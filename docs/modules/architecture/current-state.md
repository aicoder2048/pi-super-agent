# How the domain module subsystem works today

Repo: this repository, HEAD `3a98800` (includes #27 module switches, #77 source panel, #78 redeploy). Line numbers are from that commit. Everything below was read from code; nothing was run.

## Overview

A **module** is a folder with a `module.json` that the host reads once, at startup, and turns into one immutable registry object, `Modules` (src/modules.ts:227). That object is the only thing that knows about modules. At wiring time it is taken apart: the kernel gets a frozen `DomainBook` plus four closures; the Router gets two prompt strings baked into its system prompt; the Worker executor gets a `kitFor` closure; the feed and timer machinery get their specs; the web page gets a static "关注的来源" list. Nothing reloads, watches files, or swaps any of these at runtime. Every module change (add, remove, enable, edit a rule, change a watchlist) needs a host restart, and in production that means `just redeploy` (uninstall and reinstall the launchd service), which also kills running Workers and members.

Modules supply **data and paths, never code**. A module can contribute: a Router roster line, rules (`rules.md`), source declarations with filters, timers, a team of members (`agents/*.md`), a `skills/` directory, a shell `prepare` string, and a grant of two hard-coded "domain-gated" tools (`lookup`, `tripwire`). Anything executable that a domain needs (a market data poller, tripwire evaluation) lives in the host source tree under `src/sources/` and is selected by a string key in a hard-coded registry, `FEEDS` (src/sources/feeds.ts:56). The only key is `massive-stocks`. Per-user instance data exists only as one opaque TEXT blob per **source name** (`source_user_data`), and today only the us-market tripwire book uses it.

## Key Concepts

- **Module / domain.** The same thing seen from two sides (ADR-0009). A module is the folder; a domain is the name a ticket carries in `tickets.domain`. A ticket belongs to at most one domain.
- **`ModuleManifest`** (src/modules.ts:21). The TypeScript type of `module.json`. There is no schema validator and unknown keys are silently ignored. Fields: `name`, `defaultEnabled`, `title`, `description`, `team`, `tools`, `sources[]`, `timers[]`, `prepare`.
- **`SourceFilter`** (src/modules.ts:9). One `sources[]` entry: `name, title?, description?, feed?{kind, settings}, mode?("candidate"|"ignore"), market?, ignore?[regex]`.
- **Source.** A string name on every trigger, cursor, user-data row and host line. Sources are a global namespace, not owned by modules: nothing checks that a source is declared, or that two modules don't declare the same one.
- **`LoadedModule`** (src/modules.ts:38). One parsed module: dir, manifest, scoped rules, `skillsDir` (only if `skills/` existed at load), `team`, `state {enabled, by: "config"|"manifest"|"default"}`.
- **`Modules`** (src/modules.ts:227, implements `Domains`). Readonly `found` (every module, enabled or not), `modules` (enabled only), `userRules`, `skippedUserRules`, `book`, private `#scopes` (rule id to sources), plus arrow-function methods `kitFor`, `ruleAllows`, `rulesFor`, `sourcePolicy`, `isMarketSource`, and methods `timers()`, `rulesPrompt()`, `rosterPrompt()`.
- **`DomainBook`** (src/kernel/types.ts:12-21). `ReadonlyMap<moduleName, {team: string|null, onRoster: boolean}>`, built from enabled modules only. `onRoster` means the manifest has a `description`.
- **`DomainKit` / `NO_DOMAIN`** (src/modules.ts:66, :76). What a helper gets from its domain: `skillsDir`, `prepare`, `crew` (members with skills and tools already narrowed), `granted` (subset of `DOMAIN_GATED_TOOLS`).
- **Rule.** A `## heading` block in a module's `rules.md` or the user's `<stateDir>/rules.md`. Id is `<namespace>/<heading>`; namespace is the module name or `user`. Each rule has a source scope.
- **Basis.** Why a ticket exists: `request` (user asked), `rule` (a rule matched), `inference` (Router's own judgement) (src/kernel/types.ts:1). Basis decides tools and permissions as much as the domain does.
- **Helper / member.** A helper (助手, displayed as 领队 on team tickets) is the one Pi process per ticket. Members are one-shot Pi processes the helper dispatches to via `dispatch_agent`. (Memory note: in reports, say "Worker" for the helper process.)
- **Feed** (src/sources/feeds.ts:22). An in-process host object for a source: `start/stop/problem/lookup/tripwires/panel?`. Built from a `FeedSpec` by `FEEDS[kind]`.
- **Host line** (ADR-0017). A line a feed posts straight to the user's front ends, bypassing the Router: `alert` (deduped, goes to Telegram) or `receipt` (local only).
- **Cap-ask card.** The one host-issued, program-written question card that only the user can answer (ADR-0010). The precedent for any future permission card.

## How It Works

### 1. Discovery and loading (once, at startup)

`main()` (src/host/main.ts:9) calls `loadConfig()` (src/host/config.ts:57), then `loadModules(config)` (config.ts:148), which is a thin wrapper over `Modules.load(config.modulesDirs, {stateDir, allowedProviders, switches})`. Every CLI (`just modules`, `just module-new`, `market-smoke`, `toy-feed`) goes through the same two calls offline.

- `modulesDirs` defaults to `[<repo>/modules, <stateDir>/modules]` (config.ts:137). Writing it in config.json replaces both defaults; it is not type-checked, and relative entries resolve against the process cwd.
- `moduleSwitches` is config.json's `"modules": {name: bool}` (config.ts:114-117), validated as an object of booleans.

`Modules.load` (src/modules.ts:244-270):

1. `rejectLooseTeamFiles(stateDir)` fails on a stray `<stateDir>/teams.yaml` or `<stateDir>/agents/`.
2. For each root, in order, `readdirSync(root).sort()`, then `rejectFilesOutsideAnyModule`. Each subdir with a `module.json` goes to `loadModule`; one without goes to `rejectModuleWithoutManifest` (which fails if it looks like a module).
3. `loadModule` (modules.ts:151): validates name (must equal folder name, `moduleNameProblem` regex `/^[A-Za-z0-9][\w-]*$/`, not `user`), `defaultEnabled`, `title`/`description` (description at most 60 chars). Then `loadTeam` (src/teams.ts:118) parses `agents/*.md`, requiring `team` in the manifest if and only if there are members, and checks each member's model provider is one the router or worker uses. Then `checkModuleTools` (modules.ts:134) checks `tools` against `DOMAIN_GATED_TOOLS = ["lookup","tripwire"]` (src/worker/tools.ts:29) and fails if a member lists a gated tool the module doesn't grant. Then `parseRules`, rule scoping, `skills/` detection, and `stateOf`.
4. Rule default scope (modules.ts:186) is the module name plus every `sources[].name` plus every timer's source. A `来源:` line in the rule overrides it.
5. Duplicate module names across roots are fatal (no shadowing a bundled module). Switch names that match no found module are fatal.
6. User rules from `<stateDir>/rules.md` get namespace `user`. One without `来源:` is not an error; it goes into `skippedUserRules` and `main` logs it as "不生效".
7. `new Modules(found, userRules, skipped)` filters `modules`, builds `book` and `#scopes`.

Validation is fail-fast and total: every problem throws `ConfigError`, startup prints one line and exits 1. There is no quarantine path. Because `loadModule` runs before `stateOf`, a **disabled** module that is malformed still takes the host down. A disabled module's bad `feed.kind` is the exception: that is only checked in `feedSpecs`, which builds enabled modules only.

### 2. The on/off switch (#27)

`stateOf` (modules.ts:129): an explicit config entry wins (`by: "config"`, using `Object.hasOwn` so `constructor` is safe), otherwise `defaultEnabled: false` means off (`by: "manifest"`; toy-market does this), otherwise on. A disabled module stays in `found` and contributes nothing else: no rules, filters, market flag, timers, feeds, kit, book entry or roster line. There is no CLI toggle and no runtime toggle; you edit config.json and restart. `just modules` (src/cli/modules.ts) prints the found list with state and reason and ends with "重启宿主生效".

`just module-new <name>` (src/cli/module-new.ts) writes `<stateDir>/modules/<name>/` with a `module.json` (one generic source, no feed, `"//"` comment keys, no title/description so it is off the roster), `rules.md` with an `example` rule scoped to the module name, and `skills/README.txt` (`.txt` so Pi won't load it). It fully loads all modules first for its clash check, so any broken existing module makes the scaffold command fail too.

### 3. Wiring: where the registry is taken apart

`createHostOptions` (src/host/wiring.ts:87) is the single place that spreads `Modules` into the rest of the host:

- checks each member's `model` exists in `ModelRuntime`;
- `timers = modules.timers()` (ids become `<module>/<id>`, source defaults to module name; modules.ts:314);
- `feeds = feedSpecs(config, modules, log)` (wiring.ts:48). For each enabled module source with `feed`, it looks up `FEEDS[feed.kind]` (unknown kind is a `ConfigError`) and calls the factory with module `settings` plus the config.json `sources.<name>` override. Override keys are validated against the feed sources of **found** modules (wiring.ts:50-52), so a disabled module's source is still a legal override key. The factory runs immediately: `marketFeed` reads API keys and logs its status here;
- `watching = watchedSources(modules, timers)` (wiring.ts:28): static list of source, title, description, timers and rules (marked `user` or `module`);
- `HostOptions` carries `sourcePolicy`, `ruleAllows`, `isMarketSource`, `domains: modules`, `rulesFor`, `timers`, `watching`, `feeds`;
- `createRouter` closes over `rules: modules.rulesPrompt()` and `domainRoster: modules.rosterPrompt()` (wiring.ts:135-136);
- `createSpawner` closes over `lookupHelp` and `tripwireHelp`, each the concatenation of **all** feeds' help strings (wiring.ts:147-148).

The `Host` constructor (src/host/host.ts:124) then opens `state.db`, builds the `Kernel` with `domains: options.domains.book` and wraps `sourcePolicy` so source `watchdog` is always `notice` (host.ts:140); creates `GenericSource` (inbox), `TimerSource` (fixed entries, one shared cursor row `"timer"`, host.ts:162), and `feeds: Map<source, Feed>` by calling `spec.create(ctx)` with a `FeedContext` closed over that source name (host.ts:164-174); creates `MemberCap`, and `WorkerExecutor` with `kitFor` and two bridges, `lookup`/`tripwires`, that resolve **any** feed by source name (host.ts:190-199). `Host.start` (host.ts:227) creates the Router once (`host.router = await options.createRouter(deps)`), runs recovery, re-broadcasts undelivered alerts, then starts generic, timer and each feed.

```
module.json files ──Modules.load──► Modules (immutable)
                                      │ createHostOptions (wiring.ts:87)
     ┌──────────────┬────────────────┼───────────────┬──────────────┬──────────────┐
     ▼              ▼                ▼               ▼              ▼              ▼
 Kernel          Router          WorkerExecutor   PiWorkerSpawner  TimerSource    Feeds Map
 book +          rulesPrompt,    kitFor closure   lookupHelp,      fixed entries  FEEDS[kind]
 4 closures      rosterPrompt    (per spawn)      tripwireHelp     cursor "timer" create(ctx)
 (readonly)      baked in prompt                  (all feeds)                     (readonly)
```

### 4. Events in: three ways a source reaches the host

All three end in `Kernel.submitTrigger` (src/kernel/kernel.ts:218-266), which dedupes on `triggers UNIQUE(source, external_id)`, upserts threads (`thr_<source>:<thread>`), applies `sourcePolicy`, then either delivers the body to a ticket subscribed to the thread or enqueues `router.notify {kind: "candidate"}` (or `"notice"` for watchdog).

`sourcePolicy` (modules.ts:304) takes the **first** enabled module's `SourceFilter` with that name. No filter means `candidate`. `mode: "ignore"` or an `ignore` regex matching the body means `ignore`.

**A. Host-run feed (in process).** Only `massive-stocks` for source `us-market` (src/sources/market/source.ts). `marketFeed` (source.ts:63) parses settings through a strict whitelist (`parseMarketSettings`, settings.ts:19: watchlist, bands, volumeSpikeX, everySeconds, minGapMs, baseURL), reads the Massive key (missing key gives a `disabledFeed`), and builds `MarketSource` with its own `MarketClient` (serial queue, at least 12 s apart, honours 429). `MarketSource.start` runs a self-rescheduling `setTimeout` loop on the host event loop. Each `tick` (source.ts:221-248) settles MA crosses after close, polls watchlist ∪ tripwire symbols, evaluates tripwires (posting host lines, path A2), runs `detect` on watchlist quotes only, then submits each move as a trigger **before** writing the cursor (crash replays are deduped). Fifteen minutes of failures submits a `watchdog`-source notice. A 401/403 disables the feed until restart.

**B. Inbox drop.** Any process that can write `<stateDir>/inbox/*.json` (`GenericSource`, src/sources/generic.ts:80; fs.watch plus a 10 s poll). `parseDrop` (generic.ts:27) needs `thread` and `body`; `source` defaults to `generic` and may be anything except `conversation`, including `us-market` or `watchdog`. externalId is the drop's `id` or `file@mtime#sha256[0:12]`. Success moves the file to `processed/` (never cleaned); parse failure moves it to `rejected/` with `.error.txt`; a submit exception leaves it for retry. Producers today: `just drop`, `modules/toy-market/feed.ts` (an external CLI, not a `FEEDS` feed), and the watchdog process. An inbox drop can only become a trigger: no host line, cursor or user data.

**C. Timer.** `TimerSource` (src/sources/timer.ts:23) ticks every 30 s and submits at most one missed epoch-aligned slot per entry (externalId `<module>/<id>@<slot>`), then writes one shared cursor `source_cursors["timer"]`. No current module declares timers.

Only feeds can post host lines, keep user data, or answer `lookup`/`tripwire`.

### 5. Routing: from trigger to ticket and domain

The Router's system prompt is built by `routerSystemPrompt` (src/host/router.ts:192) with the roster under `## 领域` and rule text under `## 规则`, and passed once in `Router.create` (router.ts:383). The Router session continues the most recent persisted session (`SessionManager.continueRecent`, router.ts:377), but the system prompt is rebuilt from the current `Modules` on each host start. Per trigger, `noticeCard` adds an "适用规则" line from the live `rulesFor(source)` closure (router.ts:111), which still reads the frozen `#scopes`.

When the Router calls `open_ticket`, the kernel independently enforces (kernel.ts:1160-1185):

- `basis=rule`: `#ruleAllows(ruleId, triggerSource)` must pass (rule exists, trigger source in its scope, not `conversation`).
- Domain: `ruled = #domainOfRule(ruleId)` is the rule's namespace if that namespace is in `book` (so `user/*` rules give `null`). `asked` is the Router's `domain`. If `asked` is set and differs from `ruled`, it must pass `#whyNotPickable` (kernel.ts:1211: in `book` **and** on roster) or the decision is rejected. Then `domain = ruled ?? asked ?? null`; if both are set and differ, the rule's module wins and a log line says so (kernel.ts:1181).
- The ticket row stores `domain` (plain text, no foreign key) and `rule_id`. Helper identity (team name from `book`, sequence number) is fixed at open (`#newHelper`, kernel.ts:790-813). `isMarketSource(source)` gives rule tickets from `market: true` sources the market helper role.

So a module without `description` can still own tickets, but only through its own rules.

### 6. What a Worker receives from its domain

On every spawn (initial wake and every respawn after idle), `WorkerExecutor.#spawn` (src/host/workers.ts:197) calls `#kitFor(ticketId, ticket.domain)` (workers.ts:394). `null` domain gives `NO_DOMAIN`; a domain missing from the current `Modules` gives `NO_DOMAIN` plus one error line per ticket per process (`#domainless` set); no `DispatchDesk` empties the crew. `Modules.kitFor` (modules.ts:284) prepends the module `skills/` to each member's skills and narrows each member's tools with `cappedTools`.

`PiWorkerSpawner.spawn` (src/host/pi-worker.ts:104):

- runs `prepare` as `bash -lc` once per workdir (marker `.psa-prepared`, 10-min timeout, cleaned env), never for inference. No module uses it today.
- args from `workerArgs` (pi-worker.ts:73): `--no-extensions -e src/worker/extension.ts --no-skills [--skill <module>/skills]`; for inference only, `--tools <allowlist> --no-mcp`; appended prompts `WORKER_PROMPT`, the team roster if there is a crew, the output rule if basis is not inference. No `--no-context-files` for the helper.
- cwd `<stateDir>/workers/<ticketId>`; env is `workerEnv(process.env)` (drops names ending `_API_KEY/_ACCESS_KEY/_TOKEN/_SECRET/_PASSWORD`, starting `SECRET_`, and `PSA_STATE_DIR`) plus `PSA_SOCKET`, `PSA_TICKET`, `PSA_TOKEN` (random UUID), `PSA_BASIS`, `PSA_CREW`, `PSA_BG_MAX_MS`, `PSA_LOOKUPS` if `granted` has lookup, and `PSA_TRIPWIRES` if `granted` has tripwire **and** basis is `request` (pi-worker.ts:130-139).

Inside the Worker, `workerExtension` (src/worker/extension.ts:71) reads then deletes all `PSA_*` from `process.env`, and registers host-backed tools (`report`, `hand_back`, `read_ticket`, `web_get`, plus `lookup`/`tripwire`/`dispatch_agent`/`new_app`/`bg_*` depending on env and basis). A `tool_call` hook (extension.ts:302) blocks tools outside the allowlist, but an allowlist only exists for inference helpers and members. Host-backed tools send JSON lines over `<stateDir>/host.sock`; `HostServer` accepts a worker `hello` with any ticket id and token (src/host/server.ts:82-85) and every request goes to `WorkerExecutor.handleRequest` (workers.ts:307), which is the real authority: token must match the live helper or a running member (`desk.holder`); members may only call `worker.lookup` and `worker.read_web`; `#mayLookup` (workers.ts:379) checks the domain grant (helper) or the member's narrowed tools; `#tripwireRefusal` (workers.ts:384) requires basis `request`, `heardOtherThanUser` empty (no trigger or note input, no web read), and the tripwire grant.

So the module contributes exactly four things to a helper: one `--skill` path, the gated-tool grant (visible only as env), crew names plus a roster prompt, and `prepare`. Member prompts, tools and models stay in host memory and are used when `runMember` (pi-worker.ts:185) starts a one-shot `pi --mode json -p --continue` per dispatch with `--no-context-files`, `--tools <memberTools>|--no-tools --no-mcp`, module skills then member skills. Member limits live in `DispatchDesk` (src/host/dispatch.ts:231): slot per `ticket/member`, global `maxConcurrentExperts`, queue and run timeouts, stall detection, replies over 2000 chars written to `<workdir>/replies/`.

Skills are the one part re-read without restart: Pi reads `skills/` frontmatter on every process start and SKILL.md bodies when the model opens them. But `skillsDir` itself is only set if `skills/` existed at load.

### 7. Tripwires and per-user instance data

The tripwire (盯盘条件) is the only per-user, user-edited domain state. Write path: a `request` ticket in us-market calls `tripwire` → socket → `#tripwireRefusal` → host bridge → `MarketSource.tripwires` (source.ts:195-212), which parses an edit, applies caps (50 polled symbols, 10 crosses), writes `ctx.writeUserData(serializeBook(...))` **then** swaps the in-memory book, posts a local-only `receipt` host line with cost basis and shares, and returns a redacted list to the Worker. Storage is `source_user_data["us-market"].data = {"version":1,"tripwires":[...]}`, opaque to the host, read once in the `MarketSource` constructor. Evaluation runs inside the feed per poll and at post-close settlement; dedupe is entirely `host_lines UNIQUE(source, external_id)`. Alerts go through `Host.#postHostLine` → `Kernel.postHostLine` → broadcast to TUI, web, Telegram → `markHostLineDelivered`; they never touch `sourcePolicy`, rules or the Router.

The watchlist is **not** instance data: it is `module.json` `feed.settings.watchlist`, overridable in config.json, restart to change. "今日提醒" is a count query (`alertCountsToday`).

### 8. Front ends and the cap-ask card

The web page's "关注的来源" column is `#watchingNow()` (host.ts:342): the static startup `#watching` list plus live `problem()`, `panel()` (`{watchlist, tripwires}`) and `alertsToday` from each feed. There is no module list, no enable control, no domain label on task cards (only the team name in the helper label). The TUI shows neither. Telegram shows conversation, question cards, the cap note and alerts. `src/client/protocol.ts` has `WatchedSource`, `SourcePanel`, `MemberCapBoard`; no module type.

The cap-ask card (ADR-0010): when dispatches wait for a slot, `MemberCap.membersWaiting` (src/host/member-cap.ts:36) persists `{state: "asked", day}` into `cap_asks` via `Kernel.capAsks` (kernel.ts:188), then `Host.#boardState().memberCap` carries program-built text and options with id `ask_cap_<NY date>`. The web shows it in 待你处理 labelled "白宫 · 系统"; the TUI shows a row; Telegram shows a note without buttons. Answers come through the same wire as helper questions: web `POST /say {"answer": {...}}`, where `parseSayBody` accepts only `rpt_*` or `isCapAskId` ids (src/host/web.ts:240), or socket `answer` from a client-token-authenticated connection. `Host.answer` (host.ts:298) routes `ask_cap_*` to `#answerCapAsk` before the kernel, and refuses with `not_here` if `from` is an IM chat. `MemberCap.answer` (member-cap.ts:52) checks the id is today's, handles duplicate/different clicks, validates the transition (`CAP_ASK_NEXT`), **persists first**, then applies. The user's sentence ("回答成员上限：…") appears in the conversation through the `LINES` union over `cap_asks.said` (kernel.ts:166-176). It never becomes a trigger and never reaches the Router.

## Where Things Live

| Path | What |
|---|---|
| src/modules.ts | Manifest types, `loadModule`, `parseRules`, `stateOf`, `Modules` registry, `kitFor`, `sourcePolicy`, `timers()` |
| src/teams.ts | `loadTeam`, `parseMember` for `agents/*.md` |
| src/host/config.ts | `loadConfig`, `modulesDirs`, `moduleSwitches`, `loadModules` |
| src/host/main.ts | Startup entry |
| src/host/wiring.ts | `createHostOptions`, `feedSpecs`, `watchedSources`, Router/spawner factories |
| src/host/host.ts | `Host` constructor/start/stop, feeds Map, lookup/tripwire bridges, host lines, `answer`, board |
| src/host/router.ts | `routerSystemPrompt`, `Router.create`, `noticeCard` |
| src/kernel/kernel.ts, types.ts, store.ts | `submitTrigger`, `open_ticket` domain logic, source state, host lines, `capAsks`; `DomainBook`; schema |
| src/host/workers.ts, pi-worker.ts, dispatch.ts | Ticket processes, `handleRequest` gates, spawn args/env, members |
| src/worker/extension.ts, tools.ts | In-Worker tool registration, `DOMAIN_GATED_TOOLS`, allowlists |
| src/sources/feeds.ts, generic.ts, timer.ts, market/ | `FEEDS`, `Feed` contract, inbox, timers, the market feed and tripwire model |
| src/host/member-cap.ts, src/kernel/cap-ask.ts, src/host/web.ts | Cap-ask card |
| src/cli/modules.ts, module-new.ts | `just modules`, `just module-new` |
| modules/pi-pi, toy-market, us-market | The three modules (pi-pi: team of 9 + skills, roster only; toy-market: off by default, inbox-fed; us-market: team of 4, feed, `tools: [lookup, tripwire]`) |
| src/service/, src/watchdog/, justfile | launchd service, watchdog, `redeploy` |

## Gotchas

1. **No hot-plug anywhere.** A new module folder is invisible until restart; a deleted `skills/` dir is noticed only by Pi at next spawn (behaviour with a missing `--skill` dir is unverified).
2. **One bad module stops the host**, even a disabled one, and also stops `just module-new`.
3. **Sources are global strings.** Two modules can declare the same source; `sourcePolicy`/`isMarketSource` take the first, `watchedSources` merges. Undeclared sources default to `candidate`.
4. **Rule default scope includes the module's own name**, so a module with no sources still matches triggers whose source equals its name.
5. **Duplicate rule headings in one `rules.md` are not detected**; `#scopes` keeps the last.
6. **The `tools` gate hides tools via env but authorizes per domain, not per source.** A domain granted `lookup` can query every feed on the host, and its help text lists every feed.
7. **The `Feed` interface is market-shaped.** `tripwires()` is mandatory and returns `RedactedTripwire` imported from `market/tripwires.ts` (feeds.ts:4, :27); `SourcePanel` is `{watchlist, tripwires}`. A health feed would have to stub both.
8. **One `MarketClient` per feed instance.** ADR-0005's shared free-tier budget only holds because there is one `massive-stocks` source.
9. **Timer cursor is one row keyed `"timer"`**, written every 30 s; a source literally named `timer` would collide.
10. **Tripwire book is read once**; an external edit of `source_user_data` is overwritten on the feed's next write.
11. **Disabling a module orphans its rows** in `source_user_data`/`source_cursors`; they silently re-attach if any module later declares that source name.
12. **Non-inference helpers run full Pi with bash**, no `tool_call` filter, no `--no-mcp` (whether MCP is actually active for them is unverified), no `--no-context-files`.
13. **A ticket whose module vanished after a restart** degrades to a domainless helper with one log line; the board just drops the team name.

## Constraints a redesign must respect or consciously change

### Everything that captures the module list at startup

| Holder | Captured | Where |
|---|---|---|
| `Modules` | `found`, `modules`, `userRules`, `book`, `#scopes`, all readonly | src/modules.ts:228-241 |
| `Kernel` | `#domains` (book), `#sourcePolicy`, `#ruleAllows`, `#isMarketSource`, readonly private fields set in constructor | src/kernel/kernel.ts:182-185, :207 |
| `Router` | roster and rule text baked into the session system prompt; `rulesFor` closure over frozen scopes | wiring.ts:135-137, router.ts:383, router.ts:111 |
| `PiWorkerSpawner` | `lookupHelp`/`tripwireHelp` from startup feeds | wiring.ts:147-148, pi-worker.ts:138-139 |
| `WorkerExecutor` | `kitFor` closure over the frozen `Modules`; a live helper keeps its args, env and `live.crew` until exit | workers.ts:394-403 |
| `Host` | `feeds` readonly Map, `timer` with fixed entries, `#watching` static list, `#kitFor` (transcript team titles) | host.ts:103-118, :162-174 |
| `createHostOptions` | feed factories run once (key reads, status) | wiring.ts:48-68, :100-117 |
| Service | `just redeploy` = uninstall + install; only way to apply module changes in production; stops running Workers and members | justfile, src/service/cli.ts |

The kernel-to-registry surface is small (book + four closures), which makes a swappable registry behind stable function references feasible without changing the Kernel constructor contract. The Router is harder: either rebuild the session prompt or inject roster/rule changes per notice card (already done for `rulesFor`). A running ticket already keeps its spawn-time kit until the process exits, which matches the memo's "版本跟着任务走" for process lifetime, but path-based `skillsDir` means an in-place edit changes behaviour mid-task, and the next respawn re-resolves against whatever registry is current.

### What in state.db is keyed by source name, not module

No table is keyed by module. Module-ness is implicit in `tickets.domain` (text, no FK), the namespace prefix of `tickets.rule_id` (not re-validated on restart), and the in-memory timer id prefix. Source-keyed: `triggers UNIQUE(source, external_id)`, `threads.source` and the `thr_<source>:` id convention, `source_cursors` (PK source; timers share `"timer"`), `source_user_data` (PK source; the only instance data), `host_lines UNIQUE(source, external_id)` (src/kernel/store.ts:175-185, :219-234). config.json `sources.<name>` overrides are also source-keyed; config.json `modules` switches are module-keyed. Schema migration is ad hoc (`openStore` runs `ALTER TABLE ADD COLUMN` when a column is missing, store.ts:242-260); there is no version table, and CHECK constraints can only change by rebuilding the table. Per-user module instance data (a health record store, a user's watchlist) has no home today; namespacing sources as `<module>/<source>` would require migrating existing `us-market` rows.

### The cap-ask card as the permission-card precedent

What carries over: text and options built by program, never a model; a reserved id prefix checked in `Host.answer` before the kernel path; refused from IM with `not_here` (ADR-0016); persisted in its own table before taking effect; the user's choice shown as the user's sentence via the conversation union; a dedicated `BoardState` field; labelled "白宫 · 系统".

What must change to add a second card type (for example `ask_mod_<module>_<version>`):
- `src/kernel/cap-ask.ts`: a sibling id predicate;
- `src/host/web.ts:240` `parseSayBody`: accepts only `rpt_*` or `ask_cap_*` today;
- `src/host/host.ts:298` `Host.answer`: routing branch and IM refusal;
- `src/kernel/store.ts:125` `trigger_quotes.line_id` CHECK (`trg_* | rpl_* | ask_cap_*`): quoting the new card's line fails unless the table is rebuilt;
- `src/kernel/kernel.ts:166-176` `LINES` union: add the new table's `said` rows;
- `src/client/protocol.ts` `BoardState`, `src/web/view.mjs` (capCard at :239), `src/client/board.ts`, and Telegram `NOTES` (src/host/telegram/rules.ts:26) for display;
- the id scheme: cap ids are per New York day; a module card needs a different key and expiry model.

ADR-0003 says only the user's own words and rule files authorize; ADR-0010 extended that to one host card. Whether enabling a module or granting it permissions by card fits ADR-0003, and whether card state in state.db or switches in config.json win on conflict, is undecided (explorer 4's open question).

### ADR decisions a redesign hits

- **ADR-0002**: Router in process, Workers as subprocesses.
- **ADR-0003**: authority only from the user's words and rule files; source content is data; inference tickets read-only with program-enforced limits.
- **ADR-0005**: feeds run in the host, modules write only data, credentials only in the host, "add a kind = add a dir under `src/sources/` and a line in `FEEDS`". It explicitly rejected "module ships code, host dynamically imports". Module-shipped code in subprocesses is a conscious reversal.
- **ADR-0008/0009**: a helper can grow a team; a ticket has one domain and the domain is a module; modules load only at startup; a vanished module's ticket continues domainless.
- **ADR-0010/0016**: cap card, web and TUI only.
- **ADR-0013**: `lookup` gated per domain in `module.json`, host is the arbiter; per-source restriction explicitly deferred.
- **ADR-0015**: Worker writes are checked after the fact, not blocked.
- **ADR-0017**: host lines bypass the Router; alerts may leave the machine, receipts may not; the 幕僚长 does not learn which alerts were sent.

### Known security gaps

- **No Worker sandbox.** `request`/`rule` helpers have bash as the same OS user as the host; they can read `client-token`, `web-token`, the secrets file and the state dir (ADR-0007, ADR-0010 "只有使用者的边界"). `web_get` blocks private addresses, but bash/curl is unrestricted. Writes are reported, not blocked.
- **Bearer tokens in env.** `PSA_TOKEN` is readable via `ps eww` by any same-user process, so a helper can impersonate another ticket or a member can use its helper's token (docs/security/worker-token-theft-memo.md, untracked; ADR-0013 "这道检查挡不住偷来的令牌"). The socket accepts any worker `hello` (server.ts:82-85); authority rests entirely on the token match in `handleRequest`.
- **Lookup reaches every feed.** The host bridge resolves any source name (host.ts:190-194) and help text lists every feed; there is no check that the source belongs to the ticket's domain. This is the gap a health module's private data would fall into.
- **Inbox files can claim any source** except `conversation`, including `us-market` (matching its rules) or `watchdog` (forced `notice`), with no authentication beyond the 0700 state dir. There is no HTTP/webhook ingress.
- Feed code runs on the host event loop; a synchronous hang blocks the host.

### Docs that are out of date

- docs/adr/0009-...md:44: "模块没有单独的开关" (no switch); #27 added one.
- docs/modules/module-architecture-upgrade-memo.md:50-51 (§2.1) and :280 (M0 "合并 PR #27"): say #27 is unmerged; it is merged as cefb2c1.
- docs/modules/module-user-guide.md:1025: "模块开关和脚手架在 PR #27 里，还没有合并" contradicts its own lines 578-580, which already describe the switch.
- docs/modules/module-code-and-feeds-memo.md:102, :109, :124: say #27 should be merged first.
- ADR-0005's "only one `MarketClient` in the host" is true only by accident of there being one feed.

### Open questions carried forward

- Router: rebuild prompt mid-session (Pi `createAgentSession` may not support it) vs per-notice roster injection.
- Where per-user module data lives (module column vs namespaced source vs new table) and how existing `us-market` rows migrate.
- Splitting `Feed` into a generic core plus optional capabilities (user-data editor, alerts, panel).
- Per-feed runtime start/stop; a removed feed breaks `lookup` for in-flight tickets of that domain.
- Whether a disabled module's tickets keep a pinned copy of the module or keep today's `NO_DOMAIN` fallback.
- How module-specific deterministic tools would reach Workers (host socket methods keyed by module vs per-module `-e` extensions) and be gated per domain and per member.
- Pi behaviour with a missing `--skill` dir; whether helpers should get `--no-context-files`; whether MCP is live for `request`/`rule` helpers.
- Whether production state dir (the Mac mini/old Mac) differs from this machine (explorers did not inspect it).

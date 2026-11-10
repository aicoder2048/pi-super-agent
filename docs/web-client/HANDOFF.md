# Handoff: 白宫 (Pi Super Agent), 2026-11-10

For a new session picking this work up. Reply to the user in Chinese; English for technical terms. This file replaces the older handoff notes; everything below is current as of `main` at `931c445`.

## Where things stand

The Agent Teams program is done and merged. The structure is two layers, 幕僚长 ↔ 助手, and a helper grows into a team when its ticket's domain has members. Read the ADRs in this order to understand it: 0003 (authority comes only from the user), 0007 (socket clients present a credential), 0008 (a helper can grow into an Agent Team), 0009 (a ticket belongs to one domain and the domain is a module), 0010 (the user raises the member cap for a day).

Merged to `main` on 2026-11-09, bottom-up, squash:

| PR | What it delivered |
|---|---|
| #36 | Socket client credential `client-token` (ADR-0007) |
| #28 | W4 browser e2e on a fake model, demos |
| #29 | W5 helper strip, helper names, route lines |
| #35 | T1 every ticket has a team; four-character names for team tickets |
| #37 | T2 `dispatch_agent`, member sessions per ticket, 15 / 60 minute limits, live progress, stall rule, member ledger |
| #38 | D1 the module is the domain; team = the module's `agents/`; skills follow the domain |
| #39 | T2b host-raised question 「成员上限」, cap 4 → 10 for a New York day on the user's click |
| #40 | T3 看盘队 (us-market, four read-only members, skill `us-market-desk`) and Pi专家队 (pi-pi, nine experts, no shell) |
| #33 | Brand: 白宫, Pi Super Agent as subtitle, user avatar |
| #34 | Deterministic typed-then-click 409 test |
| #17 | First manual trial fixes: a closed ticket no longer receives its thread's triggers directly; TUI board rows; CLI messages name the state dir |
| #25 | Ctrl+C stops the host, workers and members cleanly; the Watchdog stops only the host it launched |

Closed without merge: #30, #31, #32 (the 副幕僚长 design, superseded) and #26 (its code reached `main` through #40).

Still open: **#27** module switches (`just modules`, `just module-new`, toy-market off by default). It conflicts heavily with D1 and with ADR-0009's statement that a module is switched off only by removing it or leaving it out of `modulesDirs`. Do not rebase it blindly; ask the user how switches should fit the domain roster, then rebuild it on `main` as a new PR and close #27.

`main` at `931c445`: `just test` 866/866 on the merge result. The user's local `main` checkout was last pulled at `f67e7c2`; it needs `git pull --ff-only` (with the host stopped) to get #25.

## The user's own host

- Runs from the main checkout with `just host`, state dir `~/.pi-super-agent` (default), web on `127.0.0.1:4517`.
- `~/.pi-super-agent/config.json` was created on 2026-11-09 at the user's request: router `openai-codex/gpt-6.1-terra`, worker and fallback `openai-codex/gpt-6.1-sol`, `secretsFile` pointing at `extensions/stock-heatmap/.env`, `sources.us-market.minGapMs` 250. Before that the file did not exist and the fallback silently defaulted to pay-per-use `deepseek/deepseek-flash`.
- The market key works now; a 看盘队 ticket answered a plain price question without dispatching, which is the skill's intended behavior. A "why did it move" question dispatches members.
- `.psa-trial/` (the 2026-11-08 trial state dir) was deleted at the user's request.
- The main checkout has an uncommitted one-line `.gitignore` change (`extensions/stock-heatmap/.env`) that this session did not make. It is redundant with the `.env` line above it. Leave it to the user.
- The user plans to run the host on a **Mac mini**. When that happens, remote reach is the first design question (web listens on 127.0.0.1 only; TUI and `just say` use a Unix socket), and the market key should move to a secrets file in the state dir.

## Backlog, in the order I would propose it

Ask the user before starting any of these; they like to discuss first, then decide, then do one step and see it.

1. **清屏 on the web page** (the user asked for this, 2026-11-09). A control that hides the conversation lines the page currently shows. The database and the 幕僚长's memory are untouched, so it can still resolve 「刚才那件事」. After a reload the hidden lines stay hidden; new lines appear as usual. The user explicitly chose this over a new 幕僚长 session (breaks continuity) and over wiping the state dir. Open questions to settle with the user: whether the TUI gets the same command, whether it is per browser or shared by all front ends, and whether there is a way to show the hidden lines again. Small PR: page and possibly a host-side marker; red-first tests and an e2e step.
2. **Blocked tickets read as running.** A ticket whose helper reported 受阻 shows a running timer on its chip and 「进行中」 in the 执行过程 header, while it is actually idle in 待你处理. Show 「受阻 · 等你处理」 and stop the clock at the block. Then ask the user whether a blocked ticket nobody answers should be reminded about or closed after some time (today it waits forever, at no cost; the helper process is already stopped).
3. **#27 module switches**, rebuilt on D1 after the user decides how switches and the domain roster fit together.
4. **Remote reach for the Mac mini**: SSH port forwarding works today; a real design extends ADR-0004 and ADR-0007 (who counts as the user from another machine).
5. **`bars` time window or a 5-minute span** in the us-market lookup. Today `bars` takes only dates and returns the last 500 bars, so after the close hour bars may start at noon and the open is not visible.
6. **Page details**: code fences render as literal ``` on task cards; a long Pi expert answer is relayed by the 幕僚长 as two bubbles with a cut code block; the helper strip scrolls sideways at 390 px and with eleven chips; a helper's own tool steps in a dispatch batch stay pending until the batch returns.
7. **Multi-channel** (email, IM, GitHub) as its own project, starting with an ADR on who counts as the user on a channel. Channels must not be declared by modules.
8. **Module data slot** (`data/` for case libraries, game records): design when the user has data to put there.
9. **OS sandbox for helper commands**: deferred by the user (2026-11-09). A helper with `bash` runs as the host's user and can read `client-token` and `state.db`; ADR-0007 and ADR-0010 state this limit. The user's note on it: `~/SecondBrain/04_areas/002_knowledge_dots/agent-harness/same-user-agent-can-read-the-keys.md`. Do not start it unless the user asks.

Smaller known follow-ups recorded in the ADRs and the trail: no token budget per dispatch (one live dispatch used about 700k input tokens); a command a member puts in the background outlives it; a second Ctrl+C while a member runs leaves that member until the next host start (the user agreed to keep this).

## Known rough edges in the repo

- `IMPLEMENTATION_PLAN.md` and `docs/web-client/decisions.tsv` cite commit SHAs from before the final restack and squash merges; most no longer exist on `main`. The plan's evidence is still true; only the SHAs are stale. Fix in one docs PR if the user wants it.
- One e2e test is flaky: `tests/e2e/helpers.e2e.ts` 「点小卡，右栏打开那个任务…」 sometimes reads 「模型 未启动」 because it clicks before the second helper reports its model. Add a wait.
- `just test` once showed a single unidentified failure on the T3 branch and passed on three reruns.
- `IMPLEMENTATION_PLAN.md` is the program plan run with pstack poteto-mode; `node ~/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/poteto-mode/scripts/check-plan.mjs IMPLEMENTATION_PLAN.md` must stay at 0 problems.

## How the user likes to work

- One step at a time: show it, wait for the go. Sketches from the user are discussion until they say they have decided. Present tradeoffs and a recommendation.
- The user merges. Merge only when they ask in that turn.
- pstack poteto-mode in full for code work: a todolist with the playbook steps, red-first tests, a decision trail in `docs/web-client/decisions.tsv` via `show-me-your-work/scripts/log.sh`, independent review and live lanes on real models before a PR.
- During long runs they want a spoken progress report every 15 minutes: `uvx edge-tts --voice zh-CN-XiaoyiNeural`, played with `afplay`; no names, paths or code identifiers in the spoken text. Set it up with CronCreate and cancel it when nothing runs.

## Rules

- Models in Pi: only `openai-codex/*` (subscription). Never `anthropic/*` or `deepseek/*` without asking.
- Never read or print `extensions/stock-heatmap/.env`; pass its path only.
- Never touch the user's running host (port 4517) or write into `~/.pi-super-agent` unless the user asks for that specific change. Stop only processes you started, by recorded PID or group; never `pgrep`/`pkill`.
- Tests that start a host must not reach a real model: use the fake-model harness, `PSA_PI_CLI`, and an empty `PI_CODING_AGENT_DIR` with `PI_OFFLINE=1`. (A rebase check once started the real Pi on the user's subscription for about a minute.)
- Work in worktrees under `.claude/worktrees/`; never commit to `main` directly. Use `--force-with-lease` pinned to the last pushed SHA on your own PR branches only.
- The Mac sleeps when unattended: wrap long runs in `caffeinate -i`.
- Subagents on Opus have been stopped by the model's safety filter when the brief asked them to enumerate ways to impersonate the user; brief security work as defensive fixes with a concrete design.

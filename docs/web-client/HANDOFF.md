# Handoff: 白宫 (Pi Super Agent), 2026-11-09

For a new session picking this work up. Reply to the user in Chinese; English for technical terms.

## What the user just decided

Roll back the 副幕僚长 design. The structure returns to two layers, 幕僚长 ↔ 助手. Task decomposition and synthesis move down into the Worker: a helper grows into an **Agent Team** when it needs to. The design is `docs/adr/0008-a-helper-can-grow-into-an-agent-team.md` on this branch (`psa/teams`, cut from `psa/helpers`). The user agreed to all four points in it:

1. The helper always has `dispatch_agent` when its ticket's team has members, keeps its own tools, and decides itself whether to dispatch.
2. Teams come from modules and the user's state dir. A rule can pin one (`团队：<name>`); otherwise the 幕僚长 picks a team name when it opens the ticket; there is a default team.
3. Members keep their own Pi session within one ticket.
4. Member tools = basis ∩ member's own list. One level only.

Reference implementation: `/Users/szou/Python/Playground/LearnTopEngSkills/practice/harness-dual-loops/vendor/pi-vs-claude-code/extensions/agent-team.ts`.

The user said "让我们一步一步来": do one step, show it, wait. Sketches from the user are discussion until they say they have decided.

## Next step

Paused on 2026-11-09 at about 16:55 because the user took the machine home. Resume here.

**State.** T1 is PR #35 (`psa/teams`), reviewed and approved by the user in chat ("通过"), not merged; the user merges. T2 is on `psa/dispatch` (worktree `.claude/worktrees/dispatch`, cut from `psa/teams`, not pushed, no PR). Its first build passed two audits and ten live lanes at `eac2f5e`; a fix round was in progress when the pause came. Read the last `t2-fix` rows of `docs/web-client/decisions.tsv` on that branch and `git log eac2f5e..HEAD` there to see how far it got. If the head commit is `wip:`, its body says what is unfinished.

**Update at the pause.** The fix round finished: `psa/dispatch` head `72632f7`, tree clean, owner reports `just test` 611/611 and `just e2e` 89/89 (the root has not re-run them or read this diff yet). All brief items are done. One open design point to raise with the user before the PR: the stall rule counts only process events, and the bash tool emits none while a command is silent, so a coding member running a quiet command longer than `dispatchStallSeconds` (180) is ended as 无进展; counting "a tool call is in flight" as activity would fix it and is not built. Owner's screenshots: `/tmp/t2fix/shot-*.png` (may be gone after a reboot).

**First action on resume.** In `.claude/worktrees/dispatch`: run `just test` and `caffeinate -i just e2e`, compare the commits against the fix-round list below, hand whatever is left to a fresh `pstack:poteto-agent`, then re-run the live lanes the fix round touched (time limit, progress line, stop, restart mid-dispatch, a 390 px screenshot), read the diff, and open the T2 PR based on `psa/teams`.

**T2 fix round scope** (the brief the owner had):
- A1 fallback daily cap checked against the model the member really runs on (blocker).
- B2 a restarted host ends members a SIGKILLed host left; B3 stop returns only after members are gone and the test fake follows the real exit order; B4 clear the late SIGKILL timer.
- C5 time limits: 60 minutes if the member's effective tools include `write`, `edit` or `bash`, else 15; keys `dispatchTimeoutSeconds` (900) and `dispatchCodingTimeoutSeconds` (3600); queue wait 15 minutes. C6 progress: 「新闻研究员 · 读取网页 · 12 秒前」 under the chip, member steps inside the dispatch step, a `stalled` end state after `dispatchStallSeconds` (180) with no event, member activity counts as the helper's progress. C7 member sessions stay in `workers/<ticket>/team/<member>`; no archive.
- D8 to D13 page defects from the live lanes (finished member shown as 排队中, stopped steps without a title, ghost step after restart, timeout reason, member row wrap, Markdown tables and Markdown in 幕僚长 bubbles, cards and reports).
- E test gaps from the mutation audit. F docs.

**Order the user confirmed on 2026-11-09** (one step, show it, wait for the go):
1. T2.
2. 领域归一, a small PR on top of T2 and before T3. A ticket belongs to one domain and the domain is the module. The 幕僚长's roster lists domains. A rule's ticket belongs to the module whose `rules.md` holds the rule, so the `团队：` line goes away. The team is the members in the module's `agents/`, so `teams.yaml` goes away; one module has at most one team; a user-defined team is a module under `<state dir>/modules/`. Skills follow the domain: the helper and every member get the module's skills whether the ticket came from a rule or from the conversation (today skills reach a helper only when a rule of that module opened the ticket). A member's prompt holds its role, judgment and report format; reusable knowledge goes in skills. Before any code: rewrite ADR-0008 point 2, show the user, wait for approval.
   The user added on 2026-11-09 evening: member definitions move into the module, so the module needs a structured design that serves two consumers. The event-driven layer (host and 幕僚长) reads its sources, timers, rules and the domain's one-line description. The Agent Team side (helper and members) reads its skills, member definitions and later data, and must be able to instantiate expert members when a team needs them or ahead of time. The ADR rewrite must lay out both faces and say what 'ahead of time' means (definitions loaded and validated at startup; whether any member process is pre-started is an open question to put to the user).
3. T2b: when members queue for a slot, ask the user with a one-click question card; on yes the member cap rises from 4 to 10 host-wide for that New York day; on no, do not ask again that day; hard maximum 10.
4. T3: 看盘队 and pi-pi 队 in the unified form. Raise with the user then: drop the `market: true` source flag that makes the kernel say 行情助手; whether `us-market` ships its team by default (my recommendation: yes).
5. Restack #33 (白宫 brand) onto T3, then close #30, #31, #32.

**Socket fix, separate branch from `main`.** The host's Unix socket accepts `role: "client"` with no token (`src/host/server.ts` about lines 63 to 70), so a worker with `bash` can `say` as the user; the T2 audit proved it; it predates T2. The user agreed to a separate PR off `main`. A token alone may not close it, because the worker runs as the same OS user and may read whatever file holds the token. An investigation agent on Opus was stopped by the model's safety filter before it reported anything, so nothing is known beyond the audit finding. On resume, tell the user and ask how they want to proceed (for example a narrower design task on the session model: require a token on the client role and keep the socket path and token out of the worker's environment); do not retry the same investigation prompt.

**Later, own project.** Multi-channel (email, IM, GitHub): after this round, starting with an ADR on who counts as the user on a channel. A `data/` slot in a module: design when the user has data to put there.

**Voice reports.** While work runs the user wants a spoken report every 15 minutes: `uvx edge-tts --voice zh-CN-XiaoyiNeural`, played with `afplay`; no names, paths or code identifiers in the spoken text. The cron job is session-only and is cancelled now; recreate it when work restarts.

## Open PRs

| PR | Branch | State |
|---|---|---|
| #25 | psa/clean-exit | Ctrl+C. Ready to merge |
| #26 | psa/market-data | indicators, earnings, lookup cache. Ready |
| #27 | psa/modules-admin | module switches, `just modules`, `just module-new`. Ready |
| #28 | psa/e2e | W4 e2e + demos. Ready |
| #34 | psa/flaky-spoke | flaky 409 test. Ready |
| #29 | psa/helpers | W5 helper strip, names, route lines. Stays. Needs the user's screenshot review |
| #35 | psa/teams | T1: teams on tickets, four-character team names. Merge-ready, needs the user's screenshot review |
| #30, #31, #32 | psa/roles, psa/consult, psa/market-experts | 副幕僚长 design. To be replaced |
| #33 | psa/brand | 白宫 name, W1 logo, U2 user avatar. Stays; restack later |
| #17 | psa/trial-fixes | old, untouched |

The user merges. Never merge unless they ask in that turn. If #27 merges before #28, the e2e and demo configs need `"modules": {"toy-market": true}`.

## Not done

- Full 10-lane live runs for W5 (and for whatever replaces W6). None have run. W5 lane 2 expects 「行情助手」 on the card, which holds again after the rollback.
- A design review on Fable against `docs/dsh-super-agent/super-agent-design-exploration.md` (five modules, four traits). The user asked for it before the rollback; the brief must be rewritten for the two-layer + Agent Team structure. Ask before starting it.
- W3 (dev test-tools panel): deferred.

## Facts worth knowing

- The user's Massive plan is Stocks Starter: unlimited calls, 15-minute delayed. They should set `sources.us-market.minGapMs` to 250, `secretsFile` to `extensions/stock-heatmap/.env`, and `models.fallback` to `openai-codex/gpt-6.1-sol` in `~/.pi-super-agent/config.json`. They may not have done so yet.
- The first live expert run timed out because one-shot `pi -p` processes never exited after using `lookup` (fixed in 38ccc66 on psa/market-experts). Carry that fix over.
- Product name 白宫: use the name only, never official White House marks.

## Rules

- pstack poteto-mode in full: plan section, red-first tests, decision trail (`docs/web-client/decisions.tsv` via `show-me-your-work/scripts/log.sh`), cleanup, independent review before any PR.
- Never `anthropic/*` or `deepseek/*` models in Pi; use `openai-codex/*`.
- Never read or print `extensions/stock-heatmap/.env`; pass its path only.
- Never touch the user's host (port 4517, `~/.pi-super-agent`). Stop only processes you started, by recorded PID or group; never pgrep/pkill.
- The Mac sleeps when unattended: wrap long runs in `caffeinate -i`. Background agents can stall on permission prompts; check their last activity.
- Tests: `just test`, `just e2e`. Work in worktrees under `.claude/worktrees/`.

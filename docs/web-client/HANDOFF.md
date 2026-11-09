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

The user has not yet read ADR-0008. Show it and wait for approval. Then:

1. Rewrite the W6 sections of `IMPLEMENTATION_PLAN.md` as T1 (members, teams, `team` on `open_ticket`), T2 (`dispatch_agent` with per-ticket member sessions), T3 (the 看盘队 and the pi-pi team). Keep check-plan at 0 problems.
2. Build on `psa/teams`, reusing code from `psa/roles`, `psa/consult`, `psa/market-experts` (the ADR's last section lists what to keep, drop and write new).
3. Open the new PRs, restack #33 (brand) onto them, then close #30, #31, #32. Do not close them before the replacements exist.

## Open PRs

| PR | Branch | State |
|---|---|---|
| #25 | psa/clean-exit | Ctrl+C. Ready to merge |
| #26 | psa/market-data | indicators, earnings, lookup cache. Ready |
| #27 | psa/modules-admin | module switches, `just modules`, `just module-new`. Ready |
| #28 | psa/e2e | W4 e2e + demos. Ready |
| #34 | psa/flaky-spoke | flaky 409 test. Ready |
| #29 | psa/helpers | W5 helper strip, names, route lines. Stays. Needs the user's screenshot review |
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

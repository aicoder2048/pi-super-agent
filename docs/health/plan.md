# Health alarms plan

The user's words (2026-11-13). "数据断了不告诉我，这个不行！" When market data or a model call breaks, the page and Telegram must show a warning until it is fixed. This plan adds one host-owned alarm registry. Host code raises and clears every alarm, never a model, because a model that is down cannot report itself. The web page shows active alarms in a banner under the header, and Telegram gets one message when an alarm goes up and one when it clears. Two stacked PRs. H1 builds the registry, model alarms, the banner, and the Telegram messages. H2 routes module feeds into the same registry and deletes the old feed-problem notice path.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator lands both PRs. H1 and H2 stop at merge-ready.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [x] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go. The coordinator's brief is the go for this run.
- [x] Read these from trunk at program start. Re-read them at every tick.
  - [x] `git show origin/main:pstack/skills/poteto-mode/playbooks/autopilot-stack.md`, read from the installed pstack copy because this repo does not vendor pstack.
  - [x] `git show origin/main:pstack/skills/swarm/SKILL.md`, read from the installed copy.
  - [x] `git show origin/main:<control skill path>`. The browser is driven by the repo's own Playwright harness in `tests/e2e/harness.ts`.
  - [x] `git show origin/main:pstack/skills/poteto-mode/playbooks/opening-a-pr.md`, read from the installed copy.
  - [x] `git show origin/main:pstack/skills/architect/SKILL.md`, read from the installed copy.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory. Skipped for this run, because one owner builds both PRs in one session and the coordinator audits.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [x] Spawn one owner per PR with the full lifecycle the execution playbook names. One owner builds H1 then H2.
- [x] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [x] H1 is first. It branches from `main` as `psa/health-models` in `../psa-health1`.
  - [x] H2 after H1. It branches from `psa/health-models` as `psa/health-data` in `../psa-health2`.
- [x] Hold the file boundaries. H2 touches only the feed wiring in `src/host/host.ts`, `src/host/health.ts`, the docs that describe feed problems, and tests.
- [x] Hold the review gate. H1 and H2 change an interaction. They wait for the operator's review in chat with screenshots before merge.

### PR mechanics, for every PR

- [x] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [x] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [x] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. The repo has no lint or typecheck step; `just test` and `docs/modules/architecture/check.mjs` stand in.
- [x] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.
- [x] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands. This repo never force-pushes, so restacking merges the parent instead of rebasing.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per `pstack/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The operator lands H1 then H2. H2 is merged with its parent first, so its patch-id against `main` is unchanged after H1 lands.

### Boot recipe, for every live lane

Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`. In this repo a lane runs locally instead, through `tests/e2e/harness.ts`, which starts a real host in a temporary `PSA_STATE_DIR`, the fake model, and headless Chromium.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Start the backend and the surface with `node --import ./src/pi-runtime.mjs --test tests/e2e/health.e2e.ts`. The harness waits for the page to say it is connected.
- [ ] Deliver input only through the page's composer, `FakeTelegram.userSays`, `FakeModel.fail` and `FakeModel.heal`. Read-only diagnostics are `host.log` and `fake-model.jsonl` in the run's output folder.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. Locally the e2e writes them under `tests/e2e/.out/<run>/health-shots/`.

## Show model failures on the page and the phone (H1)

**Depends on.** None.

**Files.**

- [x] Create `src/host/health.ts`.
- [x] Edit `src/host/host.ts`, `src/host/router.ts`, `src/host/workers.ts`, `src/host/config.ts`, `src/host/wiring.ts`, `src/host/telegram/client.ts`, `src/host/telegram/store.ts`, `src/client/protocol.ts`.
- [x] Edit `src/web/view.mjs`, `src/web/app.mjs`, `src/web/index.html`.
- [x] Create `docs/health/README.md` and `docs/health/plan.md`. Edit `GLOSSARY.md`.
- [x] Create `tests/health.test.ts`, `tests/health-models.test.ts`, `tests/e2e/health.e2e.ts`. Edit `tests/fallback.test.ts`, `tests/config.test.ts`, `tests/web.test.ts`, `tests/helpers/fakes.ts`, `tests/e2e/fake-model.ts`.

**Build.**

- [x] `Health` in `src/host/health.ts` keeps one run per alarm id. `failed(id, failure)` counts consecutive failures and raises at `failure.after`. `ok(id)` clears and moves a raised alarm to the recent list.
- [x] `ModelHealth` maps a settled model turn to alarm ids `model:router`, `model:worker`, their `:fallback` twins, and `model:fallback-cap`.
- [x] `Router.#settled` and `WorkerExecutor.#onSettled` call `ModelHealth`. The two `notifyRouter` quota sentences that asked the Router to tell the user are deleted.
- [x] `BoardState.health` carries the registry to every client. `healthBanner` in `src/web/view.mjs` builds the banner.
- [x] `TelegramClient.tell` queues one message per key in the durable outbox. Keys are `health:raised:<id>:<since>` and `health:cleared:<id>:<since>`.
- [x] `config.json` `health.modelFailuresBeforeAlarm` (default 2) and `health.feedFailuresBeforeAlarm` (default 3), validated in `parseHealth`.

**You see.**

- [x] With the Router's model returning HTTP 500, the banner shows 幕僚长模型 with the error and advice after the second failed turn, and Telegram gets one message starting with `⚠️ 幕僚长模型出问题了`.
- [x] On recovery the banner turns green with 都恢复了 and Telegram gets one `✅ 幕僚长模型恢复了`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/health.test.ts` covers threshold, single notify per run, clear, recent cap, offline hint, classification and scrubbing. Run `node --import ./src/pi-runtime.mjs --test tests/health.test.ts`.
- [x] `tests/health-models.test.ts` covers Router 500, 401, recovery, Router 429 fallback, Worker 429 fallback, Worker streak, fallback cap and the config threshold. Run `node --import ./src/pi-runtime.mjs --test tests/health-models.test.ts`.
- [x] `tests/web.test.ts` covers `healthBanner`. `tests/config.test.ts` covers `parseHealth`. Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. Lanes 2 to 5 are steps of `tests/e2e/health.e2e.ts`.

- [x] Lane 1. Regression lane against trunk. Run the Router 500 scenario at trunk and head. Trunk lacks the feature, so record that trunk shows nothing and gate the banner plus the Telegram message at head. Save `1-router-500.png`. Pass when the head shows the banner and trunk shows none.
- [x] Lane 2. Router model returns 500. Save `1-router-500.png`. Pass when the banner names 幕僚长模型, 500 and 怎么办 only after the second failed request, and one ⚠️ reaches the fake Bot API.
- [x] Lane 3. Model heals and the user speaks again. Save `2-recovered.png`. Pass when both pending replies arrive, the banner turns green, and one ✅ arrives with no second ⚠️.
- [x] Lane 4. Router model returns 401. Save `3-router-401.png`. Pass when the banner shows after one failed request with login or key advice, and the reply arrives after heal.
- [x] Lane 5. Router model returns 429. Save `4-router-429-fallback.png`. Pass when the fallback model answers and the banner names 主模型限流 and `psa-fake/fallback`.
- [ ] Lane 6. Worker model returns 500 twice on a real Worker subprocess. Save `6-worker-500.png`. Pass when the banner names 助手模型.
- [ ] Lane 7. Phone width 390 px with two alarms. Save `7-phone.png`. Pass when the banner fits without horizontal scroll and the composer is still reachable.
- [ ] Lane 8. Dark theme with an alarm. Save `8-dark.png`. Pass when the banner text reads against its background.
- [ ] Lane 9. Restart with an alarm standing. Save `9-restart.png`. Pass when the banner is gone after restart and comes back on the next failed turn, with one new ⚠️.
- [ ] Lane 10. One real-model sanity run on `openai-codex/*`. Save `10-real.png`. Pass when a real Router turn succeeds and `health.active` is empty. The run passed, read from the page's event stream, but no screenshot was saved.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Size of one board frame and the time `Health.board()` adds to it.
- [x] Probe. Build a board with ten active alarms and ten recent ones and time `board()` over 10,000 calls at head. Trunk has no registry, so the diff-added work gets an absolute budget.
- [x] Baseline. Trunk adds zero bytes and zero time.
- [x] Rule. Fail when ten alarms add more than 8 KB to a frame or `board()` takes more than 50 microseconds per call. Measured 5.1 KB for 11 active alarms with 200-character errors plus 10 recent, and about 1.1 microseconds per `board()`.

**Review gate.** The operator reviews before merge.

- [x] Copy lane 2 to 5 screenshots into the PR description.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `<media path>/H1-review.mp4`. Skipped, the screenshots stand in.
- [x] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands H1.

## Show feed failures in the same registry (H2)

**Depends on.** H1.

**Files.**

- [x] Edit `src/host/host.ts` and `src/host/health.ts`.
- [x] Create `docs/adr/0025-the-host-says-what-is-broken.md`. Edit `docs/adr/0020-a-private-feed-releases-the-fields-it-names.md`, `docs/modules/architecture/design.md`, `docs/modules/stock-ta.md`, `docs/health/README.md`.
- [x] Edit `tests/feed-line.test.ts`, `tests/health.test.ts`, `tests/fixtures/modules/private-line/feeds/inbox/index.ts`. Extend `tests/e2e/health.e2e.ts`.

**Build.**

- [x] `Host.#feedHealth` reports each beat to `Health` as `data:<source>`. A failed beat counts toward `feedFailuresBeforeAlarm`, an auth error raises at once, and a clean beat clears.
- [x] The feed's own `problem` raises `data:<source>` at once with the feed's text and clears when a beat reports none.
- [x] `Host.#feedProblem`, `#feedProblems` and the notice host line they posted are deleted.
- [x] `Health.forget` drops the alarms of feeds that stopped serving when a module switches off, with no ✅.
- [x] `Health.board().offline` from H1 becomes reachable, because a data alarm can now exist.

**You see.**

- [x] With the probe feed's provider answering 503, the banner names 行情探针 报价 after three failed beats and Telegram gets one ⚠️. No 通知 line appears in the conversation.
- [x] With the model and the provider both refusing connections, the banner says 本机可能断网了.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `tests/feed-line.test.ts` covers the feed problem as an alarm with no notice line, the failure streak against a configured threshold, the immediate auth raise, and the switched-off module. `tests/health.test.ts` covers `forget` and the recent list keeping one entry per id. Run `just test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe. Lanes 2 to 5 are steps of the second test in `tests/e2e/health.e2e.ts`, with a probe module whose feed polls a fake provider every two seconds.

- [x] Lane 1. Regression lane against trunk. Trunk's scheduler only writes a log line for a throwing feed (`src/modules/scheduler.ts`), so trunk shows nothing, read from the code and not run. Gate the banner plus the Telegram message at head. Save `5-feed-503.png`. Pass when head shows the alarm.
- [x] Lane 2. The provider returns HTTP 503. Save `5-feed-503.png`. Pass when the banner names the feed with 连着 3 次 and one ⚠️ arrives.
- [x] Lane 3. The provider heals. Save `6-feed-recovered.png`. Pass when one ✅ arrives and the banner turns green.
- [x] Lane 4. The provider returns 401. Save `7-feed-401.png`. Pass when the banner shows 连着 1 次 with key advice.
- [x] Lane 5. The model and the provider both refuse connections. The provider's port is really closed; the model's refusal is simulated by its error text. Save `8-offline.png`. Pass when the banner says 本机可能断网了 and turns green after both heal.
- [ ] Lane 6. The feed reports its own problem, such as stock-ta's no-key. Save `9-feed-problem.png`. Pass when the banner shows the feed's text and the conversation has no 通知 line. Covered by `tests/feed-line.test.ts` through a real host, not in the browser.
- [ ] Lane 7. Gmail token refresh fails with invalid_grant. Save `10-gmail.png`. Pass when the banner shows the mail feed's auth text. The mail feed reports this as a `problem`, so lane 6's path covers it; not driven live.
- [ ] Lane 8. Phone width 390 px with three alarms. Save `11-phone.png`. Pass when the page does not scroll sideways.
- [ ] Lane 9. A module switched off while its feed alarm stands. Save `12-switched-off.png`. Pass when the alarm is gone with no ✅. Covered by `tests/feed-line.test.ts`, not in the browser.
- [ ] Lane 10. One real-model sanity run on `openai-codex/*`. Save `10-real.png`. Pass when a real Router turn succeeds and `health.active` is empty. The run passed, read from the page's event stream, but no screenshot was saved.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time one feed beat spends in `Health.failed` or `Health.ok`.
- [x] Probe. Time alternating `failed` and `ok` over 10,000 calls at head. Trunk has no registry, so the diff-added work gets an absolute budget.
- [x] Baseline. Trunk adds zero.
- [x] Rule. Fail when one call takes more than 20 microseconds. Measured about 0.6 microseconds.

**Review gate.** The operator reviews before merge.

- [x] Copy lane 2 to 5 screenshots into the PR description.
- [ ] Record a 30 to 60 second video of the change on a lane VM. Save it as `<media path>/H2-review.mp4`. Skipped, the screenshots stand in.
- [x] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands H2 after H1.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

No prototype ran. The one empirical fork was whether the fake model's HTTP errors reach the Router as settled error turns through Pi's openai-completions client. Lanes 2 to 5 of H1 answer it on `psa/health-models`.

## Appendix B. Alternatives rejected

| Approach | Why it lost |
| --- | --- |
| Post each alarm as a conversation host line of kind notice, the path #131 used | The conversation fills with repeats, the line scrolls away before the fix, and a standing problem has no single place to look. The kernel also describes notice as the user's own one-way note. |
| Persist alarms in `state.db` | A restart re-tests every model and feed within minutes, and an alarm that survives a restart could outlive its cause. In memory, a standing problem comes back on its next failure. |
| Count failures inside the scheduler | The scheduler would need a second channel to the host. The host's run wrapper already sees every beat's result and the feed's problem, so the streak lives in `Health` with the model streaks. |
| Count failed on-demand module tool calls, such as stock-ta's quote, toward the feed's alarm | The user asked the question and reads the failure in the answer. The quotes feed polls the same provider every minute in market hours, so an outage shows there. A tool success would also have to clear a feed's alarm, which mixes two subjects. |
| Ask the Router to tell the user about a fallback switch, as before | A Router whose model is down cannot speak, and a Router on the fallback spends tokens on a sentence the host can write. |

## Appendix C. Risks

- H1. The classifier is a regex over provider error text. A provider that words 401 differently is counted as a provider error and raises after the streak instead of at once. The owner watches `cause` on real errors.
- H1. Pi's retry runs inside a turn, so one failed turn already means `retryAttempts` failed requests. With the default 3 and the Router's 5 second first backoff, the alarm shows within about a minute of a hard outage.
- H1 and H2. Lanes run locally through the repo harness, not on cloud VMs, and not as a ten-lane swarm. Lanes 6 to 9 of H1 are unit-covered but not driven in the browser.
- H2. stock-ta's quotes feed returns a problem only after its own 5 failed rounds, so its alarm shows from the feed's text, not from the host's streak. Both paths are one alarm id, so they do not double up.

## Appendix D. Links and reading list

- `docs/health/README.md` for the user-facing rules.
- `src/host/health.ts` for the registry.
- `docs/modules/stock-ta.md`, the feed problem section, which H2 rewrites.
- `pstack/skills/architect/SKILL.md` shaped H1. `pstack/skills/interrogate/SKILL.md` was not run.

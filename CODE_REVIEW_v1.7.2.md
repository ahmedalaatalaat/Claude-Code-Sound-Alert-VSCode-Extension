# Claude Code Sound Alerts v1.7.2: Fresh Code Review

**What I reviewed:** the current working tree, which has not been committed yet. HEAD is `10cba41`, plus your v1.7.2 changes to `extension.js` (1,829 lines), `package.json`, `README.md`, `CHANGELOG.md`, `REVIEW_FIXES.md`, `test/smoke.js`, `test/v171.js`, the new `test/v172.js`, and `Extension/claude-code-sound-alerts-1.7.2.vsix`.

**Checks run:**

| Check | Result |
|---|---|
| `node --check extension.js` | ✅ Pass |
| ESLint 9 (project config) | ✅ 0 problems |
| `npm test` | ❌ **Fails** (exit 1) at `test/v172.js:118`: `root media/*.wav duplicates would be packaged` (see R2) |
| VSIX 1.7.2: `extension.js` identical to source, version 1.7.2, no root WAVs | ✅ |
| Behaviour probes against the real `handleHookLocally()`, `stopCompletionState()` and `isSelfResumePrompt()` | 5 problems confirmed (see §4) |

---

## 1. Verdict

All of the N1–N13 items from the last review were acted on. N1–N4, N8 and N10–N11 are properly fixed, the decision logic is much stronger, and the new integration tests exercise the real `handleHookLocally` path.

Not everything is solved yet:

1. **High (agent teams only):** the new "idle teammate count" fallback can play **Finished while a teammate is still working**. That breaks the extension's main rule: never play a false Done.
2. **Medium:** `npm test` fails. The two duplicate WAVs are still in `media/`, even though the docs say they were removed.
3. **Medium:** on Windows, the silent `UserPromptSubmit` hook now goes through a **PowerShell relay**. That signal is the one that cancels a premature Finished, and a cold PowerShell start plus `Invoke-WebRequest` uses a large share of the 2.5 s grace window. This mostly affects you, since you're on Windows.
4. **Medium:** *any* same-session event after a Stop (for example `TeammateIdle` or a Notification) now silently suppresses a correct Finished.

In total: 1 High, 3 Medium, 6 Low. Several of the Low items are cheap.

---

## 2. Status of the v1.7.1 review findings

| ID | Finding | Status | Notes |
|---|---|---|---|
| N1 | Waiting-text false positives | ✅ **Fixed** | All 6 earlier false positives now give `finished`. The scan covers only the last 2 sentences, with user-wait exclusions and a negation guard. Leftovers: R5 (negation window too wide) and R6 (narrow coverage). |
| N2 | Transition mode broken by `UserPromptSubmit` | ✅ **Fixed for task notifications** | `backgroundChain` survives `<task-notification>` prompts. Leftover: R7 (other prompts that Claude Code injects itself). |
| N3 | Unknown status bypassed opt-outs | ✅ **Fixed** | The opt-out filters now run first (L640). |
| N4 | `/loop` played Done each iteration | ✅ **Fixed** | New `recurring` outcome and a silent-by-default `recurringCronIteration` alert. It never falls through to `stop`. |
| N5 | Teammate matching unverified | ⚠️ **Mitigation introduces a false Finished** | See **R1**. |
| N6 | Stop and UserPromptSubmit processed out of order | ✅ **Fixed for ordering** | Receive timestamps are stamped before routing, and `lastActivityAt` is checked when the timer fires. Side effect: **R4**. |
| N7 | Hook-error noise when no listener is running | ✅ **Implemented** | Side effect: **R3** (Windows latency on the key cancel signal) and R10. |
| N8 | Stale README | ✅ **Fixed** | |
| N9 | Event-id dedupe did nothing | ✅ **Fixed** | The id is assigned once and shared marker files dedupe across windows. Leftover: R8 (cost). |
| N10 | Non-object cron entries dropped | ✅ **Fixed** | They now block. |
| N11 | Migration and warning nits | ✅ **Fixed** | `true` → Auto, a one-time prompt for 1.7.1 Strict users, no warning in Legacy mode, and warnings remembered per version. |
| N12 | SessionEnd cancels Finished | ✔️ **Accepted as intentional** | Reasonable given "never a false Done". |
| N13 | Doc claims and duplicate media | ⚠️ **Docs fixed, repo not** | See **R2**. |

---

## 3. New and remaining issues

### HIGH

#### R1. The idle-teammate count fallback can play Finished while a teammate is working (agent teams)
- **Where:** `blockingTasks` L631-651 and `updateSessionState` L738, L747, L750-753.
- **Cause:**
  - `idleAgentNames` gains a name on `TeammateIdle`, but it is only cleared when a `SubagentStart` arrives with the same `agent_type`. Teammates that are messaged back to work don't fire `SubagentStart`.
  - The `idleAgentIds` delete on L738 only runs for events carrying `agent_id`. The only such events the extension receives are `Stop` from agent contexts, and those return early before any state update.
  - So once a teammate has been idle, it counts as idle **forever**. The count-only fallback (L650) then hides its "running" entry.
- **Probe:**
  ```
  TeammateIdle(researcher) → lead prompt "ask researcher to dig deeper" → lead Stop with
  [{type:'teammate',status:'running',description:'Goal: dig deeper'}]  →  finished  ✗ (teammate is working)
  ```
  After the 2.5 s grace the Done Fanfare plays while the teammate is still busy.
- **Fix:**
  1. Make the count-only fallback **opt-in** (for example `teammateIdleCountFallback: false`) and keep direct id/name matching on by default. The diagnostic hint you added ("only teammate entries are blocking…") already gives users an easy way out.
  2. If you keep it, at least store `idleAgentNames` as `Map<name, receivedAt>` and count an idle report only when it arrived **after** the lead's latest `UserPromptSubmit` (`receivedAt > state.lastTurnStartedAt`). A teammate re-tasked during the turn then stays blocking.
  3. Capture one real lead `Stop` + `TeammateIdle` pair and add it as a fixture. The `v172.js` case is synthetic, and the test only covers a teammate that was never re-tasked.

### MEDIUM

#### R2. `npm test` fails: duplicate WAVs are still in the repo
- `media/finished.wav` and `media/question.wav` still exist. They are byte-identical to the copies in `media/sounds/`, and `.vscodeignore` was not changed.
- `test/v172.js:118` correctly asserts they shouldn't exist, so the suite exits 1 and never prints "v1.7.2 … passed".
- `REVIEW_FIXES.md` says "the release source/VSIX keeps WAV assets only under `media/sounds/`". The VSIX is clean, but the source tree is not. Running `vsce package` from this folder would include the duplicates.
- **Fix:** delete the two root files, or add `media/*.wav` to `.vscodeignore` and change the test to check the packaged file list instead.

#### R3. On Windows, the key "cancel Finished" signal now goes through a slow PowerShell relay
- **Where:** `desiredHookGroups` L956-957 and `commandRelayHandler` L944-948.
- When the "Prompt Submitted" sound is Off (the default), `UserPromptSubmit` is installed as `powershell.exe -File relay.ps1 <url>`, which reads stdin and runs `Invoke-WebRequest`.
- This event is the main thing that cancels a premature Finished in the queued-notification race (#102617). Windows PowerShell 5.1 cold start plus the first `Invoke-WebRequest` typically takes several hundred ms. With antivirus scanning or a busy CPU (Claude spawning agents) it can exceed the 2.5 s grace, and then the timestamp check comes too late. `curl`/`sh` on macOS and Linux is fast; Windows is the weak spot, and that's your platform.
- **Fix (pick one):**
  - Use the `curl.exe` that ships with Windows 10 1803+ in exec form, so it always exits 0:
    ```js
    {type:'command',command:'cmd.exe',args:['/d','/s','/c',`curl.exe -s -m 3 -H "Content-Type: application/json" --data-binary @- "${url}" >nul 2>&1 & exit /b 0`],timeout:10,async:true}
    ```
    Fall back to PowerShell when `curl.exe` is missing. Also make `handlerUrl()` extract the URL with a regex, because it currently returns the whole `/c` string.
  - Or keep `UserPromptSubmit` on direct HTTP whenever `stop` is enabled, and accept the hook-error notice when VS Code is closed.
  - Either way, log the gap between a Finished candidate and its cancelling `UserPromptSubmit`, so the grace window can be tuned from real data.

#### R4. Any same-session event after a Stop now suppresses Finished
- **Where:** `updateSessionState` L736 bumps `lastActivityAt` for **every** event. `deferFinished` L805 suppresses Finished when `lastActivityAt > stopReceivedAt`.
- **Probe:**
  ```
  Stop[] (final) → TeammateIdle 10 ms later           → Finished played? false  ✗
  Stop[] (final) → Notification auth_success 10 ms later → Finished played? false  ✗
  ```
  In agent-team sessions, teammates commonly go idle right after the lead finishes, so the real Done gets lost. Any Notification hook you install has the same effect.
- **Fix:** only bump `lastActivityAt` for real continuation events, using the same list as `continuationCancelsFinished()`:
  ```js
  if (continuationCancelsFinished(body)) state.lastActivityAt = Math.max(Number(state.lastActivityAt)||0, receivedAt);
  ```
  Add the two probe cases above as tests.

### LOW

| # | Finding | Location | Suggestion |
|---|---|---|---|
| R5 | The negation guard looks back 32 characters **across clause boundaries**, so "**Not** done yet: the test suite is still running." is negated and gives `finished`. Other phrasings are caught by another pattern by luck. | `waitingMatchNegated` L687-690 | Only look within the current clause, after the last `.;:—,`, and only 1–3 words back: `/\b(?:no longer\|nothing(?:\s+(?:is\|was))?\|not\|isn['’]t\|aren['’]t)\s+(?:\w+\s+){0,2}$/i`. |
| R6 | Coverage of untracked waiting is now narrow. Probe misses: "Waiting on the CI pipeline to finish…", "…running in the background via nohup; results … in ~15 minutes", "I'll check back once it completes." All three give `finished`. | `WAITING_TEXT_PATTERNS` L128-132 | This is a deliberate trade-off. Consider adding `waiting (?:on\|for) the (?:ci\|pipeline\|build\|run\|suite\|tests?\|deploy)` and `I'll check back` to the patterns, with matching negative tests. Document in the README that only explicit phrases are caught. |
| R7 | Only `<task-notification` counts as a self-resume. Teammate messages (`<teammate-message …>`) and prompts fired by scheduled wake-ups or crons reset `backgroundChain`, so the Background sound replays in those flows. | `isSelfResumePrompt` L728-732 | Treat any prompt starting with a known system tag (`<task-notification`, `<teammate-message`, scheduled-task markers) as a self-resume. Log unknown leading tags. |
| R8 | The shared dedupe does **synchronous** filesystem work (`mkdirSync`, `openSync`/`writeFileSync`, and a periodic `readdirSync`+`statSync`) on the extension host for **every** hook event, including local events that were never forwarded. With the Everything preset that means many writes per minute. | `markRoutedEventSeen` L286-289, `markSharedRoutedEvent` L281-285 | Only write markers for events that had a forward attempt (the router before fallback, and receivers of `X-Claude-Sound-Alerts-Routed`), and use async `fs.promises`. |
| R9 | The primary grid now has 5 columns, but each card's `.controlgrid` needs at least about 426 px (`150+160+92`+gaps). Between 850 px and 1220 px wide, the cards are about 200–230 px, so the sound, volume and repeat controls overflow. | CSS L1570, L1589, L1611 | Use `repeat(auto-fit,minmax(260px,1fr))` for `.primary-grid`, or stack `.controlgrid` inside primary cards. |
| R10 | The Windows PowerShell relay reads stdin with the console code page, and PS 5.1 `Invoke-WebRequest -Body <string>` sends Latin-1. Non-ASCII prompt text (Arabic, for example) reaches the listener as `?`. That's harmless today because only the `<task-notification` prefix is checked, but it applies to every relayed event. | `ensureRelayScript` L934 | Read stdin as UTF-8 (`[Console]::InputEncoding=[Text.Encoding]::UTF8`) and send bytes. The `curl.exe` relay in R3 avoids this entirely. |

---

## 4. Probe output (current working tree)

```
1  re-tasked teammate (was idle earlier) at lead Stop      -> finished          ✗ R1
2  TeammateIdle 10 ms after final Stop -> Finished played?  false               ✗ R4
2b auth_success Notification after Stop -> Finished played? false               ✗ R4
3  "Not done yet: the test suite is still running."         -> finished          ✗ R5
3  "No problem — the migration is still running and I will report…" -> background ✓
3  "Not all checks passed. The background job is still running." -> background   ✓
4  "Waiting on the CI pipeline to finish; …10 minutes"      -> finished          ~ R6
4  "…running in the background via nohup; results … ~15 minutes" -> finished    ~ R6
4  "I kicked off the deploy. I'll check back once it completes." -> finished      ~ R6
4  "The benchmark is still in progress."                    -> background        ✓
4  "Started the build in the background — will let you know when it finishes." -> background ✓
5  isSelfResume <task-notification>                         -> true              ✓
5  isSelfResume <teammate-message …>                        -> false             ~ R7
6  "All done. Waiting for your review."                     -> finished          ✓
npm test                                                    -> exit 1            ✗ R2
```

---

## 5. Tests to add

1. R1: an idle teammate that is re-tasked, then the lead's Stop. Expect `background`.
2. R4: Stop followed by `TeammateIdle` or an unrelated Notification. Expect Finished to play.
3. R5: "Not done yet: … still running" and "No longer waiting; the job is still running in the background" (one negated clause, one live clause).
4. R3: an assertion on the Windows relay command (for example `curl.exe` exec form), plus the URL extraction in `handlerUrl()`.
5. R7: `<teammate-message>` keeps the background chain.

---

## 6. Suggested order

1. **R2:** delete the two root WAVs so the test suite is green again (2 minutes).
2. **R4:** a one-line restriction on `lastActivityAt`.
3. **R1:** make the count fallback opt-in, or time-bound it.
4. **R3:** switch to the faster Windows relay, or keep `UserPromptSubmit` on HTTP.
5. R5–R10, plus the tests in §5.

Everything else re-checked on this pass is solid, and I found no regressions in it: routing and pinning, security token and Host check, the JSONC patcher, audio and Windows WinMM playback, migrations, the UI wiring, the recurring-loop outcome, status filtering, the agent-Stop guard, and the background chain for task notifications.

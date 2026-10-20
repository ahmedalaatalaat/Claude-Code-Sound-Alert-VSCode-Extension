# Claude Code Sound Alerts v1.7.0: Code Review

**Scope:** every file in the project folder: `extension.js` (1,663 lines), `package.json`, `README.md`, `CHANGELOG.md`, `REVIEW_FIXES.md`, `.vscodeignore`, `eslint.config.js`, `.vscode/launch.json`, `test/*.js`, and `media/`. I also compared commit `9bd22db` (v1.7.0) against `5ee2a90` (v1.6.3).
**Goal of the update:** play the **Finished** sound only when Claude is fully done. That means no Finished sound when Claude ends a turn while background work is still running ("…still running its background PostgreSQL runs and will report when they finish"), and no Finished sound each time one of several auto-launched agents completes. Agent completion gets its own optional sound.
**Verification done:** `node --check` passes. `npm test` passes: smoke, review2, review3 and v170. I also ran an extra behaviour probe against the real `classifyHook()`. Its output is in §5. ESLint was not run because `node_modules` is not installed.

---

## 1. Verdict

The design is sound. Using the Stop payload's `background_tasks` / `session_crons` arrays is the right signal: Claude Code added them in **v2.1.145** for this purpose. Keeping `SubagentStop` and `TaskCompleted` separate from main completion is also correct. Hook generation, the JSONC patcher, routing and audio code from v1.6.x were not regressed.

But the implementation trusts those two arrays more than Claude Code currently deserves. Known upstream bugs make the arrays wrong in both directions, and the extension has no defence against either:

| Direction | Effect for you | Cause |
|---|---|---|
| Arrays say **empty** while Claude is about to wake up again | **Finished plays too early.** This is your original complaint, and it still happens with 2+ background agents or tasks | anthropics/claude-code #102617 |
| Arrays are **never empty** (teammates, artifact watchers, dev servers, `/loop` crons, completed entries) | **Finished never plays for the rest of the session**, with no warning | #98816, #85955 and others; no status or type filtering in the extension |
| Arrays **missing** (Claude Code < 2.1.145, or only one of the two keys sent) | **Finished never plays at all** on default settings, with no warning | `strictCompletionVerification=true` combined with `stopUnverified` Off by default |

Severity counts below: **4 High, 6 Medium, 9 Low.**

---

## 2. Claude Code facts this review relies on

| Fact | Status |
|---|---|
| `Stop` and `SubagentStop` input include `background_tasks` and `session_crons` since **Claude Code v2.1.145**. The official hooks page still does not document their shape. | Confirmed (docs issue #60692) |
| Observed entry shape: `{id, type, status, description, command?, agent_type?, server?, tool?, name?}`. Seen `type` values: `shell` (Monitor also reports as `shell`), `subagent`, `teammate`, `monitor`/`monitor_ws`, plus workflow, MCP and cron entries. | From captured payloads in #102765, #98816, tmux-orchestra PR #12, claude-quest PR #124 |
| When a background task finishes, Claude Code starts a **new turn on its own**. That turn fires `UserPromptSubmit` (the prompt is `<task-notification>…`) and ends with **another `Stop`**. | Confirmed (hooks guide: UserPromptSubmit "also fires on turns Claude Code starts on its own"; payload logs in #102617) |
| The Stop payload builder keeps only `running`/`pending` tasks. A task that finished during the current turn, whose notification is **queued but not yet delivered**, is not listed, so the array is `[]` although another turn starts about 2 ms after the Stop hooks return. | Open bug **#102617** (v2.1.301; original incident in the VS Code integrated terminal with two background agents) |
| Ambient tasks such as the artifact `monitor_ws` live-update watcher stay `running` in `background_tasks` for the life of the watcher. Agent-team **teammates** stay listed while idle. #85955 was closed as "not planned". | Open bug **#98816**; #85955 |
| A background subagent that waits on its own background shell drops out of the list, and only an unattributed `shell` entry remains. | Open bug #102765 (harmless for this extension, because every entry is counted) |
| `Stop` does not fire on user interrupts. API errors fire `StopFailure` instead. | Confirmed (hooks guide) |
| Notification types `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_*`, `agent_needs_input`, `agent_completed` and `quota_auto_resume_*` all exist. `agent_completed` fires **only while agent view is open**. `quota_*` needs ≥ v2.1.234. | Confirmed (hooks guide / reference matcher table) |
| `SessionStart` supports only `command`/`mcp_tool` handlers, and `Setup` only `command`. `Setup` fires only with `--init-only`, or `-p --init`/`--maintenance`. | Confirmed. The extension handles this correctly. |
| `PreModelSwitch`/`PostModelSwitch` receive `from_model`/`to_model`. | Confirmed |
| Hooks in `~/.claude/settings.json` are shared by the CLI and the VS Code extension. | Confirmed (VS Code docs) |
| Whether `Stop` can fire with `agent_id` set (inside an in-process teammate) | **Unverified.** The common-fields doc says `agent_id` identifies "the subagent or in-process teammate the hook fires in". |

---

## 3. Findings

### HIGH

#### H1. Finished still plays mid-chain with several background agents or tasks (upstream #102617, no mitigation)
- **Where:** `stopCompletionState()` L551-560, `candidateProfiles()` L653-659, `routeIncomingHook()` L249/L256 (plays immediately).
- **Scenario (your exact case):** Claude launches agents A and B in the background and ends its turn. That Stop has 2 tasks, so the Background sound plays, which is correct. A finishes and Claude wakes up and says "A finished; still waiting on B". B finished during that turn, so its notification is queued and it is no longer `running`. The Stop payload therefore has `background_tasks: []`, and **Done Fanfare plays**. Seconds later B's turn ends and **Done Fanfare plays again**.
- **Why tests miss it:** `test/v170.js` only feeds hand-made payloads. Nothing models the queued-notification window.
- **Fix (recommended):** add a short **grace window** before playing Finished, and cancel it if the same session shows any sign of continuing.
  ```js
  const pendingFinished = new Map(); // session_id -> timeout
  function deferFinished(body, result) {
    const key = sessionKey(body) || '_nosession';
    clearTimeout(pendingFinished.get(key));
    const ms = Math.round(clamp(cfg().get('finishedGraceMs', 2000), 0, 15000));
    pendingFinished.set(key, setTimeout(() => {
      pendingFinished.delete(key);
      void playProfile(result.id, result.reason);
    }, ms));
  }
  function cancelDeferredFinished(body, why) {
    const key = sessionKey(body); const t = key && pendingFinished.get(key);
    if (t) { clearTimeout(t); pendingFinished.delete(key); log(`Finished cancelled (${why}); session continued.`); }
  }
  // In the local hook handler (see L1 for unifying the two copies):
  //   UserPromptSubmit / PreToolUse / SubagentStart / Stop(non-finished) -> cancelDeferredFinished(body, event)
  //   result.id === 'stop' -> deferFinished(body, result) instead of playProfile(...)
  ```
  For the cancel to work, **always install a `UserPromptSubmit` hook whenever `stop` is enabled**, even when the "Prompt Submitted" sound is Off. The classifier already returns `null` for disabled profiles, so this adds no sound. In #102617 the wake-up `UserPromptSubmit` arrived about 75 ms after the Stop, so 1.5–2 s is plenty. A side effect is that a prompt you type within the grace window also cancels Finished, which is acceptable because you are already at the keyboard.

#### H2. Finished can never play while any "permanent" entry is in `background_tasks`
- **Where:** `stopCompletionState()` L552-556 counts **every** truthy entry and ignores `status` and `type`.
- **Probe results** (all should be Finished, or at least configurable):
  ```
  completed-only task      -> backgroundPending
  teammate idle entry      -> backgroundPending
  ambient monitor watcher  -> backgroundPending
  ```
- **Real-world triggers:**
  - (a) Agent-team **teammates** stay `running` while idle (#85955, closed not planned).
  - (b) The artifact `monitor_ws` live-update watcher stays `running` for the whole session after one artifact publish (#98816).
  - (c) A dev server, `npm run watch` or `tail -f` started with `run_in_background`.
  - (d) Terminal-status entries (`completed`/`failed`/`killed`), which other integrations have seen linger.
  - (e) Recurring `session_crons` (`/loop`, recurring CronCreate) keep the session in "background" forever, and the Background sound plays on every loop iteration (see M3).
- **Impact:** your primary alert goes silent for the rest of the session, and the log only says `Stop classified as BACKGROUND`.
- **Fix:**
  ```js
  const PENDING_STATUSES = new Set(['running', 'pending']);
  function blockingTasks(list) {
    const ignored = new Set((cfg().get('ignoredBackgroundTaskTypes', ['teammate', 'monitor_ws']) || []).map(String));
    return (Array.isArray(list) ? list : []).filter(t => {
      if (!t || typeof t !== 'object') return false;
      if (t.ambient === true || t.skip_transcript === true || t.skipTranscript === true) return false;
      if (t.status != null && !PENDING_STATUSES.has(String(t.status).toLowerCase())) return false;
      return !ignored.has(String(t.type || ''));
    });
  }
  ```
  - Make `ignoredBackgroundTaskTypes` a user setting with UI.
  - Add a "Recurring scheduled tasks count as pending" toggle that is Off by default, applied when a cron entry exposes `recurring: true`. The cron entry shape is not documented, so log unknown shapes.
  - Optionally add a "long-running shells" escape hatch: ignore `shell` entries that have stayed `running` across more than N consecutive Stops.

#### H3. Default settings give **total silence** on Claude Code < 2.1.145, or when only one array is present
- **Where:** `stopCompletionState()` L555 requires **both** arrays. `candidateProfiles()` L657-658 returns only `stopUnverified`, which is `defaultEnabled:false` (L40).
- **Probe:**
  ```
  tasks only, no crons key -> stopUnverified   (Off by default → nothing plays)
  null background_tasks    -> stopUnverified
  ```
- **Impact:** after upgrading the extension, anyone on an older Claude Code (or a build that omits `session_crons` when empty) never hears Finished again. No notification or UI badge explains why. The README mentions it, but nobody reads the README after an auto-update.
- **Fix (any combination):**
  1. Treat `background_tasks` alone as verified: a missing `session_crons` counts as `[]`.
  2. Use an **auto** strict mode: once a session has sent the arrays, be strict for it; otherwise fall back to legacy `Stop = Finished` (best combined with the H4 text check).
  3. Show a **one-time warning** on the first unverified Stop, for example: "Your Claude Code version doesn't report background tasks; update to ≥ 2.1.145 or disable 'Verify final completion'." Also surface the last Stop classification in the control panel.
  4. Or make `stopUnverified` default **On**.

#### H4. Background work Claude does not track (`nohup … &`, external CI, remote jobs, "I'll check back") still plays Finished
- **Where:** design choice, documented in the README ("does **not** inspect phrases").
- **Scenario:** Claude starts a long job in an ordinary (foreground) Bash call with `&`/`nohup`/`Start-Process`, triggers a remote pipeline, or tells you to wait for a run "in about 15 minutes". `background_tasks` is `[]`, so Done Fanfare plays. Several of the messages you quoted read like this.
- **Fix:** add an **optional downgrade-only** check of `last_assistant_message` (documented field on Stop). It can only turn Finished into Background or Likely waiting, never the reverse, so it cannot cause a false Finished:
  ```js
  const WAITING_RE = /\b(still running|still in progress|will (report|notify|let you know)|when (it|they|the run) (finish|complete)s?|waiting (only )?(on|for)|in (about|roughly|~)\s*\d+\s*(sec|min|hour)|background (run|job|task|agent)s? (is|are) (still )?running)\b/i;
  if (state.kind === 'finished' && cfg().get('textHeuristicDowngrade', true)
      && WAITING_RE.test(String(body.last_assistant_message || '').slice(-1500))) {
    return ['backgroundPending']; // reason: "Claude says work is still running"
  }
  ```
  Log the match so users can see why the sound was downgraded.

### MEDIUM

#### M1. A `Stop` that fires inside a subagent or teammate context can play main Finished
- **Where:** `candidateProfiles()` L653 never looks at `body.agent_id` or `body.agent_type`.
- **Probe:** `Stop from teammate agent -> stop`.
- The docs say `agent_id` is present when a hook fires inside a subagent or in-process teammate. Whether `Stop` (rather than `SubagentStop`/`TeammateIdle`) can arrive with `agent_id` is unverified, but the guard is one line: if `event==='Stop' && body.agent_id`, classify it as `subagentStop` (or ignore it), never as `stop`. The same idea applies to `agent_type` when the session was launched with `--agent`. Compare against the root session type instead of only checking presence.

#### M2. `SubagentStop` overwrites the parent session's pending-work state
- **Where:** `updateSessionState()` L576-579 replaces `state.backgroundTasks`/`sessionCrons` with whatever the SubagentStop payload carries.
- **Probe:** finished Stop, then SubagentStop with one running shell, then `idle_prompt`. Result: `backgroundPending`. The idle reminder is wrongly remapped.
- **Fix:** store SubagentStop arrays separately (per `agent_id`) or ignore them. Only `Stop` should update session-level completion state.

#### M3. The Background sound repeats on every intermediate turn, and on every `/loop` tick
- **Where:** `candidateProfiles()` L655. Every Stop with pending work plays `backgroundPending`.
- With N background agents you hear about N Background sounds, one per wake-up turn. A recurring cron plays it every interval, indefinitely. On top of that, `idle_prompt` is remapped to `backgroundPending` (L662), so roughly 60 s after a Background sound you hear it a second time.
- **Fix:** play Background only on the **transition** into waiting (when `state.status` was not already `waiting_background` for the same task-id set), or make it configurable. For `idle_prompt` while background is pending, **suppress** instead of remapping.

#### M4. No v1.7 migration, so existing users don't get the new behaviour you designed
- **Where:** the `migrations` list L1626 is unchanged.
- **Problems:**
  1. The v1.4 migration wrote explicit settings for **every** event, so an upgrading user's `subagentStop.sound` is stored as `calm-complete`. The new "Agent Finished" sound (`finished`) only reaches fresh installs.
  2. Users on the old **Recommended** preset keep `subagentStop` enabled, so each agent still beeps. The panel now shows them as **Custom**.
  3. Strict verification turns on silently for upgraders (see H3).
- **Fix:** add `migrateV170Completion()`:
  - If `subagentStop.sound === 'calm-complete'` and the user never changed it (equal to the old default), set it to `finished`.
  - If the old enabled set equals old Recommended, apply new Recommended.
  - Log a one-time "What's new" toast.

#### M5. Session state depends on hooks that usually aren't installed
- **Where:** `updateSessionState()` handles `SessionStart`, `UserPromptSubmit` and `SubagentStart`, but `desiredHookGroups()` L821+ installs them **only if their own sound is enabled**, which is Off by default. So `activeAgents`, `promptId` and status `working`/`active` are almost never populated. `knownBackgroundPending()` also needs `Stop` installed, so with Finished, Background and Unverified all Off, `idle_prompt` suppression never works.
- The README overclaims ("retaining `prompt_id`, active agent IDs/types…").
- **Fix:** make internal state hooks independent of sound enablement. Install `UserPromptSubmit` and `Stop` with an internal "state" flag whenever any completion-related profile is on (this is also needed for H1), and remove the dead fields or wire them into decisions.

#### M6. Session state is per VS Code window
- **Where:** module-level `sessionStates` (L115) inside each window's extension host. The router (`rankedListenerRecords` L229) picks a window per event by `cwd`.
- A session that changes `cwd` (`CwdChanged`/`DirectoryAdded`), or a fallback route when the best window is busy or restarting, splits state across windows. The H1 grace-window cancel and the M3 transition logic then break, and `idle_prompt` suppression is already affected.
- **Fix:** make the **router** the single owner of session state and classification, and forward only "play profile X" to the chosen window. Alternatively, pin a session to the first window that handled it (`session_id → listenerId` map in the router).

### LOW

| # | Finding | Location | Suggestion |
|---|---|---|---|
| L1 | The local-handling logic is duplicated three times (router self, router fallback, routed request). Only the first two log the `Stop classified as …` diagnostic, so when Stop is **forwarded** to another window, that window's log has no classification line. | L249, L256, L720-723 | Extract `handleHookLocally(body)` and call it from all three places. Put H1/H4 logic there. |
| L2 | Debounce is keyed by profile only, so two different sessions finishing within 650 ms give one sound. | `shouldPlay()` L678 | Key by `${id}:${session_id}` for `stop`/`backgroundPending`. |
| L3 | `forwardHook` has a 1 s timeout. A slow but alive target that processes the event after the timeout causes the router to try the next window, so the **same alert can play twice** (pre-existing). | L237-243 | Respond 204 to the router *before* classifying (already done), and treat a timeout as delivered when the socket was accepted; or include an event id and dedupe on the target. |
| L4 | `notificationAgentCompleted` says "reports a background session finished". Upstream it fires **only while agent view is open**, so it effectively never fires in the VS Code panel. | L56 | Correct the description. |
| L5 | The `Setup` event card is offered, but Setup fires only with `--init-only`/`-p --init|--maintenance`, never in the VS Code panel. Quota notifications need ≥ v2.1.234. | L42, L57-59 | Add "(CLI only)" / "(needs Claude Code ≥ 2.1.234)" to the descriptions. |
| L6 | `stopUnverified` and `backgroundPending` are virtual profiles of `Stop`. If a user enables **only** `stopUnverified`, the Stop hook is installed but Finished is silently impossible to hear (by design). The UI doesn't explain the Finished / Background / Unverified mutual exclusivity. | Panel | Add a small "One of these three plays per Stop" caption under Primary alerts and add Unverified to that section. |
| L7 | `media/finished.wav` and `media/question.wav` in the media root are byte-identical copies of `media/sounds/*` (MD5 verified) and are **not** excluded by `.vscodeignore`, so 73 KB of dead weight goes into the VSIX. `done-fanfare.wav` (792 KB) and `error-impact.wav` (496 KB) dominate package size. | `media/`, `.vscodeignore` | Delete the root copies or add them to `.vscodeignore`. Consider trimming or down-sampling the two large WAVs. |
| L8 | The README says Stop "includes `background_tasks` and `session_crons`" without a minimum version, and the official docs don't document them yet (#60692). | README "Completion semantics" | State "requires Claude Code ≥ 2.1.145" and link the known upstream bugs (#102617, #98816). |
| L9 | Version hygiene: `package.json` is 1.7.0 but `Extension/` only holds the 1.6.3 VSIX. `REVIEW_FIXES.md` mixes v1.6 and v1.7 notes. ESLint can't run until `npm i`. | repo | Build/package 1.7.0 and run `npm i && npm run lint` before release. |

---

## 4. Test-suite gaps (`test/v170.js`)

The suite only proves the happy-path mapping. It does not cover:

1. Status filtering (`completed`/`failed` entries) and type filtering (`teammate`, `monitor_ws`, `ambient`). **H2**
2. `background_tasks` present but `session_crons` missing, and `null` arrays. **H3**
3. Mid-chain race: Stop `[]` followed by `UserPromptSubmit` (`<task-notification>`) within 100 ms must **not** play Finished; Stop `[]` with no follow-up within the grace window **must** play. **H1** (use fake timers)
4. `Stop` carrying `agent_id`. **M1**
5. SubagentStop not mutating session-level pending state. **M2**
6. Background sound only on transition, and repeated recurring-cron Stops. **M3**
7. v1.7 migration from a v1.6 stored config. **M4**
8. `last_assistant_message` downgrade heuristic. **H4**
9. The routed path (forwarded request) producing the same classification and logs as the local path. **L1**

Also add a fixture file of **real captured payloads**. Use the extension's own log, or a `cat >> stop.jsonl` command hook, and test against those instead of hand-written shapes. `test/v170.js` currently invents a `session_crons` entry shape (`{id,schedule,recurring,prompt}`) that is not documented anywhere.

---

## 5. Probe output (current code, all completion profiles enabled, strict mode)

```
completed-only task      -> backgroundPending      ✗ should be stop
teammate idle entry      -> backgroundPending      ✗ should be stop (configurable)
ambient monitor watcher  -> backgroundPending      ✗ should be stop
tasks only, no crons key -> stopUnverified         ✗ should be stop (H3)
null background_tasks    -> stopUnverified         ~ acceptable
Stop from teammate agent -> stop                   ✗ should not be main Finished (M1)
mid-chain empty (#102617)-> stop                   ✗ plays early (H1)
idle after bg stop       -> backgroundPending      ~ duplicate sound (M3)
idle after finished+subagentStop -> backgroundPending ✗ (M2)
no session_id idle       -> notificationIdlePrompt ✓
```

---

## 6. What is good and should stay

- Using the payload arrays instead of guessing from timing is the right foundation. Stop classification is a terminal decision (`break` at L674), so it never falls through to Finished.
- `SubagentStop`, `TaskCompleted` and `agent_completed` are hard-separated from main completion.
- Virtual Stop and Notification profiles install the minimal underlying hooks with exact `notification_type` matchers (`desiredHookGroups` L835-846).
- Counting **every** entry (no type filter) protects you from #102765, where a subagent waiting on its own shell disappears and only the `shell` stays. Keep this property when adding the H2 filters: filter by *status* and an explicit ignore-list, never with a whitelist of `subagent` only.
- `SessionStart`/`Setup` correctly use command (exec-form, `args`, `async`) relays, and WorktreeCreate is correctly never hooked.
- All earlier hardening (token, Host check, JSONC patching, locks, audio timeouts) is intact, and all four test suites pass.

---

## 7. Suggested fix order

1. **H1** grace window plus always-installed `UserPromptSubmit`. This fixes your original complaint for multi-agent runs.
2. **H3** stop requiring both arrays, and add the one-time warning or auto mode.
3. **H2** status and type filtering, plus the recurring-cron option.
4. **M1** `agent_id` guard, and **M2** keep SubagentStop out of session state.
5. **H4** optional `last_assistant_message` downgrade.
6. **M4** v1.7 migration, and **M3** transition-only Background sound.
7. **L1** unify the local handler, then the remaining Low items and the tests in §4.

---

## Sources

- [Hooks reference – Claude Code Docs](https://code.claude.com/docs/en/hooks)
- [Hooks guide – Claude Code Docs](https://code.claude.com/docs/en/hooks-guide)
- [VS Code extension – Claude Code Docs](https://code.claude.com/docs/en/vs-code)
- [#60692 – Stop/SubagentStop docs omit `background_tasks` and `session_crons` (added in v2.1.145)](https://github.com/anthropics/claude-code/issues/60692)
- [#102617 – Stop `background_tasks` empty while a finished task's notification is queued](https://github.com/anthropics/claude-code/issues/102617)
- [#98816 – `background_tasks` includes ambient tasks (artifact monitor watchers)](https://github.com/anthropics/claude-code/issues/98816)
- [#102765 – subagent waiting on its own background shell drops out of `background_tasks`](https://github.com/anthropics/claude-code/issues/102765)
- [raine/workmux #301 – example Stop payload and status semantics](https://github.com/raine/workmux/issues/301)
- [warpdotdev/claude-code-warp PR #92 – reporting pending background work on Stop](https://github.com/warpdotdev/claude-code-warp/pull/92)
- [asaf-erlich/tmux-orchestra PR #12 – teammates stay listed as running](https://github.com/asaf-erlich/tmux-orchestra/pull/12)
- [TOA5TER/claude-quest PR #124 – Monitor reports as type `shell`](https://github.com/TOA5TER/claude-quest/pull/124)

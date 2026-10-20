# Claude Code Sound Alerts v1.7.3

A VS Code extension that plays configurable sound alerts for Claude Code lifecycle events.

Version 1.7.3 is a correctness and Windows-latency pass over the v1.7 background-aware completion engine. It keeps the core rule strict: **Done Fanfare must not claim that Claude is finished while known work is still active.** The release removes the unsafe default teammate-count inference, narrows which events can cancel a valid Finished candidate, makes the Windows silent-state relay prefer `curl.exe`, expands safe self-resume recognition, and removes synchronous filesystem work from ordinary local hook handling.

## Defaults

On a fresh install only two alerts are enabled:

- **Ask User Question** — Question Chime
- **Main Work Finished** — Done Fanfare, only after completion classification and the grace window

**Background Work / Waiting**, **Recurring Loop Iteration**, **Completion Unverified**, and individual **Agent Finished** alerts all start **Off**.

## What v1.7.3 changes

- **Teammate completion is conservative again.** The uncertain count-only `TeammateIdle` fallback is now **Off by default**. Direct id/name idle evidence is still used, but idle evidence is invalidated whenever a new lead turn starts because that turn may re-task a teammate without a new `SubagentStart`. An advanced opt-in setting can restore count-only matching for users who prefer fewer false negatives.
- **Valid Finished candidates survive unrelated events.** `TeammateIdle`, `auth_success`, and other non-continuation notifications no longer update the timestamp used to suppress Finished. Only events that can actually continue work cancel/defer completion.
- **Windows self-resume cancellation is faster.** Silent state hooks use a lightweight `cmd.exe` relay that prefers Windows' built-in `curl.exe`; PowerShell remains a UTF-8 fallback. The log records the receive-time gap when a self-resume cancels a Finished candidate so the grace period can be tuned from real data.
- **Waiting-language matching is clause-aware.** Negation is checked only in the current clause, so `Not done yet: the test suite is still running` remains Background while `nothing is still running` stays Finished. Additional high-confidence patterns cover CI/build waits, `nohup` background work, and “I'll check back once it completes.”
- **More machine-generated turns preserve the same background chain.** `<teammate-message>`, `<agent-message>`, cross-session messages, wake-up markers, and supported `source`/`origin` values are treated as self-resumes instead of new user work.
- **Cross-window dedupe no longer performs synchronous disk I/O for every local hook.** Shared marker files are written asynchronously only for actually forwarded events; ordinary local events stay in memory.
- **Responsive Primary Alerts UI.** Primary cards use auto-fit layout and their controls wrap instead of overflowing in mid-width VS Code panels.
- **Packaging hygiene is enforced twice.** The source tree contains no root `media/*.wav` copies and `.vscodeignore` also excludes accidental root WAVs if they reappear.
- Added the v1.7.3 regression suite covering re-tasked teammates, unrelated post-Stop events, clause-scoped negation, additional waiting phrases, teammate/system self-resumes, Windows relay URL extraction/UTF-8 behavior, responsive layout, and packaging hygiene.

## Completion safety notes

- Claude does not currently expose a universally reliable correlation key between every `background_tasks[type=teammate]` entry and every `TeammateIdle` event. v1.7.3 therefore prefers a possible **missed Done sound** over a false Done sound when teammate identity is uncertain. The experimental count fallback is available but disabled by default.
- Waiting-language detection is intentionally **downgrade-only** and conservative. It catches explicit high-confidence phrases; it is not intended to infer every possible external/remote job description. Structured Claude task state remains the primary signal.
- `SessionEnd` still cancels a pending Finished candidate. Closing/clearing a session is not proof that background work completed, so playing Done on SessionEnd would violate the extension's main invariant.

## What v1.6.3 fixes

- First-run Windows playback now explicitly loads the freshly compiled WinMM helper DLL before calling `PlaySound`, preventing `Unable to find type [ClaudeSoundNative]`.

- Windows audio-host cache locks now self-heal after an interrupted compile; stale lockfiles older than 30 seconds are removed automatically.
- Every external audio process has a bounded timeout, preventing a hung player from permanently blocking all later alerts. The timeout budget accounts for the WAV duration, repeats, and repeat gaps.
- JSONC hook patching preserves CRLF files without introducing mixed LF-only lines.
- Hook uninstall no longer leaves whitespace-only residue where the removed `hooks` member used to be.
- The third-review test suite now hard-asserts CRLF fidelity and clean removal, covers all removal layouts and round trips, verifies the 2-second HTTP hook timeout, validates stale-lock recovery logic, and exercises a real hung-child timeout.
- Relay-script production path resolution no longer contains a test-environment storage fallback.

## What v1.6.1 fixes

- Fixed JSONC hook patching so comments/trivia after the `hooks` value are preserved, comma placement stays clean, uninstall removes an empty top-level `hooks` key, and repeated patching is byte-for-byte idempotent.
- Fresh installs no longer trigger the older v1.3.1/v1.3.2 sound migrations before the v1.4 default guard; package defaults are now used without writing a large `eventSettings` object.
- Windows audio caches the tiny host-specific WinMM P/Invoke assembly in extension global storage and plays all repeats inside one PowerShell process, avoiding repeated C# compilation/process startup.
- Hook-status listener probes are cached briefly and skipped entirely when the target is this window's active listener.
- HTTP hook timeout is now 2 seconds; malformed local hook bodies are logged and acknowledged with 204 so alert parsing never creates a Claude hook-error notice.
- Imported-sound previews use the same bounded playback queue as live alerts.
- Added explicit listener `clientError` handling and stronger second-review regression tests covering 31 JSONC layouts.
- Fixed the ESLint 9 catch-parameter configuration, removed dead code, and log listener takeover bind failures.

## What v1.6 fixed

- Commands and the status bar are registered before migrations, so a migration/settings failure cannot make the extension disappear.
- Event settings are application-scoped; listener ports are machine-scoped.
- Claude hooks are installed **only for enabled alerts**. Enabling/disabling an alert automatically reconciles the managed hooks.
- Hook status detects stale URLs, stale tokens, wrong matchers/handler shapes, duplicate/extra managed hooks, and unreadable Claude settings.
- Multi-window listener failover no longer tears down a healthy listener before a replacement port is bound.
- Listener shutdown closes keep-alive connections and removes its registry entry synchronously during deactivation.
- Local HTTP endpoints now use a per-install secret token, validate the `Host` header, cap request bodies, and do not expose workspace paths from the health endpoint.
- `~/.claude/settings.json` updates use a lockfile, re-read inside the lock, accept JSONC comments/trailing commas, and patch only the top-level `hooks` property so unrelated comments/order/formatting are preserved.
- Windows audio uses the native WinMM `PlaySound` API instead of `System.Media.SoundPlayer`.
- PCM WAV validation accepts standard PCM and PCM `WAVE_FORMAT_EXTENSIBLE` files at 8/16/24/32-bit depth.
- Playback is serialized and capped to avoid overlapping PowerShell/audio processes under noisy presets.
- Missing sound files now produce actionable errors.
- Generated volume-cache WAVs are pruned automatically.
- The webview updates individual event cards instead of rebuilding the whole panel after every toggle.
- Listener heartbeats/router checks are less aggressive when idle.
- Relay scripts live in the extension's VS Code global storage and use Claude Code command-hook exec form with `args`; command relays are asynchronous with a 10-second timeout.
- The extension icon is the user-selected artwork, resized to 256×256 for a lightweight Retina-ready marketplace asset.

## Control panel

Click **Claude Alerts** in the VS Code status bar or run:

`Claude Sound Alerts: Open Control Panel`

Each event has independent:

- On / Off
- Sound
- Volume from **0–200%**
- Repeat count from **1–5×**
- Preview

The primary Stop outcomes — **Question**, **Background / Waiting**, **Recurring Loop Iteration**, **Completion Unverified**, and **Finished** — stay together at the top of the panel. Question and Finished are the only two enabled by default.

### Presets

- **Minimal** — Question + verified Finished only
- **Recommended** — Question + verified Finished + Background / Waiting + important permission/failure/task/MCP alerts + Background Agent Needs Input. Individual Agent Finished remains Off to avoid multi-agent sound storms
- **Everything** — every safe observable event
- **Custom** — shown when manual event choices do not match one of the presets

Applying a preset changes only event enablement. Existing sound, volume, and repeat selections are preserved.

## Supported Claude events

The UI represents the current Claude Code hook lifecycle, including:

- Ask User Question and Plan Approval (special `PreToolUse` cases)
- SessionStart
- Setup
- InstructionsLoaded
- UserPromptSubmit
- UserPromptExpansion
- MessageDisplay
- PreToolUse
- PermissionRequest
- PostToolUse
- PostToolUseFailure
- PostToolBatch
- PermissionDenied
- Notification subtypes (permission/idle/agent/quota) plus an optional catch-all Notification
- SubagentStart / SubagentStop (Agent Finished; never Main Work Finished)
- TaskCreated / TaskCompleted
- Stop / StopFailure with background-aware final-completion classification
- TeammateIdle
- ConfigChange
- CwdChanged / DirectoryAdded
- FileChanged
- WorktreeCreate (displayed but safety-protected)
- WorktreeRemove
- PreCompact / PostCompact
- PreModelSwitch / PostModelSwitch
- SessionEnd
- Elicitation / ElicitationResult

### WorktreeCreate safety protection

Claude Code treats a configured `WorktreeCreate` hook as a replacement for its normal worktree creation behavior and requires that hook to create and return a valid worktree path. Sound Alerts therefore displays the event but deliberately does not install a sound-only `WorktreeCreate` hook.

### FileChanged

Claude Code expects literal filenames for `FileChanged` matchers. Enter names such as:

`.env, package.json, pyproject.toml`

The managed hook configuration updates automatically when this list changes while FileChanged is enabled.

## Install / upgrade

1. Open **Extensions** in VS Code.
2. Open the `...` menu and choose **Install from VSIX...**.
3. Select the `.vsix` file.
4. Reload all open VS Code windows if prompted.
5. Open **Claude Alerts** from the status bar.
6. If this is the first install, click **Install / Update Hooks**.

When upgrading from v1.5.x, v1.6 detects existing Sound Alerts hooks and automatically reconciles stale managed hooks after activation. If Claude settings are read-only or automatic repair fails, the control panel reports the error and you can use **Install / Update Hooks** manually.

If an older release stored `claudeSoundAlerts.eventSettings` in workspace/folder settings, VS Code may now mark those old entries as invalid because event settings are application-scoped. Remove the obsolete workspace copy; the application-level settings shown in the Claude Alerts panel are authoritative.

The extension preserves unrelated Claude hook handlers.

## Completion semantics

Claude Code 2.1.145+ can provide `background_tasks` and `session_crons` on `Stop` / `SubagentStop`. Their exact entry shapes have changed across releases and upstream issues, so Sound Alerts treats known fields when present but keeps unknown task/cron shapes conservative rather than assuming they are safe to ignore.

For each main-agent `Stop`, exactly one completion state is selected:

- blocking running/pending/unknown tasks or a one-shot scheduled wakeup → **Background Work / Waiting**
- only recurring scheduled work remains → **Recurring Loop Iteration** (silent by default)
- no blocking work, but registry data cannot be trusted under the selected verification mode → **Completion Unverified**
- no blocking work and no downgrade signal → **Main Work Finished candidate**, delayed by the grace window before the Done Fanfare plays

The default **Auto** verification mode uses compatibility behavior until a session proves that it supplies authoritative registry data; after that, missing registry fields are treated as Unverified. **Strict** always requires registry evidence. **Legacy** allows Stop to become a Finished candidate without registry evidence.

Terminal background statuses (`completed`, `failed`, `killed`, `stopped`, `cancelled`, etc.) are ignored. Explicit opt-outs such as `ambient`, `skip_transcript`, configured ignored types, and known Artifact/live-update monitors are applied *before* unknown-status blocking. Unknown unignored status values remain blocking. `teammate` remains blocking by default because ignoring every teammate could reintroduce false Done sounds while a teammate is genuinely working.

Teammate lifecycle state is reconstructed from `SubagentStart` and `TeammateIdle`. Claude currently does not expose a reliable shared identifier between every teammate background-task entry and `TeammateIdle`; when ids/names do not match, Sound Alerts may safely ignore at most the number of teammates it has independently observed becoming idle. If the extension starts mid-session or misses lifecycle events, unmatched teammate entries remain blocking. The Last Stop diagnostic calls this out.

Recurring crons are **not** treated as Main Work Finished. With “Recurring crons count as pending” Off, they resolve to **Recurring Loop Iteration**, whose sound is Off by default. With the setting On, they resolve to Background / Waiting.

A Finished candidate is delayed by **Finished grace** (2,500 ms by default). Incoming hooks are timestamped before asynchronous multi-window routing; the candidate is suppressed if any newer same-session activity has already been received, even if that newer event is processed first. Claude-started task-notification turns also preserve the current background chain so transition-only Background alerts do not repeat once per worker.

The optional waiting-language heuristic is **downgrade-only** and deliberately narrow. It scans only the last two closing sentences and looks for high-confidence continuation wording such as “still running,” “waiting only on …,” or “I will report … once it finishes.” Negated phrases, user-directed waits such as “waiting for your confirmation,” and generic code-behavior descriptions do not match. Text can never promote a Stop to Finished. If Background / Waiting is disabled, a genuine text-only downgrade is intentionally silent rather than bypassing the user's disabled alert setting.

`Stop` events carrying `agent_id` are never treated as main completion. `SubagentStop`, `TaskCompleted`, and `agent_completed` notifications remain separate profiles. `agent_completed` is not used as the core VS Code completion signal.

Known Claude Code upstream issues can still affect the registry itself. The grace/order logic mitigates queued background-task wakeups, task filters mitigate stale ambient entries, and teammate reconstruction mitigates permanently listed idle teammates. Use **Open Log** and the **Last Stop** diagnostic in Advanced settings to see why a Stop was classified.

### Behavior when VS Code is closed

Claude hooks in `~/.claude/settings.json` also apply to terminal Claude sessions. v1.7.3 uses fail-silent asynchronous command relays for internal-only state hooks when their sounds are disabled; on Windows the relay prefers `curl.exe` and falls back to UTF-8 PowerShell, which reduces both hook-error noise and cancellation latency outside the VS Code panel. The core `Stop` hook remains direct HTTP because final-completion timing and audio delivery depend on the live extension listener; if Claude runs while no VS Code listener exists, that one managed HTTP hook can still report a non-blocking connection error.

### SessionEnd during the grace window

`SessionEnd` intentionally cancels a pending Finished candidate. Closing/clearing a session is not reliable proof that all background work completed, so the extension prefers a missed completion sound over a false Done Fanfare.

## Multi-window listener routing

Every VS Code window owns its own localhost listener. The default port range starts at `47391`; later windows select the next free port automatically.

Claude hooks point to one active router endpoint. The router forwards an incoming event to one healthy listener, preferring a VS Code workspace that contains Claude's current `cwd`. Once a `session_id` is seen, the router pins that session to the same listener while it remains healthy so completion state does not jump between windows when cwd changes.

If the router-owning window closes, another window can take over the configured router port. Takeover is guarded and binds the replacement listener before the previous listener is dropped.

The listener registry and command-relay scripts are stored in the extension's VS Code global storage rather than `~/.claude/`.

## Local listener security

The HTTP listener binds only to `127.0.0.1`. In addition, v1.6:

- generates a random per-install token and embeds it in hook/health paths;
- validates `Host` as `127.0.0.1:<port>` or `localhost:<port>`;
- rejects unknown paths;
- limits hook request bodies;
- keeps workspace paths out of the health response.

Claude event data is not intentionally transmitted to an external service.

## Sound library

The extension ships with:

- Question Chime
- Question Ping
- Done Fanfare
- Agent Finished
- Error Impact
- Soft Bell
- Bright Ping
- Double Ping
- Gentle Chime
- Digital Pop
- Warm Knock
- Success Chime
- Calm Complete
- Soft Pop
- Alert Pulse

Click **Add WAV to My Sounds...** to import your own WAV once and reuse it from every event dropdown.

Accepted custom audio is uncompressed PCM WAV, including PCM `WAVE_FORMAT_EXTENSIBLE`, at 8, 16, 24, or 32-bit depth. MP3/M4A/OGG files should be converted to PCM WAV before importing.

## Volume and repeat

- `0%` = silent
- `1–100%` = attenuation up to the source WAV level
- `101–200%` = digital boost
- Repeat = `1–5×`

Boost cannot bypass the operating system master volume and may clip/distort if the source is already loud.

## Audio requirements

- **Windows:** Windows PowerShell 5.1 or PowerShell 7 (`pwsh`) invokes the native WinMM `PlaySound` API. The tiny P/Invoke helper assembly is compiled once into extension global storage and reused; repeated alerts are played in one PowerShell process. The previous `System.Media.SoundPlayer` dependency is not used.
- **macOS:** uses the built-in `afplay` command.
- **Linux:** requires one of `paplay`, `ffplay`, or `aplay` to be available on `PATH`.

## Claude settings / JSONC

Hook installation updates `~/.claude/settings.json` under a short-lived lock. JSON and common JSONC syntax (comments and trailing commas) are accepted. The extension patches only the top-level `hooks` value, preserving unrelated comments, key ordering, and formatting. Formatting/comments *inside the managed hooks value itself* may be normalized when hooks are changed.

## Workspace Trust and virtual workspaces

The extension does not execute workspace code and its routing/security settings cannot be overridden from repository workspace settings, so it remains available in Restricted Mode. Virtual workspaces are supported in a limited mode because workspace-affinity routing can only score local file-system folders.

## Development

The source package includes scripts for:

- `npm run check` — JavaScript syntax check
- `npm run lint` — ESLint
- `npm test` — the smoke suite, 31-shape JSONC suite, third-review suite, and v1.7.0/v1.7.1/v1.7.2/v1.7.3 completion/routing suites. Together they cover hook patch/install/uninstall idempotence, comment/CRLF preservation, background completion races, teammate safety, self-resume chains, recurring crons, waiting-text downgrades, Windows relay behavior, routed-event dedupe, audio-process timeouts, bundled WAV validation, gain processing, responsive control-panel invariants, and manifest/package hygiene

Development dependencies are declared for VS Code types and ESLint. The packaged VSIX excludes development/test files.

## Publishing note

This build is intended for private VSIX sideloading and still uses `publisher: "local"`. To publish it to the Visual Studio Marketplace, replace that value with your real Marketplace publisher ID and add your real repository/homepage/bugs URLs. Those values are intentionally not invented by this project.

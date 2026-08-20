# Claude Code Sound Alerts v1.6.1

A VS Code extension that plays configurable sound alerts for Claude Code lifecycle events.

Version 1.6.1 is a stability, security, and performance maintenance release on top of v1.6. It keeps the v1.5 multi-window design while hardening activation, hook installation, routing, audio playback, settings writes, and the control-panel state model.

## Defaults

On a fresh install only two alerts are enabled:

- **Ask User Question** — Question Chime
- **Claude Finished** — Done Fanfare

Every other alert starts **Off**. Use the **Minimal**, **Recommended**, or **Everything** presets, or enable individual events in the control panel.

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

The two primary alerts — **Question** and **Finished** — stay at the top of the panel.

### Presets

- **Minimal** — Question + Finished only
- **Recommended** — Question + Finished plus important permission, failure, subagent, task, and MCP-input alerts
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
- Notification
- SubagentStart / SubagentStop
- TaskCreated / TaskCompleted
- Stop / StopFailure
- TeammateIdle
- ConfigChange
- CwdChanged / DirectoryAdded
- FileChanged
- WorktreeCreate (displayed but safety-protected)
- WorktreeRemove
- PreCompact / PostCompact
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

## Multi-window listener routing

Every VS Code window owns its own localhost listener. The default port range starts at `47391`; later windows select the next free port automatically.

Claude hooks point to one active router endpoint. The router forwards an incoming event to one healthy listener, preferring a VS Code workspace that contains Claude's current `cwd`, so the same alert is not played by every open window.

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
- Done Fanfare
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
- `npm test` — smoke tests for JSONC hook patching, enabled-only hook generation, bundled WAV validation, gain processing, and manifest invariants

Development dependencies are declared for VS Code types and ESLint. The packaged VSIX excludes development/test files.

## Publishing note

This build is intended for private VSIX sideloading and still uses `publisher: "local"`. To publish it to the Visual Studio Marketplace, replace that value with your real Marketplace publisher ID and add your real repository/homepage/bugs URLs. Those values are intentionally not invented by this project.

# Changelog

## 1.6.1

- Fixed ESLint 9 catch-parameter configuration; removed the stale `isOurHandlerFor` helper and added diagnostics when listener takeover binding loses a race.
- Fixed JSONC value scanning so trailing comments/whitespace are not absorbed into the `hooks` replacement range.
- Made top-level hook patching idempotent across comments, trailing commas, CRLF, nested objects/arrays, and last-member layouts.
- Hook uninstall now removes the empty top-level `hooks` member instead of leaving `"hooks": {}`.
- Fixed fresh-install migration ordering: v1.3.1/v1.3.2 sound migrations now skip when no stored `eventSettings` exist, allowing package defaults to remain implicit.
- Improved Windows audio startup: cached host-specific WinMM P/Invoke assemblies in extension global storage and moved repeat playback into one PowerShell invocation.
- Added a short hook-target probe cache and bypassed probing when the target is the current active listener.
- Increased HTTP hook timeout from 1s to 2s.
- Malformed local hook bodies/URLs are now logged and acknowledged with 204 so they do not surface Claude hook-error notices.
- Imported sound previews now use the global bounded playback queue.
- Added explicit HTTP `clientError` handling.
- Replaced brittle source-text smoke assertions with behavior checks and added a 31-shape JSONC regression suite.
- Documented the application-scope migration note for users with obsolete workspace-level event settings.

## 1.6.0

- Hardened activation: commands/status register before migrations and each migration fails independently without aborting activation.
- Removed folder-scoped event-setting writes; event settings are application-scoped and listener ports are machine-scoped.
- Installed Claude hooks now reflect only enabled alerts instead of registering every lifecycle event.
- Added automatic, debounced managed-hook reconciliation when enabled-event shape, watched filenames, listener range, or global enablement changes.
- Hook status now detects stale ports/tokens, stale handler shapes, wrong matchers, duplicate/extra managed hooks, and Claude-settings read failures.
- Fixed router takeover races by binding a replacement listener before dropping the current listener and guarding takeover attempts.
- Disabled HTTP keep-alive for internal requests and force-closes idle/open listener connections during teardown.
- Deactivation now awaits server cleanup and synchronously removes the listener registry entry.
- Secured localhost endpoints with a per-install token, Host-header validation, request-size limits, and a workspace-path-free health response.
- Moved listener registry and relay scripts from `~/.claude/` to VS Code extension global storage.
- Added a settings lock and fresh re-read around `~/.claude/settings.json` mutations.
- Added JSONC comment/trailing-comma parsing and in-place top-level `hooks` patching so unrelated formatting/comments/order are preserved.
- Switched `SessionStart` / `Setup` relays to command exec-form (`command` + `args`) with `async: true` and a 10-second timeout.
- Replaced Windows `System.Media.SoundPlayer` with native WinMM `PlaySound` invoked through PowerShell.
- Added PCM `WAVE_FORMAT_EXTENSIBLE` support and explicit sound-file existence checks.
- Serialized audio playback with a bounded queue to prevent overlapping alert processes.
- Added automatic pruning of generated volume-cache WAVs.
- Sanitized/truncated arbitrary hook payload values before logs/toasts.
- URL routing now parses pathnames correctly even when a query string is present.
- Reduced idle registry/monitor filesystem activity.
- Fixed the control-panel state model so event changes update targeted cards instead of rebuilding the entire grid.
- Restricted webview local resources to `media/`, removed `retainContextWhenHidden`, and preserved view state with webview state APIs.
- Improved control accessibility by associating labels with selects/ranges and removing redundant checkbox ARIA state.
- Removed obsolete contributed v1.2 settings while keeping private migration compatibility.
- Reduced the supplied extension icon to 256×256 for Retina use and a smaller VSIX.
- Added smoke tests, ESLint configuration, VS Code type development dependency, package scripts, richer `.vscodeignore`, and workspace/virtual-workspace capability declarations.
- Fresh installs no longer write a 32-event default object into user settings merely to establish Question + Finished defaults.

## 1.5.1

- Fixed event switches whose **On / Off** text could remain stale after toggling.
- Event cards now update their enabled/disabled visual state immediately when the switch changes.
- Serialized control-panel setting writes to prevent rapid toggle changes from being saved out of order.
- The server-confirmed UI state still refreshes after every change, so the panel remains consistent with VS Code settings.

## 1.5.0

- Added true multi-listener mode: every VS Code window owns an independent localhost listener.
- If the starting port is busy, the extension automatically tries the next port in the configured range.
- Added a lightweight local listener registry so the active hook router forwards each event to one appropriate VS Code listener, preferring the listener whose workspace contains the hook `cwd`.
- Removed the single-port shared-owner limitation from v1.4.1.
- Added automatic listener heartbeat/cleanup and failover to another active listener if a target disappears.
- Updated the extension icon to the newly supplied notification image.
- Claude hooks keep fast HTTP delivery through an elected router listener; `SessionStart` and `Setup` continue to use the small compatibility command relay. Run Install / Update Hooks once after upgrading so the router URL is refreshed.

## 1.4.1

- Fixed multi-window listener status and ownership.
- Added a localhost health endpoint so VS Code windows can verify an existing Claude Sound Alerts listener.
- A second VS Code window now shows **Listener active — shared** instead of incorrectly showing **Listener inactive** when another window owns port 47391.
- Added automatic listener failover: if the owning VS Code window closes, another open window automatically attempts to take ownership.
- Added compatibility probing for an already-running v1.4.0 listener during upgrade/reload transitions.
- Improved listener status tooltips and diagnostics for ports occupied by unrelated applications.

## 1.4.0

- Redesigned the control panel for a cleaner, more compact VS Code-native layout.
- Moved **Question** and **Finished** into a dedicated Primary Alerts section at the top.
- Changed the default event enablement so only Question and Finished are on.
- Fixed Minimal, Recommended, and Everything preset application.
- Minimal now enables exactly Question + Finished.
- Recommended enables Question + Finished plus important permission, failure, subagent, task, and MCP-input alerts.
- Everything enables every safe supported event.
- Added active preset highlighting and a Custom state after manual event changes.
- Preserved per-event sound, volume, and repeat settings when applying presets.
- Added a one-time v1.4 migration to switch existing installs to the new two-alert default.

## 1.3.3

- Added the user-selected Claude Sound Alerts artwork as the official VS Code extension icon.
- The supplied PNG is packaged directly as `media/icon.png` and referenced by the extension manifest.

## 1.3.2

- Added the user-provided **Done Fanfare** as a built-in sound and made it the default for **Claude Finished**.
- Added the user-provided **Error Impact** as a built-in sound and made it the default for **Tool Failed**, **Permission Denied**, and **Claude API / Turn Error**.
- Converted both supplied MP3 files to 44.1 kHz, stereo, 16-bit PCM WAV for reliable Windows playback.
- Removed approximately 300 ms of silent lead-in from Error Impact for faster alerts.
- Preserved existing per-event enablement, volume, and repeat settings while applying the new sounds.

## 1.3.1

- Added the user-provided **Question Chime** as a built-in sound preset.
- Made Question Chime the default sound for **Ask User Question**.
- Converted the supplied MP3 to trimmed 44.1 kHz, stereo, 16-bit PCM WAV for reliable Windows playback.
- Preserved existing per-event volume and repeat settings during the sound migration.

## 1.3.0

- Added per-event UI for the full current Claude Code hook lifecycle.
- Added separate sound selection, 0–200% volume, and 1–5 repeats for each event.
- Added digital audio boost above 100% with PCM clipping protection.
- Added a persistent **My Sounds** library for user-imported WAV files.
- Added Minimal, Recommended, and Everything enablement presets.
- Added StopFailure, tool failure, permission denied, subagent, task, agent-team, context, session, configuration, directory, worktree removal, MCP, and other lifecycle alerts.
- Added command-relay hooks for SessionStart and Setup, which do not support HTTP hooks.
- Added configurable literal filenames for FileChanged.
- Added WorktreeCreate safety protection so sound alerts cannot replace or break Claude Code's normal worktree creation.
- Preserved migration from v1.2 Question/Finished settings.

## 1.2.0

- Added VS Code control panel.
- Added 10 built-in sounds.
- Added independent Question and Finished volume controls.
- Switched Windows WAV playback to System.Media.SoundPlayer.

## 1.1.0

- Added separate Question and Finished volumes and sound selection.

## 1.0.0

- Initial release.

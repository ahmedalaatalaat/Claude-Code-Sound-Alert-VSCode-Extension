# Claude Code Sound Alerts v1.5.1

A VS Code extension that plays configurable WAV alerts for Claude Code lifecycle events.

## v1.5.1 highlights

- Redesigned the control panel with **Question** and **Finished** as prominent Primary Alerts at the top.
- Only **Question** and **Finished** are enabled by default; every other event starts off.
- Fixed **Minimal / Recommended / Everything** presets and added visible active-preset state.
- **Minimal** = Question + Finished only.
- **Recommended** = Question + Finished plus important permission, error, subagent, task, and MCP alerts.
- **Everything** = every safe hook event enabled.
- Added a **Custom** state when you manually change event enablement outside a preset.
- Added the selected artwork as the official VS Code extension icon.
- Added the user-provided **Done Fanfare** and made it the default for **Claude Finished**.
- Added the user-provided **Error Impact** and made it the default for **Tool Failed**, **Permission Denied**, and **Claude API / Turn Error**.
- Retained **Question Chime** as the default for **Ask User Question**.
- Full event control panel covering the current Claude Code hook lifecycle.
- Separate **sound**, **volume (0–200%)**, and **repeat count (1–5)** for each event.
- **My Sounds** library: import a PCM WAV once and use it from every event dropdown.
- Built-in Minimal, Recommended, and Everything enablement presets.
- Built-in sounds: Question Chime, Done Fanfare, Error Impact, Soft Bell, Bright Ping, Double Ping, Gentle Chime, Digital Pop, Warm Knock, Success Chime, Calm Complete, Soft Pop, and Alert Pulse.
- Windows playback uses `System.Media.SoundPlayer` with PCM WAV preprocessing for independent volume and digital boost.
- Global mute, optional VS Code popups, repeat-gap control, hook status, and listener status.
- True multi-listener mode: every VS Code window gets its own localhost listener.
- If the preferred port is busy, the next free port is selected automatically.
- Hook events are routed to one appropriate listener, preferring the VS Code workspace that contains Claude's current working directory.
- The configured hook/router port automatically fails over to another open VS Code window if its owner closes.
- Updated extension artwork to the newly supplied notification icon.

## Events

The UI includes:

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
- SubagentStart
- SubagentStop
- TaskCreated
- TaskCompleted
- Stop
- StopFailure
- TeammateIdle
- ConfigChange
- CwdChanged
- DirectoryAdded
- FileChanged
- WorktreeCreate (shown but safety-protected; see below)
- WorktreeRemove
- PreCompact
- PostCompact
- SessionEnd
- Elicitation
- ElicitationResult

### WorktreeCreate safety protection

Claude Code treats a configured `WorktreeCreate` hook as a replacement for its normal worktree creation behavior, and that hook must create and return a valid worktree path. Sound Alerts therefore shows this event in the UI but deliberately does not install a listener for it, to avoid breaking Claude worktrees.

### FileChanged

Claude Code requires literal filenames to watch. Enter them in the control panel, for example:

`.env, package.json, pyproject.toml`

The extension automatically updates its installed hooks when this list changes.

## Install

1. In VS Code, open **Extensions**.
2. Open the `...` menu and choose **Install from VSIX...**.
3. Select the `.vsix` file.
4. Reload VS Code if requested.
5. Click **Claude Alerts** in the status bar.
6. Click **Install / Update Hooks**.

The extension preserves unrelated settings and hook handlers in `~/.claude/settings.json`.

## Sound library

Click **Add WAV to My Sounds...** in the control panel. The file is validated as uncompressed PCM WAV, copied into the extension's persistent global storage, and appears in every event's sound dropdown.

Custom sounds support PCM WAV at 8, 16, 24, or 32-bit depth. If you have MP3/M4A/OGG audio, convert it to PCM WAV first.

## Volume and boost

- 0% = silent
- 1–100% = attenuation up to the WAV's original level
- 101–200% = digital boost

Boosting cannot bypass your operating system's master output volume and may clip/distort very loud source audio.

## Repeat

Every event can play its sound 1–5 times. The global **Repeat gap** controls the pause between repetitions.

## Listener status and multiple VS Code windows

Version 1.5 uses a real multi-listener design. Every VS Code window gets its own localhost listener. The configured `serverPort` is the starting port (47391 by default), and additional windows automatically use the next free port within `listenerPortCount` (20 by default).

Claude hooks point to one router listener. That router immediately forwards each event to one active listener, preferring the listener whose VS Code workspace contains Claude's `cwd`. This avoids duplicate sounds across windows while still allowing every window to own a separate listener.

If the router-owning VS Code window closes, another open window detects that the configured router port is free and automatically takes it over. If the starting port was already occupied when hooks are installed, the extension can use a later free port instead.

The control panel shows the actual listener port for the current window. When that listener is also the configured hook router it is marked **router**.

After upgrading from v1.4.x, click **Install / Update Hooks** once so Claude's hook URLs point to the active v1.5 router.

## Privacy

Claude hooks send event JSON only to `127.0.0.1` on the configured local port. The extension does not intentionally transmit Claude event data to an external service.

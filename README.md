# Claude Code Sound Alerts

A lightweight VS Code extension that plays configurable sounds when Claude Code needs your input and when Claude finishes responding.

## v1.2 control panel

Open the UI by either:

- Clicking **Claude Alerts** in the VS Code status bar, or
- Running **Claude Sound Alerts: Open Control Panel** from the Command Palette.

The control panel lets you configure everything visually:

- Separate sound for **Question / Attention**
- Separate sound for **Finished**
- Independent **0–100% volume sliders**
- Preview buttons
- Enable/disable each alert type
- Global enable/disable
- Optional VS Code visual notifications
- Install/remove Claude Code hooks
- Hook/listener status
- Browse for a custom WAV file

## Built-in sounds

v1.2 ships with 10 sounds:

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

You can use any built-in sound for either Question / Attention or Finished.

## Windows audio fix in v1.2

Windows playback no longer uses WPF `MediaPlayer`.

The extension now:

1. Reads the selected PCM WAV itself.
2. Creates a cached volume-adjusted WAV for the selected 0–100% level.
3. Plays it with Windows `System.Media.SoundPlayer` through PowerShell.

This keeps Question and Finished volumes independent without changing Windows master volume and is more reliable for standard WAV notification sounds.

Custom sounds should be standard PCM WAV files. The extension validates custom files before accepting them and provides clearer playback errors in the output log.

## What it detects

**Needs your input**

- `AskUserQuestion` immediately via `PreToolUse`
- Tool approval requests via `PermissionRequest`
- `ExitPlanMode` approval
- MCP elicitation/input requests
- Background-agent `agent_needs_input` notifications

**Finished**

- `Stop` when Claude finishes responding

The extension uses Claude Code HTTP hooks pointed at a localhost-only listener inside VS Code. No hook data is sent to the internet by this extension.

## Install

1. Install the `.vsix` in VS Code using **Extensions → … → Install from VSIX…**.
2. Reload VS Code if requested.
3. Click **Claude Alerts** in the status bar.
4. Click **Install Hooks** in the control panel.
5. Choose sounds and volume levels.
6. Use **Preview** for each alert.

The hook installer edits your user-level Claude settings file at:

- Windows: `%USERPROFILE%\\.claude\\settings.json`
- macOS/Linux: `~/.claude/settings.json`

Existing Claude settings and unrelated hooks are preserved.

## Notes

- VS Code needs to be open for the localhost listener to receive hooks and play sounds.
- If another VS Code window already owns the configured localhost port, that window may receive the hook event.
- Custom sounds currently use WAV for predictable cross-platform behavior and per-alert volume handling on Windows.
- If playback fails, run **Claude Sound Alerts: Open Log**; v1.2 includes the underlying PowerShell error rather than only an exit code.

# Claude Code Sound Alerts

A lightweight VS Code extension that plays one sound when Claude Code needs you and another when Claude finishes responding.

## What it detects

**Needs your input**
- `AskUserQuestion` immediately via `PreToolUse`
- Tool approval requests via `PermissionRequest`
- `ExitPlanMode` approval
- MCP elicitation/input requests
- Background-agent `agent_needs_input` notifications

**Finished**
- `Stop` when Claude finishes responding

The extension uses Claude Code HTTP hooks pointed at a localhost-only listener inside VS Code. No data is sent to the internet by this extension.

## Install

1. Install the `.vsix` in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P`).
3. Run **Claude Sound Alerts: Install Claude Code Hooks**.
4. Run **Claude Sound Alerts: Test Question Sound** and **Test Finished Sound**.
5. Use Claude Code normally.

The hook installer edits your user-level Claude settings file at:

- Windows: `%USERPROFILE%\\.claude\\settings.json`
- macOS/Linux: `~/.claude/settings.json`

Existing Claude settings and unrelated hooks are preserved.

## Custom sounds

Run either command:
- **Claude Sound Alerts: Select Question Sound**
- **Claude Sound Alerts: Select Finished Sound**

Or set paths under VS Code Settings → **Claude Code Sound Alerts**.

Custom sounds should be WAV files. Windows playback uses `System.Media.SoundPlayer`. macOS uses `afplay`. Linux tries `paplay`, `aplay`, then `ffplay`.

## Settings

- `claudeSoundAlerts.enabled`
- `claudeSoundAlerts.serverPort`
- `claudeSoundAlerts.questionSoundEnabled`
- `claudeSoundAlerts.finishedSoundEnabled`
- `claudeSoundAlerts.alertOnAskUserQuestion`
- `claudeSoundAlerts.alertOnPermissionRequest`
- `claudeSoundAlerts.alertOnPlanApproval`
- `claudeSoundAlerts.alertOnMcpElicitation`
- `claudeSoundAlerts.alertOnBackgroundInput`
- `claudeSoundAlerts.questionSoundPath`
- `claudeSoundAlerts.finishedSoundPath`
- `claudeSoundAlerts.debounceMs`
- `claudeSoundAlerts.showVisualNotifications`

If you change `serverPort`, run **Install Claude Code Hooks** again so Claude's hook URL uses the new port.

## Remove hooks

Run **Claude Sound Alerts: Remove Claude Code Hooks**. It removes only hook handlers created by this extension.

## Notes

- VS Code needs to be open for the localhost listener to receive hooks and play sounds.
- This is intended primarily for local VS Code sessions. Remote SSH/containers/WSL can run the extension host remotely, which can change where audio playback occurs.
- For immediate questions, this extension uses `PreToolUse` / `PermissionRequest` rather than the delayed `idle_prompt` notification.

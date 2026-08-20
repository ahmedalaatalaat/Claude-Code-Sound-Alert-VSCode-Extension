# Changelog

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

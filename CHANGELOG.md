# Changelog

## 1.2.0

- Added a full VS Code control panel for sound configuration.
- Added separate Question / Attention and Finished sound selectors.
- Added 10 built-in sound presets.
- Added independent 0–100% volume sliders.
- Added Preview buttons directly in the UI.
- Added custom PCM WAV selection from the UI.
- Added global enable/disable and per-alert enable toggles.
- Added Install Hooks / Remove Hooks buttons and hook/listener status.
- Added a clickable **Claude Alerts** status-bar item.
- Replaced Windows WPF `MediaPlayer` playback with volume-adjusted PCM WAV + `System.Media.SoundPlayer`.
- Added detailed Windows playback diagnostics instead of only `powershell.exe exited with code 1`.
- Preserved v1.1 custom sound paths for backward compatibility.

## 1.1.0

- Added independent Question and Finished volume settings.
- Added configuration commands for sounds and volume.

## 1.0.0

- Initial release.

'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTENSION_TAG = 'claude-code-sound-alerts';
const SOUND_PRESETS = [
  { id: 'soft-bell', label: 'Soft Bell' },
  { id: 'bright-ping', label: 'Bright Ping' },
  { id: 'double-ping', label: 'Double Ping' },
  { id: 'gentle-chime', label: 'Gentle Chime' },
  { id: 'digital-pop', label: 'Digital Pop' },
  { id: 'warm-knock', label: 'Warm Knock' },
  { id: 'success-chime', label: 'Success Chime' },
  { id: 'calm-complete', label: 'Calm Complete' },
  { id: 'soft-pop', label: 'Soft Pop' },
  { id: 'alert-pulse', label: 'Alert Pulse' }
];
const PRESET_IDS = new Set(SOUND_PRESETS.map(s => s.id));

let server;
let output;
let extensionContext;
let retryTimer;
let controlPanel;
let statusItem;
const lastPlayedAt = { question: 0, finished: 0 };

function cfg() {
  return vscode.workspace.getConfiguration('claudeSoundAlerts');
}

function log(message) {
  const stamp = new Date().toLocaleTimeString();
  output?.appendLine(`[${stamp}] ${message}`);
}

function getPort() {
  return cfg().get('serverPort', 47391);
}

function endpointFor(port = getPort()) {
  return `http://127.0.0.1:${port}/${EXTENSION_TAG}/hook`;
}

function presetSoundPath(id) {
  const safeId = PRESET_IDS.has(id) ? id : 'soft-bell';
  return extensionContext.asAbsolutePath(path.join('media', 'sounds', `${safeId}.wav`));
}

function soundSelection(kind) {
  const soundKey = kind === 'question' ? 'questionSound' : 'finishedSound';
  const pathKey = kind === 'question' ? 'questionSoundPath' : 'finishedSoundPath';
  const fallback = kind === 'question' ? 'soft-bell' : 'success-chime';
  const inspection = cfg().inspect(soundKey);
  const customPath = String(cfg().get(pathKey, '') || '').trim();

  // Backward compatibility with v1.1: if a custom path was already chosen and
  // the new sound selector has never been explicitly set, treat it as custom.
  let id = cfg().get(soundKey, fallback);
  if (inspection && inspection.globalValue === undefined && customPath) id = 'custom';
  if (id !== 'custom' && !PRESET_IDS.has(id)) id = fallback;

  return { id, customPath };
}

function selectedSound(kind) {
  const selection = soundSelection(kind);
  if (selection.id === 'custom') {
    if (selection.customPath && fs.existsSync(selection.customPath)) return selection.customPath;
    if (selection.customPath) log(`Custom ${kind} sound not found: ${selection.customPath}; using built-in fallback.`);
  }
  const fallback = kind === 'question' ? 'soft-bell' : 'success-chime';
  return presetSoundPath(selection.id === 'custom' ? fallback : selection.id);
}

function volumeFor(kind) {
  const key = kind === 'question' ? 'questionVolume' : 'finishedVolume';
  const fallback = kind === 'question' ? 70 : 50;
  const value = Number(cfg().get(key, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function shouldPlay(kind) {
  if (!cfg().get('enabled', true)) return false;
  if (kind === 'question' && !cfg().get('questionSoundEnabled', true)) return false;
  if (kind === 'finished' && !cfg().get('finishedSoundEnabled', true)) return false;

  const debounce = cfg().get('debounceMs', 650);
  const now = Date.now();
  if (now - lastPlayedAt[kind] < debounce) return false;
  lastPlayedAt[kind] = now;
  return true;
}

function spawnCaptured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += String(d); });
    child.stderr?.on('data', d => { stderr += String(d); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = (stderr || stdout || '').trim();
      reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

function findWavChunks(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The selected sound is not a valid WAV file.');
  }
  let offset = 12;
  let fmt;
  let data;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);
    if (id === 'fmt ' && size >= 16) fmt = { start, size };
    if (id === 'data') data = { start, size: end - start };
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('The WAV file is missing audio format or data chunks.');
  return { fmt, data };
}

function scalePcmWav(buffer, volumePercent) {
  const { fmt, data } = findWavChunks(buffer);
  const format = buffer.readUInt16LE(fmt.start);
  const bits = buffer.readUInt16LE(fmt.start + 14);
  if (format !== 1) {
    throw new Error('This WAV uses a compressed/non-PCM format. Please choose a standard PCM WAV file.');
  }
  if (![8, 16, 24, 32].includes(bits)) {
    throw new Error(`Unsupported WAV bit depth: ${bits}. Use 8, 16, 24, or 32-bit PCM WAV.`);
  }

  const gain = Math.max(0, Math.min(1, Number(volumePercent) / 100));
  const out = Buffer.from(buffer);
  const end = data.start + data.size;

  if (bits === 8) {
    for (let i = data.start; i < end; i += 1) {
      const centered = out[i] - 128;
      out[i] = Math.max(0, Math.min(255, Math.round(centered * gain + 128)));
    }
  } else if (bits === 16) {
    for (let i = data.start; i + 1 < end; i += 2) {
      const v = out.readInt16LE(i);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * gain))), i);
    }
  } else if (bits === 24) {
    for (let i = data.start; i + 2 < end; i += 3) {
      let v = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16);
      if (v & 0x800000) v |= 0xff000000;
      const scaled = Math.max(-8388608, Math.min(8388607, Math.round(v * gain)));
      out[i] = scaled & 0xff;
      out[i + 1] = (scaled >> 8) & 0xff;
      out[i + 2] = (scaled >> 16) & 0xff;
    }
  } else {
    for (let i = data.start; i + 3 < end; i += 4) {
      const v = out.readInt32LE(i);
      const scaled = Math.max(-2147483648, Math.min(2147483647, Math.round(v * gain)));
      out.writeInt32LE(scaled, i);
    }
  }
  return out;
}

async function windowsVolumeAdjustedWav(file, volumePercent) {
  if (volumePercent >= 100) return file;
  const stat = await fs.promises.stat(file);
  const key = crypto.createHash('sha256')
    .update(`${file}|${stat.size}|${stat.mtimeMs}|${volumePercent}`)
    .digest('hex')
    .slice(0, 24);
  const cacheDir = path.join(extensionContext.globalStorageUri.fsPath, 'audio-cache');
  const cached = path.join(cacheDir, `${key}.wav`);
  try {
    await fs.promises.access(cached, fs.constants.R_OK);
    return cached;
  } catch (_) {}

  const input = await fs.promises.readFile(file);
  const adjusted = scalePcmWav(input, volumePercent);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  await fs.promises.writeFile(cached, adjusted);
  return cached;
}

async function playWindowsWav(file, volumePercent) {
  const adjusted = await windowsVolumeAdjustedWav(file, volumePercent);
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System',
    '$player = New-Object System.Media.SoundPlayer',
    '$player.SoundLocation = $env:CLAUDE_SOUND_FILE',
    '$player.Load()',
    '$player.PlaySync()'
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const env = { ...process.env, CLAUDE_SOUND_FILE: adjusted };

  let firstError;
  for (const command of ['powershell.exe', 'pwsh.exe']) {
    try {
      await spawnCaptured(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env });
      return;
    } catch (error) {
      if (!firstError) firstError = error;
      if (error && error.code === 'ENOENT') continue;
      log(`${command} audio attempt failed: ${error.message || error}`);
    }
  }
  throw firstError || new Error('No PowerShell audio host was available.');
}

async function playAudioFile(file, volumePercent) {
  const volume = Math.max(0, Math.min(100, Number(volumePercent)));
  if (volume <= 0) return;

  if (process.platform === 'win32') {
    await playWindowsWav(file, volume);
    return;
  }

  if (process.platform === 'darwin') {
    await spawnCaptured('afplay', ['-v', String(volume / 100), file]);
    return;
  }

  const pulseVolume = Math.round((volume / 100) * 65536);
  const players = [
    ['paplay', [`--volume=${pulseVolume}`, file]],
    ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume)), file]],
    ['aplay', [file]]
  ];
  let lastError;
  for (const [command, args] of players) {
    try {
      await spawnCaptured(command, args);
      if (command === 'aplay' && volume !== 100) log('Linux aplay fallback cannot apply per-alert volume; system volume was used.');
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No supported Linux audio player found (paplay, ffplay, or aplay).');
}

async function play(kind, reason, force = false, volumeOverride) {
  if (!force && !shouldPlay(kind)) return;
  const file = selectedSound(kind);
  const volume = volumeOverride === undefined ? volumeFor(kind) : Math.max(0, Math.min(100, Number(volumeOverride)));
  log(`${kind === 'question' ? 'Attention' : 'Finished'} alert: ${reason} (${volume}% volume) — ${file}`);

  if (cfg().get('showVisualNotifications', false) && !force) {
    const message = kind === 'question' ? `Claude needs you: ${reason}` : 'Claude finished responding.';
    vscode.window.showInformationMessage(message);
  }

  try {
    await playAudioFile(file, volume);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`Unable to play sound: ${message}`);
    vscode.window.showWarningMessage(`Claude Sound Alerts could not play audio: ${message}`, 'Open Log').then(choice => {
      if (choice === 'Open Log') output.show(true);
    });
  }
}

function classifyHook(body) {
  const event = body?.hook_event_name;

  if (event === 'PreToolUse') {
    if (body.tool_name === 'AskUserQuestion' && cfg().get('alertOnAskUserQuestion', true)) {
      return { kind: 'question', reason: 'Claude asked a question' };
    }
    if (body.tool_name === 'ExitPlanMode' && cfg().get('alertOnPlanApproval', true)) {
      return { kind: 'question', reason: 'Claude is waiting for plan approval' };
    }
  }

  if (event === 'PermissionRequest' && cfg().get('alertOnPermissionRequest', true)) {
    return { kind: 'question', reason: `Permission requested${body.tool_name ? ` for ${body.tool_name}` : ''}` };
  }

  if (event === 'Elicitation' && cfg().get('alertOnMcpElicitation', true)) {
    return { kind: 'question', reason: 'An MCP tool is waiting for input' };
  }

  if (event === 'Notification') {
    if (body.notification_type === 'agent_needs_input' && cfg().get('alertOnBackgroundInput', true)) {
      return { kind: 'question', reason: 'A background Claude agent needs input' };
    }
    if ((body.notification_type === 'elicitation_dialog' || body.notification_type === 'elicitation_url_dialog') && cfg().get('alertOnMcpElicitation', true)) {
      return { kind: 'question', reason: 'An MCP interaction needs input' };
    }
  }

  if (event === 'Stop') return { kind: 'finished', reason: 'Claude finished responding' };
  return null;
}

function startServer() {
  stopServer();
  if (!cfg().get('enabled', true)) {
    log('Listener disabled by settings.');
    updateStatusBar();
    return;
  }

  const port = getPort();
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== `/${EXTENSION_TAG}/hook`) {
      res.writeHead(404);
      res.end();
      return;
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const result = classifyHook(body);
        if (result) void play(result.kind, result.reason);
        else log(`Ignored hook event: ${body.hook_event_name || 'unknown'}${body.tool_name ? ` / ${body.tool_name}` : ''}${body.notification_type ? ` / ${body.notification_type}` : ''}`);
        res.writeHead(204);
        res.end();
      } catch (error) {
        log(`Invalid hook request: ${error.message || error}`);
        res.writeHead(400);
        res.end();
      }
    });
  });

  server.on('error', error => {
    log(`Listener error on port ${port}: ${error.message || error}`);
    if (error && error.code === 'EADDRINUSE') {
      log('Port is already in use, likely by another VS Code window. Retrying periodically.');
      try { server?.close(); } catch (_) {}
      server = undefined;
      retryTimer = setTimeout(startServer, 5000);
      updateStatusBar();
      return;
    }
    vscode.window.showErrorMessage(`Claude Sound Alerts could not listen on localhost:${port}. Change claudeSoundAlerts.serverPort or close the program using that port.`);
    updateStatusBar();
  });

  server.listen(port, '127.0.0.1', () => {
    log(`Listening for Claude Code hooks at ${endpointFor(port)}`);
    updateStatusBar();
  });
}

function stopServer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  if (server) {
    try { server.close(); } catch (_) {}
    server = undefined;
  }
}

function hookHandler(url) {
  return { type: 'http', url, timeout: 2 };
}

function desiredHookGroups(url) {
  return {
    PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [hookHandler(url)] }],
    PermissionRequest: [{ matcher: '*', hooks: [hookHandler(url)] }],
    Elicitation: [{ hooks: [hookHandler(url)] }],
    Notification: [{ matcher: 'agent_needs_input|elicitation_dialog|elicitation_url_dialog', hooks: [hookHandler(url)] }],
    Stop: [{ hooks: [hookHandler(url)] }]
  };
}

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function isOurHandler(handler) {
  return handler && handler.type === 'http' && typeof handler.url === 'string' && handler.url.includes(`/${EXTENSION_TAG}/hook`);
}

function removeOurHooksFromSettings(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map(group => {
        if (!group || !Array.isArray(group.hooks)) return group;
        return { ...group, hooks: group.hooks.filter(handler => !isOurHandler(handler)) };
      })
      .filter(group => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

async function readClaudeSettings() {
  const file = claudeSettingsPath();
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeClaudeSettings(settings) {
  const file = claudeSettingsPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await fs.promises.rename(temp, file);
  return file;
}

async function hooksInstalled() {
  try {
    const settings = await readClaudeSettings();
    for (const groups of Object.values(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (Array.isArray(group?.hooks) && group.hooks.some(isOurHandler)) return true;
      }
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function installHooks(showMessage = true) {
  try {
    const url = endpointFor(getPort());
    const settings = removeOurHooksFromSettings(await readClaudeSettings());
    settings.hooks = settings.hooks || {};
    const desired = desiredHookGroups(url);
    for (const [event, groups] of Object.entries(desired)) {
      settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      settings.hooks[event].push(...groups);
    }
    const file = await writeClaudeSettings(settings);
    log(`Installed Claude Code hooks in ${file}`);
    if (showMessage) vscode.window.showInformationMessage('Claude Code Sound Alerts hooks installed.');
    await sendUiState();
    updateStatusBar();
    return true;
  } catch (error) {
    log(`Hook installation failed: ${error.stack || error}`);
    vscode.window.showErrorMessage(`Could not install Claude Code hooks: ${error.message || error}`);
    return false;
  }
}

async function uninstallHooks(showMessage = true) {
  try {
    const settings = removeOurHooksFromSettings(await readClaudeSettings());
    const file = await writeClaudeSettings(settings);
    log(`Removed Claude Sound Alerts hooks from ${file}`);
    if (showMessage) vscode.window.showInformationMessage('Claude Code Sound Alerts hooks removed.');
    await sendUiState();
    updateStatusBar();
    return true;
  } catch (error) {
    log(`Hook removal failed: ${error.stack || error}`);
    vscode.window.showErrorMessage(`Could not remove Claude Code hooks: ${error.message || error}`);
    return false;
  }
}

async function chooseCustomSound(kind, previewAfter = true) {
  const result = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    title: kind === 'question' ? 'Select Claude Question Sound' : 'Select Claude Finished Sound',
    filters: { 'PCM WAV audio': ['wav'] }
  });
  if (!result?.length) return false;

  const file = result[0].fsPath;
  try {
    const buffer = await fs.promises.readFile(file);
    const { fmt } = findWavChunks(buffer);
    const format = buffer.readUInt16LE(fmt.start);
    if (format !== 1) throw new Error('Please choose a standard PCM WAV file.');
  } catch (error) {
    vscode.window.showErrorMessage(`Cannot use this sound: ${error.message || error}`);
    return false;
  }

  const pathKey = kind === 'question' ? 'questionSoundPath' : 'finishedSoundPath';
  const soundKey = kind === 'question' ? 'questionSound' : 'finishedSound';
  await cfg().update(pathKey, file, vscode.ConfigurationTarget.Global);
  await cfg().update(soundKey, 'custom', vscode.ConfigurationTarget.Global);
  await sendUiState();
  if (previewAfter) await play(kind, `Testing selected ${kind} sound`, true);
  return true;
}

async function setSoundChoice(kind, id) {
  if (id === 'custom') {
    const selection = soundSelection(kind);
    if (!selection.customPath || !fs.existsSync(selection.customPath)) {
      return chooseCustomSound(kind, false);
    }
  } else if (!PRESET_IDS.has(id)) {
    return false;
  }
  const key = kind === 'question' ? 'questionSound' : 'finishedSound';
  await cfg().update(key, id, vscode.ConfigurationTarget.Global);
  await sendUiState();
  return true;
}

async function chooseSoundLegacy(kind) {
  await chooseCustomSound(kind, true);
}

async function chooseVolumeLegacy(kind) {
  const current = volumeFor(kind);
  const label = kind === 'question' ? 'Question / Attention' : 'Finished';
  const value = await vscode.window.showInputBox({
    title: `Set ${label} Volume`,
    prompt: 'Enter a volume from 0 to 100',
    value: String(current),
    validateInput: input => {
      const n = Number(input);
      if (!Number.isFinite(n) || n < 0 || n > 100) return 'Enter a number from 0 to 100.';
      return undefined;
    }
  });
  if (value === undefined) return;
  const key = kind === 'question' ? 'questionVolume' : 'finishedVolume';
  await cfg().update(key, Number(value), vscode.ConfigurationTarget.Global);
  await play(kind, `Testing ${kind} sound at ${Number(value)}%`, true);
}

function nonce() {
  return crypto.randomBytes(16).toString('base64');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getUiState() {
  const q = soundSelection('question');
  const f = soundSelection('finished');
  return {
    enabled: cfg().get('enabled', true),
    questionEnabled: cfg().get('questionSoundEnabled', true),
    finishedEnabled: cfg().get('finishedSoundEnabled', true),
    questionSound: q.id,
    finishedSound: f.id,
    questionCustomPath: q.customPath,
    finishedCustomPath: f.customPath,
    questionVolume: volumeFor('question'),
    finishedVolume: volumeFor('finished'),
    visualNotifications: cfg().get('showVisualNotifications', false),
    hooksInstalled: await hooksInstalled(),
    listenerActive: Boolean(server?.listening),
    platform: process.platform,
    presets: SOUND_PRESETS
  };
}

async function sendUiState() {
  if (!controlPanel) return;
  try {
    await controlPanel.webview.postMessage({ type: 'state', state: await getUiState() });
  } catch (_) {}
}

function controlPanelHtml(webview, initialState) {
  const n = nonce();
  const stateJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<title>Claude Code Sound Alerts</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 22px; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; font-weight: 600; }
  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
  .topbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:18px; padding:14px; border:1px solid var(--vscode-panel-border); border-radius:10px; background:var(--vscode-sideBar-background); }
  .status { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .pill { padding:4px 9px; border-radius:999px; border:1px solid var(--vscode-panel-border); font-size:12px; }
  .pill.ok { color: var(--vscode-testing-iconPassed); }
  .pill.warn { color: var(--vscode-editorWarning-foreground); }
  .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  .card { border:1px solid var(--vscode-panel-border); border-radius:12px; padding:18px; background:var(--vscode-sideBar-background); }
  .card h2 { font-size:18px; margin:0 0 4px; }
  .hint { color:var(--vscode-descriptionForeground); font-size:12px; margin-bottom:16px; }
  .row { margin:14px 0; }
  label { display:block; margin-bottom:6px; font-weight:500; }
  select, button { font:inherit; }
  select { width:100%; box-sizing:border-box; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding:8px 10px; border-radius:6px; }
  input[type="range"] { width:100%; }
  .volrow { display:flex; gap:12px; align-items:center; }
  .volvalue { min-width:48px; text-align:right; font-variant-numeric:tabular-nums; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  button { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border:none; padding:8px 12px; border-radius:6px; cursor:pointer; }
  button:hover { background:var(--vscode-button-hoverBackground); }
  button.secondary { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity:.55; cursor:not-allowed; }
  .switchrow { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .switchrow label { margin:0; }
  .path { margin-top:7px; color:var(--vscode-descriptionForeground); font-size:12px; overflow-wrap:anywhere; min-height:16px; }
  .footer { margin-top:16px; border:1px solid var(--vscode-panel-border); border-radius:12px; padding:16px; }
  .footergrid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
  .note { color:var(--vscode-descriptionForeground); font-size:12px; margin-top:10px; }
  #toast { min-height:18px; margin-top:12px; color:var(--vscode-descriptionForeground); }
  @media (max-width:720px) { .grid,.footergrid { grid-template-columns:1fr; } body { padding:14px; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Claude Code Sound Alerts</h1>
  <div class="subtitle">Choose the sound and volume Claude uses when it needs you and when it finishes.</div>

  <div class="topbar">
    <div class="status">
      <span id="hookStatus" class="pill"></span>
      <span id="listenerStatus" class="pill"></span>
    </div>
    <div class="actions" style="margin-top:0">
      <button id="installHooks">Install Hooks</button>
      <button id="removeHooks" class="secondary">Remove Hooks</button>
      <button id="openLog" class="secondary">Open Log</button>
    </div>
  </div>

  <div class="grid">
    <section class="card">
      <div class="switchrow">
        <div><h2>Question / Attention</h2><div class="hint">When Claude asks a question, needs permission, or needs your input.</div></div>
        <input id="questionEnabled" type="checkbox" aria-label="Enable question sound">
      </div>
      <div class="row">
        <label for="questionSound">Sound</label>
        <select id="questionSound"></select>
        <div id="questionPath" class="path"></div>
      </div>
      <div class="actions">
        <button id="questionPreview">Preview</button>
        <button id="questionCustom" class="secondary">Choose Custom WAV…</button>
      </div>
      <div class="row">
        <label for="questionVolume">Volume</label>
        <div class="volrow">
          <input id="questionVolume" type="range" min="0" max="100" step="1">
          <span id="questionVolumeValue" class="volvalue"></span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="switchrow">
        <div><h2>Finished</h2><div class="hint">When Claude completes its response.</div></div>
        <input id="finishedEnabled" type="checkbox" aria-label="Enable finished sound">
      </div>
      <div class="row">
        <label for="finishedSound">Sound</label>
        <select id="finishedSound"></select>
        <div id="finishedPath" class="path"></div>
      </div>
      <div class="actions">
        <button id="finishedPreview">Preview</button>
        <button id="finishedCustom" class="secondary">Choose Custom WAV…</button>
      </div>
      <div class="row">
        <label for="finishedVolume">Volume</label>
        <div class="volrow">
          <input id="finishedVolume" type="range" min="0" max="100" step="1">
          <span id="finishedVolumeValue" class="volvalue"></span>
        </div>
      </div>
    </section>
  </div>

  <section class="footer">
    <div class="footergrid">
      <div class="switchrow"><label for="enabled">Enable Claude Sound Alerts</label><input id="enabled" type="checkbox"></div>
      <div class="switchrow"><label for="visualNotifications">Also show VS Code notifications</label><input id="visualNotifications" type="checkbox"></div>
    </div>
    <div class="note">Volumes are independent and do not change your Windows master volume. Custom sounds should be standard PCM WAV files for reliable playback.</div>
    <div id="toast" aria-live="polite"></div>
  </section>
</div>
<script nonce="${n}">
(() => {
  const vscode = acquireVsCodeApi();
  let state = ${stateJson};
  const $ = id => document.getElementById(id);

  function optionHtml(presets, selected) {
    const options = presets.map(p => '<option value=\"' + p.id + '\">' + p.label + '</option>').join('');
    return options + '<option value="custom">Custom WAV…</option>';
  }

  function render() {
    const presets = state.presets || [];
    $('questionSound').innerHTML = optionHtml(presets, state.questionSound);
    $('finishedSound').innerHTML = optionHtml(presets, state.finishedSound);
    $('questionSound').value = state.questionSound || 'soft-bell';
    $('finishedSound').value = state.finishedSound || 'success-chime';
    $('questionEnabled').checked = !!state.questionEnabled;
    $('finishedEnabled').checked = !!state.finishedEnabled;
    $('questionVolume').value = state.questionVolume;
    $('finishedVolume').value = state.finishedVolume;
    $('questionVolumeValue').textContent = state.questionVolume + '%';
    $('finishedVolumeValue').textContent = state.finishedVolume + '%';
    $('questionPath').textContent = state.questionSound === 'custom' ? (state.questionCustomPath || 'No custom file selected') : 'Built-in sound';
    $('finishedPath').textContent = state.finishedSound === 'custom' ? (state.finishedCustomPath || 'No custom file selected') : 'Built-in sound';
    $('enabled').checked = !!state.enabled;
    $('visualNotifications').checked = !!state.visualNotifications;
    $('hookStatus').textContent = state.hooksInstalled ? 'Claude hooks installed' : 'Claude hooks not installed';
    $('hookStatus').className = 'pill ' + (state.hooksInstalled ? 'ok' : 'warn');
    $('listenerStatus').textContent = state.listenerActive ? 'Listener active' : 'Listener inactive';
    $('listenerStatus').className = 'pill ' + (state.listenerActive ? 'ok' : 'warn');
  }

  function post(action, extra = {}) { vscode.postMessage({ action, ...extra }); }
  function setSetting(key, value) { post('setSetting', { key, value }); }
  function toast(text) { $('toast').textContent = text || ''; }

  $('questionSound').addEventListener('change', e => post('setSound', { kind:'question', id:e.target.value }));
  $('finishedSound').addEventListener('change', e => post('setSound', { kind:'finished', id:e.target.value }));
  $('questionCustom').addEventListener('click', () => post('chooseCustom', { kind:'question' }));
  $('finishedCustom').addEventListener('click', () => post('chooseCustom', { kind:'finished' }));
  $('questionPreview').addEventListener('click', () => post('preview', { kind:'question', volume:Number($('questionVolume').value) }));
  $('finishedPreview').addEventListener('click', () => post('preview', { kind:'finished', volume:Number($('finishedVolume').value) }));

  $('questionVolume').addEventListener('input', e => $('questionVolumeValue').textContent = e.target.value + '%');
  $('finishedVolume').addEventListener('input', e => $('finishedVolumeValue').textContent = e.target.value + '%');
  $('questionVolume').addEventListener('change', e => setSetting('questionVolume', Number(e.target.value)));
  $('finishedVolume').addEventListener('change', e => setSetting('finishedVolume', Number(e.target.value)));
  $('questionEnabled').addEventListener('change', e => setSetting('questionSoundEnabled', e.target.checked));
  $('finishedEnabled').addEventListener('change', e => setSetting('finishedSoundEnabled', e.target.checked));
  $('enabled').addEventListener('change', e => setSetting('enabled', e.target.checked));
  $('visualNotifications').addEventListener('change', e => setSetting('showVisualNotifications', e.target.checked));
  $('installHooks').addEventListener('click', () => post('installHooks'));
  $('removeHooks').addEventListener('click', () => post('removeHooks'));
  $('openLog').addEventListener('click', () => post('openLog'));

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'state') { state = msg.state; render(); }
    if (msg.type === 'toast') toast(msg.text);
  });
  render();
})();
</script>
</body>
</html>`;
}

async function openControlPanel() {
  if (controlPanel) {
    controlPanel.reveal(vscode.ViewColumn.One);
    await sendUiState();
    return;
  }
  controlPanel = vscode.window.createWebviewPanel(
    'claudeSoundAlerts.controlPanel',
    'Claude Sound Alerts',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  controlPanel.webview.html = controlPanelHtml(controlPanel.webview, await getUiState());
  controlPanel.onDidDispose(() => { controlPanel = undefined; }, null, extensionContext.subscriptions);
  controlPanel.webview.onDidReceiveMessage(async msg => {
    try {
      if (msg.action === 'setSetting') {
        const allowed = new Set(['questionVolume','finishedVolume','questionSoundEnabled','finishedSoundEnabled','enabled','showVisualNotifications']);
        if (!allowed.has(msg.key)) return;
        await cfg().update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        if (msg.key === 'enabled') startServer();
        await sendUiState();
        updateStatusBar();
        return;
      }
      if (msg.action === 'setSound') {
        const ok = await setSoundChoice(msg.kind, msg.id);
        if (!ok) await sendUiState();
        return;
      }
      if (msg.action === 'chooseCustom') {
        await chooseCustomSound(msg.kind, false);
        return;
      }
      if (msg.action === 'preview') {
        await play(msg.kind, 'Control panel preview', true, msg.volume);
        controlPanel?.webview.postMessage({ type:'toast', text:'Preview played.' });
        return;
      }
      if (msg.action === 'installHooks') { await installHooks(false); return; }
      if (msg.action === 'removeHooks') { await uninstallHooks(false); return; }
      if (msg.action === 'openLog') { output.show(true); return; }
    } catch (error) {
      log(`Control panel error: ${error.stack || error}`);
      controlPanel?.webview.postMessage({ type:'toast', text:`Error: ${error.message || error}` });
    }
  }, null, extensionContext.subscriptions);
}

function updateStatusBar() {
  if (!statusItem) return;
  if (!cfg().get('enabled', true)) {
    statusItem.text = '$(mute) Claude Alerts';
    statusItem.tooltip = 'Claude Code Sound Alerts are disabled. Click to configure.';
  } else {
    statusItem.text = '$(unmute) Claude Alerts';
    statusItem.tooltip = 'Configure Claude Code Sound Alerts';
  }
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Claude Code Sound Alerts');
  context.subscriptions.push(output);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeSoundAlerts.openControlPanel';
  statusItem.show();
  context.subscriptions.push(statusItem);
  updateStatusBar();

  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.installHooks', () => installHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.uninstallHooks', () => uninstallHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testQuestionSound', () => play('question', 'Manual test', true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testFinishedSound', () => play('finished', 'Manual test', true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectQuestionSound', () => chooseSoundLegacy('question')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectFinishedSound', () => chooseSoundLegacy('finished')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openLog', () => output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openControlPanel', openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.configureSounds', openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setQuestionVolume', () => chooseVolumeLegacy('question')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setFinishedVolume', () => chooseVolumeLegacy('finished')));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('claudeSoundAlerts.enabled') || event.affectsConfiguration('claudeSoundAlerts.serverPort')) startServer();
    if (event.affectsConfiguration('claudeSoundAlerts')) {
      void sendUiState();
      updateStatusBar();
    }
  }));

  startServer();
  log('Extension activated. Click “Claude Alerts” in the status bar or run “Claude Sound Alerts: Open Control Panel”.');
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };

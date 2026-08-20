'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EXTENSION_TAG = 'claude-code-sound-alerts';
let server;
let output;
let extensionContext;
let retryTimer;
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

function builtInSound(kind) {
  return extensionContext.asAbsolutePath(path.join('media', kind === 'question' ? 'question.wav' : 'finished.wav'));
}

function selectedSound(kind) {
  const key = kind === 'question' ? 'questionSoundPath' : 'finishedSoundPath';
  const custom = cfg().get(key, '').trim();
  if (custom && fs.existsSync(custom)) return custom;
  if (custom) log(`Custom ${kind} sound not found: ${custom}; using built-in sound.`);
  return builtInSound(kind);
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

function spawnHidden(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function volumeFor(kind) {
  const key = kind === 'question' ? 'questionVolume' : 'finishedVolume';
  const fallback = kind === 'question' ? 70 : 50;
  const value = Number(cfg().get(key, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
}

async function playAudioFile(file, volumePercent) {
  const volume = Math.max(0, Math.min(100, Number(volumePercent)));
  if (volume <= 0) return;

  if (process.platform === 'win32') {
    // WPF MediaPlayer supports per-playback volume without changing Windows master volume.
    const script = [
      'Add-Type -AssemblyName PresentationCore',
      '$p = New-Object System.Windows.Media.MediaPlayer',
      '$p.Volume = [Math]::Max(0,[Math]::Min(1,([double]$args[1] / 100)))',
      '$p.Open([Uri]::new($args[0]))',
      '$deadline = (Get-Date).AddSeconds(5)',
      'while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 25 }',
      '$p.Play()',
      'if ($p.NaturalDuration.HasTimeSpan) {',
      '  Start-Sleep -Milliseconds ([Math]::Ceiling($p.NaturalDuration.TimeSpan.TotalMilliseconds) + 100)',
      '} else {',
      '  Start-Sleep -Milliseconds 1500',
      '}',
      '$p.Close()'
    ].join('; ');
    await spawnHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', script, file, String(volume)]);
    return;
  }

  if (process.platform === 'darwin') {
    await spawnHidden('afplay', ['-v', String(volume / 100), file]);
    return;
  }

  const pulseVolume = Math.round((volume / 100) * 65536);
  const players = [
    ['paplay', [`--volume=${pulseVolume}`, file]],
    ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume)), file]],
    // aplay has no portable per-process volume flag, so it is a last-resort fallback.
    ['aplay', [file]]
  ];
  let lastError;
  for (const [command, args] of players) {
    try {
      await spawnHidden(command, args);
      if (command === 'aplay' && volume !== 100) {
        log('Linux aplay fallback cannot apply per-alert volume; system volume was used. Install paplay or ffplay for volume control.');
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No supported Linux audio player found (paplay, ffplay, or aplay).');
}

async function play(kind, reason, force = false) {
  if (!force && !shouldPlay(kind)) return;
  const file = selectedSound(kind);
  const volume = volumeFor(kind);
  log(`${kind === 'question' ? 'Attention' : 'Finished'} alert: ${reason} (${volume}% volume)`);

  if (cfg().get('showVisualNotifications', false)) {
    const message = kind === 'question' ? `Claude needs you: ${reason}` : 'Claude finished responding.';
    vscode.window.showInformationMessage(message);
  }

  try {
    await playAudioFile(file, volume);
  } catch (error) {
    log(`Unable to play sound: ${error.message || error}`);
    vscode.window.showWarningMessage(`Claude Sound Alerts could not play audio: ${error.message || error}`);
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

  if (event === 'Stop') {
    return { kind: 'finished', reason: 'Claude finished responding' };
  }

  return null;
}

function startServer() {
  stopServer();
  if (!cfg().get('enabled', true)) {
    log('Listener disabled by settings.');
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
      log('Port is already in use, likely by another VS Code window. Retrying periodically so this window can take over if that listener closes.');
      try { server?.close(); } catch (_) {}
      server = undefined;
      retryTimer = setTimeout(startServer, 5000);
      return;
    }
    vscode.window.showErrorMessage(`Claude Sound Alerts could not listen on localhost:${port}. Change claudeSoundAlerts.serverPort or close the program using that port.`);
  });

  server.listen(port, '127.0.0.1', () => {
    log(`Listening for Claude Code hooks at ${endpointFor(port)}`);
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
  return {
    type: 'http',
    url,
    timeout: 2
  };
}

function desiredHookGroups(url) {
  return {
    PreToolUse: [
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [hookHandler(url)] }
    ],
    PermissionRequest: [
      { matcher: '*', hooks: [hookHandler(url)] }
    ],
    Elicitation: [
      { hooks: [hookHandler(url)] }
    ],
    Notification: [
      { matcher: 'agent_needs_input|elicitation_dialog|elicitation_url_dialog', hooks: [hookHandler(url)] }
    ],
    Stop: [
      { hooks: [hookHandler(url)] }
    ]
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

async function installHooks() {
  try {
    const port = getPort();
    const url = endpointFor(port);
    const settings = removeOurHooksFromSettings(await readClaudeSettings());
    settings.hooks = settings.hooks || {};

    const desired = desiredHookGroups(url);
    for (const [event, groups] of Object.entries(desired)) {
      settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      settings.hooks[event].push(...groups);
    }

    const file = await writeClaudeSettings(settings);
    log(`Installed Claude Code hooks in ${file}`);
    vscode.window.showInformationMessage('Claude Code Sound Alerts hooks installed. New Claude Code turns will now trigger sounds.');
  } catch (error) {
    log(`Hook installation failed: ${error.stack || error}`);
    vscode.window.showErrorMessage(`Could not install Claude Code hooks: ${error.message || error}`);
  }
}

async function uninstallHooks() {
  try {
    const settings = removeOurHooksFromSettings(await readClaudeSettings());
    const file = await writeClaudeSettings(settings);
    log(`Removed Claude Sound Alerts hooks from ${file}`);
    vscode.window.showInformationMessage('Claude Code Sound Alerts hooks removed.');
  } catch (error) {
    log(`Hook removal failed: ${error.stack || error}`);
    vscode.window.showErrorMessage(`Could not remove Claude Code hooks: ${error.message || error}`);
  }
}

async function chooseSound(kind) {
  const result = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    title: kind === 'question' ? 'Select Claude Question Sound' : 'Select Claude Finished Sound',
    filters: {
      'WAV audio': ['wav']
    }
  });
  if (!result?.length) return;

  const key = kind === 'question' ? 'questionSoundPath' : 'finishedSoundPath';
  await cfg().update(key, result[0].fsPath, vscode.ConfigurationTarget.Global);
  await play(kind, `Testing selected ${kind} sound`, true);
}

async function chooseVolume(kind) {
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

async function configureSounds() {
  const choice = await vscode.window.showQuickPick([
    { label: '$(question) Question / Attention sound', description: `${volumeFor('question')}% volume`, action: 'questionSound' },
    { label: '$(unmute) Question / Attention volume', description: `${volumeFor('question')}%`, action: 'questionVolume' },
    { label: '$(check) Finished sound', description: `${volumeFor('finished')}% volume`, action: 'finishedSound' },
    { label: '$(unmute) Finished volume', description: `${volumeFor('finished')}%`, action: 'finishedVolume' },
    { label: '$(settings-gear) Open all extension settings', action: 'settings' }
  ], {
    title: 'Claude Code Sound Alerts',
    placeHolder: 'Choose what you want to change'
  });
  if (!choice) return;

  if (choice.action === 'questionSound') return chooseSound('question');
  if (choice.action === 'questionVolume') return chooseVolume('question');
  if (choice.action === 'finishedSound') return chooseSound('finished');
  if (choice.action === 'finishedVolume') return chooseVolume('finished');
  if (choice.action === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.claude-code-sound-alerts');
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Claude Code Sound Alerts');
  context.subscriptions.push(output);

  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.installHooks', installHooks));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.uninstallHooks', uninstallHooks));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testQuestionSound', () => play('question', 'Manual test', true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testFinishedSound', () => play('finished', 'Manual test', true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectQuestionSound', () => chooseSound('question')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectFinishedSound', () => chooseSound('finished')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openLog', () => output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.configureSounds', configureSounds));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setQuestionVolume', () => chooseVolume('question')));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setFinishedVolume', () => chooseVolume('finished')));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('claudeSoundAlerts.enabled') || event.affectsConfiguration('claudeSoundAlerts.serverPort')) {
      startServer();
    }
  }));

  startServer();
  log('Extension activated. Run “Claude Sound Alerts: Install Claude Code Hooks” once to connect Claude Code.');
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };

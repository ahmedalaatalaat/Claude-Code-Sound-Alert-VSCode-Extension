'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTENSION_TAG = 'claude-code-sound-alerts';
const RELAY_TAG = 'claude-sound-alerts-relay';
const SOUND_PRESETS = [
  { id: 'question-chime', label: 'Question Chime' },
  { id: 'done-fanfare', label: 'Done Fanfare' },
  { id: 'error-impact', label: 'Error Impact' },
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

// Every current Claude Code hook event is represented here. WorktreeCreate is
// intentionally safety-protected because merely configuring that hook replaces
// Claude Code's default worktree creation and requires the hook to create/return
// a real worktree path. FileChanged requires literal filenames to watch.
const EVENT_DEFS = [
  { id:'askUserQuestion', hookEvent:'PreToolUse', virtual:true, category:'Attention', label:'Ask User Question', description:'Claude calls AskUserQuestion and waits for your answer.', defaultEnabled:true, sound:'question-chime', volume:75, repeat:2 },
  { id:'exitPlanMode', hookEvent:'PreToolUse', virtual:true, category:'Attention', label:'Plan Approval', description:'Claude asks to leave plan mode / approve the plan.', defaultEnabled:true, sound:'bright-ping', volume:75, repeat:2 },
  { id:'sessionStart', hookEvent:'SessionStart', category:'Session', label:'Session Started', description:'A Claude Code session starts or resumes.', defaultEnabled:false, sound:'gentle-chime', volume:35, repeat:1, transport:'command' },
  { id:'setup', hookEvent:'Setup', category:'Session', label:'Setup', description:'Claude Code setup/init/maintenance hook fires.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1, transport:'command' },
  { id:'instructionsLoaded', hookEvent:'InstructionsLoaded', category:'Context', label:'Instructions Loaded', description:'CLAUDE.md or rule instructions are loaded.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'userPromptSubmit', hookEvent:'UserPromptSubmit', category:'Turn', label:'Prompt Submitted', description:'Your prompt is submitted to Claude.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'userPromptExpansion', hookEvent:'UserPromptExpansion', category:'Turn', label:'Prompt Expansion', description:'A command/skill expands into a prompt.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'messageDisplay', hookEvent:'MessageDisplay', category:'Turn', label:'Message Display', description:'Assistant message text is displayed. This can fire frequently.', defaultEnabled:false, sound:'soft-pop', volume:15, repeat:1, noisy:true },
  { id:'preToolUse', hookEvent:'PreToolUse', category:'Tools', label:'Tool Starting', description:'Before any tool call, except special Question/Plan events above.', defaultEnabled:false, sound:'digital-pop', volume:20, repeat:1, noisy:true },
  { id:'permissionRequest', hookEvent:'PermissionRequest', category:'Attention', label:'Permission Requested', description:'A tool needs your permission decision.', defaultEnabled:true, sound:'bright-ping', volume:80, repeat:2 },
  { id:'postToolUse', hookEvent:'PostToolUse', category:'Tools', label:'Tool Succeeded', description:'After a tool call succeeds.', defaultEnabled:false, sound:'soft-pop', volume:20, repeat:1, noisy:true },
  { id:'postToolUseFailure', hookEvent:'PostToolUseFailure', category:'Errors', label:'Tool Failed', description:'A Claude tool call fails.', defaultEnabled:true, sound:'error-impact', volume:90, repeat:2 },
  { id:'postToolBatch', hookEvent:'PostToolBatch', category:'Tools', label:'Tool Batch Finished', description:'A full batch of parallel tool calls resolves.', defaultEnabled:false, sound:'calm-complete', volume:25, repeat:1 },
  { id:'permissionDenied', hookEvent:'PermissionDenied', category:'Errors', label:'Permission Denied', description:'Auto mode denies a tool call.', defaultEnabled:true, sound:'error-impact', volume:85, repeat:2 },
  { id:'notification', hookEvent:'Notification', category:'Attention', label:'Claude Notification', description:'Claude sends a notification, including input/idle/agent notifications.', defaultEnabled:true, sound:'soft-bell', volume:65, repeat:1 },
  { id:'subagentStart', hookEvent:'SubagentStart', category:'Agents', label:'Subagent Started', description:'A Claude subagent is spawned.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'subagentStop', hookEvent:'SubagentStop', category:'Agents', label:'Subagent Finished', description:'A Claude subagent finishes.', defaultEnabled:true, sound:'calm-complete', volume:45, repeat:1 },
  { id:'taskCreated', hookEvent:'TaskCreated', category:'Tasks', label:'Task Created', description:'Claude creates a task.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'taskCompleted', hookEvent:'TaskCompleted', category:'Tasks', label:'Task Completed', description:'Claude marks a task as completed.', defaultEnabled:true, sound:'success-chime', volume:45, repeat:1 },
  { id:'stop', hookEvent:'Stop', category:'Turn', label:'Claude Finished', description:'Claude finishes responding normally.', defaultEnabled:true, sound:'done-fanfare', volume:55, repeat:1 },
  { id:'stopFailure', hookEvent:'StopFailure', category:'Errors', label:'Claude API / Turn Error', description:'The turn ends due to an API/model/auth/rate-limit error.', defaultEnabled:true, sound:'error-impact', volume:100, repeat:3 },
  { id:'teammateIdle', hookEvent:'TeammateIdle', category:'Agents', label:'Teammate Idle', description:'An agent-team teammate is about to go idle.', defaultEnabled:true, sound:'soft-bell', volume:45, repeat:1 },
  { id:'configChange', hookEvent:'ConfigChange', category:'System', label:'Claude Config Changed', description:'Claude settings/policy/skills configuration changes.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1 },
  { id:'cwdChanged', hookEvent:'CwdChanged', category:'System', label:'Working Directory Changed', description:'Claude changes the working directory.', defaultEnabled:false, sound:'soft-pop', volume:20, repeat:1 },
  { id:'directoryAdded', hookEvent:'DirectoryAdded', category:'System', label:'Directory Added', description:'A working directory is added during a session.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'fileChanged', hookEvent:'FileChanged', category:'Files', label:'Watched File Changed', description:'A configured watched filename changes on disk.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1, requiresFiles:true },
  { id:'worktreeCreate', hookEvent:'WorktreeCreate', category:'System', label:'Worktree Created', description:'Safety-protected: Claude Code replaces normal worktree creation when this hook is configured.', defaultEnabled:false, sound:'gentle-chime', volume:30, repeat:1, unavailable:true },
  { id:'worktreeRemove', hookEvent:'WorktreeRemove', category:'System', label:'Worktree Removed', description:'A Claude-created worktree is being removed.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'preCompact', hookEvent:'PreCompact', category:'Context', label:'Before Context Compaction', description:'Claude is about to compact conversation context.', defaultEnabled:false, sound:'gentle-chime', volume:25, repeat:1 },
  { id:'postCompact', hookEvent:'PostCompact', category:'Context', label:'Context Compacted', description:'Context compaction has completed.', defaultEnabled:false, sound:'calm-complete', volume:30, repeat:1 },
  { id:'sessionEnd', hookEvent:'SessionEnd', category:'Session', label:'Session Ended', description:'A Claude Code session terminates.', defaultEnabled:false, sound:'calm-complete', volume:35, repeat:1 },
  { id:'elicitation', hookEvent:'Elicitation', category:'Attention', label:'MCP Needs Input', description:'An MCP server requests user input.', defaultEnabled:true, sound:'bright-ping', volume:80, repeat:2 },
  { id:'elicitationResult', hookEvent:'ElicitationResult', category:'Attention', label:'MCP Input Answered', description:'A user response to MCP elicitation is ready.', defaultEnabled:false, sound:'soft-pop', volume:30, repeat:1 }
];
const EVENT_MAP = new Map(EVENT_DEFS.map(e => [e.id, e]));
const EVENT_BY_HOOK = new Map(EVENT_DEFS.filter(e => !e.virtual).map(e => [e.hookEvent, e.id]));
const CATEGORIES = [...new Set(EVENT_DEFS.map(e => e.category))];

let server;
let output;
let extensionContext;
let retryTimer;
let controlPanel;
let statusItem;
const lastPlayedAt = new Map();

function cfg() { return vscode.workspace.getConfiguration('claudeSoundAlerts'); }
function log(message) { output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`); }
function clamp(n, min, max) { n = Number(n); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getPort() { return clamp(cfg().get('serverPort', 47391), 1024, 65535); }
function endpointFor(port = getPort()) { return `http://127.0.0.1:${port}/${EXTENSION_TAG}/hook`; }

function defaultEventSetting(def) {
  return { enabled: !!def.defaultEnabled, sound: def.sound, volume: def.volume, repeat: def.repeat };
}
function allEventSettings() {
  const raw = cfg().get('eventSettings', {}) || {};
  const out = {};
  for (const def of EVENT_DEFS) {
    const r = raw[def.id] && typeof raw[def.id] === 'object' ? raw[def.id] : {};
    out[def.id] = {
      enabled: def.unavailable ? false : (r.enabled === undefined ? !!def.defaultEnabled : !!r.enabled),
      sound: typeof r.sound === 'string' ? r.sound : def.sound,
      volume: Math.round(clamp(r.volume === undefined ? def.volume : r.volume, 0, 200)),
      repeat: Math.round(clamp(r.repeat === undefined ? def.repeat : r.repeat, 1, 5))
    };
  }
  return out;
}
function eventSetting(id) { return allEventSettings()[id] || null; }
async function updateEventSetting(id, key, value) {
  const def = EVENT_MAP.get(id);
  if (!def || def.unavailable) return;
  const raw = { ...(cfg().get('eventSettings', {}) || {}) };
  raw[id] = { ...(raw[id] || {}) };
  if (key === 'enabled') raw[id][key] = !!value;
  else if (key === 'volume') raw[id][key] = Math.round(clamp(value, 0, 200));
  else if (key === 'repeat') raw[id][key] = Math.round(clamp(value, 1, 5));
  else if (key === 'sound') raw[id][key] = String(value);
  else return;
  await cfg().update('eventSettings', raw, vscode.ConfigurationTarget.Global);
}

function presetSoundPath(id) {
  const safeId = PRESET_IDS.has(id) ? id : 'soft-bell';
  return extensionContext.asAbsolutePath(path.join('media', 'sounds', `${safeId}.wav`));
}
function customSoundLibrary() {
  const list = extensionContext.globalState.get('customSoundLibrary', []);
  return Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string' && typeof x.path === 'string' && fs.existsSync(x.path)) : [];
}
function allSoundOptions() {
  return [
    ...SOUND_PRESETS.map(s => ({ ...s, builtIn:true })),
    ...customSoundLibrary().map(s => ({ id:s.id, label:s.label, builtIn:false }))
  ];
}
function soundPathFor(id) {
  if (PRESET_IDS.has(id)) return presetSoundPath(id);
  const custom = customSoundLibrary().find(s => s.id === id);
  if (custom) return custom.path;
  return presetSoundPath('soft-bell');
}

function findWavChunks(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The selected sound is not a valid WAV file.');
  }
  let offset = 12, fmt, data;
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
function validatePcmWav(buffer) {
  const { fmt } = findWavChunks(buffer);
  const format = buffer.readUInt16LE(fmt.start);
  const bits = buffer.readUInt16LE(fmt.start + 14);
  if (format !== 1) throw new Error('Use a standard uncompressed PCM WAV file.');
  if (![8,16,24,32].includes(bits)) throw new Error(`Unsupported PCM bit depth: ${bits}. Use 8, 16, 24, or 32-bit WAV.`);
  return true;
}
function scalePcmWav(buffer, volumePercent) {
  const { fmt, data } = findWavChunks(buffer);
  const format = buffer.readUInt16LE(fmt.start);
  const bits = buffer.readUInt16LE(fmt.start + 14);
  if (format !== 1) throw new Error('This WAV is not uncompressed PCM.');
  if (![8,16,24,32].includes(bits)) throw new Error(`Unsupported WAV bit depth: ${bits}.`);
  const gain = clamp(volumePercent, 0, 200) / 100;
  const out = Buffer.from(buffer);
  const end = data.start + data.size;
  if (bits === 8) {
    for (let i=data.start; i<end; i++) {
      const v = out[i] - 128;
      out[i] = Math.max(0, Math.min(255, Math.round(v * gain + 128)));
    }
  } else if (bits === 16) {
    for (let i=data.start; i+1<end; i+=2) {
      const v = out.readInt16LE(i);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * gain))), i);
    }
  } else if (bits === 24) {
    for (let i=data.start; i+2<end; i+=3) {
      let v = out[i] | (out[i+1]<<8) | (out[i+2]<<16);
      if (v & 0x800000) v |= 0xff000000;
      const s = Math.max(-8388608, Math.min(8388607, Math.round(v * gain)));
      out[i]=s&0xff; out[i+1]=(s>>8)&0xff; out[i+2]=(s>>16)&0xff;
    }
  } else {
    for (let i=data.start; i+3<end; i+=4) {
      const v = out.readInt32LE(i);
      const s = Math.max(-2147483648, Math.min(2147483647, Math.round(v * gain)));
      out.writeInt32LE(s, i);
    }
  }
  return out;
}
async function volumeAdjustedWav(file, volumePercent) {
  const volume = Math.round(clamp(volumePercent, 0, 200));
  if (volume === 100) return file;
  const stat = await fs.promises.stat(file);
  const key = crypto.createHash('sha256').update(`${file}|${stat.size}|${stat.mtimeMs}|${volume}`).digest('hex').slice(0,24);
  const cacheDir = path.join(extensionContext.globalStorageUri.fsPath, 'audio-cache');
  const cached = path.join(cacheDir, `${key}.wav`);
  try { await fs.promises.access(cached, fs.constants.R_OK); return cached; } catch (_) {}
  const input = await fs.promises.readFile(file);
  validatePcmWav(input);
  const adjusted = scalePcmWav(input, volume);
  await fs.promises.mkdir(cacheDir, { recursive:true });
  await fs.promises.writeFile(cached, adjusted);
  return cached;
}

function spawnCaptured(command, args, options={}) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{ windowsHide:true, stdio:['ignore','pipe','pipe'], ...options });
    let stdout='', stderr='';
    child.stdout?.on('data', d => stdout += String(d));
    child.stderr?.on('data', d => stderr += String(d));
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) return resolve({stdout,stderr});
      const detail=(stderr||stdout||'').trim();
      reject(new Error(`${command} exited with code ${code}${detail?`: ${detail}`:''}`));
    });
  });
}
async function playRawWav(file) {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System',
      '$p = New-Object System.Media.SoundPlayer',
      '$p.SoundLocation = $env:CLAUDE_SOUND_FILE',
      '$p.Load()',
      '$p.PlaySync()'
    ].join('; ');
    const encoded = Buffer.from(script,'utf16le').toString('base64');
    const env = { ...process.env, CLAUDE_SOUND_FILE:file };
    let firstError;
    for (const command of ['powershell.exe','pwsh.exe']) {
      try { await spawnCaptured(command,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{env}); return; }
      catch (e) { if (!firstError) firstError=e; if (e?.code==='ENOENT') continue; log(`${command} audio attempt failed: ${e.message||e}`); }
    }
    throw firstError || new Error('No PowerShell audio host is available.');
  }
  if (process.platform === 'darwin') { await spawnCaptured('afplay',[file]); return; }
  let lastError;
  for (const [cmd,args] of [['paplay',[file]],['ffplay',['-nodisp','-autoexit','-loglevel','quiet',file]],['aplay',[file]]]) {
    try { await spawnCaptured(cmd,args); return; } catch(e) { lastError=e; }
  }
  throw lastError || new Error('No supported Linux WAV player found.');
}
async function playAudioFile(file, volume, repeat) {
  const vol = Math.round(clamp(volume,0,200));
  if (vol <= 0) return;
  const adjusted = await volumeAdjustedWav(file, vol);
  const count = Math.round(clamp(repeat,1,5));
  const gap = Math.round(clamp(cfg().get('repeatGapMs',150),0,3000));
  for (let i=0;i<count;i++) {
    await playRawWav(adjusted);
    if (i < count-1 && gap) await sleep(gap);
  }
}

function reasonFor(body, id) {
  const e = body?.hook_event_name || 'Claude event';
  switch(id) {
    case 'askUserQuestion': return 'Claude asked a question';
    case 'exitPlanMode': return 'Claude is waiting for plan approval';
    case 'permissionRequest': return `Permission requested${body.tool_name?` for ${body.tool_name}`:''}`;
    case 'permissionDenied': return `Permission denied${body.tool_name?` for ${body.tool_name}`:''}`;
    case 'postToolUseFailure': return `Tool failed${body.tool_name?`: ${body.tool_name}`:''}`;
    case 'postToolUse': return `Tool succeeded${body.tool_name?`: ${body.tool_name}`:''}`;
    case 'preToolUse': return `Tool starting${body.tool_name?`: ${body.tool_name}`:''}`;
    case 'notification': return `Notification${body.notification_type?`: ${body.notification_type}`:''}`;
    case 'subagentStart': return `Subagent started${body.agent_type?`: ${body.agent_type}`:''}`;
    case 'subagentStop': return `Subagent finished${body.agent_type?`: ${body.agent_type}`:''}`;
    case 'taskCreated': return `Task created${body.task_subject?`: ${body.task_subject}`:''}`;
    case 'taskCompleted': return `Task completed${body.task_subject?`: ${body.task_subject}`:''}`;
    case 'stop': return 'Claude finished responding';
    case 'stopFailure': return `Claude stopped with an error${body.error?`: ${body.error}`:''}`;
    case 'teammateIdle': return `Teammate idle${body.teammate_name?`: ${body.teammate_name}`:''}`;
    case 'configChange': return `Claude configuration changed${body.source?`: ${body.source}`:''}`;
    case 'cwdChanged': return 'Working directory changed';
    case 'directoryAdded': return `Directory added${body.directory?`: ${body.directory}`:''}`;
    case 'fileChanged': return `Watched file ${body.event||'changed'}${body.file_path?`: ${path.basename(body.file_path)}`:''}`;
    case 'preCompact': return `Context compaction starting${body.trigger?`: ${body.trigger}`:''}`;
    case 'postCompact': return `Context compaction finished${body.trigger?`: ${body.trigger}`:''}`;
    case 'sessionStart': return `Claude session started${body.source?`: ${body.source}`:''}`;
    case 'sessionEnd': return `Claude session ended${body.reason?`: ${body.reason}`:''}`;
    case 'elicitation': return `MCP needs input${body.mcp_server_name?`: ${body.mcp_server_name}`:''}`;
    case 'elicitationResult': return `MCP input answered${body.mcp_server_name?`: ${body.mcp_server_name}`:''}`;
    case 'instructionsLoaded': return 'Claude instructions loaded';
    case 'userPromptSubmit': return 'Prompt submitted';
    case 'userPromptExpansion': return 'Prompt expanded';
    case 'messageDisplay': return 'Claude message displayed';
    case 'postToolBatch': return 'Parallel tool batch finished';
    case 'setup': return 'Claude setup event';
    case 'worktreeRemove': return 'Worktree removed';
    default: return e;
  }
}
function candidateProfiles(body) {
  const event = body?.hook_event_name;
  if (event === 'PreToolUse') {
    if (body.tool_name === 'AskUserQuestion') return ['askUserQuestion','preToolUse'];
    if (body.tool_name === 'ExitPlanMode') return ['exitPlanMode','preToolUse'];
    return ['preToolUse'];
  }
  const id = EVENT_BY_HOOK.get(event);
  return id ? [id] : [];
}
function classifyHook(body) {
  const settings = allEventSettings();
  for (const id of candidateProfiles(body)) {
    if (settings[id]?.enabled) return { id, reason:reasonFor(body,id) };
  }
  return null;
}
function shouldPlay(id) {
  if (!cfg().get('enabled',true)) return false;
  const debounce = Math.round(clamp(cfg().get('debounceMs',650),0,10000));
  const now=Date.now(), last=lastPlayedAt.get(id)||0;
  if (now-last < debounce) return false;
  lastPlayedAt.set(id,now); return true;
}
async function playProfile(id, reason, force=false, overrides={}) {
  const def=EVENT_MAP.get(id); if (!def) return;
  const setting=eventSetting(id); if (!setting) return;
  if (!force && (!setting.enabled || !shouldPlay(id))) return;
  const sound = overrides.sound || setting.sound;
  const volume = overrides.volume===undefined ? setting.volume : Math.round(clamp(overrides.volume,0,200));
  const repeat = overrides.repeat===undefined ? setting.repeat : Math.round(clamp(overrides.repeat,1,5));
  const file = soundPathFor(sound);
  log(`${def.label}: ${reason} | sound=${sound} volume=${volume}% repeat=${repeat} | ${file}`);
  if (cfg().get('showVisualNotifications',false) && !force) vscode.window.showInformationMessage(`${def.label}: ${reason}`);
  try { await playAudioFile(file,volume,repeat); }
  catch(error) {
    const message=error?.message||String(error); log(`Unable to play sound: ${message}`);
    vscode.window.showWarningMessage(`Claude Sound Alerts could not play audio: ${message}`,'Open Log').then(c=>{ if(c==='Open Log') output.show(true); });
  }
}

function startServer() {
  stopServer();
  if (!cfg().get('enabled',true)) { log('Listener disabled by settings.'); updateStatusBar(); return; }
  const port=getPort();
  server=http.createServer((req,res)=>{
    if (req.method!=='POST' || req.url!==`/${EXTENSION_TAG}/hook`) { res.writeHead(404); res.end(); return; }
    let raw=''; req.setEncoding('utf8');
    req.on('data',chunk=>{ raw+=chunk; if(raw.length>1024*1024) req.destroy(); });
    req.on('end',()=>{
      try {
        const body=raw?JSON.parse(raw):{};
        const result=classifyHook(body);
        if(result) void playProfile(result.id,result.reason);
        else log(`Ignored/disabled hook event: ${body.hook_event_name||'unknown'}${body.tool_name?` / ${body.tool_name}`:''}${body.notification_type?` / ${body.notification_type}`:''}`);
        // 204 is deliberately non-interfering for notification-only HTTP hooks.
        res.writeHead(204); res.end();
      } catch(error) { log(`Invalid hook request: ${error.message||error}`); res.writeHead(400); res.end(); }
    });
  });
  server.on('error',error=>{
    log(`Listener error on port ${port}: ${error.message||error}`);
    if(error?.code==='EADDRINUSE') {
      log('Port is in use, likely by another VS Code window. Retrying periodically.');
      try{server?.close();}catch(_){} server=undefined; retryTimer=setTimeout(startServer,5000); updateStatusBar(); return;
    }
    vscode.window.showErrorMessage(`Claude Sound Alerts could not listen on localhost:${port}.`); updateStatusBar();
  });
  server.listen(port,'127.0.0.1',()=>{ log(`Listening for Claude Code hooks at ${endpointFor(port)}`); updateStatusBar(); void sendUiState(); });
}
function stopServer(){ if(retryTimer){clearTimeout(retryTimer);retryTimer=undefined;} if(server){try{server.close();}catch(_){} server=undefined;} }

function hookHandler(url){ return {type:'http',url,timeout:2}; }
function claudeSettingsPath(){ return path.join(os.homedir(),'.claude','settings.json'); }
function relayScriptPath(){ return path.join(os.homedir(),'.claude', process.platform==='win32' ? `${RELAY_TAG}.ps1` : `${RELAY_TAG}.sh`); }
async function ensureRelayScript(){
  const file=relayScriptPath(); await fs.promises.mkdir(path.dirname(file),{recursive:true});
  if(process.platform==='win32') {
    const text = `param([string]$Url)\n$ErrorActionPreference = 'SilentlyContinue'\n$body = [Console]::In.ReadToEnd()\ntry { Invoke-WebRequest -UseBasicParsing -Uri $Url -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 2 | Out-Null } catch {}\nexit 0\n`;
    await fs.promises.writeFile(file,text,'utf8');
  } else {
    const text = `#!/bin/sh\nurl="$1"\nif command -v curl >/dev/null 2>&1; then curl -sS --max-time 2 -X POST -H 'Content-Type: application/json' --data-binary @- "$url" >/dev/null 2>&1 || true; else cat >/dev/null; fi\nexit 0\n`;
    await fs.promises.writeFile(file,text,{encoding:'utf8',mode:0o700}); try{await fs.promises.chmod(file,0o700);}catch(_){}
  }
  return file;
}
function quoteShellArg(value){ return `"${String(value).replace(/"/g,'\\"')}"`; }
function commandRelayHandler(url){
  const file=relayScriptPath();
  const command = process.platform==='win32'
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoteShellArg(file)} ${quoteShellArg(url)}`
    : `sh ${quoteShellArg(file)} ${quoteShellArg(url)}`;
  return {type:'command',command,timeout:2};
}
function desiredHookGroups(url){
  const out={};
  const httpEvents = EVENT_DEFS.filter(d=>!d.virtual && !d.unavailable && d.transport!=='command' && d.hookEvent!=='FileChanged').map(d=>d.hookEvent);
  for(const event of new Set(httpEvents)) out[event]=[{hooks:[hookHandler(url)]}];
  // Capture every PreToolUse once; the listener distinguishes AskUserQuestion/ExitPlanMode from generic tool starts.
  out.PreToolUse=[{hooks:[hookHandler(url)]}];
  out.SessionStart=[{hooks:[commandRelayHandler(url)]}];
  out.Setup=[{hooks:[commandRelayHandler(url)]}];
  const names=(cfg().get('watchedFiles',[])||[]).map(String).map(s=>s.trim()).filter(Boolean).filter(s=>!s.includes('|'));
  if(names.length) out.FileChanged=[{matcher:[...new Set(names)].join('|'),hooks:[hookHandler(url)]}];
  return out;
}
function isOurHandler(handler){
  if(!handler || typeof handler!=='object') return false;
  if(handler.type==='http' && typeof handler.url==='string' && handler.url.includes(`/${EXTENSION_TAG}/hook`)) return true;
  if(handler.type==='command' && typeof handler.command==='string' && handler.command.includes(RELAY_TAG)) return true;
  return false;
}
function removeOurHooksFromSettings(settings){
  if(!settings.hooks || typeof settings.hooks!=='object') return settings;
  for(const event of Object.keys(settings.hooks)) {
    if(!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event]=settings.hooks[event].map(group=>{
      if(!group || !Array.isArray(group.hooks)) return group;
      return {...group,hooks:group.hooks.filter(h=>!isOurHandler(h))};
    }).filter(group=>!group || !Array.isArray(group.hooks) || group.hooks.length>0);
    if(settings.hooks[event].length===0) delete settings.hooks[event];
  }
  if(Object.keys(settings.hooks).length===0) delete settings.hooks;
  return settings;
}
async function readClaudeSettings(){
  try{const text=await fs.promises.readFile(claudeSettingsPath(),'utf8');return text.trim()?JSON.parse(text):{};}
  catch(error){if(error.code==='ENOENT')return{};throw error;}
}
async function writeClaudeSettings(settings){
  const file=claudeSettingsPath(); await fs.promises.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`; await fs.promises.writeFile(temp,JSON.stringify(settings,null,2)+'\n','utf8'); await fs.promises.rename(temp,file); return file;
}
async function hookInstallStatus(){
  try{
    const settings=await readClaudeSettings(); const desired=desiredHookGroups(endpointFor(getPort()));
    let installed=0,total=0;
    for(const event of Object.keys(desired)) {
      total++;
      const groups=Array.isArray(settings.hooks?.[event])?settings.hooks[event]:[];
      if(groups.some(g=>Array.isArray(g?.hooks)&&g.hooks.some(isOurHandler))) installed++;
    }
    return {installed,total,complete:total>0&&installed===total};
  }catch(_){return{installed:0,total:0,complete:false};}
}
async function installHooks(showMessage=true){
  try{
    await ensureRelayScript();
    const url=endpointFor(getPort()); const settings=removeOurHooksFromSettings(await readClaudeSettings()); settings.hooks=settings.hooks||{};
    for(const [event,groups] of Object.entries(desiredHookGroups(url))) {
      settings.hooks[event]=Array.isArray(settings.hooks[event])?settings.hooks[event]:[]; settings.hooks[event].push(...groups);
    }
    const file=await writeClaudeSettings(settings); log(`Installed Claude Code hooks in ${file}`);
    if(showMessage) vscode.window.showInformationMessage('Claude Code Sound Alerts hooks installed/updated.');
    await sendUiState(); updateStatusBar(); return true;
  }catch(error){log(`Hook installation failed: ${error.stack||error}`);vscode.window.showErrorMessage(`Could not install Claude Code hooks: ${error.message||error}`);return false;}
}
async function uninstallHooks(showMessage=true){
  try{
    const settings=removeOurHooksFromSettings(await readClaudeSettings()); const file=await writeClaudeSettings(settings);
    try{await fs.promises.unlink(relayScriptPath());}catch(_){}
    log(`Removed Claude Sound Alerts hooks from ${file}`); if(showMessage)vscode.window.showInformationMessage('Claude Code Sound Alerts hooks removed.');
    await sendUiState(); updateStatusBar(); return true;
  }catch(error){log(`Hook removal failed: ${error.stack||error}`);vscode.window.showErrorMessage(`Could not remove Claude Code hooks: ${error.message||error}`);return false;}
}

async function addSoundToLibrary(preview=true){
  const result=await vscode.window.showOpenDialog({canSelectMany:false,canSelectFiles:true,canSelectFolders:false,title:'Add Sound to Claude Alerts Library',filters:{'PCM WAV audio':['wav']}});
  if(!result?.length)return null;
  const source=result[0].fsPath;
  try{
    const buffer=await fs.promises.readFile(source); validatePcmWav(buffer);
    const hash=crypto.createHash('sha256').update(buffer).digest('hex').slice(0,12);
    const id=`user-${hash}`; const label=path.basename(source,path.extname(source));
    const dir=path.join(extensionContext.globalStorageUri.fsPath,'sound-library'); await fs.promises.mkdir(dir,{recursive:true});
    const dest=path.join(dir,`${id}.wav`); await fs.promises.writeFile(dest,buffer);
    let list=customSoundLibrary().filter(s=>s.id!==id); list.push({id,label,path:dest}); await extensionContext.globalState.update('customSoundLibrary',list);
    log(`Added custom sound to library: ${label} (${dest})`); await sendUiState();
    if(preview) await playAudioFile(dest,100,1);
    return id;
  }catch(error){vscode.window.showErrorMessage(`Cannot add this sound: ${error.message||error}`);return null;}
}
async function removeCustomSound(id){
  const current=customSoundLibrary(); const target=current.find(s=>s.id===id); if(!target)return;
  await extensionContext.globalState.update('customSoundLibrary',current.filter(s=>s.id!==id)); try{await fs.promises.unlink(target.path);}catch(_){}
  const raw={...(cfg().get('eventSettings',{})||{})};
  for(const def of EVENT_DEFS) if(raw[def.id]?.sound===id) raw[def.id]={...raw[def.id],sound:def.sound};
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global); await sendUiState();
}

async function migrateV131QuestionSound(){
  if(extensionContext.globalState.get('v131QuestionSoundApplied',false))return;
  const raw={...(cfg().get('eventSettings',{})||{})};
  const current=raw.askUserQuestion&&typeof raw.askUserQuestion==='object'?raw.askUserQuestion:{};
  const def=EVENT_MAP.get('askUserQuestion');
  raw.askUserQuestion={...defaultEventSetting(def),...current,sound:'question-chime'};
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global);
  await extensionContext.globalState.update('v131QuestionSoundApplied',true);
  log('Set the user-provided Question Chime as the Ask User Question sound.');
}


async function migrateV132DoneAndErrorSounds(){
  if(extensionContext.globalState.get('v132DoneAndErrorSoundsApplied',false))return;
  const raw={...(cfg().get('eventSettings',{})||{})};
  const applySound=(id,sound)=>{
    const def=EVENT_MAP.get(id);
    const current=raw[id]&&typeof raw[id]==='object'?raw[id]:{};
    raw[id]={...defaultEventSetting(def),...current,sound};
  };
  applySound('stop','done-fanfare');
  for(const id of ['postToolUseFailure','permissionDenied','stopFailure']) applySound(id,'error-impact');
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global);
  await extensionContext.globalState.update('v132DoneAndErrorSoundsApplied',true);
  log('Set the user-provided Done Fanfare for Claude Finished and Error Impact for error events.');
}

async function migrateV12Settings(){
  if(extensionContext.globalState.get('v13MigrationDone',false))return;
  const legacyKeys=['questionSound','finishedSound','questionVolume','finishedVolume','questionSoundEnabled','finishedSoundEnabled','questionSoundPath','finishedSoundPath'];
  const hasLegacy=legacyKeys.some(k=>cfg().inspect(k)?.globalValue!==undefined);
  if(!hasLegacy){await extensionContext.globalState.update('v13MigrationDone',true);return;}
  const raw={...(cfg().get('eventSettings',{})||{})};
  let qSound=String(cfg().get('questionSound','soft-bell')); let fSound=String(cfg().get('finishedSound','success-chime'));
  const importLegacy=async(kind,sound,pathKey)=>{
    if(sound!=='custom')return sound;
    const file=String(cfg().get(pathKey,'')||''); if(!file||!fs.existsSync(file))return kind==='question'?'soft-bell':'success-chime';
    try{
      const buffer=await fs.promises.readFile(file); validatePcmWav(buffer); const hash=crypto.createHash('sha256').update(buffer).digest('hex').slice(0,12); const id=`user-${hash}`;
      const dir=path.join(extensionContext.globalStorageUri.fsPath,'sound-library'); await fs.promises.mkdir(dir,{recursive:true}); const dest=path.join(dir,`${id}.wav`); await fs.promises.writeFile(dest,buffer);
      let list=customSoundLibrary().filter(s=>s.id!==id); list.push({id,label:path.basename(file,path.extname(file)),path:dest}); await extensionContext.globalState.update('customSoundLibrary',list); return id;
    }catch(_){return kind==='question'?'soft-bell':'success-chime';}
  };
  qSound=await importLegacy('question',qSound,'questionSoundPath'); fSound=await importLegacy('finished',fSound,'finishedSoundPath');
  const q={enabled:cfg().get('questionSoundEnabled',true),sound:qSound,volume:Math.round(clamp(cfg().get('questionVolume',70),0,200)),repeat:1};
  const f={enabled:cfg().get('finishedSoundEnabled',true),sound:fSound,volume:Math.round(clamp(cfg().get('finishedVolume',50),0,200)),repeat:1};
  for(const id of ['askUserQuestion','exitPlanMode','permissionRequest','elicitation']) if(!raw[id]) raw[id]={...q};
  if(!raw.stop) raw.stop={...f};
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global); await extensionContext.globalState.update('v13MigrationDone',true); log('Migrated v1.2 sound choices to v1.3 event settings.');
}

const PRESET_GROUPS={
  minimal:new Set(['askUserQuestion','permissionRequest','stop']),
  recommended:new Set(['askUserQuestion','exitPlanMode','permissionRequest','permissionDenied','notification','postToolUseFailure','subagentStop','taskCompleted','stop','stopFailure','teammateIdle','elicitation'])
};
async function applyPreset(name){
  const raw={...(cfg().get('eventSettings',{})||{})};
  for(const def of EVENT_DEFS) {
    if(def.unavailable) continue;
    const enabled = name==='everything' ? true : (PRESET_GROUPS[name]?.has(def.id)||false);
    raw[def.id]={...(raw[def.id]||{}),enabled};
  }
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global); await sendUiState();
}

function nonce(){return crypto.randomBytes(16).toString('base64');}
async function getUiState(){
  const hs=await hookInstallStatus();
  return {
    enabled:cfg().get('enabled',true), visualNotifications:cfg().get('showVisualNotifications',false), repeatGapMs:Math.round(clamp(cfg().get('repeatGapMs',150),0,3000)),
    hooks:hs, listenerActive:Boolean(server?.listening), platform:process.platform,
    events:EVENT_DEFS.map(d=>({...d,setting:eventSetting(d.id)})), categories:CATEGORIES, sounds:allSoundOptions(), watchedFiles:cfg().get('watchedFiles',[])||[]
  };
}
async function sendUiState(){if(!controlPanel)return;try{await controlPanel.webview.postMessage({type:'state',state:await getUiState()});}catch(_){} }

function controlPanelHtml(webview,initialState){
  const n=nonce(); const stateJson=JSON.stringify(initialState).replace(/</g,'\\u003c');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';"><title>Claude Code Sound Alerts</title>
<style>
:root{color-scheme:light dark}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:22px}.wrap{max-width:1180px;margin:auto}h1{font-size:24px;margin:0 0 5px}.sub,.hint,.note{color:var(--vscode-descriptionForeground)}.sub{margin-bottom:16px}.bar,.panel,.event{border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-sideBar-background)}.bar,.panel{padding:14px;margin-bottom:14px}.bar{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap}.actions,.filters,.status{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 9px;font-size:12px}.ok{color:var(--vscode-testing-iconPassed)}.warn{color:var(--vscode-editorWarning-foreground)}button,select,input{font:inherit}button{border:0;border-radius:6px;padding:7px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button:disabled{opacity:.5;cursor:not-allowed}select,input[type=text],input[type=number]{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:6px;padding:6px 8px}.panelgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.eventgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.event{padding:14px}.event.disabled-card{opacity:.7}.head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.title{font-weight:600}.badge{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px}.hint{font-size:12px;margin:4px 0 12px}.controlgrid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(100px,1fr) 90px;gap:10px;align-items:end}.field label{display:block;font-size:12px;margin-bottom:4px}.field select,.field input[type=range]{width:100%;box-sizing:border-box}.volline{display:flex;gap:8px;align-items:center}.volline input{flex:1}.value{min-width:48px;text-align:right;font-size:12px}.eventactions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.boost{color:var(--vscode-editorWarning-foreground);font-size:11px}.library-list{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.soundchip{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 8px;font-size:12px}.search{min-width:220px}.filewatch{width:100%;box-sizing:border-box}.footerline{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.toast{min-height:18px;margin-top:10px}.safety{color:var(--vscode-editorWarning-foreground);font-size:12px;margin-top:8px}@media(max-width:820px){.panelgrid,.eventgrid{grid-template-columns:1fr}.controlgrid{grid-template-columns:1fr}.search{min-width:0;width:100%}} 
</style></head><body><div class="wrap"><h1>Claude Code Sound Alerts</h1><div class="sub">Configure a separate sound, 0–200% volume, and 1–5 repeats for Claude Code lifecycle events.</div>
<div class="bar"><div class="status"><span id="hookStatus" class="pill"></span><span id="listenerStatus" class="pill"></span></div><div class="actions"><button id="installHooks">Install / Update Hooks</button><button id="removeHooks" class="secondary">Remove Hooks</button><button id="openLog" class="secondary">Open Log</button></div></div>
<div class="panel"><div class="panelgrid"><div><div class="title">Alert presets</div><div class="hint">Presets only change which events are enabled; your sound/volume/repeat choices are preserved.</div><div class="actions"><button data-preset="minimal" class="secondary">Minimal</button><button data-preset="recommended">Recommended</button><button data-preset="everything" class="secondary">Everything</button></div></div><div><div class="title">Sound library</div><div class="hint">Built-in sounds plus WAV files you add yourself.</div><div class="actions"><button id="addSound">Add WAV to My Sounds…</button></div><div id="customSounds" class="library-list"></div></div></div></div>
<div class="panel"><div class="panelgrid"><div><div class="title">FileChanged event</div><div class="hint">Claude requires literal filenames to watch. Separate names with commas, e.g. <code>.env, package.json</code>.</div><input id="watchedFiles" class="filewatch" type="text" placeholder=".env, package.json"></div><div><div class="title">Global controls</div><div class="footerline"><label><input id="enabled" type="checkbox"> Enable alerts</label><label><input id="visual" type="checkbox"> VS Code popups</label><label>Repeat gap <input id="gap" type="number" min="0" max="3000" step="50" style="width:80px"> ms</label></div><div class="note">Volume above 100% digitally boosts the WAV and may clip. Windows master volume still applies.</div></div></div></div>
<div class="bar"><div class="filters"><input id="search" class="search" type="text" placeholder="Search events…"><select id="category"><option value="">All categories</option></select></div><div class="note">Very frequent events such as Message Display and Tool Starting are off by default.</div></div>
<div id="events" class="eventgrid"></div><div id="toast" class="toast note" aria-live="polite"></div></div>
<script nonce="${n}">(()=>{const vscode=acquireVsCodeApi();let state=${stateJson};const $=id=>document.getElementById(id);function post(action,extra={}){vscode.postMessage({action,...extra})}function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function soundOptions(selected){return(state.sounds||[]).map(s=>'<option value="'+esc(s.id)+'" '+(s.id===selected?'selected':'')+'>'+esc(s.label)+(s.builtIn?'':' (My Sound)')+'</option>').join('')}function renderLibrary(){const custom=(state.sounds||[]).filter(s=>!s.builtIn);$('customSounds').innerHTML=custom.length?custom.map(s=>'<span class="soundchip">'+esc(s.label)+' <button class="secondary removeSound" data-id="'+esc(s.id)+'" title="Remove" style="padding:1px 5px">×</button></span>').join(''):'<span class="note">No personal sounds added yet.</span>';document.querySelectorAll('.removeSound').forEach(b=>b.addEventListener('click',()=>post('removeSound',{id:b.dataset.id})))}function eventCard(e){const s=e.setting||{};const locked=!!e.unavailable;return '<section class="event '+(locked?'disabled-card':'')+'" data-id="'+esc(e.id)+'" data-category="'+esc(e.category)+'" data-search="'+esc((e.label+' '+e.description+' '+e.hookEvent).toLowerCase())+'"><div class="head"><div><div class="title">'+esc(e.label)+'</div><span class="badge">'+esc(e.hookEvent)+'</span> <span class="badge">'+esc(e.category)+'</span></div><label><input class="evtEnabled" type="checkbox" '+(s.enabled?'checked':'')+' '+(locked?'disabled':'')+'> On</label></div><div class="hint">'+esc(e.description)+'</div>'+(locked?'<div class="safety">Not hooked: configuring WorktreeCreate would replace Claude Code’s normal worktree creation behavior.</div>':'<div class="controlgrid"><div class="field"><label>Sound</label><select class="evtSound">'+soundOptions(s.sound)+'</select></div><div class="field"><label>Volume <span class="boost">'+(s.volume>100?'BOOST':'')+'</span></label><div class="volline"><input class="evtVolume" type="range" min="0" max="200" value="'+s.volume+'"><span class="value">'+s.volume+'%</span></div></div><div class="field"><label>Repeat</label><select class="evtRepeat">'+[1,2,3,4,5].map(n=>'<option value="'+n+'" '+(n===s.repeat?'selected':'')+'>'+n+'×</option>').join('')+'</select></div></div><div class="eventactions"><button class="preview">Preview</button></div>')+'</section>'}function bindCards(){document.querySelectorAll('.event').forEach(card=>{const id=card.dataset.id;const en=card.querySelector('.evtEnabled'),sound=card.querySelector('.evtSound'),vol=card.querySelector('.evtVolume'),rep=card.querySelector('.evtRepeat'),preview=card.querySelector('.preview');if(en)en.addEventListener('change',e=>post('setEvent',{id,key:'enabled',value:e.target.checked}));if(sound)sound.addEventListener('change',e=>post('setEvent',{id,key:'sound',value:e.target.value}));if(vol){vol.addEventListener('input',e=>{card.querySelector('.value').textContent=e.target.value+'%';card.querySelector('.boost').textContent=Number(e.target.value)>100?'BOOST':''});vol.addEventListener('change',e=>post('setEvent',{id,key:'volume',value:Number(e.target.value)}))}if(rep)rep.addEventListener('change',e=>post('setEvent',{id,key:'repeat',value:Number(e.target.value)}));if(preview)preview.addEventListener('click',()=>post('preview',{id,volume:Number(vol.value),repeat:Number(rep.value),sound:sound.value}))})}function applyFilter(){const q=$('search').value.trim().toLowerCase(),cat=$('category').value;document.querySelectorAll('.event').forEach(c=>{c.style.display=(!q||c.dataset.search.includes(q))&&(!cat||c.dataset.category===cat)?'':'none'})}function render(){const hs=state.hooks||{};$('hookStatus').textContent=hs.complete?'Hooks installed ('+hs.installed+'/'+hs.total+')':'Hooks incomplete ('+hs.installed+'/'+hs.total+')';$('hookStatus').className='pill '+(hs.complete?'ok':'warn');$('listenerStatus').textContent=state.listenerActive?'Listener active':'Listener inactive';$('listenerStatus').className='pill '+(state.listenerActive?'ok':'warn');$('enabled').checked=!!state.enabled;$('visual').checked=!!state.visualNotifications;$('gap').value=state.repeatGapMs;$('watchedFiles').value=(state.watchedFiles||[]).join(', ');$('category').innerHTML='<option value="">All categories</option>'+(state.categories||[]).map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');$('events').innerHTML=(state.events||[]).map(eventCard).join('');renderLibrary();bindCards();applyFilter()}$('installHooks').addEventListener('click',()=>post('installHooks'));$('removeHooks').addEventListener('click',()=>post('removeHooks'));$('openLog').addEventListener('click',()=>post('openLog'));$('addSound').addEventListener('click',()=>post('addSound'));document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>post('applyPreset',{name:b.dataset.preset})));$('enabled').addEventListener('change',e=>post('setGlobal',{key:'enabled',value:e.target.checked}));$('visual').addEventListener('change',e=>post('setGlobal',{key:'showVisualNotifications',value:e.target.checked}));$('gap').addEventListener('change',e=>post('setGlobal',{key:'repeatGapMs',value:Number(e.target.value)}));$('watchedFiles').addEventListener('change',e=>post('setWatchedFiles',{value:e.target.value}));$('search').addEventListener('input',applyFilter);$('category').addEventListener('change',applyFilter);window.addEventListener('message',ev=>{const m=ev.data;if(m.type==='state'){state=m.state;render()}if(m.type==='toast')$('toast').textContent=m.text||''});render()})();</script></body></html>`;
}

async function openControlPanel(){
  if(controlPanel){controlPanel.reveal(vscode.ViewColumn.One);await sendUiState();return;}
  controlPanel=vscode.window.createWebviewPanel('claudeSoundAlerts.controlPanel','Claude Sound Alerts',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:true});
  controlPanel.webview.html=controlPanelHtml(controlPanel.webview,await getUiState()); controlPanel.onDidDispose(()=>{controlPanel=undefined;},null,extensionContext.subscriptions);
  controlPanel.webview.onDidReceiveMessage(async msg=>{
    try{
      if(msg.action==='setEvent'){await updateEventSetting(msg.id,msg.key,msg.value);await sendUiState();return;}
      if(msg.action==='preview'){await playProfile(msg.id,'Control panel preview',true,{sound:msg.sound,volume:msg.volume,repeat:msg.repeat});controlPanel?.webview.postMessage({type:'toast',text:'Preview played.'});return;}
      if(msg.action==='setGlobal'){
        const allowed=new Set(['enabled','showVisualNotifications','repeatGapMs']); if(!allowed.has(msg.key))return;
        const value=msg.key==='repeatGapMs'?Math.round(clamp(msg.value,0,3000)):msg.value; await cfg().update(msg.key,value,vscode.ConfigurationTarget.Global); if(msg.key==='enabled')startServer(); await sendUiState();updateStatusBar();return;
      }
      if(msg.action==='setWatchedFiles'){
        const names=String(msg.value||'').split(',').map(s=>s.trim()).filter(Boolean).filter(s=>!s.includes('|')); await cfg().update('watchedFiles',[...new Set(names)],vscode.ConfigurationTarget.Global);
        const hs=await hookInstallStatus(); if(hs.installed>0) await installHooks(false); else await sendUiState(); return;
      }
      if(msg.action==='addSound'){await addSoundToLibrary(false);return;}
      if(msg.action==='removeSound'){await removeCustomSound(msg.id);return;}
      if(msg.action==='applyPreset'){await applyPreset(msg.name);return;}
      if(msg.action==='installHooks'){await installHooks(false);return;}
      if(msg.action==='removeHooks'){await uninstallHooks(false);return;}
      if(msg.action==='openLog'){output.show(true);return;}
    }catch(error){log(`Control panel error: ${error.stack||error}`);controlPanel?.webview.postMessage({type:'toast',text:`Error: ${error.message||error}`});}
  },null,extensionContext.subscriptions);
}
function updateStatusBar(){if(!statusItem)return;if(!cfg().get('enabled',true)){statusItem.text='$(mute) Claude Alerts';statusItem.tooltip='Claude Code Sound Alerts are disabled. Click to configure.';}else{statusItem.text='$(unmute) Claude Alerts';statusItem.tooltip='Configure Claude Code Sound Alerts';}}

async function activate(context){
  extensionContext=context; output=vscode.window.createOutputChannel('Claude Code Sound Alerts'); context.subscriptions.push(output);
  await migrateV12Settings();
  await migrateV131QuestionSound();
  await migrateV132DoneAndErrorSounds();
  statusItem=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,100); statusItem.command='claudeSoundAlerts.openControlPanel'; statusItem.show(); context.subscriptions.push(statusItem); updateStatusBar();
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.installHooks',()=>installHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.uninstallHooks',()=>uninstallHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openLog',()=>output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openControlPanel',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.configureSounds',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.addSoundToLibrary',()=>addSoundToLibrary(true)));
  // Legacy commands kept functional.
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testQuestionSound',()=>playProfile('askUserQuestion','Manual test',true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testFinishedSound',()=>playProfile('stop','Manual test',true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectQuestionSound',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectFinishedSound',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setQuestionVolume',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setFinishedVolume',openControlPanel));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    if(event.affectsConfiguration('claudeSoundAlerts.enabled')||event.affectsConfiguration('claudeSoundAlerts.serverPort'))startServer();
    if(event.affectsConfiguration('claudeSoundAlerts')){void sendUiState();updateStatusBar();}
  }));
  startServer(); log('Extension v1.3.2 activated. Open the Claude Alerts control panel from the status bar.');
}
function deactivate(){stopServer();}
module.exports={activate,deactivate};

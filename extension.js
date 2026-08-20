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
  { id:'exitPlanMode', hookEvent:'PreToolUse', virtual:true, category:'Attention', label:'Plan Approval', description:'Claude asks to leave plan mode / approve the plan.', defaultEnabled:false, sound:'bright-ping', volume:75, repeat:2 },
  { id:'sessionStart', hookEvent:'SessionStart', category:'Session', label:'Session Started', description:'A Claude Code session starts or resumes.', defaultEnabled:false, sound:'gentle-chime', volume:35, repeat:1, transport:'command' },
  { id:'setup', hookEvent:'Setup', category:'Session', label:'Setup', description:'Claude Code setup/init/maintenance hook fires.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1, transport:'command' },
  { id:'instructionsLoaded', hookEvent:'InstructionsLoaded', category:'Context', label:'Instructions Loaded', description:'CLAUDE.md or rule instructions are loaded.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'userPromptSubmit', hookEvent:'UserPromptSubmit', category:'Turn', label:'Prompt Submitted', description:'Your prompt is submitted to Claude.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'userPromptExpansion', hookEvent:'UserPromptExpansion', category:'Turn', label:'Prompt Expansion', description:'A command/skill expands into a prompt.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'messageDisplay', hookEvent:'MessageDisplay', category:'Turn', label:'Message Display', description:'Assistant message text is displayed. This can fire frequently.', defaultEnabled:false, sound:'soft-pop', volume:15, repeat:1, noisy:true },
  { id:'preToolUse', hookEvent:'PreToolUse', category:'Tools', label:'Tool Starting', description:'Before any tool call, except special Question/Plan events above.', defaultEnabled:false, sound:'digital-pop', volume:20, repeat:1, noisy:true },
  { id:'permissionRequest', hookEvent:'PermissionRequest', category:'Attention', label:'Permission Requested', description:'A tool needs your permission decision.', defaultEnabled:false, sound:'bright-ping', volume:80, repeat:2 },
  { id:'postToolUse', hookEvent:'PostToolUse', category:'Tools', label:'Tool Succeeded', description:'After a tool call succeeds.', defaultEnabled:false, sound:'soft-pop', volume:20, repeat:1, noisy:true },
  { id:'postToolUseFailure', hookEvent:'PostToolUseFailure', category:'Errors', label:'Tool Failed', description:'A Claude tool call fails.', defaultEnabled:false, sound:'error-impact', volume:90, repeat:2 },
  { id:'postToolBatch', hookEvent:'PostToolBatch', category:'Tools', label:'Tool Batch Finished', description:'A full batch of parallel tool calls resolves.', defaultEnabled:false, sound:'calm-complete', volume:25, repeat:1 },
  { id:'permissionDenied', hookEvent:'PermissionDenied', category:'Errors', label:'Permission Denied', description:'Auto mode denies a tool call.', defaultEnabled:false, sound:'error-impact', volume:85, repeat:2 },
  { id:'notification', hookEvent:'Notification', category:'Attention', label:'Claude Notification', description:'Claude sends a notification, including input/idle/agent notifications.', defaultEnabled:false, sound:'soft-bell', volume:65, repeat:1 },
  { id:'subagentStart', hookEvent:'SubagentStart', category:'Agents', label:'Subagent Started', description:'A Claude subagent is spawned.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'subagentStop', hookEvent:'SubagentStop', category:'Agents', label:'Subagent Finished', description:'A Claude subagent finishes.', defaultEnabled:false, sound:'calm-complete', volume:45, repeat:1 },
  { id:'taskCreated', hookEvent:'TaskCreated', category:'Tasks', label:'Task Created', description:'Claude creates a task.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'taskCompleted', hookEvent:'TaskCompleted', category:'Tasks', label:'Task Completed', description:'Claude marks a task as completed.', defaultEnabled:false, sound:'success-chime', volume:45, repeat:1 },
  { id:'stop', hookEvent:'Stop', category:'Turn', label:'Claude Finished', description:'Claude finishes responding normally.', defaultEnabled:true, sound:'done-fanfare', volume:55, repeat:1 },
  { id:'stopFailure', hookEvent:'StopFailure', category:'Errors', label:'Claude API / Turn Error', description:'The turn ends due to an API/model/auth/rate-limit error.', defaultEnabled:false, sound:'error-impact', volume:100, repeat:3 },
  { id:'teammateIdle', hookEvent:'TeammateIdle', category:'Agents', label:'Teammate Idle', description:'An agent-team teammate is about to go idle.', defaultEnabled:false, sound:'soft-bell', volume:45, repeat:1 },
  { id:'configChange', hookEvent:'ConfigChange', category:'System', label:'Claude Config Changed', description:'Claude settings/policy/skills configuration changes.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1 },
  { id:'cwdChanged', hookEvent:'CwdChanged', category:'System', label:'Working Directory Changed', description:'Claude changes the working directory.', defaultEnabled:false, sound:'soft-pop', volume:20, repeat:1 },
  { id:'directoryAdded', hookEvent:'DirectoryAdded', category:'System', label:'Directory Added', description:'A working directory is added during a session.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'fileChanged', hookEvent:'FileChanged', category:'Files', label:'Watched File Changed', description:'A configured watched filename changes on disk.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1, requiresFiles:true },
  { id:'worktreeCreate', hookEvent:'WorktreeCreate', category:'System', label:'Worktree Created', description:'Safety-protected: Claude Code replaces normal worktree creation when this hook is configured.', defaultEnabled:false, sound:'gentle-chime', volume:30, repeat:1, unavailable:true },
  { id:'worktreeRemove', hookEvent:'WorktreeRemove', category:'System', label:'Worktree Removed', description:'A Claude-created worktree is being removed.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'preCompact', hookEvent:'PreCompact', category:'Context', label:'Before Context Compaction', description:'Claude is about to compact conversation context.', defaultEnabled:false, sound:'gentle-chime', volume:25, repeat:1 },
  { id:'postCompact', hookEvent:'PostCompact', category:'Context', label:'Context Compacted', description:'Context compaction has completed.', defaultEnabled:false, sound:'calm-complete', volume:30, repeat:1 },
  { id:'sessionEnd', hookEvent:'SessionEnd', category:'Session', label:'Session Ended', description:'A Claude Code session terminates.', defaultEnabled:false, sound:'calm-complete', volume:35, repeat:1 },
  { id:'elicitation', hookEvent:'Elicitation', category:'Attention', label:'MCP Needs Input', description:'An MCP server requests user input.', defaultEnabled:false, sound:'bright-ping', volume:80, repeat:2 },
  { id:'elicitationResult', hookEvent:'ElicitationResult', category:'Attention', label:'MCP Input Answered', description:'A user response to MCP elicitation is ready.', defaultEnabled:false, sound:'soft-pop', volume:30, repeat:1 }
];
const EVENT_MAP = new Map(EVENT_DEFS.map(e => [e.id, e]));
const EVENT_BY_HOOK = new Map(EVENT_DEFS.filter(e => !e.virtual).map(e => [e.hookEvent, e.id]));
const CATEGORIES = [...new Set(EVENT_DEFS.map(e => e.category))];

let server;
let output;
let extensionContext;
let retryTimer;
let heartbeatTimer;
let hookReconcileTimer;
let uiStateTimer;
let settingsCache = null;
let settingsCacheAt = 0;
let settingsCacheMtime = 0;
let suppressEventSettingsUi = 0;
let listenerToken = '';
let playChain = Promise.resolve();
let queuedPlays = 0;
const MAX_QUEUED_PLAYS = 3;
let listenerMode = 'inactive'; // inactive | owned | disabled
let listenerDetail = '';
let listenerPort = null;
let listenerGeneration = 0;
const listenerId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
let controlPanel;
let statusItem;
const lastPlayedAt = new Map();
let controlMutationQueue = Promise.resolve();
let listenerMutationQueue = Promise.resolve();
let hookShapeKey = '';

function cfg() { return vscode.workspace.getConfiguration('claudeSoundAlerts'); }
function log(message) { output?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`); }
function clamp(n, min, max) { n = Number(n); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getBasePort() { return clamp(cfg().get('serverPort', 47391), 1024, 65535); }
function getPortCount() { return Math.round(clamp(cfg().get('listenerPortCount', 20), 1, 100)); }
function getPort() { return listenerPort || getBasePort(); }
function hookPath() { return `/${EXTENSION_TAG}/hook/${listenerToken}`; }
function healthPath() { return `/${EXTENSION_TAG}/health/${listenerToken}`; }
function endpointFor(port = getPort()) { return `http://127.0.0.1:${port}${hookPath()}`; }
function listenerIsActive() { return listenerMode === 'owned' && Number.isInteger(listenerPort); }
function listenerRegistryDir() { return path.join(extensionContext.globalStorageUri.fsPath, 'listeners'); }
function listenerRegistryFile() { return path.join(listenerRegistryDir(), `${listenerId}.json`); }
function listenerTokenFile(){return path.join(extensionContext.globalStorageUri.fsPath,'listener-token.txt');}
function initializeListenerToken(){
  const file=listenerTokenFile(); fs.mkdirSync(path.dirname(file),{recursive:true});
  try{const existing=fs.readFileSync(file,'utf8').trim();if(/^[a-f0-9]{32,128}$/i.test(existing)){listenerToken=existing;return existing;}}catch(_error){}
  const candidate=crypto.randomBytes(32).toString('hex');
  try{fs.writeFileSync(file,candidate,{encoding:'utf8',flag:'wx',mode:0o600});listenerToken=candidate;}
  catch(error){if(error.code!=='EEXIST')throw error;listenerToken=fs.readFileSync(file,'utf8').trim();}
  void extensionContext.globalState.update('listenerToken',listenerToken);
  return listenerToken;
}
function takeoverLockPath(port) { return path.join(listenerRegistryDir(), `takeover-${port}.lock`); }
function allowedHost(req, port) {
  const host=String(req.headers.host||'').toLowerCase();
  return host===`127.0.0.1:${port}` || host===`localhost:${port}`;
}
function workspaceRoots() {
  return (vscode.workspace.workspaceFolders || [])
    .filter(f => f?.uri?.scheme === 'file')
    .map(f => f.uri.fsPath)
    .filter(Boolean)
    .map(p => path.resolve(p));
}
async function writeListenerRegistration() {
  if (!listenerIsActive()) return;
  const dir=listenerRegistryDir(); await fs.promises.mkdir(dir,{recursive:true});
  const record={tag:EXTENSION_TAG,id:listenerId,pid:process.pid,port:listenerPort,token:listenerToken,heartbeatAt:Date.now(),workspaceRoots:workspaceRoots()};
  const file=listenerRegistryFile(), temp=`${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp,JSON.stringify(record),'utf8');
  await fs.promises.rename(temp,file);
}
async function removeListenerRegistration() {
  try { await fs.promises.unlink(listenerRegistryFile()); } catch(error) { if(error?.code!=='ENOENT') log(`Could not remove listener registration: ${error.message||error}`); }
}
async function cleanupStaleRegistrations(maxAgeMs=90000) {
  try {
    const dir=listenerRegistryDir(); const names=await fs.promises.readdir(dir); const now=Date.now();
    await Promise.all(names.filter(n=>n.endsWith('.json')).map(async name=>{
      const file=path.join(dir,name);
      try { const data=JSON.parse(await fs.promises.readFile(file,'utf8')); if(!data?.heartbeatAt || now-Number(data.heartbeatAt)>maxAgeMs) await fs.promises.unlink(file); } catch(_) {}
    }));
  } catch(error) { if(error?.code!=='ENOENT') log(`Could not clean listener registry: ${error.message||error}`); }
}
function startHeartbeat() {
  if(heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer=setInterval(()=>{ void writeListenerRegistration(); },12000);
}

function stopHeartbeat() { if(heartbeatTimer){clearInterval(heartbeatTimer);heartbeatTimer=undefined;} }

function probeListener(port) {
  return new Promise(resolve=>{
    const req=http.request({host:'127.0.0.1',port,path:healthPath(),method:'GET',timeout:700,agent:false,headers:{Host:`127.0.0.1:${port}`,Connection:'close'}},res=>{
      let raw=''; res.setEncoding('utf8'); res.on('data',c=>raw+=c); res.on('end',()=>{
        try { const data=raw?JSON.parse(raw):{}; if(res.statusCode===200 && data?.ok===true && data?.tag===EXTENSION_TAG) return resolve({active:true,free:false,data}); } catch(_) {}
        resolve({active:false,free:false});
      });
    });
    req.on('timeout',()=>{req.destroy();resolve({active:false,free:false});});
    req.on('error',error=>resolve({active:false,free:error?.code==='ECONNREFUSED'})); req.end();
  });
}
async function activeListenerRecords() {
  const now=Date.now(), records=[];
  try {
    const dir=listenerRegistryDir(); const names=await fs.promises.readdir(dir);
    for(const name of names.filter(n=>n.endsWith('.json'))) {
      try {
        const d=JSON.parse(await fs.promises.readFile(path.join(dir,name),'utf8'));
        if(d?.tag===EXTENSION_TAG && Number(d.port)>0 && now-Number(d.heartbeatAt)>=0 && now-Number(d.heartbeatAt)<45000) records.push(d);
      } catch(_) {}
    }
  } catch(error) { if(error?.code!=='ENOENT') log(`Could not read listener registry: ${error.message||error}`); }
  return records;
}
function pathMatchScore(cwd,root) {
  if(!cwd || !root) return 0;
  try {
    const c=path.resolve(cwd), r=path.resolve(root);
    let inside;
    if(process.platform==='win32') { const cl=c.toLowerCase(), rl=r.toLowerCase().replace(/[\\/]+$/,''); inside=cl===rl || cl.startsWith(rl+'\\') || cl.startsWith(rl+'/'); }
    else { const relative=path.relative(r,c); inside=relative==='' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
    if(!inside) return 0;
    return r.length;
  } catch(_) { return 0; }
}
async function rankedListenerRecords(body) {
  const cwd=typeof body?.cwd==='string'?body.cwd:'';
  const records=await activeListenerRecords();
  return records.map(d=>{
    let score=0; for(const root of (Array.isArray(d.workspaceRoots)?d.workspaceRoots:[])) score=Math.max(score,pathMatchScore(cwd,root));
    return {d,score,heartbeat:Number(d.heartbeatAt)||0};
  }).sort((a,b)=>b.score-a.score || b.heartbeat-a.heartbeat).map(x=>x.d);
}
function forwardHook(port,body,token=listenerToken) {
  return new Promise(resolve=>{
    const raw=JSON.stringify(body||{});
    const req=http.request({host:'127.0.0.1',port,path:`/${EXTENSION_TAG}/hook/${token}`,method:'POST',timeout:1000,agent:false,headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw),'X-Claude-Sound-Alerts-Routed':'1',Connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode===204));});
    req.on('timeout',()=>{req.destroy();resolve(false);}); req.on('error',()=>resolve(false)); req.write(raw); req.end();
  });
}
async function routeIncomingHook(body) {
  const candidates=await rankedListenerRecords(body);
  for(const d of candidates) {
    const port=Number(d.port);
    if(port===listenerPort) {
      const result=classifyHook(body); if(result) void playProfile(result.id,result.reason); else log(`Ignored/disabled hook event: ${body.hook_event_name||'unknown'}${body.tool_name?` / ${body.tool_name}`:''}${body.notification_type?` / ${body.notification_type}`:''}`);
      return true;
    }
    if(await forwardHook(port,body,d.token||listenerToken)) return true;
  }
  // Registry may not be ready during startup; fall back to this listener.
  if(listenerIsActive()) {
    const result=classifyHook(body); if(result) void playProfile(result.id,result.reason); return true;
  }
  return false;
}
async function configuredBrokerPort() { return (await configuredBrokerTarget())?.port || null; }
async function withTakeoverLock(port,fn){
  const dir=listenerRegistryDir(); await fs.promises.mkdir(dir,{recursive:true});
  const lock=takeoverLockPath(port); let handle;
  try{
    try{handle=await fs.promises.open(lock,'wx');await handle.writeFile(`${listenerId}\n${Date.now()}\n`,'utf8');}
    catch(error){
      if(error.code!=='EEXIST') throw error;
      try{const stat=await fs.promises.stat(lock);if(Date.now()-stat.mtimeMs>12000){await fs.promises.unlink(lock);handle=await fs.promises.open(lock,'wx');}}catch(_error){}
      if(!handle) return false;
    }
    return await fn();
  }finally{
    if(handle){try{await handle.close();}catch(_error){}try{await fs.promises.unlink(lock);}catch(_error){}}
  }
}
async function switchListenerToPortNow(port){
  if(listenerPort===port && listenerIsActive()) return true;
  const generation=listenerGeneration;
  const candidate=createListenerServer(port);
  try{await tryListen(candidate,port);}catch(error){try{candidate.close();}catch(_error){}return false;}
  if(generation!==listenerGeneration){try{candidate.close();candidate.closeAllConnections?.();}catch(_error){}return false;}
  const old=server, oldPort=listenerPort;
  server=candidate; listenerPort=port; listenerMode='owned'; listenerDetail=`Took over configured router port ${port} without dropping the previous listener first.`;
  server.on('error',error=>log(`Listener runtime error on port ${port}: ${error.message||error}`));
  await writeListenerRegistration(); startHeartbeat(); updateStatusBar(); scheduleUiState();
  if(old){
    try{old.close();old.closeIdleConnections?.();setTimeout(()=>{try{old.closeAllConnections?.();}catch(_error){}},750);}catch(_error){}
  }
  log(`Listener moved from ${oldPort||'none'} to configured router port ${port}.`);
  return true;
}
function switchListenerToPort(port){
  const run=listenerMutationQueue.then(()=>switchListenerToPortNow(port));
  listenerMutationQueue=run.catch(error=>{log(`Listener port switch failed: ${error.message||error}`);return false;});
  return run;
}
function scheduleBrokerMonitor(delay=18000+Math.floor(Math.random()*7000)) {
  if(retryTimer) clearTimeout(retryTimer);
  retryTimer=setTimeout(async()=>{
    retryTimer=undefined;
    try{
      if(cfg().get('enabled',true)){
        const broker=await configuredBrokerPort();
        if(broker && listenerPort!==broker) {
          const probe=await probeListener(broker);
          if(!probe.active && probe.free) {
            await withTakeoverLock(broker,async()=>{
              const again=await probeListener(broker);
              if(again.active || !again.free) return false;
              log(`Configured router port ${broker} is free; attempting guarded takeover.`);
              return switchListenerToPort(broker);
            });
          }
        }
      }
    }catch(error){log(`Router monitor error: ${error.message||error}`);}
    scheduleBrokerMonitor();
  },delay);
}

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
function pcmWavInfo(buffer){
  const {fmt,data}=findWavChunks(buffer);
  const format=buffer.readUInt16LE(fmt.start);
  const bits=buffer.readUInt16LE(fmt.start+14);
  let pcm=false;
  if(format===1) pcm=true;
  else if(format===0xFFFE && fmt.size>=40){
    const pcmGuid=Buffer.from([0x01,0x00,0x00,0x00,0x00,0x00,0x10,0x00,0x80,0x00,0x00,0xaa,0x00,0x38,0x9b,0x71]);
    pcm=buffer.subarray(fmt.start+24,fmt.start+40).equals(pcmGuid);
    if(!pcm) throw new Error('This WAV uses WAVE_FORMAT_EXTENSIBLE with a non-PCM subformat.');
  }
  if(!pcm) throw new Error('Use an uncompressed PCM WAV file.');
  if(![8,16,24,32].includes(bits)) throw new Error(`Unsupported PCM bit depth: ${bits}. Use 8, 16, 24, or 32-bit WAV.`);
  return {fmt,data,bits,format};
}
function validatePcmWav(buffer) { pcmWavInfo(buffer); return true; }
function scalePcmWav(buffer, volumePercent) {
  const {data,bits}=pcmWavInfo(buffer);
  const gain=clamp(volumePercent,0,200)/100;
  const out=Buffer.from(buffer); const end=data.start+data.size;
  if(bits===8){
    for(let i=data.start;i<end;i++){const v=out[i]-128;out[i]=Math.max(0,Math.min(255,Math.round(v*gain+128)));}
  }else if(bits===16){
    for(let i=data.start;i+1<end;i+=2){const v=out.readInt16LE(i);out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*gain))),i);}
  }else if(bits===24){
    for(let i=data.start;i+2<end;i+=3){let v=out[i]|(out[i+1]<<8)|(out[i+2]<<16);if(v&0x800000)v|=0xff000000;const scaled=Math.max(-8388608,Math.min(8388607,Math.round(v*gain)));out[i]=scaled&0xff;out[i+1]=(scaled>>8)&0xff;out[i+2]=(scaled>>16)&0xff;}
  }else{
    for(let i=data.start;i+3<end;i+=4){const v=out.readInt32LE(i);const scaled=Math.max(-2147483648,Math.min(2147483647,Math.round(v*gain)));out.writeInt32LE(scaled,i);}
  }
  return out;
}
async function volumeAdjustedWav(file, volumePercent) {
  let stat;
  try{stat=await fs.promises.stat(file);}catch(error){if(error.code==='ENOENT')throw new Error(`Sound file is missing: ${file}`);throw error;}
  if(!stat.isFile()) throw new Error(`Sound path is not a file: ${file}`);
  const volume=Math.round(clamp(volumePercent,0,200));
  if(volume===100) return file;
  const key=crypto.createHash('sha256').update(`${file}|${stat.size}|${stat.mtimeMs}|${volume}`).digest('hex').slice(0,24);
  const cacheDir=path.join(extensionContext.globalStorageUri.fsPath,'audio-cache');
  const cached=path.join(cacheDir,`${key}.wav`);
  try{await fs.promises.access(cached,fs.constants.R_OK);return cached;}catch(_error){}
  const input=await fs.promises.readFile(file); validatePcmWav(input);
  const adjusted=scalePcmWav(input,volume); await fs.promises.mkdir(cacheDir,{recursive:true}); await fs.promises.writeFile(cached,adjusted); return cached;
}
async function pruneAudioCache(){
  const dir=path.join(extensionContext.globalStorageUri.fsPath,'audio-cache');
  try{
    const names=(await fs.promises.readdir(dir)).filter(n=>n.endsWith('.wav')); const now=Date.now(); const entries=[];
    for(const name of names){try{const file=path.join(dir,name),stat=await fs.promises.stat(file);if(now-stat.mtimeMs>14*24*60*60*1000){await fs.promises.unlink(file);continue;}entries.push({file,mtime:stat.mtimeMs});}catch(_error){}}
    entries.sort((a,b)=>b.mtime-a.mtime); for(const entry of entries.slice(50)){try{await fs.promises.unlink(entry.file);}catch(_error){}}
  }catch(error){if(error.code!=='ENOENT')log(`Audio cache cleanup failed: ${error.message||error}`);}
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
  if(process.platform==='win32'){
    // Use the native Windows PlaySound API instead of System.Media.SoundPlayer.
    // This works from both Windows PowerShell 5.1 and PowerShell 7 without
    // depending on System.Windows.Extensions being installed/loaded.
    const script=[
      "$ErrorActionPreference='Stop'",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ClaudeSoundNative { [DllImport(\"winmm.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool PlaySound(string pszSound, IntPtr hmod, uint fdwSound); }'",
      '$ok = [ClaudeSoundNative]::PlaySound($env:CLAUDE_SOUND_FILE, [IntPtr]::Zero, 0x00020002)',
      "if (-not $ok) { throw 'Windows PlaySound failed.' }"
    ].join('; ');
    const env={...process.env,CLAUDE_SOUND_FILE:file}; let meaningfulError=null; let missing=0;
    for(const command of ['powershell.exe','pwsh.exe']){
      const encoded=Buffer.from(script,'utf16le').toString('base64');
      try{await spawnCaptured(command,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{env});return;}
      catch(error){if(error?.code==='ENOENT'){missing++;continue;}meaningfulError=error;log(`${command} audio attempt failed: ${error.message||error}`);}
    }
    if(meaningfulError) throw meaningfulError;
    if(missing===2) throw new Error('No Windows PowerShell audio host was found. Windows PowerShell 5.1 or PowerShell 7 is required for WAV playback.');
    throw new Error('Windows could not play the WAV file.');
  }
  if(process.platform==='darwin'){await spawnCaptured('afplay',[file]);return;}
  let lastError;
  for(const [cmd,args] of [['paplay',[file]],['ffplay',['-nodisp','-autoexit','-loglevel','quiet',file]],['aplay',[file]]]){
    try{await spawnCaptured(cmd,args);return;}catch(error){lastError=error;}
  }
  throw new Error(`No supported Linux WAV player is available. Install paplay (PulseAudio/PipeWire), ffplay, or aplay.${lastError?` Last error: ${lastError.message||lastError}`:''}`);
}
async function playAudioFile(file, volume, repeat) {
  const vol=Math.round(clamp(volume,0,200)); if(vol<=0)return;
  try{const stat=await fs.promises.stat(file);if(!stat.isFile())throw new Error('not a regular file');}catch(error){throw new Error(`Sound file is unavailable: ${file}${error?.message?` (${error.message})`:''}`);}
  const adjusted=await volumeAdjustedWav(file,vol); const count=Math.round(clamp(repeat,1,5)); const gap=Math.round(clamp(cfg().get('repeatGapMs',150),0,3000));
  for(let i=0;i<count;i++){await playRawWav(adjusted);if(i<count-1&&gap)await sleep(gap);}
}
function enqueuePlayback(task,label){
  if(queuedPlays>=MAX_QUEUED_PLAYS){log(`Dropping alert because playback backlog is full: ${label}`);return Promise.resolve(false);}
  queuedPlays++;
  const run=playChain.then(task);
  playChain=run.catch(error=>{log(`Playback error (${label}): ${error.message||error}`);}).finally(()=>{queuedPlays--;});
  return run.then(()=>true);
}

function brief(value,max=80){if(value===undefined||value===null)return'';let text;try{text=typeof value==='string'?value:JSON.stringify(value);}catch(_error){text=String(value);}text=String(text).replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max-1)+'…':text;}
function reasonFor(body, id) {
  const e = body?.hook_event_name || 'Claude event';
  switch(id) {
    case 'askUserQuestion': return 'Claude asked a question';
    case 'exitPlanMode': return 'Claude is waiting for plan approval';
    case 'permissionRequest': return `Permission requested${body.tool_name?` for ${brief(body.tool_name)}`:''}`;
    case 'permissionDenied': return `Permission denied${body.tool_name?` for ${brief(body.tool_name)}`:''}`;
    case 'postToolUseFailure': return `Tool failed${body.tool_name?`: ${brief(body.tool_name)}`:''}`;
    case 'postToolUse': return `Tool succeeded${body.tool_name?`: ${brief(body.tool_name)}`:''}`;
    case 'preToolUse': return `Tool starting${body.tool_name?`: ${brief(body.tool_name)}`:''}`;
    case 'notification': return `Notification${body.notification_type?`: ${brief(body.notification_type)}`:''}`;
    case 'subagentStart': return `Subagent started${body.agent_type?`: ${brief(body.agent_type)}`:''}`;
    case 'subagentStop': return `Subagent finished${body.agent_type?`: ${brief(body.agent_type)}`:''}`;
    case 'taskCreated': return `Task created${body.task_subject?`: ${brief(body.task_subject)}`:''}`;
    case 'taskCompleted': return `Task completed${body.task_subject?`: ${brief(body.task_subject)}`:''}`;
    case 'stop': return 'Claude finished responding';
    case 'stopFailure': return `Claude stopped with an error${body.error?`: ${brief(body.error)}`:''}`;
    case 'teammateIdle': return `Teammate idle${body.teammate_name?`: ${brief(body.teammate_name)}`:''}`;
    case 'configChange': return `Claude configuration changed${body.source?`: ${brief(body.source)}`:''}`;
    case 'cwdChanged': return 'Working directory changed';
    case 'directoryAdded': return `Directory added${body.directory?`: ${brief(body.directory)}`:''}`;
    case 'fileChanged': return `Watched file ${brief(body.event)||'changed'}${body.file_path?`: ${path.basename(body.file_path)}`:''}`;
    case 'preCompact': return `Context compaction starting${body.trigger?`: ${brief(body.trigger)}`:''}`;
    case 'postCompact': return `Context compaction finished${body.trigger?`: ${brief(body.trigger)}`:''}`;
    case 'sessionStart': return `Claude session started${body.source?`: ${brief(body.source)}`:''}`;
    case 'sessionEnd': return `Claude session ended${body.reason?`: ${brief(body.reason)}`:''}`;
    case 'elicitation': return `MCP needs input${body.mcp_server_name?`: ${brief(body.mcp_server_name)}`:''}`;
    case 'elicitationResult': return `MCP input answered${body.mcp_server_name?`: ${brief(body.mcp_server_name)}`:''}`;
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
  try { await enqueuePlayback(()=>playAudioFile(file,volume,repeat),def.label); }
  catch(error) {
    const message=error?.message||String(error); log(`Unable to play sound: ${message}`);
    vscode.window.showWarningMessage(`Claude Sound Alerts could not play audio: ${message}`,'Open Log').then(c=>{ if(c==='Open Log') output.show(true); });
  }
}

function createListenerServer(port) {
  return http.createServer((req,res)=>{
    if(!allowedHost(req,port)){res.writeHead(404);res.end();return;}
    let pathname='';
    try{pathname=new URL(req.url||'/',`http://127.0.0.1:${port}`).pathname;}catch(_error){res.writeHead(400);res.end();return;}
    if(req.method==='GET' && pathname===healthPath()){
      const payload=JSON.stringify({ok:true,tag:EXTENSION_TAG,id:listenerId,pid:process.pid,port});
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(payload),'Connection':'close'});res.end(payload);return;
    }
    if(req.method!=='POST' || pathname!==hookPath()){res.writeHead(404,{'Connection':'close'});res.end();return;}
    let raw='',tooLarge=false;req.setEncoding('utf8');
    req.on('data',chunk=>{if(tooLarge)return;raw+=chunk;if(raw.length>1024*1024){tooLarge=true;res.writeHead(413,{'Connection':'close'});res.end();req.destroy();}});
    req.on('end',()=>{
      if(tooLarge)return;
      try{
        const body=raw?JSON.parse(raw):{};
        if(body?.probe===true && body?.hook_event_name==='__claude_sound_alerts_probe__'){res.writeHead(204,{'Connection':'close'});res.end();return;}
        const routed=req.headers['x-claude-sound-alerts-routed']==='1';
        if(routed){
          const result=classifyHook(body);
          if(result)void playProfile(result.id,result.reason);
          else log(`Ignored/disabled hook event: ${brief(body.hook_event_name)||'unknown'}${body.tool_name?` / ${brief(body.tool_name)}`:''}${body.notification_type?` / ${brief(body.notification_type)}`:''}`);
        }else void routeIncomingHook(body);
        res.writeHead(204,{'Connection':'close'});res.end();
      }catch(error){log(`Invalid hook request: ${error.message||error}`);res.writeHead(400,{'Connection':'close'});res.end();}
    });
  });
}

function tryListen(serverToUse, port) {
  return new Promise((resolve,reject)=>{
    const onError=error=>{cleanup();reject(error);};
    const onListening=()=>{cleanup();resolve();};
    const cleanup=()=>{serverToUse.off('error',onError);serverToUse.off('listening',onListening);};
    serverToUse.once('error',onError); serverToUse.once('listening',onListening); serverToUse.listen(port,'127.0.0.1');
  });
}
function startServer(preferredPort=null){
  const run=listenerMutationQueue.then(()=>startServerNow(preferredPort));
  listenerMutationQueue=run.catch(error=>{log(`Listener restart failed: ${error.stack||error}`);return undefined;});
  return run;
}
async function startServerNow(preferredPort=null) {
  const generation=++listenerGeneration;
  await stopServer(false,false);
  await removeListenerRegistration();
  if (!cfg().get('enabled',true)) {
    listenerMode='disabled'; listenerDetail='Sound alerts are globally disabled.';
    log('Listener disabled by settings.'); updateStatusBar(); void sendUiState(); return;
  }
  await cleanupStaleRegistrations();
  const base=getBasePort(), count=getPortCount();
  const ports=[]; if(Number.isInteger(preferredPort)&&preferredPort>=1024&&preferredPort<=65535) ports.push(preferredPort);
  for(let offset=0; offset<count; offset++){const p=base+offset;if(p<=65535&&!ports.includes(p))ports.push(p);}
  for(const port of ports) {
    if(generation!==listenerGeneration) return;
    const candidate=createListenerServer(port);
    try {
      await tryListen(candidate,port);
      if(generation!==listenerGeneration){try{candidate.close();}catch(_){} return;}
      server=candidate; listenerPort=port; listenerMode='owned';
      listenerDetail=port===base ? `Listening on port ${port}.` : (preferredPort===port ? `Listening on configured router port ${port}.` : `Port ${base} was unavailable; automatically switched to port ${port}.`);
      server.on('error',error=>{log(`Listener runtime error on port ${port}: ${error.message||error}`);});
      log(`Listening for Claude Code hooks at ${endpointFor(port)} (listener ${listenerId.slice(0,8)}).`);
      await writeListenerRegistration(); startHeartbeat(); scheduleBrokerMonitor(); updateStatusBar(); scheduleUiState();
      // A runtime/configuration-driven port move can make previously installed hook
      // URLs stale. Verify after the new listener is live and repair only if needed.
      setTimeout(async()=>{try{const hs=await hookInstallStatus();if(hs.oursAnywhere>0&&!hs.complete)scheduleHookReconcile(250);}catch(error){log(`Post-listener hook check failed: ${error.message||error}`);}},150);
      return;
    } catch(error) {
      try{candidate.close();}catch(_){}
      if(error?.code==='EADDRINUSE' || error?.code==='EACCES') {
        log(`Port ${port} unavailable (${error.code}); trying the next listener port.`); continue;
      }
      log(`Listener error on port ${port}: ${error.message||error}`);
    }
  }
  listenerMode='inactive'; listenerPort=null; listenerDetail=`No free localhost listener port was found in ${base}-${Math.min(65535,base+count-1)}.`;
  log(listenerDetail); vscode.window.showErrorMessage(`Claude Sound Alerts could not find a free listener port in ${base}-${Math.min(65535,base+count-1)}.`); scheduleBrokerMonitor(); updateStatusBar(); scheduleUiState();
}
async function stopServer(invalidate=true,removeRegistration=true){
  if(invalidate) listenerGeneration++;
  if(retryTimer){clearTimeout(retryTimer);retryTimer=undefined;}
  stopHeartbeat();
  if(removeRegistration) await removeListenerRegistration();
  const closing=server; server=undefined;
  listenerPort=null;
  if(listenerMode!=='disabled'){listenerMode='inactive'; listenerDetail='';}
  if(closing){
    await new Promise(resolve=>{
      let done=false;const finish=()=>{if(!done){done=true;resolve();}};
      try{closing.close(finish);closing.closeIdleConnections?.();closing.closeAllConnections?.();setTimeout(finish,250);}catch(_error){finish();}
    });
  }
}

function hookHandler(url){ return {type:'http',url,timeout:1}; }
function claudeSettingsPath(){ return path.join(os.homedir(),'.claude','settings.json'); }
function relayScriptPath(){ return path.join(extensionContext.globalStorageUri.fsPath, process.platform==='win32' ? `${RELAY_TAG}.ps1` : `${RELAY_TAG}.sh`); }
async function ensureRelayScript(){
  const file=relayScriptPath(); await fs.promises.mkdir(path.dirname(file),{recursive:true});
  if(process.platform==='win32') {
    const text = `param([string]$Url)\n$ErrorActionPreference = 'SilentlyContinue'\n$body = [Console]::In.ReadToEnd()\ntry { Invoke-WebRequest -UseBasicParsing -Uri $Url -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null } catch {}\nexit 0\n`;
    await fs.promises.writeFile(file,text,'utf8');
  } else {
    const text = `#!/bin/sh\nurl="$1"\nif command -v curl >/dev/null 2>&1; then\n  exec curl -sS --max-time 3 -X POST -H 'Content-Type: application/json' --data-binary @- "$url" >/dev/null 2>&1\nelif command -v python3 >/dev/null 2>&1; then\n  exec python3 -c 'import sys,urllib.request; u=sys.argv[1]; d=sys.stdin.buffer.read(); urllib.request.urlopen(urllib.request.Request(u,data=d,headers={"Content-Type":"application/json"},method="POST"),timeout=3).read()' "$url" >/dev/null 2>&1\nelif command -v python >/dev/null 2>&1; then\n  exec python -c 'import sys,urllib.request; u=sys.argv[1]; d=sys.stdin.buffer.read(); urllib.request.urlopen(urllib.request.Request(u,data=d,headers={"Content-Type":"application/json"},method="POST"),timeout=3).read()' "$url" >/dev/null 2>&1\nelse\n  cat >/dev/null\nfi\nexit 0\n`;
    await fs.promises.writeFile(file,text,{encoding:'utf8',mode:0o700}); try{await fs.promises.chmod(file,0o700);}catch(_error){}
  }
  return file;
}
function commandRelayHandler(url){
  const file=relayScriptPath();
  return process.platform==='win32'
    ? {type:'command',command:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,url],timeout:10,async:true}
    : {type:'command',command:'sh',args:[file,url],timeout:10,async:true};
}
function desiredHookGroups(url, settings=allEventSettings()){
  const out={};
  const live=EVENT_DEFS.filter(d=>!d.unavailable && settings[d.id]?.enabled);

  const genericPreTool=live.some(d=>d.id==='preToolUse');
  if(genericPreTool) {
    out.PreToolUse=[{hooks:[hookHandler(url)]}];
  } else {
    const toolNames=[];
    if(live.some(d=>d.id==='askUserQuestion')) toolNames.push('AskUserQuestion');
    if(live.some(d=>d.id==='exitPlanMode')) toolNames.push('ExitPlanMode');
    if(toolNames.length) out.PreToolUse=[{matcher:toolNames.join('|'),hooks:[hookHandler(url)]}];
  }

  for(const d of live) {
    if(d.virtual || d.hookEvent==='PreToolUse' || d.hookEvent==='FileChanged' || d.transport==='command') continue;
    if(!out[d.hookEvent]) out[d.hookEvent]=[{hooks:[hookHandler(url)]}];
  }

  for(const d of live.filter(d=>d.transport==='command')) {
    out[d.hookEvent]=[{hooks:[commandRelayHandler(url)]}];
  }

  if(live.some(d=>d.id==='fileChanged')) {
    const names=(cfg().get('watchedFiles',[])||[]).map(String).map(v=>v.trim()).filter(Boolean).filter(v=>!v.includes('|'));
    if(names.length) out.FileChanged=[{matcher:[...new Set(names)].join('|'),hooks:[hookHandler(url)]}];
  }
  return out;
}

function handlerUrl(handler){
  if(!handler || typeof handler!=='object') return null;
  if(handler.type==='http' && typeof handler.url==='string') return handler.url;
  if(handler.type==='command') {
    if(Array.isArray(handler.args)) {
      const candidate=handler.args.find(v=>typeof v==='string' && v.includes(`/${EXTENSION_TAG}/hook/`));
      if(candidate) return candidate;
    }
    if(typeof handler.command==='string') {
      const match=handler.command.match(/https?:\/\/127\.0\.0\.1:\d+\/claude-code-sound-alerts\/hook\/[^\s"']+/);
      if(match) return match[0];
    }
  }
  return null;
}
function isOurHandler(handler){
  if(!handler || typeof handler!=='object') return false;
  if(handler.type==='http' && typeof handler.url==='string' && handler.url.includes(`/${EXTENSION_TAG}/hook`)) return true;
  if(handler.type==='command') {
    if(typeof handler.command==='string' && handler.command.includes(RELAY_TAG)) return true;
    if(Array.isArray(handler.args) && handler.args.some(v=>typeof v==='string' && v.includes(RELAY_TAG))) return true;
    if(handlerUrl(handler)) return true;
  }
  return false;
}
function isOurHandlerFor(handler,url){ return isOurHandler(handler) && handlerUrl(handler)===url; }
function stableHandlerShape(handler){
  if(!handler || typeof handler!=='object') return null;
  if(handler.type==='http') return {type:'http',url:handler.url||'',timeout:Number(handler.timeout||0)};
  if(handler.type==='command') return {type:'command',command:handler.command||'',args:Array.isArray(handler.args)?handler.args.map(String):[],timeout:Number(handler.timeout||0),async:handler.async===true};
  return {type:String(handler.type||'')};
}
function hookSignature(event,group,handler){
  return JSON.stringify({event,matcher:group?.matcher===undefined?'':String(group.matcher),handler:stableHandlerShape(handler)});
}
function ourHookSignatures(settings){
  const signatures=[];
  for(const [event,groups] of Object.entries(settings?.hooks||{})) for(const group of (Array.isArray(groups)?groups:[])) for(const handler of (Array.isArray(group?.hooks)?group.hooks:[])) if(isOurHandler(handler)) signatures.push(hookSignature(event,group,handler));
  return signatures;
}
function desiredHookSignatures(groupsByEvent){
  const signatures=[];
  for(const [event,groups] of Object.entries(groupsByEvent||{})) for(const group of (Array.isArray(groups)?groups:[])) for(const handler of (Array.isArray(group?.hooks)?group.hooks:[])) signatures.push(hookSignature(event,group,handler));
  return signatures;
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
function stripJsonComments(text){
  let out='', inString=false, escape=false, line=false, block=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(line){ if(c==='\n'){line=false;out+=c;} continue; }
    if(block){ if(c==='*'&&n==='/'){block=false;i++;} else if(c==='\n')out+='\n'; continue; }
    if(inString){ out+=c; if(escape)escape=false; else if(c==='\\')escape=true; else if(c==='"')inString=false; continue; }
    if(c==='"'){inString=true;out+=c;continue;}
    if(c==='/'&&n==='/'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block=true;i++;continue;}
    out+=c;
  }
  return out;
}
function stripTrailingCommas(text){
  let out='', inString=false, escape=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inString){out+=c;if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;out+=c;continue;}
    if(c===','){
      let j=i+1; while(j<text.length && /\s/.test(text[j]))j++;
      if(text[j]==='}'||text[j]===']') continue;
    }
    out+=c;
  }
  return out;
}
function parseClaudeSettingsText(text){
  const raw=String(text||'').replace(/^\uFEFF/,'');
  if(!raw.trim()) return {};
  try{return JSON.parse(raw);}catch(first){
    try{return JSON.parse(stripTrailingCommas(stripJsonComments(raw)));}
    catch(_error){throw new Error(`Claude settings are not valid JSON/JSONC: ${first.message}`);}
  }
}
function cloneJson(value){ return JSON.parse(JSON.stringify(value||{})); }
function invalidateSettingsCache(){settingsCache=null;settingsCacheAt=0;settingsCacheMtime=0;}
async function readClaudeSettings(fresh=false){
  const file=claudeSettingsPath();
  try{
    const stat=await fs.promises.stat(file);
    if(!fresh && settingsCache && Date.now()-settingsCacheAt<1000 && stat.mtimeMs===settingsCacheMtime) return cloneJson(settingsCache);
    const text=await fs.promises.readFile(file,'utf8');
    const parsed=parseClaudeSettingsText(text);
    settingsCache=cloneJson(parsed); settingsCacheAt=Date.now(); settingsCacheMtime=stat.mtimeMs;
    return parsed;
  }catch(error){
    if(error.code==='ENOENT'){invalidateSettingsCache();return{};}
    throw error;
  }
}
function skipJsoncTrivia(text,index){
  let i=index;
  while(i<text.length){
    if(/\s/.test(text[i])){i++;continue;}
    if(text[i]==='/'&&text[i+1]==='/'){i+=2;while(i<text.length&&text[i]!=='\n')i++;continue;}
    if(text[i]==='/'&&text[i+1]==='*'){i+=2;while(i+1<text.length&&!(text[i]==='*'&&text[i+1]==='/'))i++;i=Math.min(text.length,i+2);continue;}
    break;
  }
  return i;
}
function scanJsonStringEnd(text,index){
  if(text[index]!=='"')throw new Error('Expected a JSON string.');
  let escape=false;
  for(let i=index+1;i<text.length;i++){
    const c=text[i];
    if(escape){escape=false;continue;}
    if(c==='\\'){escape=true;continue;}
    if(c==='"')return i+1;
  }
  throw new Error('Unterminated string in Claude settings.');
}
function scanJsoncValueEnd(text,index){
  let obj=0,arr=0,inString=false,escape=false,line=false,block=false;
  for(let i=index;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(line){if(c==='\n')line=false;continue;}
    if(block){if(c==='*'&&n==='/'){block=false;i++;}continue;}
    if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;continue;}
    if(c==='/'&&n==='/'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block=true;i++;continue;}
    if(c==='{'){obj++;continue;} if(c==='['){arr++;continue;}
    if(c==='}'){if(obj>0){obj--;continue;}if(arr===0)return i;}
    if(c===']'){if(arr>0){arr--;continue;}}
    if(c===','&&obj===0&&arr===0)return i;
  }
  return text.length;
}
function scanTopLevelJsoncObject(text){
  let i=skipJsoncTrivia(text,0);
  if(text[i]!=='{')throw new Error('Claude settings root must be a JSON object.');
  const open=i; i++;
  const members=[]; let close=-1;
  while(i<text.length){
    i=skipJsoncTrivia(text,i);
    if(text[i]==='}'){close=i;break;}
    const keyStart=i, keyEnd=scanJsonStringEnd(text,keyStart);
    let key; try{key=JSON.parse(text.slice(keyStart,keyEnd));}catch(error){throw new Error(`Invalid property name in Claude settings: ${error.message}`);}
    i=skipJsoncTrivia(text,keyEnd); if(text[i]!==':')throw new Error(`Expected ':' after ${key} in Claude settings.`); i++;
    const valueStart=skipJsoncTrivia(text,i), valueEnd=scanJsoncValueEnd(text,valueStart);
    let lineStart=text.lastIndexOf('\n',keyStart-1)+1; const indent=(text.slice(lineStart,keyStart).match(/^[ \t]*/)||[''])[0];
    i=skipJsoncTrivia(text,valueEnd);
    const trailingComma=text[i]===',';
    members.push({key,keyStart,keyEnd,valueStart,valueEnd,indent,trailingComma});
    if(trailingComma){i++;continue;}
    if(text[i]==='}'){close=i;break;}
    // scanJsoncValueEnd stops at the delimiter, so any other token is invalid.
    throw new Error(`Expected ',' or '}' after ${key} in Claude settings.`);
  }
  if(close<0)throw new Error('Claude settings JSON object is not closed.');
  return {open,close,members};
}
function formatJsoncValue(value,baseIndent,indentUnit){
  const json=JSON.stringify(value,null,indentUnit);
  return json.replace(/\n/g,'\n'+baseIndent);
}
function patchTopLevelHooks(text,hooksValue){
  let raw=String(text||''); if(!raw.trim())raw='{}\n';
  const parsed=scanTopLevelJsoncObject(raw);
  const existing=parsed.members.find(m=>m.key==='hooks');
  const hasHooks=hooksValue && typeof hooksValue==='object' && Object.keys(hooksValue).length>0;
  if(!existing && !hasHooks)return raw;
  const firstIndent=parsed.members[0]?.indent || '  ';
  const indentUnit=firstIndent || '  ';
  if(existing){
    const value=hasHooks?hooksValue:{};
    const formatted=formatJsoncValue(value,existing.indent,indentUnit);
    return raw.slice(0,existing.valueStart)+formatted+raw.slice(existing.valueEnd);
  }
  const formatted=formatJsoncValue(hooksValue,firstIndent,indentUnit);
  const after=raw.slice(parsed.close);
  const newline=raw.includes('\r\n')?'\r\n':'\n';
  let before=raw.slice(0,parsed.close);
  const last=parsed.members[parsed.members.length-1];
  if(last && !last.trailingComma) before=raw.slice(0,last.valueEnd)+','+raw.slice(last.valueEnd,parsed.close);
  const needsNewline=!before.endsWith('\n')&&!before.endsWith('\r');
  return before+(needsNewline?newline:'')+firstIndent+'"hooks": '+formatted+newline+after;
}
async function writeClaudeSettingsTextUnlocked(text){
  const file=claudeSettingsPath(); await fs.promises.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${listenerId}.tmp`; await fs.promises.writeFile(temp,text,'utf8'); await fs.promises.rename(temp,file);
  invalidateSettingsCache(); return file;
}
async function withClaudeSettingsLock(fn){
  const dir=path.dirname(claudeSettingsPath()); await fs.promises.mkdir(dir,{recursive:true});
  const lock=path.join(dir,'.claude-sound-alerts-settings.lock');
  const deadline=Date.now()+5000; let handle;
  while(!handle){
    try{handle=await fs.promises.open(lock,'wx');await handle.writeFile(`${process.pid}\n${Date.now()}\n`,'utf8');}
    catch(error){
      if(error.code!=='EEXIST') throw error;
      try{const stat=await fs.promises.stat(lock);if(Date.now()-stat.mtimeMs>10000){await fs.promises.unlink(lock);continue;}}catch(_error){}
      if(Date.now()>=deadline) throw new Error('Timed out waiting for another Claude Sound Alerts window to finish updating ~/.claude/settings.json.');
      await sleep(75+Math.floor(Math.random()*75));
    }
  }
  try{return await fn();}
  finally{try{await handle.close();}catch(_error){}try{await fs.promises.unlink(lock);}catch(_error){}}
}
async function mutateClaudeSettings(mutator){
  return withClaudeSettingsLock(async()=>{
    const file=claudeSettingsPath(); let text='{}\n';
    try{text=await fs.promises.readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    const current=parseClaudeSettingsText(text);
    const next=await mutator(cloneJson(current)) || current;
    // This extension only mutates the top-level hooks property. Patch that value
    // in place so comments, key ordering, and formatting elsewhere in settings.json
    // are preserved instead of rewriting the entire file.
    const patched=patchTopLevelHooks(text,next.hooks);
    const written=await writeClaudeSettingsTextUnlocked(patched);
    return {file:written,settings:next};
  });
}
function configuredBrokerTargetFromSettings(settings){
  const targets=[];
  for(const groups of Object.values(settings?.hooks||{})) for(const group of (Array.isArray(groups)?groups:[])) for(const h of (Array.isArray(group?.hooks)?group.hooks:[])) {
    if(!isOurHandler(h)) continue;
    const url=handlerUrl(h); if(!url) continue;
    try{const u=new URL(url);const port=Number(u.port);if(Number.isInteger(port)&&port>0)targets.push({url,port,token:u.pathname.split('/').pop()||'',path:u.pathname});}catch(_error){}
  }
  if(!targets.length)return null;
  return targets.find(t=>t.path===hookPath()) || targets[0];
}
async function configuredBrokerTarget(){
  try{return configuredBrokerTargetFromSettings(await readClaudeSettings());}catch(_error){return null;}
}
async function hookInstallStatus(){
  try{
    const settings=await readClaudeSettings();
    const target=configuredBrokerTargetFromSettings(settings);
    const desiredUrl=target?.path===hookPath() ? target.url : endpointFor(listenerPort||getBasePort());
    const desired=desiredHookGroups(desiredUrl);
    const desiredSigs=desiredHookSignatures(desired);
    const actualSigs=ourHookSignatures(settings);
    const desiredSet=new Set(desiredSigs), actualSet=new Set(actualSigs);
    const current=desiredSigs.filter(sig=>actualSet.has(sig)).length;
    const total=desiredSigs.length;
    const oursAnywhere=actualSigs.length;
    const extra=actualSigs.filter(sig=>!desiredSet.has(sig)).length + Math.max(0,actualSigs.length-actualSet.size);
    let installed=0;
    for(const event of Object.keys(desired)) {
      const groups=Array.isArray(settings.hooks?.[event])?settings.hooks[event]:[];
      if(groups.some(g=>Array.isArray(g?.hooks)&&g.hooks.some(isOurHandler))) installed++;
    }
    let targetActive=false,targetPathCurrent=false;
    if(target?.port){
      targetPathCurrent=target.path===hookPath();
      if(targetPathCurrent){const probe=await probeListener(target.port);targetActive=!!probe.active;}
    }
    const complete=total===0 ? oursAnywhere===0 : current===total && extra===0 && targetActive && targetPathCurrent;
    const stale=oursAnywhere>0 && !complete;
    return {installed,current,total,complete,stale,extra,targetUrl:target?.url||null,targetPort:target?.port||null,targetActive,targetPathCurrent,oursAnywhere};
  }catch(error){return{installed:0,current:0,total:0,complete:false,stale:false,extra:0,error:error.message||String(error)};}
}
function currentHookShapeKey(){
  const settings=allEventSettings();
  return JSON.stringify({
    enabled:cfg().get('enabled',true),
    serverPort:getBasePort(),
    listenerPortCount:getPortCount(),
    events:EVENT_DEFS.filter(d=>!d.unavailable && settings[d.id]?.enabled).map(d=>d.id),
    watchedFiles:settings.fileChanged?.enabled ? [...new Set((cfg().get('watchedFiles',[])||[]).map(String))].sort() : []
  });
}
function scheduleHookReconcileIfShapeChanged(delay=500){
  const next=currentHookShapeKey();
  if(next===hookShapeKey)return false;
  hookShapeKey=next;
  scheduleHookReconcile(delay);
  return true;
}

function scheduleHookReconcile(delay=500){
  if(hookReconcileTimer) clearTimeout(hookReconcileTimer);
  hookReconcileTimer=setTimeout(async()=>{
    hookReconcileTimer=undefined;
    try{
      const status=await hookInstallStatus();
      if(status.oursAnywhere>0)await extensionContext.globalState.update('hooksManaged',true);
      const managed=extensionContext.globalState.get('hooksManaged',false)||status.oursAnywhere>0;
      if(!managed)return;
      if(!cfg().get('enabled',true)){
        await mutateClaudeSettings(async settings=>removeOurHooksFromSettings(settings));
        scheduleUiState();
        return;
      }
      await installHooks(false);
    }catch(error){log(`Automatic hook refresh failed: ${error.message||error}`);}
  },delay);
}
async function installHooks(showMessage=true){
  try{
    await ensureRelayScript();
    if(!listenerIsActive()) await startServer();
    if(!listenerIsActive()) throw new Error('No active localhost listener is available.');
    let url=endpointFor(listenerPort);
    const existing=await configuredBrokerTarget();
    if(existing?.port){
      try{const pathCurrent=new URL(existing.url).pathname===hookPath();const probe=pathCurrent?await probeListener(existing.port):{active:false};if(pathCurrent&&probe.active)url=existing.url;}catch(_error){}
    }
    const result=await mutateClaudeSettings(async settings=>{
      removeOurHooksFromSettings(settings); settings.hooks=settings.hooks||{};
      for(const [event,groups] of Object.entries(desiredHookGroups(url))) {
        settings.hooks[event]=Array.isArray(settings.hooks[event])?settings.hooks[event]:[];
        settings.hooks[event].push(...groups);
      }
      return settings;
    });
    await extensionContext.globalState.update('hooksManaged',true);
    log(`Installed enabled Claude Code hooks in ${result.file}; router=${url}`);
    if(showMessage) vscode.window.showInformationMessage('Claude Code Sound Alerts hooks installed/updated for the enabled alerts.');
    await sendUiState(); updateStatusBar(); return true;
  }catch(error){log(`Hook installation failed: ${error.stack||error}`);vscode.window.showErrorMessage(`Could not install Claude Code hooks: ${error.message||error}`);return false;}
}
async function uninstallHooks(showMessage=true){
  try{
    const result=await mutateClaudeSettings(async settings=>removeOurHooksFromSettings(settings));
    await extensionContext.globalState.update('hooksManaged',false);
    try{await fs.promises.unlink(relayScriptPath());}catch(_error){}
    log(`Removed Claude Sound Alerts hooks from ${result.file}`); if(showMessage)vscode.window.showInformationMessage('Claude Code Sound Alerts hooks removed.');
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
  suppressEventSettingsUi=Date.now()+750;
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

async function migrateV140PrimaryDefaults(){
  if(extensionContext.globalState.get('v140PrimaryDefaultsDone')) return;
  const inspected=cfg().inspect('eventSettings');
  const hasExplicitValue=inspected?.globalValue!==undefined || inspected?.workspaceValue!==undefined || inspected?.workspaceFolderValue!==undefined;
  if(!hasExplicitValue){
    await extensionContext.globalState.update('v140PrimaryDefaultsDone',true);
    log('v1.4 migration skipped on a fresh/default configuration; package defaults already enable only Question and Finished.');
    return;
  }
  const current=allEventSettings(); const raw={};
  for(const def of EVENT_DEFS){const setting=current[def.id]||defaultEventSetting(def);raw[def.id]={...setting,enabled:!def.unavailable && (def.id==='askUserQuestion'||def.id==='stop')};}
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global);
  await extensionContext.globalState.update('v140PrimaryDefaultsDone',true);
  log('v1.4 migration applied to an existing explicit event configuration.');
}

const PRESET_GROUPS={
  minimal:new Set(['askUserQuestion','stop']),
  recommended:new Set(['askUserQuestion','stop','permissionRequest','permissionDenied','postToolUseFailure','stopFailure','subagentStop','taskCompleted','elicitation'])
};
function enabledSetFromSettings(settings=allEventSettings()){
  return new Set(EVENT_DEFS.filter(d=>!d.unavailable && settings[d.id]?.enabled).map(d=>d.id));
}
function sameSet(a,b){
  if(a.size!==b.size)return false;
  for(const v of a) if(!b.has(v)) return false;
  return true;
}
function activePresetName(settings=allEventSettings()){
  const enabled=enabledSetFromSettings(settings);
  const all=new Set(EVENT_DEFS.filter(d=>!d.unavailable).map(d=>d.id));
  if(sameSet(enabled,PRESET_GROUPS.minimal))return 'minimal';
  if(sameSet(enabled,PRESET_GROUPS.recommended))return 'recommended';
  if(sameSet(enabled,all))return 'everything';
  return 'custom';
}
async function applyPreset(name){
  if(!['minimal','recommended','everything'].includes(name)) throw new Error(`Unknown preset: ${name}`);
  const current=allEventSettings();
  const raw={};
  const wanted = name==='everything'
    ? new Set(EVENT_DEFS.filter(d=>!d.unavailable).map(d=>d.id))
    : PRESET_GROUPS[name];
  for(const def of EVENT_DEFS){
    const s=current[def.id]||defaultEventSetting(def);
    raw[def.id]={...s,enabled:!def.unavailable && wanted.has(def.id)};
  }
  suppressEventSettingsUi=Date.now()+750;
  await cfg().update('eventSettings',raw,vscode.ConfigurationTarget.Global);
  scheduleHookReconcileIfShapeChanged(250);
  log(`Applied ${name} alert preset.`);
  if(controlPanel) controlPanel.webview.postMessage({type:'toast',text:`${name[0].toUpperCase()+name.slice(1)} preset applied.`});
  await sendUiState();
}

function nonce(){return crypto.randomBytes(16).toString('base64');}
async function getUiState(){
  const hs=await hookInstallStatus(); const brokerPort=hs.targetPort||null;
  const settings=allEventSettings();
  return {
    enabled:cfg().get('enabled',true), visualNotifications:cfg().get('showVisualNotifications',false), repeatGapMs:Math.round(clamp(cfg().get('repeatGapMs',150),0,3000)),
    hooks:hs, listenerActive:listenerIsActive(), listenerMode, listenerDetail, listenerPort, brokerPort, listenerBasePort:getBasePort(), listenerPortCount:getPortCount(), platform:process.platform,
    events:EVENT_DEFS.map(d=>({...d,setting:settings[d.id]})), categories:CATEGORIES, sounds:allSoundOptions(), watchedFiles:cfg().get('watchedFiles',[])||[], activePreset:activePresetName(settings)
  };
}
async function sendUiState(){if(!controlPanel)return;try{await controlPanel.webview.postMessage({type:'state',state:await getUiState()});}catch(_error){} }
function scheduleUiState(delay=120){if(uiStateTimer)clearTimeout(uiStateTimer);uiStateTimer=setTimeout(()=>{uiStateTimer=undefined;void sendUiState();},delay);}

function controlPanelHtml(webview,initialState){
  const n=nonce();
  const stateJson=JSON.stringify(initialState).replace(/</g,'\\u003c');
  const iconUri=webview.asWebviewUri(vscode.Uri.file(extensionContext.asAbsolutePath(path.join('media','icon.png'))));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';"><title>Claude Code Sound Alerts</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px}
.wrap{max-width:1220px;margin:0 auto}
.hero{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:18px}
.brand{display:flex;gap:14px;align-items:center}
.brand-icon{width:58px;height:58px;border-radius:14px;object-fit:cover;border:1px solid var(--vscode-panel-border)}
h1{font-size:24px;line-height:1.2;margin:0 0 5px;font-weight:650}
.sub,.hint,.note{color:var(--vscode-descriptionForeground)}
.sub{font-size:13px}
.toolbar,.panel,.event{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
.toolbar,.panel{border-radius:12px;padding:14px 16px;margin-bottom:16px}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.actions,.status,.filters,.preset-row,.footerline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:5px 9px;font-size:12px;background:var(--vscode-editor-background)}
.pill.ok{color:var(--vscode-testing-iconPassed)}
.pill.warn{color:var(--vscode-editorWarning-foreground)}
button,select,input{font:inherit}
button{border:0;border-radius:7px;padding:7px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{opacity:.5;cursor:not-allowed}
.panel-title{font-size:14px;font-weight:650;margin-bottom:4px}
.preset-panel{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(280px,.8fr);gap:18px}
.preset-row{margin-top:10px}
.preset-btn{position:relative;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:8px 14px}
.preset-btn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-focusBorder)}
.preset-btn.active:after{content:"✓";margin-left:7px;font-weight:700}
.custom-label{display:none;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:5px 9px;color:var(--vscode-descriptionForeground)}
.custom-label.show{display:inline-flex}
.section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:22px 0 10px}
.section-head h2{font-size:16px;margin:0;font-weight:650}
.section-caption{font-size:12px;color:var(--vscode-descriptionForeground);margin-top:3px}
.primary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.eventgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.event{border-radius:12px;padding:15px;min-width:0}
.event.primary{border-color:var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-sideBar-background) 92%,var(--vscode-focusBorder) 8%)}
.event.disabled-card{opacity:.68}
.event.off:not(.primary){opacity:.82}
.head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.event-title{font-size:14px;font-weight:650}
.event.primary .event-title{font-size:16px}
.meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}
.badge{font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 7px;color:var(--vscode-descriptionForeground)}
.primary-badge{font-size:10px;border-radius:999px;padding:3px 7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);text-transform:uppercase;letter-spacing:.4px}
.hint{font-size:12px;margin:7px 0 13px;line-height:1.45}
.switch{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;cursor:pointer;font-weight:600}
.switch input{appearance:none;width:34px;height:19px;border-radius:999px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);position:relative;margin:0;cursor:pointer;transition:.15s}
.switch input:after{content:"";position:absolute;width:13px;height:13px;border-radius:50%;top:2px;left:2px;background:var(--vscode-descriptionForeground);transition:.15s}
.switch input:checked{background:var(--vscode-button-background);border-color:var(--vscode-button-background)}
.switch input:checked:after{left:17px;background:var(--vscode-button-foreground)}
.switch input:disabled{cursor:not-allowed}
.controlgrid{display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(160px,1fr) 92px;gap:12px;align-items:end}
.field label{display:block;font-size:12px;margin-bottom:5px;color:var(--vscode-descriptionForeground)}
.field select,.field input[type=range]{width:100%}
select,input[type=text],input[type=number]{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:7px;padding:7px 9px}
.volline{display:flex;gap:8px;align-items:center}
.volline input{flex:1;min-width:80px}
.value{min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.boost{color:var(--vscode-editorWarning-foreground);font-size:10px;font-weight:650;margin-left:3px}
.eventactions{display:flex;gap:8px;margin-top:11px}
.preview{min-width:82px}
.library-list{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}
.soundchip{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:4px 8px;font-size:12px}
.utility-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.search{min-width:240px}
.filewatch{width:100%}
.toast{min-height:20px;margin:10px 0 0;font-size:12px;color:var(--vscode-descriptionForeground)}
.safety{color:var(--vscode-editorWarning-foreground);font-size:12px;margin-top:8px}
details.more{margin-top:2px}
details.more>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;font-weight:650;font-size:14px;padding:7px 0}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:before{content:"›";font-size:18px;transform:rotate(0deg);transition:.15s}
details.more[open]>summary:before{transform:rotate(90deg)}
@media(max-width:850px){body{padding:16px}.hero{flex-direction:column}.preset-panel,.utility-grid,.primary-grid,.eventgrid{grid-template-columns:1fr}.controlgrid{grid-template-columns:1fr}.search{min-width:0;width:100%}}
</style></head>
<body><div class="wrap">
<div class="hero"><div class="brand"><img class="brand-icon" src="${iconUri}" alt=""><div><h1>Claude Code Sound Alerts</h1><div class="sub">Hear when Claude needs you and when the work is done.</div></div></div></div>

<div class="toolbar"><div class="status"><span id="hookStatus" class="pill"></span><span id="listenerStatus" class="pill"></span></div><div class="actions"><button id="installHooks">Install / Update Hooks</button><button id="removeHooks" class="secondary">Remove Hooks</button><button id="openLog" class="secondary">Open Log</button></div></div>

<div class="panel preset-panel">
  <div>
    <div class="panel-title">Alert preset</div>
    <div class="hint">Choose how much Claude activity should make a sound. Sound, volume, and repeat choices are preserved.</div>
    <div class="preset-row">
      <button data-preset="minimal" class="preset-btn">Minimal</button>
      <button data-preset="recommended" class="preset-btn">Recommended</button>
      <button data-preset="everything" class="preset-btn">Everything</button>
      <span id="customPreset" class="custom-label">Custom</span>
    </div>
  </div>
  <div>
    <div class="panel-title">Sound library</div>
    <div class="hint">Use the built-in sounds or add your own PCM WAV once and reuse it anywhere.</div>
    <div class="actions"><button id="addSound">Add WAV to My Sounds…</button></div>
    <div id="customSounds" class="library-list"></div>
  </div>
</div>

<div class="section-head"><div><h2>Primary alerts</h2><div class="section-caption">These are the only two alerts enabled by default.</div></div></div>
<div id="primaryEvents" class="primary-grid"></div>

<div class="section-head"><div><h2>Other Claude events</h2><div class="section-caption">Optional alerts for permissions, errors, tools, agents, tasks, sessions, and more.</div></div><div class="filters"><input id="search" class="search" type="text" placeholder="Search events…" aria-label="Search Claude events"><select id="category" aria-label="Filter events by category"><option value="">All categories</option></select></div></div>
<div id="events" class="eventgrid"></div>

<details class="more">
  <summary>Advanced & global settings</summary>
  <div class="panel utility-grid">
    <div>
      <div class="panel-title">FileChanged event</div>
      <div class="hint">Claude requires literal filenames to watch. Separate names with commas, e.g. <code>.env, package.json</code>.</div>
      <input id="watchedFiles" class="filewatch" type="text" placeholder=".env, package.json" aria-label="Watched filenames for FileChanged alerts">
    </div>
    <div>
      <div class="panel-title">Global controls</div>
      <div class="footerline"><label><input id="enabled" type="checkbox"> Enable alerts</label><label><input id="visual" type="checkbox"> VS Code popups</label><label>Repeat gap <input id="gap" type="number" min="0" max="3000" step="50" style="width:82px"> ms</label></div>
      <div class="note" style="margin-top:8px">Volume above 100% digitally boosts the WAV and can clip. Windows master volume still applies.</div>
    </div>
  </div>
</details>
<div id="toast" class="toast" aria-live="polite"></div>
</div>
<script nonce="${n}">
(()=>{const vscode=acquireVsCodeApi();let state=${stateJson};const $=id=>document.getElementById(id);
function post(action,extra={}){vscode.postMessage({action,...extra})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function soundOptions(selected){return(state.sounds||[]).map(s=>'<option value="'+esc(s.id)+'" '+(s.id===selected?'selected':'')+'>'+esc(s.label)+(s.builtIn?'':' (My Sound)')+'</option>').join('')}
function renderLibrary(){const custom=(state.sounds||[]).filter(s=>!s.builtIn);$('customSounds').innerHTML=custom.length?custom.map(s=>'<span class="soundchip">'+esc(s.label)+' <button class="secondary removeSound" data-id="'+esc(s.id)+'" title="Remove" style="padding:1px 5px">×</button></span>').join(''):'<span class="note">No personal sounds added yet.</span>';document.querySelectorAll('.removeSound').forEach(b=>b.addEventListener('click',()=>post('removeSound',{id:b.dataset.id})))}
function eventCard(e,primary){
  const s=e.setting||{},locked=!!e.unavailable,title=primary?(e.id==='askUserQuestion'?'Question':'Finished'):e.label;
  const sid='sound-'+e.id,vid='volume-'+e.id,rid='repeat-'+e.id;
  return '<section class="event '+(primary?'primary ':'')+(locked?'disabled-card ':'')+(!s.enabled?'off':'')+'" data-id="'+esc(e.id)+'" data-category="'+esc(e.category)+'" data-search="'+esc((e.label+' '+e.description+' '+e.hookEvent).toLowerCase())+'"><div class="head"><div><div class="event-title">'+esc(title)+'</div><div class="meta">'+(primary?'<span class="primary-badge">Primary</span>':'')+'<span class="badge">'+esc(e.hookEvent)+'</span><span class="badge">'+esc(e.category)+'</span></div></div><label class="switch"><input class="evtEnabled" type="checkbox" '+(s.enabled?'checked':'')+' '+(locked?'disabled':'')+'><span>'+(s.enabled?'On':'Off')+'</span></label></div><div class="hint">'+esc(e.description)+'</div>'+(locked?'<div class="safety">Not hooked: configuring WorktreeCreate would replace Claude Code’s normal worktree creation behavior.</div>':'<div class="controlgrid"><div class="field"><label for="'+sid+'">Sound</label><select id="'+sid+'" class="evtSound">'+soundOptions(s.sound)+'</select></div><div class="field"><label for="'+vid+'">Volume <span class="boost">'+(s.volume>100?'BOOST':'')+'</span></label><div class="volline"><input id="'+vid+'" class="evtVolume" type="range" min="0" max="200" value="'+s.volume+'"><span class="value">'+s.volume+'%</span></div></div><div class="field"><label for="'+rid+'">Repeat</label><select id="'+rid+'" class="evtRepeat">'+[1,2,3,4,5].map(n=>'<option value="'+n+'" '+(n===s.repeat?'selected':'')+'>'+n+'×</option>').join('')+'</select></div></div><div class="eventactions"><button class="preview">Preview</button></div>')+'</section>';
}
function bindCards(){
  document.querySelectorAll('.event').forEach(card=>{
    const id=card.dataset.id,en=card.querySelector('.evtEnabled'),sound=card.querySelector('.evtSound'),vol=card.querySelector('.evtVolume'),rep=card.querySelector('.evtRepeat'),preview=card.querySelector('.preview');
    if(en)en.addEventListener('change',e=>{const checked=!!e.target.checked;const label=e.target.closest('.switch')?.querySelector('span');if(label)label.textContent=checked?'On':'Off';card.classList.toggle('off',!checked);post('setEvent',{id,key:'enabled',value:checked});});
    if(sound)sound.addEventListener('change',e=>post('setEvent',{id,key:'sound',value:e.target.value}));
    if(vol){vol.addEventListener('input',e=>{card.querySelector('.value').textContent=e.target.value+'%';card.querySelector('.boost').textContent=Number(e.target.value)>100?'BOOST':''});vol.addEventListener('change',e=>post('setEvent',{id,key:'volume',value:Number(e.target.value)}));}
    if(rep)rep.addEventListener('change',e=>post('setEvent',{id,key:'repeat',value:Number(e.target.value)}));
    if(preview)preview.addEventListener('click',()=>post('preview',{id,volume:Number(vol.value),repeat:Number(rep.value),sound:sound.value}));
  });
}
function updateEventView(id,setting,activePreset){
  const event=(state.events||[]).find(e=>e.id===id);if(event)event.setting=setting;state.activePreset=activePreset||state.activePreset;
  const card=document.querySelector('.event[data-id="'+CSS.escape(id)+'"]');if(!card)return;
  const en=card.querySelector('.evtEnabled'),sound=card.querySelector('.evtSound'),vol=card.querySelector('.evtVolume'),rep=card.querySelector('.evtRepeat');
  if(en){en.checked=!!setting.enabled;const label=en.closest('.switch')?.querySelector('span');if(label)label.textContent=setting.enabled?'On':'Off';card.classList.toggle('off',!setting.enabled);}
  if(sound)sound.value=setting.sound;
  if(vol){vol.value=setting.volume;card.querySelector('.value').textContent=setting.volume+'%';card.querySelector('.boost').textContent=Number(setting.volume)>100?'BOOST':'';}
  if(rep)rep.value=String(setting.repeat);
  renderPreset();
}

function applyFilter(){const q=$('search').value.trim().toLowerCase(),cat=$('category').value;document.querySelectorAll('#events .event').forEach(c=>{c.style.display=(!q||c.dataset.search.includes(q))&&(!cat||c.dataset.category===cat)?'':'none'})}
function renderPreset(){document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('active',b.dataset.preset===state.activePreset));$('customPreset').classList.toggle('show',state.activePreset==='custom')}
function saveViewState(){const more=document.querySelector('details.more');vscode.setState({search:$('search')?.value||'',category:$('category')?.value||'',advanced:!!more?.open,scrollY:window.scrollY});}
function render(){
  const saved=vscode.getState()||{},hs=state.hooks||{};
  let hookText,hookOk=false;
  if(hs.error)hookText='⚠ Hook status unavailable';
  else if(hs.complete&&hs.total===0){hookText='✓ No hooks needed';hookOk=true;}
  else if(hs.complete){hookText='✓ Hooks current ('+hs.current+'/'+hs.total+')';hookOk=true;}
  else if(hs.stale)hookText='⚠ Hooks need update ('+hs.current+'/'+hs.total+')';
  else hookText='⚠ Hooks incomplete ('+hs.installed+'/'+hs.total+')';
  $('hookStatus').textContent=hookText;$('hookStatus').className='pill '+(hookOk?'ok':'warn');$('hookStatus').title=hs.error||hs.targetUrl||'';
  const lm=state.listenerMode||'inactive';$('listenerStatus').textContent=lm==='owned'?'● Listener '+state.listenerPort+(state.brokerPort===state.listenerPort?' — router':''):lm==='disabled'?'○ Listener disabled':'○ Listener inactive';$('listenerStatus').className='pill '+(state.listenerActive?'ok':'warn');$('listenerStatus').title=state.listenerDetail||'';
  $('enabled').checked=!!state.enabled;$('visual').checked=!!state.visualNotifications;$('gap').value=state.repeatGapMs;$('watchedFiles').value=(state.watchedFiles||[]).join(', ');
  const currentCat=saved.category||$('category').value;$('category').innerHTML='<option value="">All categories</option>'+(state.categories||[]).map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');if((state.categories||[]).includes(currentCat))$('category').value=currentCat;
  $('search').value=saved.search||$('search').value||'';document.querySelector('details.more').open=!!saved.advanced;
  const primaryIds=new Set(['askUserQuestion','stop']);const primary=(state.events||[]).filter(e=>primaryIds.has(e.id)).sort((a,b)=>a.id==='askUserQuestion'?-1:1);const others=(state.events||[]).filter(e=>!primaryIds.has(e.id));
  $('primaryEvents').innerHTML=primary.map(e=>eventCard(e,true)).join('');$('events').innerHTML=others.map(e=>eventCard(e,false)).join('');renderLibrary();renderPreset();bindCards();applyFilter();requestAnimationFrame(()=>window.scrollTo(0,Number(saved.scrollY)||0));
}

$('installHooks').addEventListener('click',()=>post('installHooks'));$('removeHooks').addEventListener('click',()=>post('removeHooks'));$('openLog').addEventListener('click',()=>post('openLog'));$('addSound').addEventListener('click',()=>post('addSound'));document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{b.disabled=true;post('applyPreset',{name:b.dataset.preset});setTimeout(()=>{b.disabled=false},500)}));$('enabled').addEventListener('change',e=>post('setGlobal',{key:'enabled',value:e.target.checked}));$('visual').addEventListener('change',e=>post('setGlobal',{key:'showVisualNotifications',value:e.target.checked}));$('gap').addEventListener('change',e=>post('setGlobal',{key:'repeatGapMs',value:Number(e.target.value)}));$('watchedFiles').addEventListener('change',e=>post('setWatchedFiles',{value:e.target.value}));$('search').addEventListener('input',()=>{applyFilter();saveViewState()});$('category').addEventListener('change',()=>{applyFilter();saveViewState()});document.querySelector('details.more').addEventListener('toggle',saveViewState);let scrollTimer;window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(saveViewState,150)});window.addEventListener('message',ev=>{const m=ev.data;if(m.type==='state'){saveViewState();state=m.state;render()}if(m.type==='eventSetting'){updateEventView(m.id,m.setting,m.activePreset)}if(m.type==='toast'){$('toast').textContent=m.text||'';if(m.text)setTimeout(()=>{if($('toast').textContent===m.text)$('toast').textContent=''},3000)}});render()})();
</script></body></html>`;
}

async function openControlPanel(){
  if(controlPanel){controlPanel.reveal(vscode.ViewColumn.One);await sendUiState();return;}
  controlPanel=vscode.window.createWebviewPanel('claudeSoundAlerts.controlPanel','Claude Sound Alerts',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:false,localResourceRoots:[vscode.Uri.file(extensionContext.asAbsolutePath('media'))]});
  controlPanel.webview.html=controlPanelHtml(controlPanel.webview,await getUiState()); controlPanel.onDidDispose(()=>{controlPanel=undefined;},null,extensionContext.subscriptions);
  controlPanel.webview.onDidReceiveMessage(async msg=>{
    try{
      if(msg.action==='setEvent'){
        controlMutationQueue=controlMutationQueue.then(async()=>{
          suppressEventSettingsUi=Date.now()+750;
          await updateEventSetting(msg.id,msg.key,msg.value);
          const setting=eventSetting(msg.id);
          await controlPanel?.webview.postMessage({type:'eventSetting',id:msg.id,setting,activePreset:activePresetName()});
          if(msg.key==='enabled')scheduleHookReconcileIfShapeChanged(250);
        }).catch(error=>{log(`Event setting update failed: ${error.stack||error}`);controlPanel?.webview.postMessage({type:'toast',text:`Could not save alert setting: ${error.message||error}`});});
        await controlMutationQueue;return;
      }
      if(msg.action==='preview'){await playProfile(msg.id,'Control panel preview',true,{sound:msg.sound,volume:msg.volume,repeat:msg.repeat});controlPanel?.webview.postMessage({type:'toast',text:'Preview played.'});return;}
      if(msg.action==='setGlobal'){
        const allowed=new Set(['enabled','showVisualNotifications','repeatGapMs']); if(!allowed.has(msg.key))return;
        const value=msg.key==='repeatGapMs'?Math.round(clamp(msg.value,0,3000)):msg.value; await cfg().update(msg.key,value,vscode.ConfigurationTarget.Global); scheduleUiState();updateStatusBar();return;
      }
      if(msg.action==='setWatchedFiles'){
        const names=String(msg.value||'').split(',').map(v=>v.trim()).filter(Boolean).filter(v=>!v.includes('|')); await cfg().update('watchedFiles',[...new Set(names)],vscode.ConfigurationTarget.Global);
        scheduleHookReconcileIfShapeChanged(250);scheduleUiState();return;
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
function updateStatusBar(){if(!statusItem)return;if(!cfg().get('enabled',true)){statusItem.text='$(mute) Claude Alerts';statusItem.tooltip='Claude Code Sound Alerts are disabled. Click to configure.';return;}statusItem.text='$(unmute) Claude Alerts';statusItem.tooltip=listenerMode==='owned'?`Claude Sound Alerts listener is active on localhost:${listenerPort}. Click to configure.`:listenerMode==='disabled'?'Claude Sound Alerts listener is disabled. Click to configure.':'Claude Sound Alerts listener is not currently active. Click to configure.';}

async function activate(context){
  extensionContext=context;
  output=vscode.window.createOutputChannel('Claude Code Sound Alerts');context.subscriptions.push(output);

  // Register user-facing commands/status first so a migration or settings problem
  // cannot make the whole extension disappear from the Command Palette.
  statusItem=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,100);statusItem.command='claudeSoundAlerts.openControlPanel';statusItem.show();context.subscriptions.push(statusItem);updateStatusBar();
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.installHooks',()=>installHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.uninstallHooks',()=>uninstallHooks(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openLog',()=>output.show(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.openControlPanel',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.configureSounds',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.addSoundToLibrary',()=>addSoundToLibrary(true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testQuestionSound',()=>playProfile('askUserQuestion','Manual test',true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.testFinishedSound',()=>playProfile('stop','Manual test',true)));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectQuestionSound',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.selectFinishedSound',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setQuestionVolume',openControlPanel));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSoundAlerts.setFinishedVolume',openControlPanel));

  try{initializeListenerToken();}catch(error){listenerToken=crypto.randomBytes(32).toString('hex');log(`Could not persist listener security token; using a temporary token: ${error.message||error}`);}

  const migrations=[migrateV12Settings,migrateV131QuestionSound,migrateV132DoneAndErrorSounds,migrateV140PrimaryDefaults];
  for(const migration of migrations){try{await migration();}catch(error){log(`Migration ${migration.name} failed; continuing with current/default settings: ${error.stack||error}`);}
  }
  hookShapeKey=currentHookShapeKey();

  // Subscribe after migrations so migration writes do not trigger unnecessary
  // listener restarts, UI redraws, or hook reconciliation during activation.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    const listenerConfig=event.affectsConfiguration('claudeSoundAlerts.enabled')||event.affectsConfiguration('claudeSoundAlerts.serverPort')||event.affectsConfiguration('claudeSoundAlerts.listenerPortCount');
    const eventConfig=event.affectsConfiguration('claudeSoundAlerts.eventSettings');
    const fileConfig=event.affectsConfiguration('claudeSoundAlerts.watchedFiles');
    if(listenerConfig){void startServer();scheduleHookReconcileIfShapeChanged(1200);}
    if(eventConfig){if(Date.now()>=suppressEventSettingsUi)scheduleUiState();scheduleHookReconcileIfShapeChanged(400);}
    if(fileConfig){scheduleUiState();scheduleHookReconcileIfShapeChanged(400);}
    if(event.affectsConfiguration('claudeSoundAlerts')&&!eventConfig&&!fileConfig)scheduleUiState();
    if(event.affectsConfiguration('claudeSoundAlerts'))updateStatusBar();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>{void writeListenerRegistration();}));
  void pruneAudioCache();
  void startServer().then(async()=>{
    try{const status=await hookInstallStatus();if(status.oursAnywhere>0)await extensionContext.globalState.update('hooksManaged',true);if(status.oursAnywhere>0&&!status.complete)scheduleHookReconcile(800);}catch(error){log(`Initial hook reconciliation check failed: ${error.message||error}`);}
  });
  log('Extension v1.6.0 activated. Secure dynamic multi-window routing is enabled; only enabled alerts are installed as Claude hooks.');
}
async function deactivate(){
  if(hookReconcileTimer){clearTimeout(hookReconcileTimer);hookReconcileTimer=undefined;}
  if(uiStateTimer){clearTimeout(uiStateTimer);uiStateTimer=undefined;}
  if(retryTimer){clearTimeout(retryTimer);retryTimer=undefined;}
  stopHeartbeat();
  try{fs.unlinkSync(listenerRegistryFile());}catch(_error){}
  await stopServer(true,false);
}
const testApi=process.env.CLAUDE_SOUND_ALERTS_TEST==='1' ? {
  EVENT_DEFS, parseClaudeSettingsText, patchTopLevelHooks, pcmWavInfo, scalePcmWav,
  desiredHookGroups, desiredHookSignatures, ourHookSignatures, hookSignature
} : null;
module.exports=testApi?{activate,deactivate,__test:testApi}:{activate,deactivate};

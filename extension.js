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
  { id: 'question', label: 'Question Ping' },
  { id: 'done-fanfare', label: 'Done Fanfare' },
  { id: 'finished', label: 'Agent Finished' },
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
  { id:'backgroundPending', hookEvent:'Stop', virtual:true, category:'Turn', label:'Background Work / Waiting', description:'The main Claude turn paused, but blocking background work or a one-shot scheduled wakeup is still active. Ambient/ignored task types can be excluded.', defaultEnabled:false, sound:'calm-complete', volume:35, repeat:1 },
  { id:'recurringCronIteration', hookEvent:'Stop', virtual:true, category:'Turn', label:'Recurring Loop Iteration', description:'The current turn ended but only recurring scheduled work such as /loop remains. Silent by default and separate from Main Work Finished.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'stopUnverified', hookEvent:'Stop', virtual:true, category:'Turn', label:'Completion Unverified', description:'Claude stopped, but the current payload did not include enough task-registry data to prove that all background work is finished.', defaultEnabled:false, sound:'soft-bell', volume:30, repeat:1 },
  { id:'sessionStart', hookEvent:'SessionStart', category:'Session', label:'Session Started', description:'A Claude Code session starts or resumes.', defaultEnabled:false, sound:'gentle-chime', volume:35, repeat:1, transport:'command' },
  { id:'setup', hookEvent:'Setup', category:'Session', label:'Setup', description:'CLI-only setup/init/maintenance hook. It does not normally fire in the VS Code panel.', defaultEnabled:false, sound:'digital-pop', volume:30, repeat:1, transport:'command' },
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
  { id:'notificationPermissionPrompt', hookEvent:'Notification', virtual:true, matcher:'permission_prompt', category:'Attention', label:'Permission Reminder', description:'A permission prompt has been waiting and Claude sends a notification reminder.', defaultEnabled:false, sound:'bright-ping', volume:70, repeat:2 },
  { id:'notificationIdlePrompt', hookEvent:'Notification', virtual:true, matcher:'idle_prompt', category:'Attention', label:'Idle Reminder', description:'Claude sends an idle reminder after a completed response. Suppressed if this extension still knows background work is pending.', defaultEnabled:false, sound:'soft-bell', volume:35, repeat:1 },
  { id:'notificationAgentNeedsInput', hookEvent:'Notification', virtual:true, matcher:'agent_needs_input', category:'Agents', label:'Background Agent Needs Input', description:'A background session or teammate is waiting for your input.', defaultEnabled:false, sound:'question-chime', volume:80, repeat:2 },
  { id:'notificationAgentCompleted', hookEvent:'Notification', virtual:true, matcher:'agent_completed', category:'Agents', label:'Background Session Completed', description:'Terminal Agent View reports a background session finished or failed. Claude currently fires this only while Agent View is open; it is separate from main-work completion.', defaultEnabled:false, sound:'finished', volume:45, repeat:1 },
  { id:'notificationQuotaResumed', hookEvent:'Notification', virtual:true, matcher:'quota_auto_resume_fired', category:'Session', label:'Quota Auto-Resume', description:'Claude automatically resumed work after usage became available again. Requires Claude Code 2.1.234 or later.', defaultEnabled:false, sound:'gentle-chime', volume:35, repeat:1 },
  { id:'notificationQuotaStale', hookEvent:'Notification', virtual:true, matcher:'quota_auto_resume_stale', category:'Attention', label:'Quota Resume Needs You', description:'The quota reset happened after a long sleep and Claude is waiting for you to continue. Requires Claude Code 2.1.234 or later.', defaultEnabled:false, sound:'bright-ping', volume:65, repeat:2 },
  { id:'notificationQuotaDisabled', hookEvent:'Notification', virtual:true, matcher:'quota_auto_resume_disabled', category:'Errors', label:'Quota Auto-Resume Stopped', description:'Claude ended its usage-limit wait without continuing automatically. Requires Claude Code 2.1.234 or later.', defaultEnabled:false, sound:'error-impact', volume:70, repeat:1 },
  { id:'notification', hookEvent:'Notification', category:'Attention', label:'Other Claude Notification', description:'Catch-all for Claude notifications not handled by a more specific notification alert.', defaultEnabled:false, sound:'soft-bell', volume:55, repeat:1 },
  { id:'subagentStart', hookEvent:'SubagentStart', category:'Agents', label:'Subagent Started', description:'A Claude subagent is spawned.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'subagentStop', hookEvent:'SubagentStop', category:'Agents', label:'Agent Finished', description:'One Claude subagent finished. This never counts as the main Claude work being finished.', defaultEnabled:false, sound:'finished', volume:45, repeat:1 },
  { id:'taskCreated', hookEvent:'TaskCreated', category:'Tasks', label:'Task Created', description:'Claude creates a task.', defaultEnabled:false, sound:'soft-pop', volume:25, repeat:1 },
  { id:'taskCompleted', hookEvent:'TaskCompleted', category:'Tasks', label:'Task Completed', description:'Claude marks one task as completed. This does not mean the overall turn is finished.', defaultEnabled:false, sound:'success-chime', volume:45, repeat:1 },
  { id:'stop', hookEvent:'Stop', category:'Turn', label:'Main Work Finished', description:'Plays only after the completion grace window when Claude appears fully done: no blocking background work, no one-shot wakeups, no immediate self-resume, and no waiting-language downgrade.', defaultEnabled:true, sound:'done-fanfare', volume:55, repeat:1 },
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
  { id:'preModelSwitch', hookEvent:'PreModelSwitch', category:'System', label:'Before Model Switch', description:'Claude Code is about to apply a requested model switch.', defaultEnabled:false, sound:'digital-pop', volume:25, repeat:1 },
  { id:'postModelSwitch', hookEvent:'PostModelSwitch', category:'System', label:'Model Switched', description:'The session model changed, including automatic/restored model changes.', defaultEnabled:false, sound:'gentle-chime', volume:30, repeat:1 },
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
let relayStoragePathOverride=null;
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
const listenerProbeCache = new Map();
const LISTENER_PROBE_CACHE_MS = 3000;
const sessionStates = new Map();
const SESSION_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const pendingFinished = new Map();
const sessionRoutePins = new Map();
const routedEventSeen = new Map();
const ROUTE_PIN_TTL_MS = 6 * 60 * 60 * 1000;
const ROUTED_EVENT_TTL_MS = 60 * 1000;
let lastSharedDedupePruneAt = 0;
let lastStopDiagnostic = null;
const TERMINAL_TASK_STATUSES = new Set(['completed','failed','killed','stopped','cancelled','canceled','done']);
const WAITING_TEXT_PATTERNS = [
  /\bstill\s+(?:running|in progress|working|pending)\b/i,
  /\bwaiting\s+only\s+(?:on|for)\s+(?!you\b|your\b|the\s+user\b|confirmation\b|approval\b|input\b|feedback\b)[^.!?\n]{1,100}/i,
  /\bwaiting\s+(?:on|for)\s+the\s+(?:ci(?:\s+pipeline)?|pipeline|build|run|suite|tests?|deploy(?:ment)?|job|benchmark)\b[^.!?\n]{0,120}/i,
  /\b(?:i(?:'|’)ll|i\s+will|we\s+will|will)\s+(?:report|notify|let\s+you\s+know|update\s+you)\b[^.!?\n]{0,140}\b(?:when|once|after)\b[^.!?\n]{0,100}\b(?:finish|finishes|complete|completes|done|ready)\b/i,
  /\b(?:i(?:'|’)ll|i\s+will)\s+check\s+back\b[^.!?\n]{0,120}\b(?:once|when|after)\b[^.!?\n]{0,80}\b(?:complete|completes|finish|finishes|done|ready)\b/i,
  /\bbackground\s+(?:run|job|task|agent|agents|process|processes)\b[^.!?\n]{0,90}\b(?:is|are)?\s*(?:still\s+)?(?:running|in progress|pending)\b/i,
  /\b(?:running|started|launched)\b[^.!?\n]{0,60}\bin\s+the\s+background\b[^.!?\n]{0,120}\b(?:nohup|results?|report|finish|complete|minutes?|hours?)\b/i
];
const WAITING_CLAUSE_NEGATION_RE = /\b(?:no\s+longer|nothing(?:\s+(?:is|was))?|none|not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|no)\s+(?:\w+\s+){0,2}$/i;


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
function invalidateProbeCache(port=null){
  if(port===null) listenerProbeCache.clear();
  else listenerProbeCache.delete(Number(port));
}
async function probeListenerCached(port,maxAgeMs=LISTENER_PROBE_CACHE_MS){
  const p=Number(port);
  if(p===listenerPort && listenerIsActive()) return {active:true,free:false,data:{ok:true,tag:EXTENSION_TAG,id:listenerId,pid:process.pid,port:p}};
  const cached=listenerProbeCache.get(p);
  if(cached && Date.now()-cached.at<maxAgeMs) return cached.result;
  const result=await probeListener(p);
  listenerProbeCache.set(p,{at:Date.now(),result});
  return result;
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
function pruneRoutePins(now=Date.now()) {
  for(const [key,pin] of sessionRoutePins) if(now-Number(pin?.at||0)>ROUTE_PIN_TTL_MS) sessionRoutePins.delete(key);
  for(const [key,at] of routedEventSeen) if(now-Number(at||0)>ROUTED_EVENT_TTL_MS) routedEventSeen.delete(key);
}
async function rankedListenerRecords(body) {
  const cwd=typeof body?.cwd==='string'?body.cwd:'';
  const records=await activeListenerRecords();
  pruneRoutePins();
  const sid=sessionKey(body),pin=sid?sessionRoutePins.get(sid):null;
  const ranked=records.map(d=>{
    let score=0; for(const root of (Array.isArray(d.workspaceRoots)?d.workspaceRoots:[])) score=Math.max(score,pathMatchScore(cwd,root));
    return {d,score,heartbeat:Number(d.heartbeatAt)||0,pinned:!!pin&&d.id===pin.listenerId};
  }).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.score-a.score||b.heartbeat-a.heartbeat).map(x=>x.d);
  if(pin && !ranked.some(d=>d.id===pin.listenerId)) sessionRoutePins.delete(sid);
  return ranked;
}
function pinSessionRoute(body,record){
  const sid=sessionKey(body);if(!sid||!record?.id)return;
  if(body?.hook_event_name==='SessionEnd'){sessionRoutePins.delete(sid);return;}
  sessionRoutePins.set(sid,{listenerId:record.id,at:Date.now()});
}
function ensureRoutingMetadata(body){
  if(!body||typeof body!=='object')return body;
  if(!body._claude_sound_alerts_event_id)body._claude_sound_alerts_event_id=crypto.randomBytes(10).toString('hex');
  if(!Number.isFinite(Number(body._claude_sound_alerts_received_at)))body._claude_sound_alerts_received_at=Date.now();
  return body;
}
function forwardedEventId(body){
  return typeof body?._claude_sound_alerts_event_id==='string'&&body._claude_sound_alerts_event_id?body._claude_sound_alerts_event_id:null;
}
function routedDedupeDir(){return extensionContext?.globalStorageUri?.fsPath?path.join(extensionContext.globalStorageUri.fsPath,'routed-event-dedupe'):null;}
async function pruneSharedRoutedDedupe(now=Date.now()){
  const dir=routedDedupeDir();if(!dir||now-lastSharedDedupePruneAt<ROUTED_EVENT_TTL_MS)return;lastSharedDedupePruneAt=now;
  try{
    const names=await fs.promises.readdir(dir);
    await Promise.all(names.map(async name=>{const file=path.join(dir,name);try{const st=await fs.promises.stat(file);if(now-st.mtimeMs>ROUTED_EVENT_TTL_MS*2)await fs.promises.unlink(file);}catch(_error){}}));
  }catch(_error){}
}
async function markSharedRoutedEvent(id,now=Date.now()){
  const dir=routedDedupeDir();if(!dir)return false;
  try{
    await fs.promises.mkdir(dir,{recursive:true});
    void pruneSharedRoutedDedupe(now);
    const safe=/^[a-f0-9]{8,64}$/i.test(id)?id:crypto.createHash('sha1').update(id).digest('hex');
    const file=path.join(dir,`${safe}.seen`),handle=await fs.promises.open(file,'wx',0o600);
    try{await handle.writeFile(String(now),'utf8');}finally{await handle.close();}
    return false;
  }catch(error){if(error?.code==='EEXIST')return true;log(`Shared routed-event dedupe unavailable: ${error?.message||error}`);return false;}
}
async function markRoutedEventSeen(body){
  const id=forwardedEventId(body);if(!id)return false;
  const now=Date.now();if(routedEventSeen.has(id)){routedEventSeen.set(id,now);pruneRoutePins(now);return true;}
  let sharedSeen=false;
  if(body?._claude_sound_alerts_routed===1||body?._claude_sound_alerts_routed===true)sharedSeen=await markSharedRoutedEvent(id,now);
  routedEventSeen.set(id,now);pruneRoutePins(now);return sharedSeen;
}
function forwardHook(port,body,token=listenerToken) {
  return new Promise(resolve=>{
    const forwarded=ensureRoutingMetadata({...((body&&typeof body==='object')?body:{}),_claude_sound_alerts_routed:1});
    const raw=JSON.stringify(forwarded);
    const req=http.request({host:'127.0.0.1',port,path:`/${EXTENSION_TAG}/hook/${token}`,method:'POST',timeout:1500,agent:false,headers:{Host:`127.0.0.1:${port}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw),'X-Claude-Sound-Alerts-Routed':'1',Connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode===204));});
    req.on('timeout',()=>{req.destroy();resolve(false);}); req.on('error',()=>resolve(false)); req.write(raw); req.end();
  });
}
async function routeIncomingHook(body) {
  body=ensureRoutingMetadata((body&&typeof body==='object')?body:{});
  const candidates=await rankedListenerRecords(body);
  for(const d of candidates) {
    const port=Number(d.port);
    if(port===listenerPort) {
      pinSessionRoute(body,d);
      void handleHookLocally(body);
      return true;
    }
    if(await forwardHook(port,body,d.token||listenerToken)){pinSessionRoute(body,d);return true;}
    const sid=sessionKey(body),pin=sid?sessionRoutePins.get(sid):null;if(pin?.listenerId===d.id)sessionRoutePins.delete(sid);
  }
  if(listenerIsActive()) {
    pinSessionRoute(body,{id:listenerId});
    void handleHookLocally(body);
    return true;
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
  try{await tryListen(candidate,port);}catch(error){log(`Takeover bind on ${port} failed: ${error?.code||error?.message||error}`);try{candidate.close();}catch(_error){}return false;}
  if(generation!==listenerGeneration){try{candidate.close();candidate.closeAllConnections?.();}catch(_error){}return false;}
  const old=server, oldPort=listenerPort;
  server=candidate; listenerPort=port; listenerMode='owned'; invalidateProbeCache(); listenerDetail=`Took over configured router port ${port} without dropping the previous listener first.`;
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
  const byteRate=fmt.size>=16?buffer.readUInt32LE(fmt.start+8):0;
  const durationMs=byteRate>0?Math.ceil((data.size/byteRate)*1000):0;
  return {fmt,data,bits,format,byteRate,durationMs};
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
  const {timeoutMs=30000,...spawnOptions}=options;
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{ windowsHide:true, stdio:['ignore','pipe','pipe'], ...spawnOptions });
    let stdout='', stderr='', settled=false, timer;
    const finish=(fn,value)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);fn(value);};
    child.stdout?.on('data', d => stdout += String(d));
    child.stderr?.on('data', d => stderr += String(d));
    child.once('error', error => finish(reject,error));
    child.once('exit', (code,signal) => {
      if (code === 0) return finish(resolve,{stdout,stderr});
      const detail=(stderr||stdout||'').trim();
      finish(reject,new Error(`${command} exited with code ${code===null?'null':code}${signal?` (${signal})`:''}${detail?`: ${detail}`:''}`));
    });
    if(Number.isFinite(timeoutMs)&&timeoutMs>0){
      timer=setTimeout(()=>{
        try{child.kill();}catch(_error){}
        const error=new Error(`${command} audio playback timed out after ${Math.round(timeoutMs)} ms.`);
        error.code='ETIMEDOUT';
        finish(reject,error);
      },timeoutMs);
      timer.unref?.();
    }
  });
}
function audioPlaybackTimeoutMs(count=1,gapMs=0,durationMs=0){
  const repeats=Math.round(clamp(count,1,5));
  const gap=Math.round(clamp(gapMs,0,3000));
  const duration=Math.max(0,Number(durationMs)||0);
  return Math.min(10*60*1000,8000 + repeats*(duration+3000) + Math.max(0,repeats-1)*gap);
}
function windowsAudioHostScript(){
  return [
      "$ErrorActionPreference='Stop'",
      '$dll = $env:CLAUDE_SOUND_NATIVE_DLL',
      '$dir = [IO.Path]::GetDirectoryName($dll)',
      '[IO.Directory]::CreateDirectory($dir) | Out-Null',
      "$src = 'using System; using System.Runtime.InteropServices; public static class ClaudeSoundNative { [DllImport(\"winmm.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool PlaySound(string pszSound, IntPtr hmod, uint fdwSound); }'; $loaded = $false; if (Test-Path -LiteralPath $dll) { try { Add-Type -Path $dll; $loaded = $true } catch { Remove-Item -LiteralPath $dll -Force -ErrorAction SilentlyContinue } }; if (-not $loaded) { $lock = $dll + '.lock'; if (Test-Path -LiteralPath $lock) { try { $lockItem = Get-Item -LiteralPath $lock; if (([DateTime]::UtcNow - $lockItem.LastWriteTimeUtc).TotalSeconds -gt 30) { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } } catch {} }; $stream = $null; try { try { $stream = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) } catch {} ; if ($stream) { if (Test-Path -LiteralPath $dll) { Add-Type -Path $dll } else { Add-Type -TypeDefinition $src -OutputAssembly $dll; if (-not ('ClaudeSoundNative' -as [type])) { Add-Type -Path $dll } } } else { $deadline = (Get-Date).AddSeconds(5); while (-not (Test-Path -LiteralPath $dll) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }; if (Test-Path -LiteralPath $dll) { Add-Type -Path $dll } else { Add-Type -TypeDefinition $src } } } finally { if ($stream) { $stream.Dispose(); Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } } }",
      '$count = [Math]::Max(1, [int]$env:CLAUDE_SOUND_REPEAT)',
      '$gap = [Math]::Max(0, [int]$env:CLAUDE_SOUND_GAP_MS)',
      'for ($i = 0; $i -lt $count; $i++) { $ok = [ClaudeSoundNative]::PlaySound($env:CLAUDE_SOUND_FILE, [IntPtr]::Zero, 0x00020002); if (-not $ok) { throw \'Windows PlaySound failed.\' }; if ($i -lt ($count - 1) -and $gap -gt 0) { Start-Sleep -Milliseconds $gap } }'
  ].join('; ');
}
async function playRawWav(file, repeat=1, gap=0, durationMs=0) {
  const count=Math.round(clamp(repeat,1,5));
  const gapMs=Math.round(clamp(gap,0,3000));
  if(process.platform==='win32'){
    // Use the native Windows PlaySound API. The tiny P/Invoke assembly is cached
    // in extension global storage, so subsequent alerts load a precompiled DLL
    // instead of invoking the C# compiler. Repeats happen inside one PowerShell
    // process, avoiding a process spawn/compile for every repetition.
    const audioHostDir=path.join(extensionContext.globalStorageUri.fsPath,'audio-host');
    const script=windowsAudioHostScript();
    let meaningfulError=null; let missing=0;
    for(const command of ['powershell.exe','pwsh.exe']){
      const hostTag=command==='powershell.exe'?'winps':'pwsh';
      const dll=path.join(audioHostDir,`ClaudeSoundNative-${hostTag}-v1.dll`);
      const env={...process.env,CLAUDE_SOUND_FILE:file,CLAUDE_SOUND_NATIVE_DLL:dll,CLAUDE_SOUND_REPEAT:String(count),CLAUDE_SOUND_GAP_MS:String(gapMs)};
      const encoded=Buffer.from(script,'utf16le').toString('base64');
      try{await spawnCaptured(command,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',encoded],{env,timeoutMs:audioPlaybackTimeoutMs(count,gapMs,durationMs)});return;}
      catch(error){if(error?.code==='ENOENT'){missing++;continue;}meaningfulError=error;log(`${command} audio attempt failed: ${error.message||error}`);}
    }
    if(meaningfulError) throw meaningfulError;
    if(missing===2) throw new Error('No Windows PowerShell audio host was found. Windows PowerShell 5.1 or PowerShell 7 is required for WAV playback.');
    throw new Error('Windows could not play the WAV file.');
  }
  if(process.platform==='darwin'){
    for(let i=0;i<count;i++){await spawnCaptured('afplay',[file],{timeoutMs:audioPlaybackTimeoutMs(1,0,durationMs)});if(i<count-1&&gapMs)await sleep(gapMs);}
    return;
  }
  for(let i=0;i<count;i++){
    let lastError,played=false;
    for(const [cmd,args] of [['paplay',[file]],['ffplay',['-nodisp','-autoexit','-loglevel','quiet',file]],['aplay',[file]]]){
      try{await spawnCaptured(cmd,args,{timeoutMs:audioPlaybackTimeoutMs(1,0,durationMs)});played=true;break;}catch(error){lastError=error;}
    }
    if(!played) throw new Error(`No supported Linux WAV player is available. Install paplay (PulseAudio/PipeWire), ffplay, or aplay.${lastError?` Last error: ${lastError.message||lastError}`:''}`);
    if(i<count-1&&gapMs)await sleep(gapMs);
  }
}
async function playAudioFile(file, volume, repeat) {
  const vol=Math.round(clamp(volume,0,200)); if(vol<=0)return;
  try{const stat=await fs.promises.stat(file);if(!stat.isFile())throw new Error('not a regular file');}catch(error){throw new Error(`Sound file is unavailable: ${file}${error?.message?` (${error.message})`:''}`);}
  const sourceBuffer=await fs.promises.readFile(file); const {durationMs}=pcmWavInfo(sourceBuffer);
  const adjusted=await volumeAdjustedWav(file,vol); const count=Math.round(clamp(repeat,1,5)); const gap=Math.round(clamp(cfg().get('repeatGapMs',150),0,3000));
  await playRawWav(adjusted,count,gap,durationMs);
}
function enqueuePlayback(task,label){
  if(queuedPlays>=MAX_QUEUED_PLAYS){log(`Dropping alert because playback backlog is full: ${label}`);return Promise.resolve(false);}
  queuedPlays++;
  const run=playChain.then(task);
  playChain=run.catch(error=>{log(`Playback error (${label}): ${error.message||error}`);}).finally(()=>{queuedPlays--;});
  return run.then(()=>true);
}

function brief(value,max=80){if(value===undefined||value===null)return'';let text;try{text=typeof value==='string'?value:JSON.stringify(value);}catch(_error){text=String(value);}text=String(text).replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max-1)+'…':text;}
function sessionKey(body){const id=typeof body?.session_id==='string'?body.session_id.trim():'';return id||null;}
function completionKey(body){return sessionKey(body)||(typeof body?.transcript_path==='string'&&body.transcript_path?`transcript:${body.transcript_path}`:typeof body?.cwd==='string'&&body.cwd?`cwd:${body.cwd}`:'_nosession');}
function pruneSessionStates(now=Date.now()){
  for(const [key,state] of sessionStates) if(now-(state.updatedAt||0)>SESSION_STATE_TTL_MS) sessionStates.delete(key);
  if(sessionStates.size>200){const oldest=[...sessionStates.entries()].sort((a,b)=>(a[1].updatedAt||0)-(b[1].updatedAt||0)).slice(0,sessionStates.size-200);for(const [key] of oldest)sessionStates.delete(key);}
}
function getSessionState(body,create=true){
  const key=sessionKey(body);if(!key)return null;
  let state=sessionStates.get(key);
  if(!state&&create){state={sessionId:key,promptId:null,status:'unknown',backgroundTasks:[],sessionCrons:[],activeAgents:new Map(),idleAgentIds:new Map(),idleAgentNames:new Map(),seenAuthoritativeStop:false,blockingSignature:'',lastStopKind:'unknown',backgroundChain:false,backgroundChainSignature:'',lastActivityAt:0,lastTurnStartedAt:0,lastStopReceivedAt:0,updatedAt:Date.now()};sessionStates.set(key,state);}
  return state||null;
}
function completionVerificationMode(options={}){
  if(options.completionVerificationMode)return String(options.completionVerificationMode);
  if(options.strictCompletionVerification!==undefined)return options.strictCompletionVerification?'strict':'legacy';
  const configured=String(cfg().get('completionVerificationMode','auto')||'auto');
  return ['auto','strict','legacy'].includes(configured)?configured:'auto';
}
function ignoredBackgroundTaskTypes(options={}){
  const raw=options.ignoredBackgroundTaskTypes!==undefined?options.ignoredBackgroundTaskTypes:cfg().get('ignoredBackgroundTaskTypes',['monitor_ws']);
  return new Set((Array.isArray(raw)?raw:[]).map(v=>String(v).trim().toLowerCase()).filter(Boolean));
}
function taskType(task){return String(task?.type||'unknown').trim().toLowerCase();}
function taskStatus(task){return String(task?.status||'').trim().toLowerCase();}
function knownAmbientTask(entry){
  const type=taskType(entry);if(type==='monitor_ws')return true;
  if(type!=='monitor')return false;
  const text=[entry?.description,entry?.name,entry?.server,entry?.tool].map(v=>String(v||'')).join(' ').toLowerCase();
  return /artifact|live[ -]?update|monitor_ws|workspace\s+watch/.test(text);
}
function idleMarkerTime(collection,key){
  if(!collection||!key)return 0;
  if(collection instanceof Map)return Number(collection.get(key)||0);
  if(collection instanceof Set)return collection.has(key)?Number.MAX_SAFE_INTEGER:0;
  return 0;
}
function teammateIdleCountFallbackEnabled(options={}){
  return options.teammateIdleCountFallback===undefined?cfg().get('teammateIdleCountFallback',false):!!options.teammateIdleCountFallback;
}
function blockingTasks(list,options={}){
  const ignored=ignoredBackgroundTaskTypes(options),out=[],state=options.state||null,entries=Array.isArray(list)?list:[];
  const turnStartedAt=Number(state?.lastTurnStartedAt)||0;
  const allowCountFallback=teammateIdleCountFallbackEnabled(options);
  let idleTeammateBudget=0;
  if(allowCountFallback&&state){
    const nameTimes=state.idleAgentNames instanceof Map?[...state.idleAgentNames.values()]:[];
    const idTimes=state.idleAgentIds instanceof Map?[...state.idleAgentIds.values()]:[];
    idleTeammateBudget=Math.max(
      nameTimes.filter(t=>Number(t)>=turnStartedAt).length,
      idTimes.filter(t=>Number(t)>=turnStartedAt).length
    );
  }
  for(const entry of entries){
    if(!entry)continue;
    if(typeof entry!=='object'){out.push({id:'unknown',type:'unknown',status:'unknown',description:brief(entry,120)});continue;}
    const status=taskStatus(entry),type=taskType(entry);
    // Explicit opt-outs must win even when Claude introduces a new status string.
    if(entry.ambient===true||entry.skip_transcript===true||entry.skipTranscript===true||knownAmbientTask(entry)||ignored.has(type))continue;
    if(type==='teammate'&&state){
      const id=String(entry.id||'');
      const names=[entry.name,entry.agent_type].map(v=>String(v||'').trim().toLowerCase()).filter(Boolean);
      const idIdleAt=id?idleMarkerTime(state.idleAgentIds,id):0;const directIdle=(idIdleAt>0&&idIdleAt>=turnStartedAt)||names.some(n=>{const at=idleMarkerTime(state.idleAgentNames,n);return at>0&&at>=turnStartedAt;});
      if(directIdle)continue;
      // Count-only correlation is intentionally opt-in because Claude's teammate
      // background-task id is not guaranteed to equal TeammateIdle.agent_id.
      // Even when enabled, only idle observations from the current lead turn count.
      if(allowCountFallback&&idleTeammateBudget>0){idleTeammateBudget--;continue;}
    }
    if(status&&TERMINAL_TASK_STATUSES.has(status))continue;
    // Known pending states block. Unknown/non-terminal states also block
    // conservatively, but only after the explicit opt-outs above had a chance.
    out.push(entry);
  }
  return out;
}
function cronPartitions(list,options={}){
  const recurringPending=options.recurringCronsCountAsPending===undefined?cfg().get('recurringCronsCountAsPending',false):!!options.recurringCronsCountAsPending;
  const blocking=[],recurring=[];
  for(const entry of (Array.isArray(list)?list:[])){
    if(!entry||typeof entry!=='object'){
      // Unknown cron shapes are treated as one-shot/blocking so they can never
      // accidentally produce a false Finished sound.
      blocking.push({id:'unknown-cron',recurring:false,description:brief(entry,120)});
      continue;
    }
    if(entry.recurring===true){
      if(recurringPending)blocking.push(entry);else recurring.push(entry);
    }else blocking.push(entry);
  }
  return{blocking,recurring};
}
function blockingCrons(list,options={}){return cronPartitions(list,options).blocking;}
function blockingSignature(tasks,crons,extra=''){
  const taskIds=tasks.map(t=>String(t?.id||`${t?.type||'task'}:${t?.description||''}`)).sort();
  const cronIds=crons.map(c=>String(c?.id||`${c?.schedule||'cron'}:${c?.prompt||''}`)).sort();
  return crypto.createHash('sha1').update(JSON.stringify([taskIds,cronIds,extra])).digest('hex').slice(0,16);
}
function lastMessageTail(value,max=420){
  const text=String(value||'').trim();if(!text)return'';
  const sentences=text.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);
  const tail=(sentences.length?sentences.slice(-2).join(' '):text);
  return tail.slice(-max);
}
function waitingMatchNegated(text,index){
  const before=String(text||'').slice(0,index);
  const clauseStart=Math.max(before.lastIndexOf('.'),before.lastIndexOf(';'),before.lastIndexOf(':'),before.lastIndexOf('—'),before.lastIndexOf(','),before.lastIndexOf('\n'),before.lastIndexOf('!'),before.lastIndexOf('?'))+1;
  const clause=before.slice(clauseStart).slice(-64);
  return WAITING_CLAUSE_NEGATION_RE.test(clause);
}
function waitingTextMatch(body,options={}){
  const enabled=options.textHeuristicDowngrade===undefined?cfg().get('textHeuristicDowngrade',true):!!options.textHeuristicDowngrade;
  if(!enabled)return null;
  const text=lastMessageTail(body?.last_assistant_message);
  if(!text)return null;
  for(const re of WAITING_TEXT_PATTERNS){
    const match=re.exec(text);re.lastIndex=0;
    if(match&&!waitingMatchNegated(text,match.index))return brief(match[0],120);
  }
  return null;
}
function stopCompletionState(body,options={}){
  const state=options.state||null;
  const hasBackground=Array.isArray(body?.background_tasks),hasCrons=Array.isArray(body?.session_crons);
  const rawBackground=hasBackground?body.background_tasks.filter(Boolean):[];
  const rawCrons=hasCrons?body.session_crons.filter(v=>v!==null&&v!==undefined):[];
  const backgroundTasks=blockingTasks(rawBackground,{...options,state});
  const cronParts=cronPartitions(rawCrons,options),sessionCrons=cronParts.blocking,recurringCrons=cronParts.recurring;
  const ignoredTaskCount=Math.max(0,rawBackground.length-backgroundTasks.length),ignoredCronCount=Math.max(0,rawCrons.length-sessionCrons.length-recurringCrons.length);
  const fullyAuthoritative=hasBackground&&hasCrons;
  if(backgroundTasks.length||sessionCrons.length)return{kind:'background',verified:fullyAuthoritative,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:blockingSignature(backgroundTasks,sessionCrons),reason:'registry'};
  const textMatch=waitingTextMatch(body,options);
  if(textMatch)return{kind:'background',verified:fullyAuthoritative,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:blockingSignature([],[],'waiting-text'),reason:'text',textMatch};
  if(recurringCrons.length)return{kind:'recurring',verified:fullyAuthoritative,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:blockingSignature([],recurringCrons,'recurring'),reason:'recurring-cron'};
  if(fullyAuthoritative)return{kind:'finished',verified:true,compatibility:false,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:'',reason:'registry'};
  const mode=completionVerificationMode(options),seenAuthoritative=!!state?.seenAuthoritativeStop;
  if(mode==='strict'||(mode==='auto'&&seenAuthoritative))return{kind:'unverified',verified:false,compatibility:false,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:'',reason:'missing-registry'};
  return{kind:'finished',verified:false,compatibility:true,backgroundTasks,sessionCrons,recurringCrons,rawBackgroundTasks:rawBackground,rawSessionCrons:rawCrons,ignoredTaskCount,ignoredCronCount,blockingSignature:'',reason:'compatibility'};
}
function pendingWorkReason(body,completion=null){
  const st=completion||stopCompletionState(body,{state:getSessionState(body,false)}),parts=[];
  if(st.reason==='text'&&st.textMatch)return `Claude says work is still pending — “${st.textMatch}”`;
  if(st.backgroundTasks.length){const labels=st.backgroundTasks.slice(0,3).map(t=>brief(t?.agent_type||t?.type||t?.description||'task',32)).filter(Boolean);parts.push(`${st.backgroundTasks.length} blocking background task${st.backgroundTasks.length===1?'':'s'}${labels.length?` (${labels.join(', ')}${st.backgroundTasks.length>labels.length?', …':''})`:''}`);}
  if(st.sessionCrons.length)parts.push(`${st.sessionCrons.length} one-shot/scheduled wakeup${st.sessionCrons.length===1?'':'s'}`);
  return parts.length?`Background work continues — ${parts.join(' and ')}`:'Background work continues';
}
function hookReceivedAt(body){const n=Number(body?._claude_sound_alerts_received_at);return Number.isFinite(n)&&n>0?n:Date.now();}
function isSelfResumePrompt(body){
  const prompt=String(body?.prompt||'');
  const source=String(body?.source||'').trim().toLowerCase();
  const origin=body?.origin&&typeof body.origin==='object'?String(body.origin.kind||body.origin.type||'').trim().toLowerCase():'';
  if(['system','loop_wakeup','schedule_wakeup','poll_event','task-notification','peer'].includes(source))return true;
  if(['task-notification','peer','system','loop_wakeup','schedule_wakeup','poll_event'].includes(origin))return true;
  return /^\s*(?:<task-notification[\s>]|<teammate-message[\s>]|<agent-message[\s>]|<cross-session-message[\s>]|Another Claude session sent a message:|Heartbeat:|Wake-up (?:timer|check)\b|Stop hook feedback:)/i.test(prompt);
}
function updateSessionState(body,completion=null){
  const event=body?.hook_event_name,state=getSessionState(body,true);if(!state)return null;
  const receivedAt=hookReceivedAt(body);
  state.updatedAt=Date.now();
  if(continuationCancelsFinished(body))state.lastActivityAt=Math.max(Number(state.lastActivityAt)||0,receivedAt);
  if(typeof body?.prompt_id==='string'&&body.prompt_id)state.promptId=body.prompt_id;
  if(body?.agent_id&&event!=='TeammateIdle')state.idleAgentIds?.delete?.(String(body.agent_id));
  if(event==='SessionStart'){state.status='active';state.backgroundChain=false;state.backgroundChainSignature='';state.lastTurnStartedAt=receivedAt;}
  else if(event==='UserPromptSubmit'){
    const selfResume=isSelfResumePrompt(body);
    state.lastTurnStartedAt=receivedAt;
    // Any new lead turn can re-task a teammate, including machine-injected turns.
    // Discard prior idle evidence so stale TeammateIdle observations can never
    // suppress a teammate that became busy again without SubagentStart.
    state.idleAgentIds?.clear?.();state.idleAgentNames?.clear?.();
    if(!selfResume){
      state.backgroundChain=false;state.backgroundChainSignature='';
      const prompt=String(body?.prompt||'');
      if(!body?.source&&/^\s*<[a-z][\w-]*(?:\s|>)/i.test(prompt))log(`UserPromptSubmit begins with an unrecognised system-like tag; treating it conservatively as a new user turn: ${brief(prompt,80)}`);
    }
    state.status='working';
  }
  else if(event==='SubagentStart'){
    if(body.agent_id)state.activeAgents.set(String(body.agent_id),{agentType:brief(body.agent_type,80),startedAt:receivedAt});
    const agentName=String(body.agent_type||'').trim().toLowerCase();if(agentName)state.idleAgentNames?.delete?.(agentName);
  }
  else if(event==='SubagentStop'){if(body.agent_id)state.activeAgents.delete(String(body.agent_id));}
  else if(event==='TeammateIdle'){
    if(body.agent_id)state.idleAgentIds?.set?.(String(body.agent_id),receivedAt);
    const teammateName=String(body.teammate_name||body.agent_type||'').trim().toLowerCase();if(teammateName)state.idleAgentNames?.set?.(teammateName,receivedAt);
  }
  else if(event==='Stop'){
    const st=completion||stopCompletionState(body,{state});
    if(Array.isArray(body?.background_tasks)&&Array.isArray(body?.session_crons))state.seenAuthoritativeStop=true;
    state.backgroundTasks=st.backgroundTasks;state.sessionCrons=st.sessionCrons;state.blockingSignature=st.blockingSignature||'';state.lastStopKind=st.kind;state.lastStopReceivedAt=receivedAt;
    if(st.kind==='background'){state.status='waiting_background';state.backgroundChain=true;state.backgroundChainSignature=st.blockingSignature||state.backgroundChainSignature||'';}
    else if(st.kind==='finished'){state.status='candidate_finished';state.backgroundChain=false;state.backgroundChainSignature='';}
    else if(st.kind==='recurring'){state.status='recurring_wait';state.backgroundChain=false;state.backgroundChainSignature='';}
    else{state.status='completion_unverified';state.backgroundChain=false;state.backgroundChainSignature='';}
  } else if(event==='StopFailure'){state.status='failed';state.backgroundChain=false;state.backgroundChainSignature='';}
  else if(event==='Notification'&&body.notification_type==='agent_needs_input')state.status='waiting_user';
  else if(event==='SessionEnd'){state.status='ended';setTimeout(()=>{if(sessionStates.get(state.sessionId)===state)sessionStates.delete(state.sessionId);},1000);}
  pruneSessionStates();return state;
}
function knownBackgroundPending(body){const state=getSessionState(body,false);return !!state&&(state.status==='waiting_background'||state.backgroundChain===true);}
function reasonFor(body,id,completion=null){
  const e=body?.hook_event_name||'Claude event';
  switch(id){
    case 'askUserQuestion':return'Claude asked a question';case 'exitPlanMode':return'Claude is waiting for plan approval';case 'backgroundPending':return pendingWorkReason(body,completion);case 'recurringCronIteration':return`Recurring scheduled work remains${completion?.recurringCrons?.length?` — ${completion.recurringCrons.length} recurring cron${completion.recurringCrons.length===1?'':'s'}`:''}`;case 'stopUnverified':return'Claude stopped, but final completion could not be verified from the task registry';
    case 'permissionRequest':return`Permission requested${body.tool_name?` for ${brief(body.tool_name)}`:''}`;case 'permissionDenied':return`Permission denied${body.tool_name?` for ${brief(body.tool_name)}`:''}`;case 'postToolUseFailure':return`Tool failed${body.tool_name?`: ${brief(body.tool_name)}`:''}`;case 'postToolUse':return`Tool succeeded${body.tool_name?`: ${brief(body.tool_name)}`:''}`;case 'preToolUse':return`Tool starting${body.tool_name?`: ${brief(body.tool_name)}`:''}`;
    case 'notificationPermissionPrompt':return'Permission reminder';case 'notificationIdlePrompt':return'Claude idle reminder';case 'notificationAgentNeedsInput':return'Background agent needs your input';case 'notificationAgentCompleted':return'Background session completed';case 'notificationQuotaResumed':return'Claude automatically resumed after a usage-limit wait';case 'notificationQuotaStale':return'Usage limit reset; Claude is waiting for you to resume';case 'notificationQuotaDisabled':return'Claude stopped waiting for automatic usage-limit resume';case 'notification':return`Notification${body.notification_type?`: ${brief(body.notification_type)}`:''}`;
    case 'subagentStart':return`Subagent started${body.agent_type?`: ${brief(body.agent_type)}`:''}`;case 'subagentStop':return`Agent finished${body.agent_type?`: ${brief(body.agent_type)}`:''}${body.agent_id?` (${brief(body.agent_id,24)})`:''}`;case 'taskCreated':return`Task created${body.task_subject?`: ${brief(body.task_subject)}`:''}`;case 'taskCompleted':return`Task completed${body.task_subject?`: ${brief(body.task_subject)}`:''}`;
    case 'stop':return completion?.compatibility?'Claude finished (compatibility mode; background registry was unavailable)':'Claude fully finished — no blocking background work or one-shot scheduled wakeups remain';case 'stopFailure':return`Claude stopped with an error${body.error?`: ${brief(body.error)}`:''}`;case 'teammateIdle':return`Teammate idle${body.teammate_name?`: ${brief(body.teammate_name)}`:''}`;case 'configChange':return`Claude configuration changed${body.source?`: ${brief(body.source)}`:''}`;case 'cwdChanged':return'Working directory changed';case 'directoryAdded':return`Directory added${body.directory?`: ${brief(body.directory)}`:''}`;case 'fileChanged':return`Watched file ${brief(body.event)||'changed'}${body.file_path?`: ${path.basename(body.file_path)}`:''}`;
    case 'preCompact':return`Context compaction starting${body.trigger?`: ${brief(body.trigger)}`:''}`;case 'postCompact':return`Context compaction finished${body.trigger?`: ${brief(body.trigger)}`:''}`;case 'preModelSwitch':return`Model switch requested${body.from_model||body.to_model?`: ${brief(body.from_model)||'?'} → ${brief(body.to_model)||'?'}`:''}`;case 'postModelSwitch':return`Model switched${body.from_model||body.to_model?`: ${brief(body.from_model)||'?'} → ${brief(body.to_model)||'?'}`:''}`;case 'sessionStart':return`Claude session started${body.source?`: ${brief(body.source)}`:''}`;case 'sessionEnd':return`Claude session ended${body.reason?`: ${brief(body.reason)}`:''}`;case 'elicitation':return`MCP needs input${body.mcp_server_name?`: ${brief(body.mcp_server_name)}`:''}`;case 'elicitationResult':return`MCP input answered${body.mcp_server_name?`: ${brief(body.mcp_server_name)}`:''}`;case 'instructionsLoaded':return'Claude instructions loaded';case 'userPromptSubmit':return'Prompt submitted';case 'userPromptExpansion':return'Prompt expanded';case 'messageDisplay':return'Claude message displayed';case 'postToolBatch':return'Parallel tool batch finished';case 'setup':return'Claude setup event';case 'worktreeRemove':return'Worktree removed';default:return e;
  }
}
const NOTIFICATION_PROFILE_BY_TYPE=new Map([['permission_prompt','notificationPermissionPrompt'],['idle_prompt','notificationIdlePrompt'],['agent_needs_input','notificationAgentNeedsInput'],['agent_completed','notificationAgentCompleted'],['quota_auto_resume_fired','notificationQuotaResumed'],['quota_auto_resume_stale','notificationQuotaStale'],['quota_auto_resume_disabled','notificationQuotaDisabled']]);
function candidateProfiles(body,options={}){
  const event=body?.hook_event_name;
  if(event==='PreToolUse'){if(body.tool_name==='AskUserQuestion')return['askUserQuestion','preToolUse'];if(body.tool_name==='ExitPlanMode')return['exitPlanMode','preToolUse'];return['preToolUse'];}
  if(event==='Stop'){if(body?.agent_id)return[];const state=options.completionState||stopCompletionState(body,{...options,state:getSessionState(body,false)});if(state.kind==='background')return['backgroundPending'];if(state.kind==='recurring')return['recurringCronIteration'];if(state.kind==='finished')return['stop'];return['stopUnverified'];}
  if(event==='Notification'){const type=String(body?.notification_type||'');if(type==='idle_prompt'&&knownBackgroundPending(body))return[];const specific=NOTIFICATION_PROFILE_BY_TYPE.get(type);return specific?[specific,'notification']:['notification'];}
  const id=EVENT_BY_HOOK.get(event);return id?[id]:[];
}
function backgroundAlertShouldFire(previous,completion,options={}){const mode=String(options.backgroundAlertMode||cfg().get('backgroundAlertMode','transition'));if(mode==='everyStop')return true;if(!previous?.backgroundChain)return true;if(mode==='changes')return previous.backgroundChainSignature!==completion.blockingSignature;return false;}
function classifyHook(body,settings=allEventSettings(),options={}){
  const event=body?.hook_event_name;if(event==='Stop'&&body?.agent_id)return null;
  const existing=getSessionState(body,false),previous=existing?{status:existing.status,blockingSignature:existing.blockingSignature,backgroundChain:!!existing.backgroundChain,backgroundChainSignature:existing.backgroundChainSignature||'',seenAuthoritativeStop:existing.seenAuthoritativeStop}:null;
  const completion=event==='Stop'?(options.completionState||stopCompletionState(body,{...options,state:existing})):null;updateSessionState(body,completion);
  for(const id of candidateProfiles(body,{...options,completionState:completion})){if(id==='backgroundPending'&&!backgroundAlertShouldFire(previous,completion,options))return null;if(settings[id]?.enabled)return{id,reason:reasonFor(body,id,completion),completion,defer:id==='stop'};if(event==='Stop')break;}return null;
}
function eventDedupeKey(id,body){const sid=sessionKey(body)||'global';if(['stop','backgroundPending','recurringCronIteration','stopUnverified'].includes(id))return`${id}:${sid}`;if(id==='subagentStop')return`${id}:${sid}:${body?.agent_id||'agent'}`;if(id==='taskCompleted')return`${id}:${sid}:${body?.task_id||'task'}`;return id;}
function shouldPlay(id,body=null){if(!cfg().get('enabled',true))return false;const debounce=Math.round(clamp(cfg().get('debounceMs',650),0,10000));const key=eventDedupeKey(id,body),now=Date.now(),last=lastPlayedAt.get(key)||0;if(now-last<debounce)return false;lastPlayedAt.set(key,now);return true;}
async function playProfile(id,reason,force=false,overrides={},body=null){const def=EVENT_MAP.get(id);if(!def)return;const setting=eventSetting(id);if(!setting)return;if(!force&&(!setting.enabled||!shouldPlay(id,body)))return;const sound=overrides.sound||setting.sound;const volume=overrides.volume===undefined?setting.volume:Math.round(clamp(overrides.volume,0,200));const repeat=overrides.repeat===undefined?setting.repeat:Math.round(clamp(overrides.repeat,1,5));const file=soundPathFor(sound);log(`${def.label}: ${reason} | sound=${sound} volume=${volume}% repeat=${repeat} | ${file}`);if(cfg().get('showVisualNotifications',false)&&!force)vscode.window.showInformationMessage(`${def.label}: ${reason}`);try{await enqueuePlayback(()=>playAudioFile(file,volume,repeat),def.label);}catch(error){const message=error?.message||String(error);log(`Unable to play sound: ${message}`);vscode.window.showWarningMessage(`Claude Sound Alerts could not play audio: ${message}`,'Open Log').then(c=>{if(c==='Open Log')output.show(true);});}}
function cancelDeferredFinished(body,why='session continued'){const key=completionKey(body),pending=pendingFinished.get(key);if(!pending)return false;clearTimeout(pending.timer);pendingFinished.delete(key);const at=hookReceivedAt(body),gap=Number.isFinite(Number(pending.stopReceivedAt))?at-Number(pending.stopReceivedAt):null;log(`Finished cancelled (${why}); session continued${gap!==null&&gap>=0?` after ${gap} ms`:''}.`);return true;}
function deferFinished(body,result,options={}){
  const key=completionKey(body);cancelDeferredFinished(body,'new completion candidate');
  const ms=Math.round(clamp(options.ms===undefined?cfg().get('finishedGraceMs',2500):options.ms,0,15000));
  const play=typeof options.play==='function'?options.play:()=>playProfile(result.id,result.reason,false,{},body);
  const stopReceivedAt=hookReceivedAt(body);
  const fire=()=>{pendingFinished.delete(key);const state=getSessionState(body,false);
    if(state&&state.status!=='candidate_finished'){log(`Finished grace expired but session state is ${state.status}; sound suppressed.`);return;}
    if(state&&Number(state.lastActivityAt||0)>stopReceivedAt){log(`Finished grace expired but newer same-session activity was received after this Stop; sound suppressed.`);return;}
    if(state)state.status='finished';log(`Finished confirmed after ${ms} ms grace window.`);void play();
  };
  if(ms===0){fire();return null;}
  const timer=setTimeout(fire,ms);pendingFinished.set(key,{timer,createdAt:Date.now(),stopReceivedAt,result,promptId:body?.prompt_id||null,play});
  log(`Finished candidate deferred for ${ms} ms to catch queued background-task wakeups.`);return timer;
}
function continuationCancelsFinished(body){const event=body?.hook_event_name;if(['UserPromptSubmit','PreToolUse','SubagentStart','SubagentStop','TaskCreated','TaskCompleted','PostToolUse','PostToolBatch','StopFailure','SessionEnd'].includes(event))return true;return event==='Notification'&&['agent_completed','agent_needs_input'].includes(String(body?.notification_type||''));}
function stopDiagnostic(body,completion){
  const teammateOnly=completion.backgroundTasks.length>0&&completion.backgroundTasks.every(t=>taskType(t)==='teammate');
  return{at:Date.now(),sessionId:sessionKey(body),kind:completion.kind,verified:!!completion.verified,compatibility:!!completion.compatibility,reason:completion.reason,backgroundCount:completion.backgroundTasks.length,cronCount:completion.sessionCrons.length,recurringCronCount:completion.recurringCrons?.length||0,ignoredTaskCount:completion.ignoredTaskCount||0,ignoredCronCount:completion.ignoredCronCount||0,textMatch:completion.textMatch||'',teammateOnly,message:brief(body?.last_assistant_message,160)};
}
async function maybeWarnCompatibility(body,completion){
  if(!completion?.compatibility||!extensionContext||completionVerificationMode()==='legacy')return;
  const version=brief(body?.claude_version||body?.claude_code_version||body?.version,48)||'unknown';
  const seen=extensionContext.globalState.get('completionCompatibilityWarnings',{})||{};
  if(seen[version])return;
  await extensionContext.globalState.update('completionCompatibilityWarnings',{...seen,[version]:Date.now()});
  log(`Completion registry was unavailable; auto compatibility mode treated Stop as a tentative finish candidate (Claude version: ${version}).`);
  void vscode.window.showWarningMessage("Claude Sound Alerts could not verify background-task state for this Stop. Auto compatibility mode is being used; update Claude Code if this persists.",'Open Claude Alerts').then(choice=>{if(choice==='Open Claude Alerts')void openControlPanel();});
}
async function handleHookLocally(body,options={}){
  if(await markRoutedEventSeen(body)){log(`Duplicate routed hook ignored: ${brief(body?.hook_event_name)||'unknown'}`);return true;}
  if(continuationCancelsFinished(body))cancelDeferredFinished(body,body?.hook_event_name||body?.notification_type||'session activity');
  if(body?.hook_event_name==='Stop'&&body?.agent_id){cancelDeferredFinished(body,'agent-context Stop');log(`Ignored Stop from agent context ${brief(body.agent_id,32)}; main Finished cannot fire from a subagent/teammate hook.`);return true;}
  let completion=null;
  if(body?.hook_event_name==='Stop'){completion=stopCompletionState(body,{state:getSessionState(body,false)});lastStopDiagnostic=stopDiagnostic(body,completion);log(`Stop classified as ${completion.kind.toUpperCase()}: ${completion.backgroundTasks.length} blocking task(s), ${completion.sessionCrons.length} one-shot wakeup(s), ${completion.recurringCrons?.length||0} recurring cron(s), ${completion.ignoredTaskCount||0} task(s) ignored${completion.textMatch?`; waiting-text match: ${completion.textMatch}`:''}.`);scheduleUiState();if(completion.kind!=='finished')cancelDeferredFinished(body,`Stop classified ${completion.kind}`);void maybeWarnCompatibility(body,completion);}
  const settings=options.settings||allEventSettings();const result=classifyHook(body,settings,{completionState:completion,...options});if(result?.id==='stop'){deferFinished(body,result,options.deferOptions||{});return true;}if(result){const player=typeof options.playProfile==='function'?options.playProfile:playProfile;void player(result.id,result.reason,false,{},body);return true;}log(`Ignored/disabled hook event: ${brief(body?.hook_event_name)||'unknown'}${body.tool_name?` / ${brief(body.tool_name)}`:''}${body.notification_type?` / ${brief(body.notification_type)}`:''}`);return true;
}

function createListenerServer(port) {
  const listener=http.createServer((req,res)=>{
    if(!allowedHost(req,port)){res.writeHead(404);res.end();return;}
    let pathname='';
    try{pathname=new URL(req.url||'/',`http://127.0.0.1:${port}`).pathname;}catch(error){log(`Invalid listener URL ignored: ${error.message||error}`);res.writeHead(204,{'Connection':'close'});res.end();return;}
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
        const body=ensureRoutingMetadata(raw?JSON.parse(raw):{});
        if(body?.probe===true && body?.hook_event_name==='__claude_sound_alerts_probe__'){res.writeHead(204,{'Connection':'close'});res.end();return;}
        const routed=req.headers['x-claude-sound-alerts-routed']==='1';
        res.writeHead(204,{'Connection':'close'});res.end();
        if(routed)setImmediate(()=>{void handleHookLocally(body);});else void routeIncomingHook(body);
      }catch(error){log(`Invalid hook request ignored: ${error.message||error}`);res.writeHead(204,{'Connection':'close'});res.end();}
    });
  });
  listener.on('clientError',(_error,socket)=>{try{socket.destroy();}catch(_closeError){}});
  return listener;
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
      server=candidate; listenerPort=port; listenerMode='owned'; invalidateProbeCache();
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
  invalidateProbeCache();
  listenerPort=null;
  if(listenerMode!=='disabled'){listenerMode='inactive'; listenerDetail='';}
  if(closing){
    await new Promise(resolve=>{
      let done=false;const finish=()=>{if(!done){done=true;resolve();}};
      try{closing.close(finish);closing.closeIdleConnections?.();closing.closeAllConnections?.();setTimeout(finish,250);}catch(_error){finish();}
    });
  }
}

function hookHandler(url){ return {type:'http',url,timeout:2}; }
function claudeSettingsPath(){ return path.join(os.homedir(),'.claude','settings.json'); }
function relayScriptPath(platform=process.platform){ const base=relayStoragePathOverride || extensionContext?.globalStorageUri?.fsPath; if(!base)throw new Error('Extension global storage is not initialized.'); return path.join(base, platform==='win32' ? `${RELAY_TAG}.cmd` : `${RELAY_TAG}.sh`); }
function windowsRelayScript(){return `@echo off\r\nsetlocal\r\nset "CLAUDE_SOUND_ALERTS_URL=%~1"\r\nwhere curl.exe >nul 2>&1\r\nif %errorlevel%==0 (\r\n  curl.exe -sS --max-time 3 -X POST -H "Content-Type: application/json; charset=utf-8" --data-binary @- "%CLAUDE_SOUND_ALERTS_URL%" >nul 2>&1\r\n  exit /b 0\r\n)\r\npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $r=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.Encoding]::UTF8,$true); $body=$r.ReadToEnd(); try { $bytes=[Text.Encoding]::UTF8.GetBytes($body); Invoke-WebRequest -UseBasicParsing -Uri $env:CLAUDE_SOUND_ALERTS_URL -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 3 | Out-Null } catch {}; exit 0" >nul 2>&1\r\nexit /b 0\r\n`;}
async function ensureRelayScript(){
  const file=relayScriptPath(); await fs.promises.mkdir(path.dirname(file),{recursive:true});
  if(process.platform==='win32') {
    const text = windowsRelayScript();
    await fs.promises.writeFile(file,text,'utf8');
  } else {
    const text = `#!/bin/sh\nurl="$1"\nif command -v curl >/dev/null 2>&1; then\n  curl -sS --max-time 3 -X POST -H 'Content-Type: application/json; charset=utf-8' --data-binary @- "$url" >/dev/null 2>&1 || true\nelif command -v python3 >/dev/null 2>&1; then\n  python3 -c 'import sys,urllib.request; u=sys.argv[1]; d=sys.stdin.buffer.read(); urllib.request.urlopen(urllib.request.Request(u,data=d,headers={"Content-Type":"application/json; charset=utf-8"},method="POST"),timeout=3).read()' "$url" >/dev/null 2>&1 || true\nelif command -v python >/dev/null 2>&1; then\n  python -c 'import sys,urllib.request; u=sys.argv[1]; d=sys.stdin.buffer.read(); urllib.request.urlopen(urllib.request.Request(u,data=d,headers={"Content-Type":"application/json; charset=utf-8"},method="POST"),timeout=3).read()' "$url" >/dev/null 2>&1 || true\nelse\n  cat >/dev/null\nfi\nexit 0\n`;
    await fs.promises.writeFile(file,text,{encoding:'utf8',mode:0o700}); try{await fs.promises.chmod(file,0o700);}catch(_error){}
  }
  return file;
}
function commandRelayHandler(url,platform=process.platform){
  const file=relayScriptPath(platform);
  return platform==='win32'
    ? {type:'command',command:'cmd.exe',args:['/d','/s','/c',`call "${file}" "${url}"`],timeout:10,async:true}
    : {type:'command',command:'sh',args:[file,url],timeout:10,async:true};
}
function completionStateHooksNeeded(settings){return !!(settings.stop?.enabled||settings.backgroundPending?.enabled||settings.recurringCronIteration?.enabled||settings.stopUnverified?.enabled||settings.notificationIdlePrompt?.enabled);}
function desiredHookGroups(url,settings=allEventSettings()){
  const out={},live=EVENT_DEFS.filter(d=>!d.unavailable&&settings[d.id]?.enabled),stateNeeded=completionStateHooksNeeded(settings);
  const genericPreTool=live.some(d=>d.id==='preToolUse');
  if(genericPreTool)out.PreToolUse=[{hooks:[hookHandler(url)]}];else{const toolNames=[];if(live.some(d=>d.id==='askUserQuestion'))toolNames.push('AskUserQuestion');if(live.some(d=>d.id==='exitPlanMode'))toolNames.push('ExitPlanMode');if(toolNames.length)out.PreToolUse=[{matcher:toolNames.join('|'),hooks:[hookHandler(url)]}];}
  if(stateNeeded||live.some(d=>d.hookEvent==='Stop'))out.Stop=[{hooks:[hookHandler(url)]}];
  const stateHook=(event,id)=>[{hooks:[live.some(d=>d.id===id||(!d.virtual&&d.hookEvent===event))?hookHandler(url):commandRelayHandler(url)]}];
  if(stateNeeded||live.some(d=>d.hookEvent==='UserPromptSubmit'))out.UserPromptSubmit=stateHook('UserPromptSubmit','userPromptSubmit');
  if(stateNeeded||live.some(d=>d.hookEvent==='SubagentStart'))out.SubagentStart=stateHook('SubagentStart','subagentStart');
  if(stateNeeded||live.some(d=>d.hookEvent==='SubagentStop'))out.SubagentStop=stateHook('SubagentStop','subagentStop');
  if(stateNeeded||live.some(d=>d.hookEvent==='TeammateIdle'))out.TeammateIdle=stateHook('TeammateIdle','teammateIdle');
  const genericNotification=live.some(d=>d.id==='notification');if(genericNotification)out.Notification=[{hooks:[hookHandler(url)]}];else{const matchers=[...new Set(live.filter(d=>d.hookEvent==='Notification'&&d.virtual&&d.matcher).map(d=>d.matcher))];if(matchers.length)out.Notification=[{matcher:matchers.join('|'),hooks:[hookHandler(url)]}];}
  for(const d of live){if(d.virtual||['PreToolUse','Stop','Notification','UserPromptSubmit','SubagentStart','SubagentStop','FileChanged'].includes(d.hookEvent)||d.transport==='command')continue;if(!out[d.hookEvent])out[d.hookEvent]=[{hooks:[hookHandler(url)]}];}
  for(const d of live.filter(d=>d.transport==='command'))out[d.hookEvent]=[{hooks:[commandRelayHandler(url)]}];
  if(live.some(d=>d.id==='fileChanged')){const names=(cfg().get('watchedFiles',[])||[]).map(String).map(v=>v.trim()).filter(Boolean).filter(v=>!v.includes('|'));if(names.length)out.FileChanged=[{matcher:[...new Set(names)].join('|'),hooks:[hookHandler(url)]}];}
  return out;
}

function handlerUrl(handler){
  if(!handler || typeof handler!=='object') return null;
  if(handler.type==='http' && typeof handler.url==='string') return handler.url;
  if(handler.type==='command') {
    const pattern=/https?:\/\/127\.0\.0\.1:\d+\/claude-code-sound-alerts\/hook\/[a-z0-9]+/i;
    if(Array.isArray(handler.args)) {
      for(const value of handler.args){if(typeof value!=='string')continue;const match=value.match(pattern);if(match)return match[0];}
    }
    if(typeof handler.command==='string') {const match=handler.command.match(pattern);if(match)return match[0];}
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
  let obj=0,arr=0,inString=false,escape=false,line=false,block=false,lastSig=index;
  for(let i=index;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(line){if(c==='\n')line=false;continue;}
    if(block){if(c==='*'&&n==='/'){block=false;i++;}continue;}
    if(inString){lastSig=i+1;if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;lastSig=i+1;continue;}
    if(c==='/'&&n==='/'){line=true;i++;continue;}
    if(c==='/'&&n==='*'){block=true;i++;continue;}
    if(c==='{'){obj++;lastSig=i+1;continue;} if(c==='['){arr++;lastSig=i+1;continue;}
    if(c==='}'){if(obj>0){obj--;lastSig=i+1;continue;}if(arr===0)return {end:i,valueEnd:lastSig};}
    if(c===']'){if(arr>0){arr--;lastSig=i+1;continue;}}
    if(c===','&&obj===0&&arr===0)return {end:i,valueEnd:lastSig};
    if(!/\s/.test(c))lastSig=i+1;
  }
  return {end:text.length,valueEnd:lastSig};
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
    const valueStart=skipJsoncTrivia(text,i), scannedValue=scanJsoncValueEnd(text,valueStart), valueEnd=scannedValue.valueEnd;
    let lineStart=text.lastIndexOf('\n',keyStart-1)+1; const indent=(text.slice(lineStart,keyStart).match(/^[ \t]*/)||[''])[0];
    i=scannedValue.end;
    const trailingComma=text[i]===',';
    members.push({key,keyStart,keyEnd,valueStart,valueEnd,indent,trailingComma,delimiter:i});
    if(trailingComma){i++;continue;}
    if(text[i]==='}'){close=i;break;}
    // scanJsoncValueEnd returns the structural delimiter separately from trailing trivia.
    throw new Error(`Expected ',' or '}' after ${key} in Claude settings.`);
  }
  if(close<0)throw new Error('Claude settings JSON object is not closed.');
  return {open,close,members};
}
function formatJsoncValue(value,baseIndent,indentUnit,newline='\n'){
  const json=JSON.stringify(value,null,indentUnit);
  return json.replace(/\n/g,newline+baseIndent);
}
function joinRemovalParts(left,right,newline){
  let a=left.replace(/[ \t]+$/,'');
  let b=right;
  if(a.endsWith(newline)&&b.startsWith(newline)) b=b.slice(newline.length);
  return a+b;
}
function patchTopLevelHooks(text,hooksValue){
  let raw=String(text||''); if(!raw.trim())raw='{}\n';
  const newline=raw.includes('\r\n')?'\r\n':'\n';
  const parsed=scanTopLevelJsoncObject(raw);
  const existing=parsed.members.find(m=>m.key==='hooks');
  const hasHooks=hooksValue && typeof hooksValue==='object' && Object.keys(hooksValue).length>0;
  if(!existing && !hasHooks)return raw;
  const firstIndent=parsed.members[0]?.indent || '  ';
  const indentUnit=firstIndent || '  ';
  if(existing){
    if(hasHooks){
      const formatted=formatJsoncValue(hooksValue,existing.indent,indentUnit,newline);
      return raw.slice(0,existing.valueStart)+formatted+raw.slice(existing.valueEnd);
    }
    // Remove our now-empty top-level hooks member without consuming comments or
    // whitespace that follow the value. If it is the final member, remove the
    // previous member's delimiter comma instead.
    const index=parsed.members.indexOf(existing);
    const previous=index>0?parsed.members[index-1]:null;
    if(existing.trailingComma){
      const left=raw.slice(0,existing.keyStart);
      const right=raw.slice(existing.valueEnd,existing.delimiter)+raw.slice(existing.delimiter+1);
      return joinRemovalParts(left,right,newline);
    }
    if(previous?.trailingComma){
      const left=raw.slice(0,previous.delimiter);
      const between=raw.slice(previous.delimiter+1,existing.keyStart).replace(/[ \t]+$/,'');
      const right=raw.slice(existing.valueEnd);
      return joinRemovalParts(left+between,right,newline);
    }
    return joinRemovalParts(raw.slice(0,existing.keyStart),raw.slice(existing.valueEnd),newline);
  }
  const formatted=formatJsoncValue(hooksValue,firstIndent,indentUnit,newline);
  const after=raw.slice(parsed.close);
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
      if(targetPathCurrent){const probe=await probeListenerCached(target.port);targetActive=!!probe.active;}
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
    if(preview) await enqueuePlayback(()=>playAudioFile(dest,100,1),`Imported sound preview: ${label}`);
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

function hasStoredEventSettingsFromInspection(inspected){
  const some=value=>value&&typeof value==='object'&&Object.keys(value).length>0;
  return !!(some(inspected?.globalValue)||some(inspected?.workspaceValue)||some(inspected?.workspaceFolderValue));
}
function hasStoredEventSettings(){return hasStoredEventSettingsFromInspection(cfg().inspect('eventSettings'));}

async function migrateV131QuestionSound(){
  if(extensionContext.globalState.get('v131QuestionSoundApplied',false))return;
  if(!hasStoredEventSettings()){await extensionContext.globalState.update('v131QuestionSoundApplied',true);log('v1.3.1 sound migration skipped on a fresh/default configuration.');return;}
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
  if(!hasStoredEventSettings()){await extensionContext.globalState.update('v132DoneAndErrorSoundsApplied',true);log('v1.3.2 sound migration skipped on a fresh/default configuration.');return;}
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
  if(!hasStoredEventSettings()){
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

const OLD_RECOMMENDED_V16=new Set(['askUserQuestion','stop','permissionRequest','permissionDenied','postToolUseFailure','stopFailure','subagentStop','taskCompleted','elicitation']);
function enabledIdsFromRawEventSettings(raw){return new Set(Object.entries(raw||{}).filter(([,v])=>v&&typeof v==='object'&&v.enabled===true).map(([id])=>id));}
function migrateV171EventSettingsObject(rawInput){
  const raw={...(rawInput||{})},hadV17Shape=['backgroundPending','stopUnverified','notificationAgentNeedsInput','preModelSwitch','postModelSwitch'].some(id=>Object.prototype.hasOwnProperty.call(raw,id));
  let changed=false,oldRecommended=false;
  if(!hadV17Shape){
    const enabled=enabledIdsFromRawEventSettings(raw);
    oldRecommended=sameSet(enabled,OLD_RECOMMENDED_V16);
    const sub=raw.subagentStop;
    if(sub&&sub.sound==='calm-complete'&&(sub.volume===undefined||Number(sub.volume)===45)&&(sub.repeat===undefined||Number(sub.repeat)===1)){raw.subagentStop={...sub,sound:'finished'};changed=true;}
    if(oldRecommended){
      for(const def of EVENT_DEFS){
        const current=raw[def.id]&&typeof raw[def.id]==='object'?raw[def.id]:defaultEventSetting(def);
        raw[def.id]={...current,enabled:!def.unavailable&&PRESET_GROUPS.recommended.has(def.id)};
      }
      changed=true;
    }
  }
  return{raw,changed,oldRecommended,hadV17Shape};
}
async function migrateV171Completion(){
  if(extensionContext.globalState.get('v171CompletionMigrationDone',false))return;
  let changed=false,oldRecommended=false;
  const inspectedEvents=cfg().inspect('eventSettings');
  const explicit=inspectedEvents?.globalValue&&typeof inspectedEvents.globalValue==='object'?inspectedEvents.globalValue:null;
  if(explicit&&Object.keys(explicit).length){const result=migrateV171EventSettingsObject(explicit);changed=result.changed;oldRecommended=result.oldRecommended;if(result.changed)await cfg().update('eventSettings',result.raw,vscode.ConfigurationTarget.Global);}
  const newModeInspect=cfg().inspect('completionVerificationMode');
  if(newModeInspect?.globalValue===undefined){const old=cfg().inspect('strictCompletionVerification')?.globalValue;if(old!==undefined){await cfg().update('completionVerificationMode',old?'auto':'legacy',vscode.ConfigurationTarget.Global);changed=true;}}
  await extensionContext.globalState.update('v171CompletionMigrationDone',true);
  if(changed||oldRecommended){await extensionContext.globalState.update('v171ShowWhatsNew',true);log(`v1.7.1 completion migration applied${oldRecommended?' (old Recommended preset upgraded)':''}.`);}else log('v1.7.1 completion migration required no stored-setting changes.');
}


async function migrateV172Completion(){
  if(extensionContext.globalState.get('v172CompletionMigrationDone',false))return;
  const mode=cfg().inspect('completionVerificationMode')?.globalValue;
  const oldStrict=cfg().inspect('strictCompletionVerification')?.globalValue;
  if(mode==='strict'&&oldStrict===true&&extensionContext.globalState.get('v171CompletionMigrationDone',false)){
    await extensionContext.globalState.update('v172StrictModeReviewNeeded',true);
    log('v1.7.2 detected a Strict completion mode that may have come from the v1.7.1 legacy migration; user confirmation will be requested instead of overriding it silently.');
  }
  await extensionContext.globalState.update('v172CompletionMigrationDone',true);
}

const PRESET_GROUPS={
  minimal:new Set(['askUserQuestion','stop']),
  recommended:new Set(['askUserQuestion','stop','backgroundPending','permissionRequest','permissionDenied','postToolUseFailure','stopFailure','taskCompleted','elicitation','notificationAgentNeedsInput'])
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
    enabled:cfg().get('enabled',true), visualNotifications:cfg().get('showVisualNotifications',false), completionVerificationMode:completionVerificationMode(), finishedGraceMs:Math.round(clamp(cfg().get('finishedGraceMs',2500),0,15000)), textHeuristicDowngrade:cfg().get('textHeuristicDowngrade',true)!==false, backgroundAlertMode:String(cfg().get('backgroundAlertMode','transition')), ignoredBackgroundTaskTypes:(Array.isArray(cfg().get('ignoredBackgroundTaskTypes',['monitor_ws']))?cfg().get('ignoredBackgroundTaskTypes',['monitor_ws']):['monitor_ws']).map(String), teammateIdleCountFallback:cfg().get('teammateIdleCountFallback',false)===true, recurringCronsCountAsPending:cfg().get('recurringCronsCountAsPending',false)===true, repeatGapMs:Math.round(clamp(cfg().get('repeatGapMs',150),0,3000)),
    hooks:hs, listenerActive:listenerIsActive(), listenerMode, listenerDetail, listenerPort, brokerPort, listenerBasePort:getBasePort(), listenerPortCount:getPortCount(), platform:process.platform,
    events:EVENT_DEFS.map(d=>({...d,setting:settings[d.id]})), categories:CATEGORIES, sounds:allSoundOptions(), watchedFiles:cfg().get('watchedFiles',[])||[], activePreset:activePresetName(settings), lastStopDiagnostic
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
.primary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:14px}
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
.controlgrid{display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(160px,1fr) 92px;gap:12px;align-items:end}.event.primary .controlgrid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}
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
<div class="hero"><div class="brand"><img class="brand-icon" src="${iconUri}" alt=""><div><h1>Claude Code Sound Alerts</h1><div class="sub">Hear when Claude needs you, when background work is still running, and when the work is truly done.</div></div></div></div>

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

<div class="section-head"><div><h2>Primary alerts</h2><div class="section-caption">Question and Finished are enabled by default. Every Stop resolves to exactly one of Background / Waiting, Recurring Loop, Completion Unverified, or Finished; only enabled profiles make a sound.</div></div></div>
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
      <div class="panel-title">Completion intelligence</div>
      <div class="field" style="margin-bottom:10px"><label for="completionMode">Completion verification</label><select id="completionMode"><option value="auto">Auto — recommended</option><option value="strict">Strict — require registry data</option><option value="legacy">Legacy — Stop can finish without registry data</option></select></div>
      <div class="footerline"><label>Finished grace <input id="finishedGrace" type="number" min="0" max="15000" step="100" style="width:86px"> ms</label><label>Background sound <select id="backgroundMode"><option value="transition">On transition only</option><option value="changes">When pending set changes</option><option value="everyStop">Every pending Stop</option></select></label></div>
      <div class="footerline" style="margin-top:9px"><label><input id="textDowngrade" type="checkbox"> Downgrade waiting-language to Background</label><label><input id="recurringCrons" type="checkbox"> Recurring crons count as pending</label></div>
      <div class="field" style="margin-top:10px"><label for="ignoredTaskTypes">Ignored ambient task types (comma-separated)</label><input id="ignoredTaskTypes" type="text" placeholder="monitor_ws" aria-label="Ignored background task types"></div>
      <div class="footerline" style="margin-top:9px"><label><input id="teammateCountFallback" type="checkbox"> Experimental idle-teammate count fallback</label></div>
      <div id="lastStop" class="note" style="margin-top:10px"></div>
    </div>
    <div>
      <div class="panel-title">Global controls</div>
      <div class="footerline"><label><input id="enabled" type="checkbox"> Enable alerts</label><label><input id="visual" type="checkbox"> VS Code popups</label><label>Repeat gap <input id="gap" type="number" min="0" max="3000" step="50" style="width:82px"> ms</label></div>
      <div class="note" style="margin-top:8px">Auto verification learns whether a session supplies the task registry, waits through a short grace window for Claude self-resume turns, preserves a background-wait chain across task notifications, filters terminal/ignored ambient tasks, treats recurring loops separately, and can downgrade a Done candidate only on high-confidence waiting language. Volume above 100% digitally boosts the WAV and can clip.</div>
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
  const s=e.setting||{},locked=!!e.unavailable,primaryTitle={askUserQuestion:'Question',backgroundPending:'Background / Waiting',stopUnverified:'Unverified',stop:'Finished'},title=primary?(primaryTitle[e.id]||e.label):e.label;
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
  $('enabled').checked=!!state.enabled;$('visual').checked=!!state.visualNotifications;$('gap').value=state.repeatGapMs;$('watchedFiles').value=(state.watchedFiles||[]).join(', ');$('completionMode').value=state.completionVerificationMode||'auto';$('finishedGrace').value=state.finishedGraceMs??2500;$('backgroundMode').value=state.backgroundAlertMode||'transition';$('textDowngrade').checked=state.textHeuristicDowngrade!==false;$('recurringCrons').checked=!!state.recurringCronsCountAsPending;$('teammateCountFallback').checked=!!state.teammateIdleCountFallback;$('ignoredTaskTypes').value=(state.ignoredBackgroundTaskTypes||[]).join(', ');const diag=state.lastStopDiagnostic;$('lastStop').textContent=diag?('Last Stop: '+String(diag.kind||'unknown').toUpperCase()+' · '+diag.backgroundCount+' blocking task(s) · '+diag.cronCount+' one-shot wakeup(s)'+(diag.recurringCronCount?' · '+diag.recurringCronCount+' recurring cron(s)':'')+(diag.textMatch?' · waiting text: '+diag.textMatch:'')+(diag.compatibility?' · compatibility mode':'')+(diag.teammateOnly?' · only teammate entries are blocking; if they are idle, consider adding teammate to Ignored task types':'')):'No Stop classification recorded in this VS Code window yet.';
  const currentCat=saved.category||$('category').value;$('category').innerHTML='<option value="">All categories</option>'+(state.categories||[]).map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');if((state.categories||[]).includes(currentCat))$('category').value=currentCat;
  $('search').value=saved.search||$('search').value||'';document.querySelector('details.more').open=!!saved.advanced;
  const primaryOrder=['askUserQuestion','backgroundPending','recurringCronIteration','stopUnverified','stop'];const primaryIds=new Set(primaryOrder);const primary=(state.events||[]).filter(e=>primaryIds.has(e.id)).sort((a,b)=>primaryOrder.indexOf(a.id)-primaryOrder.indexOf(b.id));const others=(state.events||[]).filter(e=>!primaryIds.has(e.id));
  $('primaryEvents').innerHTML=primary.map(e=>eventCard(e,true)).join('');$('events').innerHTML=others.map(e=>eventCard(e,false)).join('');renderLibrary();renderPreset();bindCards();applyFilter();requestAnimationFrame(()=>window.scrollTo(0,Number(saved.scrollY)||0));
}

$('installHooks').addEventListener('click',()=>post('installHooks'));$('removeHooks').addEventListener('click',()=>post('removeHooks'));$('openLog').addEventListener('click',()=>post('openLog'));$('addSound').addEventListener('click',()=>post('addSound'));document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{b.disabled=true;post('applyPreset',{name:b.dataset.preset});setTimeout(()=>{b.disabled=false},500)}));$('enabled').addEventListener('change',e=>post('setGlobal',{key:'enabled',value:e.target.checked}));$('visual').addEventListener('change',e=>post('setGlobal',{key:'showVisualNotifications',value:e.target.checked}));$('completionMode').addEventListener('change',e=>post('setGlobal',{key:'completionVerificationMode',value:e.target.value}));$('finishedGrace').addEventListener('change',e=>post('setGlobal',{key:'finishedGraceMs',value:Number(e.target.value)}));$('backgroundMode').addEventListener('change',e=>post('setGlobal',{key:'backgroundAlertMode',value:e.target.value}));$('textDowngrade').addEventListener('change',e=>post('setGlobal',{key:'textHeuristicDowngrade',value:e.target.checked}));$('recurringCrons').addEventListener('change',e=>post('setGlobal',{key:'recurringCronsCountAsPending',value:e.target.checked}));$('teammateCountFallback').addEventListener('change',e=>post('setGlobal',{key:'teammateIdleCountFallback',value:e.target.checked}));$('ignoredTaskTypes').addEventListener('change',e=>post('setGlobal',{key:'ignoredBackgroundTaskTypes',value:String(e.target.value||'').split(',').map(v=>v.trim()).filter(Boolean)}));$('gap').addEventListener('change',e=>post('setGlobal',{key:'repeatGapMs',value:Number(e.target.value)}));$('watchedFiles').addEventListener('change',e=>post('setWatchedFiles',{value:e.target.value}));$('search').addEventListener('input',()=>{applyFilter();saveViewState()});$('category').addEventListener('change',()=>{applyFilter();saveViewState()});document.querySelector('details.more').addEventListener('toggle',saveViewState);let scrollTimer;window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(saveViewState,150)});window.addEventListener('message',ev=>{const m=ev.data;if(m.type==='state'){saveViewState();state=m.state;render()}if(m.type==='eventSetting'){updateEventView(m.id,m.setting,m.activePreset)}if(m.type==='toast'){$('toast').textContent=m.text||'';if(m.text)setTimeout(()=>{if($('toast').textContent===m.text)$('toast').textContent=''},3000)}});render()})();
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
        const allowed=new Set(['enabled','showVisualNotifications','completionVerificationMode','finishedGraceMs','textHeuristicDowngrade','backgroundAlertMode','ignoredBackgroundTaskTypes','teammateIdleCountFallback','recurringCronsCountAsPending','repeatGapMs']); if(!allowed.has(msg.key))return;
        let value=msg.value;
        if(msg.key==='repeatGapMs')value=Math.round(clamp(value,0,3000));
        else if(msg.key==='finishedGraceMs')value=Math.round(clamp(value,0,15000));
        else if(msg.key==='completionVerificationMode')value=['auto','strict','legacy'].includes(String(value))?String(value):'auto';
        else if(msg.key==='backgroundAlertMode')value=['transition','changes','everyStop'].includes(String(value))?String(value):'transition';
        else if(msg.key==='ignoredBackgroundTaskTypes')value=[...new Set((Array.isArray(value)?value:[]).map(v=>String(v).trim().toLowerCase()).filter(Boolean))];
        else if(['enabled','showVisualNotifications','textHeuristicDowngrade','teammateIdleCountFallback','recurringCronsCountAsPending'].includes(msg.key))value=!!value;
        await cfg().update(msg.key,value,vscode.ConfigurationTarget.Global); scheduleUiState();if(['enabled'].includes(msg.key))updateStatusBar();if(['completionVerificationMode','ignoredBackgroundTaskTypes','recurringCronsCountAsPending'].includes(msg.key))scheduleHookReconcileIfShapeChanged(400);return;
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

  const migrations=[migrateV12Settings,migrateV131QuestionSound,migrateV132DoneAndErrorSounds,migrateV140PrimaryDefaults,migrateV171Completion,migrateV172Completion];
  for(const migration of migrations){try{await migration();}catch(error){log(`Migration ${migration.name} failed; continuing with current/default settings: ${error.stack||error}`);}
  }
  hookShapeKey=currentHookShapeKey();
  if(extensionContext.globalState.get('v171ShowWhatsNew',false)){await extensionContext.globalState.update('v171ShowWhatsNew',false);void vscode.window.showInformationMessage('Claude Sound Alerts updated completion detection for background-agent runs. Finished is now grace-delayed and old Recommended settings were upgraded.','Open Claude Alerts').then(choice=>{if(choice==='Open Claude Alerts')void openControlPanel();});}
  if(extensionContext.globalState.get('v172StrictModeReviewNeeded',false)){await extensionContext.globalState.update('v172StrictModeReviewNeeded',false);void vscode.window.showInformationMessage('Claude Sound Alerts: v1.7.1 may have migrated the old verification toggle to Strict. Auto is recommended for partial/older Claude payloads.','Use Auto','Keep Strict').then(async choice=>{if(choice==='Use Auto'){await cfg().update('completionVerificationMode','auto',vscode.ConfigurationTarget.Global);scheduleUiState();scheduleHookReconcileIfShapeChanged(250);}});}

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
  log('Extension v1.7.2 activated. Completion tracking now handles self-resume ordering, recurring-loop Stops, tighter waiting-language downgrades, background chains, and silent internal state relays.');
}
async function deactivate(){
  if(hookReconcileTimer){clearTimeout(hookReconcileTimer);hookReconcileTimer=undefined;}
  if(uiStateTimer){clearTimeout(uiStateTimer);uiStateTimer=undefined;}
  if(retryTimer){clearTimeout(retryTimer);retryTimer=undefined;}
  for(const pending of pendingFinished.values())try{clearTimeout(pending.timer);}catch(_error){} pendingFinished.clear();sessionRoutePins.clear();routedEventSeen.clear();
  stopHeartbeat();
  try{fs.unlinkSync(listenerRegistryFile());}catch(_error){}
  await stopServer(true,false);
}
const testApi=process.env.CLAUDE_SOUND_ALERTS_TEST==='1' ? {
  EVENT_DEFS, PRESET_GROUPS, OLD_RECOMMENDED_V16, parseClaudeSettingsText, patchTopLevelHooks, pcmWavInfo, scalePcmWav, audioPlaybackTimeoutMs, spawnCaptured, windowsAudioHostScript, stopCompletionState, blockingTasks, blockingCrons, knownAmbientTask, waitingTextMatch, candidateProfiles, classifyHook, updateSessionState, getSessionState, pendingWorkReason, backgroundAlertShouldFire, deferFinished, cancelDeferredFinished, completionVerificationMode, migrateV171EventSettingsObject, migrateV172Completion, NOTIFICATION_PROFILE_BY_TYPE, handleHookLocally, ensureRoutingMetadata, isSelfResumePrompt, hookReceivedAt, lastMessageTail, cronPartitions, commandRelayHandler, handlerUrl, waitingMatchNegated, windowsRelayScript,
  desiredHookGroups, desiredHookSignatures, ourHookSignatures, hookSignature, hasStoredEventSettingsFromInspection,
  setTestStoragePath: value => { relayStoragePathOverride=value?path.resolve(String(value)):null; }, clearTestState:()=>{for(const p of pendingFinished.values())try{clearTimeout(p.timer);}catch(_error){}pendingFinished.clear();sessionStates.clear();sessionRoutePins.clear();routedEventSeen.clear();lastSharedDedupePruneAt=0;lastPlayedAt.clear();lastStopDiagnostic=null;}
} : null;
module.exports=testApi?{activate,deactivate,__test:testApi}:{activate,deactivate};

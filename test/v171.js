'use strict';
const assert = require('assert');
const Module = require('module');
const path = require('path');
const os = require('os');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (_k,d)=>d, inspect:()=>({}) }) },
      ConfigurationTarget: { Global: 1 }, window: {}, Uri: {}, StatusBarAlignment: { Right: 2 }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.CLAUDE_SOUND_ALERTS_TEST = '1';
const t = require('../extension.js').__test;
t.setTestStoragePath(path.join(os.tmpdir(),'claude-sound-alerts-v171-test'));
Module._load = originalLoad;

function settings(overrides={}) {
  const out=Object.fromEntries(t.EVENT_DEFS.map(d=>[d.id,{enabled:false}]));
  for(const [id,value] of Object.entries(overrides)) out[id]={...(out[id]||{}),...(typeof value==='boolean'?{enabled:value}:value)};
  return out;
}
function stop(session, background=[], crons=[], extra={}) { return {session_id:session,hook_event_name:'Stop',background_tasks:background,session_crons:crons,...extra}; }
const runTask=(id,type='subagent',status='running')=>({id,type,status,description:`${type} ${id}`});

// H2: terminal and configured ambient tasks do not block, but live teammates do by default.
t.clearTestState();
assert.strictEqual(t.stopCompletionState(stop('terminal',[runTask('a','shell','completed')],[])).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('failed',[runTask('a','shell','failed')],[])).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('ambient',[{id:'m',type:'monitor_ws',status:'running'}],[])).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('ambient-flag',[{id:'m',type:'shell',status:'running',ambient:true}],[])).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('team',[{id:'tm',type:'teammate',status:'running'}],[])).kind,'background');
assert.strictEqual(t.stopCompletionState(stop('team-ignore',[{id:'tm',type:'teammate',status:'running'}],[]),{ignoredBackgroundTaskTypes:['monitor_ws','teammate']}).kind,'finished');

// TeammateIdle state can make a permanently-listed teammate non-blocking without ignoring all teammates.
t.clearTestState();
t.updateSessionState({session_id:'team-state',hook_event_name:'TeammateIdle',agent_id:'tm-id',teammate_name:'probe-two'});
const teamState=t.getSessionState({session_id:'team-state'},false);
assert.strictEqual(t.stopCompletionState(stop('team-state',[{id:'tm-id',type:'teammate',status:'running',description:'probe-two'}],[]),{state:teamState}).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('artifact-monitor',[{id:'m',type:'monitor',status:'running',description:'Artifact live updates watcher'}],[])).kind,'finished');

// Recurring crons are non-blocking by default; one-shot wakeups block.
assert.strictEqual(t.stopCompletionState(stop('cron-rec',[],[{id:'c',recurring:true,schedule:'* * * * *'}])).kind,'recurring');
assert.strictEqual(t.stopCompletionState(stop('cron-rec-on',[],[{id:'c',recurring:true,schedule:'* * * * *'}]),{recurringCronsCountAsPending:true}).kind,'background');
assert.strictEqual(t.stopCompletionState(stop('cron-once',[],[{id:'c',recurring:false,schedule:'once'}])).kind,'background');

// H3: auto mode is compatible until a session proves it sends authoritative registries.
t.clearTestState();
const partial={session_id:'partial',hook_event_name:'Stop',background_tasks:[]};
let c=t.stopCompletionState(partial,{completionVerificationMode:'auto'});
assert.strictEqual(c.kind,'finished'); assert.strictEqual(c.compatibility,true);
assert.strictEqual(t.stopCompletionState(partial,{completionVerificationMode:'strict'}).kind,'unverified');
t.updateSessionState(stop('partial',[],[]),t.stopCompletionState(stop('partial',[],[]),{completionVerificationMode:'auto'}));
c=t.stopCompletionState(partial,{completionVerificationMode:'auto',state:t.getSessionState(partial,false)});
assert.strictEqual(c.kind,'unverified','auto mode must become strict after authoritative registry was observed');

// H4: downgrade-only text heuristic catches the user's real examples even if registries are empty.
const msg1='The PostgreSQL/architecture agent is still running its background PostgreSQL runs and will report when they finish.';
const msg2='Both document scripts pass their dry runs. They are waiting only on the full-suite numbers, which arrive when the run finishes in about 15 minutes.';
assert.strictEqual(t.stopCompletionState(stop('txt1',[],[],{last_assistant_message:msg1})).kind,'background');
assert.strictEqual(t.stopCompletionState(stop('txt2',[],[],{last_assistant_message:msg2})).kind,'background');
assert.strictEqual(t.stopCompletionState(stop('txt3',[],[],{last_assistant_message:msg1}),{textHeuristicDowngrade:false}).kind,'finished');

// M1: Stop inside an agent context can never become the main Finished profile.
t.clearTestState();
assert.strictEqual(t.classifyHook(stop('agent-stop',[],[],{agent_id:'agent-1',agent_type:'postgresql'}),settings({stop:true}),{}),null);

// M2: SubagentStop does not overwrite the parent session's pending background state.
t.clearTestState();
const parentPending=stop('parent',[runTask('shell1','shell','running')],[]);
t.classifyHook(parentPending,settings({backgroundPending:true}),{});
t.classifyHook({session_id:'parent',hook_event_name:'SubagentStop',agent_id:'a1',agent_type:'general-purpose',background_tasks:[],session_crons:[]},settings({subagentStop:true}),{});
const idle={session_id:'parent',hook_event_name:'Notification',notification_type:'idle_prompt'};
assert.strictEqual(t.classifyHook(idle,settings({notificationIdlePrompt:true,notification:true}),{}),null,'idle prompt must remain suppressed while parent work is pending');
assert.strictEqual(t.getSessionState({session_id:'parent'},false).status,'waiting_background');

// M3: Background sound fires on transition only by default; changes/everyStop are opt-in modes.
t.clearTestState();
const a=stop('transition',[runTask('a')],[]),b=stop('transition',[runTask('b')],[]);
let r=t.classifyHook(a,settings({backgroundPending:true}),{}); assert(r&&r.id==='backgroundPending');
r=t.classifyHook(a,settings({backgroundPending:true}),{}); assert.strictEqual(r,null);
r=t.classifyHook(b,settings({backgroundPending:true}),{backgroundAlertMode:'changes'}); assert(r&&r.id==='backgroundPending');
r=t.classifyHook(b,settings({backgroundPending:true}),{backgroundAlertMode:'everyStop'}); assert(r&&r.id==='backgroundPending');

// H1: Finished candidates are deferred and a quick self-resume cancels them.
(async()=>{
  t.clearTestState();
  let played=0;
  const body=stop('grace',[],[]),result={id:'stop',reason:'done'};
  t.updateSessionState(body,t.stopCompletionState(body));
  t.deferFinished(body,result,{ms:90,play:()=>{played++;}});
  setTimeout(()=>t.cancelDeferredFinished({session_id:'grace',hook_event_name:'UserPromptSubmit'},'UserPromptSubmit'),20);
  await new Promise(res=>setTimeout(res,150));
  assert.strictEqual(played,0,'queued self-resume must cancel Finished');

  t.clearTestState();
  played=0;
  const body2=stop('grace-real',[],[]);
  t.updateSessionState(body2,t.stopCompletionState(body2));
  t.deferFinished(body2,result,{ms:40,play:()=>{played++;}});
  await new Promise(res=>setTimeout(res,90));
  assert.strictEqual(played,1,'quiet grace window must confirm Finished exactly once');

  // M5/H1: completion tracking installs state hooks even if their sounds are disabled.
  let g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({stop:true,askUserQuestion:true}));
  assert(g.Stop,'Stop state hook missing');
  assert(g.UserPromptSubmit,'UserPromptSubmit continuation-cancel hook missing');
  assert(g.SubagentStart,'SubagentStart state hook missing');
  assert(g.SubagentStop,'SubagentStop state hook missing');
  assert(g.TeammateIdle,'TeammateIdle state hook missing for teammate busy/idle reconstruction');
  assert(g.PreToolUse && g.PreToolUse[0].matcher==='AskUserQuestion');

  // M4: old v1.6 Recommended config migrates to new Recommended and Agent Finished sound.
  const raw={};
  for(const id of t.OLD_RECOMMENDED_V16)raw[id]={enabled:true};
  raw.subagentStop={enabled:true,sound:'calm-complete',volume:45,repeat:1};
  raw.preToolUse={enabled:false};raw.postToolUse={enabled:false};raw.notification={enabled:false};
  const migrated=t.migrateV171EventSettingsObject(raw);
  assert.strictEqual(migrated.oldRecommended,true);
  assert.strictEqual(migrated.raw.subagentStop.sound,'finished');
  assert.strictEqual(migrated.raw.subagentStop.enabled,false,'new Recommended must not beep for every individual agent');
  assert.strictEqual(migrated.raw.backgroundPending.enabled,true);
  assert.strictEqual(migrated.raw.notificationAgentNeedsInput.enabled,true);

  console.log('v1.7.1 completion robustness regression tests passed.');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});

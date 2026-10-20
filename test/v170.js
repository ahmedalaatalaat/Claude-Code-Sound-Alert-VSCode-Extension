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
t.setTestStoragePath(path.join(os.tmpdir(),'claude-sound-alerts-v170-test'));
Module._load = originalLoad;

function settings(overrides={}) {
  const out=Object.fromEntries(t.EVENT_DEFS.map(d=>[d.id,{enabled:false}]));
  for(const [id,value] of Object.entries(overrides)) out[id]={...(out[id]||{}),...(typeof value==='boolean'?{enabled:value}:value)};
  return out;
}

// Authoritative Stop payloads: Done is allowed only when both registries are present and empty.
const pendingStop={
  session_id:'s-pending',prompt_id:'p1',hook_event_name:'Stop',
  background_tasks:[{id:'bg1',type:'subagent',status:'running',agent_type:'postgresql',description:'PostgreSQL checks'}],
  session_crons:[]
};
const doneStop={session_id:'s-done',prompt_id:'p2',hook_event_name:'Stop',background_tasks:[],session_crons:[]};
const scheduledStop={session_id:'s-cron',hook_event_name:'Stop',background_tasks:[],session_crons:[{id:'c1',schedule:'* * * * *',recurring:false,prompt:'check build'}]};
const legacyStop={session_id:'s-legacy',hook_event_name:'Stop'};

assert.strictEqual(t.stopCompletionState(pendingStop).kind,'background');
assert.strictEqual(t.stopCompletionState(scheduledStop).kind,'background');
assert.strictEqual(t.stopCompletionState(doneStop).kind,'finished');
assert.strictEqual(t.stopCompletionState(legacyStop,{completionVerificationMode:'auto'}).kind,'finished');

// Critical regression: background work must never fall through to Main Work Finished.
t.clearTestState();
assert.strictEqual(
  t.classifyHook(pendingStop,settings({stop:true}),{strictCompletionVerification:true}),
  null,
  'background Stop must not fall through to Main Work Finished when Background alert is disabled'
);
t.clearTestState();
let r=t.classifyHook(pendingStop,settings({stop:true,backgroundPending:true}),{strictCompletionVerification:true});
assert(r && r.id==='backgroundPending','background Stop should classify as Background Work / Waiting');
assert(/background task/i.test(r.reason));

t.clearTestState();
r=t.classifyHook(doneStop,settings({stop:true}),{strictCompletionVerification:true});
assert(r && r.id==='stop','empty authoritative registries should classify as Main Work Finished');

// Missing registry data is conservative by default.
t.clearTestState();
assert.strictEqual(t.classifyHook(legacyStop,settings({stop:true}),{strictCompletionVerification:true}),null);
t.clearTestState();
r=t.classifyHook(legacyStop,settings({stop:true,stopUnverified:true}),{strictCompletionVerification:true});
assert(r && r.id==='stopUnverified');
t.clearTestState();
r=t.classifyHook(legacyStop,settings({stop:true}),{strictCompletionVerification:false});
assert(r && r.id==='stop','legacy compatibility mode should allow Stop as Finished');

// Subagent completion is independent and can never map to the main Finished profile.
const agentStop={session_id:'s-agents',hook_event_name:'SubagentStop',agent_id:'agent-db',agent_type:'postgresql',background_tasks:[],session_crons:[]};
r=t.classifyHook(agentStop,settings({stop:true,subagentStop:true}),{strictCompletionVerification:true});
assert(r && r.id==='subagentStop');
assert.notStrictEqual(r.id,'stop');

// Task completion is also not overall completion.
const taskDone={session_id:'s-agents',hook_event_name:'TaskCompleted',task_id:'t1',task_subject:'Run PostgreSQL checks',agent_id:'agent-db'};
r=t.classifyHook(taskDone,settings({stop:true,taskCompleted:true}),{strictCompletionVerification:true});
assert(r && r.id==='taskCompleted');

// Notification subtype routing: specific first, generic fallback second.
const agentNeeds={session_id:'s-notif',hook_event_name:'Notification',notification_type:'agent_needs_input'};
r=t.classifyHook(agentNeeds,settings({notification:true,notificationAgentNeedsInput:true}),{});
assert(r && r.id==='notificationAgentNeedsInput');
const otherNotif={session_id:'s-notif',hook_event_name:'Notification',notification_type:'auth_success'};
r=t.classifyHook(otherNotif,settings({notification:true}),{});
assert(r && r.id==='notification');

// Known background state suppresses a misleading idle reminder rather than treating it as completion/idle.
t.classifyHook({...pendingStop,session_id:'s-idle'},settings({}),{strictCompletionVerification:true});
const idle={session_id:'s-idle',hook_event_name:'Notification',notification_type:'idle_prompt'};
assert.strictEqual(t.classifyHook(idle,settings({notificationIdlePrompt:true,notification:true}),{}),null);
r=t.classifyHook(idle,settings({backgroundPending:true,notificationIdlePrompt:true}),{});
assert.strictEqual(r,null,'idle_prompt should be suppressed instead of replaying Background');

// Hook installation remains enabled-only, but virtual Stop and Notification profiles still install their underlying hook.
let g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({backgroundPending:true}));
assert(g.Stop,'Background Work profile must install Stop even when Main Finished is disabled');
g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({notificationAgentNeedsInput:true,notificationAgentCompleted:true}));
assert(g.Notification && g.Notification[0].matcher);
assert(g.Notification[0].matcher.includes('agent_needs_input'));
assert(g.Notification[0].matcher.includes('agent_completed'));
assert(!g.Notification[0].matcher.includes('idle_prompt'));

// Current Claude lifecycle additions are represented and hookable.
const byId=new Map(t.EVENT_DEFS.map(d=>[d.id,d]));
assert.strictEqual(byId.get('preModelSwitch').hookEvent,'PreModelSwitch');
assert.strictEqual(byId.get('postModelSwitch').hookEvent,'PostModelSwitch');
g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({preModelSwitch:true,postModelSwitch:true}));
assert(g.PreModelSwitch && g.PostModelSwitch);

// Defaults remain intentionally quiet: Question + verified Main Finished only.
const defaults=t.EVENT_DEFS.filter(d=>d.defaultEnabled).map(d=>d.id).sort();
assert.deepStrictEqual(defaults,['askUserQuestion','stop']);
assert.strictEqual(byId.get('backgroundPending').defaultEnabled,false);
assert.strictEqual(byId.get('subagentStop').defaultEnabled,false);
assert.strictEqual(byId.get('notificationAgentCompleted').defaultEnabled,false);

console.log('v1.7 background-aware completion regression tests passed.');

'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

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
t.setTestStoragePath(path.join(os.tmpdir(),'claude-sound-alerts-v172-test'));
Module._load = originalLoad;

function settings(overrides={}) {
  const out=Object.fromEntries(t.EVENT_DEFS.map(d=>[d.id,{enabled:false}]));
  for(const [id,value] of Object.entries(overrides)) out[id]={...(out[id]||{}),...(typeof value==='boolean'?{enabled:value}:value)};
  return out;
}
function stop(session, background=[], crons=[], extra={}) { return {session_id:session,hook_event_name:'Stop',background_tasks:background,session_crons:crons,...extra}; }
const task=(id,type='subagent',status='running',extra={})=>({id,type,status,description:`${type} ${id}`,...extra});

// N1: text heuristic must catch real waiting language without downgrading normal finals.
const waiting1='The PostgreSQL/architecture agent is still running its background PostgreSQL runs and will report when they finish.';
const waiting2='Both document scripts pass their dry runs. They are waiting only on the full-suite numbers, which arrive when the run finishes in about 15 minutes.';
assert.strictEqual(t.stopCompletionState(stop('w1',[],[],{last_assistant_message:waiting1})).kind,'background');
assert.strictEqual(t.stopCompletionState(stop('w2',[],[],{last_assistant_message:waiting2})).kind,'background');
const negatives=[
  "Done. I'm waiting for your confirmation before deploying.",
  'The retry logic now cleans up temp files when they finish.',
  'Fixed the CI config so the job finishes in about 5 minutes after a retry.',
  'Summary: nothing is still running; all processes have exited.',
  'Workers are now waiting on the Redis lock correctly.',
  'Refactor complete. Let me know if you want any changes.'
];
for(const [i,message] of negatives.entries()) assert.strictEqual(t.stopCompletionState(stop(`neg${i}`,[],[],{last_assistant_message:message})).kind,'finished',message);

// N2: self-resume task notifications do not start a new background alert chain.
t.clearTestState();
let r=t.classifyHook(stop('chain',[task('A'),task('B')],[]),settings({backgroundPending:true}),{});
assert(r&&r.id==='backgroundPending');
assert.strictEqual(t.classifyHook({session_id:'chain',hook_event_name:'UserPromptSubmit',prompt:'<task-notification>Agent A finished</task-notification>'},settings({backgroundPending:true}),{}),null);
r=t.classifyHook(stop('chain',[task('B')],[]),settings({backgroundPending:true}),{});
assert.strictEqual(r,null,'self-resume must not retrigger transition-only Background');
// A real user prompt starts a fresh waiting chain.
t.classifyHook({session_id:'chain',hook_event_name:'UserPromptSubmit',prompt:'What is the status?'},settings({backgroundPending:true}),{});
r=t.classifyHook(stop('chain',[task('B')],[]),settings({backgroundPending:true}),{});
assert(r&&r.id==='backgroundPending','real user prompt should start a new background chain');

// N3: explicit ignore/ambient rules run before conservative unknown-status blocking.
assert.strictEqual(t.stopCompletionState(stop('idle-ignore',[task('tm','teammate','idle')],[]),{ignoredBackgroundTaskTypes:['teammate']}).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('idle-monitor',[task('m','monitor_ws','idle')],[])).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('ambient-wait',[task('s','shell','waiting',{ambient:true})],[])).kind,'finished');

// N4/N10: recurring crons are a third Stop outcome; unknown cron shapes block conservatively.
let c=t.stopCompletionState(stop('loop',[],[{id:'loop',recurring:true,schedule:'*/5 * * * *'}]));
assert.strictEqual(c.kind,'recurring');
assert.strictEqual(t.classifyHook(stop('loop2',[],[{id:'loop',recurring:true}]),settings({stop:true}),{}),null,'recurring loop must never fall through to Main Finished');
r=t.classifyHook(stop('loop3',[],[{id:'loop',recurring:true}]),settings({recurringCronIteration:true}),{});
assert(r&&r.id==='recurringCronIteration');
assert.strictEqual(t.stopCompletionState(stop('bad-cron',[],['mystery cron'])).kind,'background');

// N5: use reconstructed idle-teammate count even when background task ids do not match agent ids.
t.clearTestState();
t.updateSessionState({session_id:'team-real-shape',hook_event_name:'TeammateIdle',agent_id:'agent-uuid',teammate_name:'probe-two'});
let state=t.getSessionState({session_id:'team-real-shape'},false);
assert.strictEqual(t.stopCompletionState(stop('team-real-shape',[{id:'tk8gt4uh4',type:'teammate',status:'running',description:'Goal: open a DRAFT…'}],[]),{state}).kind,'finished');
assert.strictEqual(t.stopCompletionState(stop('team-one-busy',[{id:'t1',type:'teammate',status:'running'},{id:'t2',type:'teammate',status:'running'}],[]),{state}).kind,'background','one idle teammate cannot hide two teammate entries');
t.updateSessionState({session_id:'team-real-shape',hook_event_name:'SubagentStart',agent_id:'busy-agent',agent_type:'busy-teammate'});
state=t.getSessionState({session_id:'team-real-shape'},false);
assert.strictEqual(t.stopCompletionState(stop('team-busy-guard',[{id:'t3',type:'teammate',status:'running',description:'unknown teammate'}],[]),{state}).kind,'background','known busy teammate must disable count-only idle fallback');

// N6: out-of-order processing is safe because receive timestamps are assigned before routing.
(async()=>{
  t.clearTestState();
  let played=0;
  const s=settings({stop:true});
  // Newer self-resume is processed first.
  await t.handleHookLocally({_claude_sound_alerts_received_at:200,session_id:'order',hook_event_name:'UserPromptSubmit',prompt:'<task-notification>done</task-notification>'},{settings:s,playProfile:()=>{}});
  await t.handleHookLocally(stop('order',[],[],{_claude_sound_alerts_received_at:100}),{settings:s,deferOptions:{ms:30,play:()=>{played++;}}});
  await new Promise(res=>setTimeout(res,70));
  assert.strictEqual(played,0,'newer activity processed first must still suppress older Finished');

  // Normal order also cancels.
  t.clearTestState();played=0;
  await t.handleHookLocally(stop('order2',[],[],{_claude_sound_alerts_received_at:100}),{settings:s,deferOptions:{ms:60,play:()=>{played++;}}});
  await t.handleHookLocally({_claude_sound_alerts_received_at:200,session_id:'order2',hook_event_name:'UserPromptSubmit',prompt:'<task-notification>done</task-notification>'},{settings:s,playProfile:()=>{}});
  await new Promise(res=>setTimeout(res,90));
  assert.strictEqual(played,0,'normal-order self-resume must cancel Finished');

  // Truly quiet Stop still finishes.
  t.clearTestState();played=0;
  await t.handleHookLocally(stop('order3',[],[],{_claude_sound_alerts_received_at:300}),{settings:s,deferOptions:{ms:25,play:()=>{played++;}}});
  await new Promise(res=>setTimeout(res,60));
  assert.strictEqual(played,1);

  // N7: silent state hooks use fire-and-forget command relays; audible hooks remain HTTP.
  let g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({stop:true}));
  for(const name of ['UserPromptSubmit','SubagentStart','SubagentStop','TeammateIdle']) assert.strictEqual(g[name][0].hooks[0].type,'command',`${name} internal state hook should fail silently outside VS Code`);
  g=t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok',settings({stop:true,subagentStop:true}));
  assert.strictEqual(g.SubagentStop[0].hooks[0].type,'http','audible Agent Finished hook should use direct HTTP');

  // N9: routing metadata is stable across retries/forwards.
  const body={session_id:'meta',hook_event_name:'Stop'};
  t.ensureRoutingMetadata(body);const id=body._claude_sound_alerts_event_id,at=body._claude_sound_alerts_received_at;
  t.ensureRoutingMetadata(body);assert.strictEqual(body._claude_sound_alerts_event_id,id);assert.strictEqual(body._claude_sound_alerts_received_at,at);

  // Packaging hygiene: media WAVs only live in media/sounds.
  const media=path.join(__dirname,'..','media');
  assert.strictEqual(fs.readdirSync(media).filter(n=>n.toLowerCase().endsWith('.wav')).length,0,'root media/*.wav duplicates would be packaged');

  console.log('v1.7.2 completion correctness regression tests passed.');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});

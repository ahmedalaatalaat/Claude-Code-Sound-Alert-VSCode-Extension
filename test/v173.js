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
t.setTestStoragePath(path.join(os.tmpdir(),'claude-sound-alerts-v173-test'));
Module._load = originalLoad;

function settings(overrides={}) {
  const out=Object.fromEntries(t.EVENT_DEFS.map(d=>[d.id,{enabled:false}]));
  for(const [id,value] of Object.entries(overrides)) out[id]={...(out[id]||{}),...(typeof value==='boolean'?{enabled:value}:value)};
  return out;
}
function stop(session, background=[], crons=[], extra={}) { return {session_id:session,hook_event_name:'Stop',background_tasks:background,session_crons:crons,...extra}; }
const task=(id,type='subagent',status='running',extra={})=>({id,type,status,description:`${type} ${id}`,...extra});

// R1: stale teammate-idle evidence cannot produce a false Finished after a real lead prompt.
t.clearTestState();
t.updateSessionState({_claude_sound_alerts_received_at:100,session_id:'team-retask',hook_event_name:'TeammateIdle',agent_id:'agent-r',teammate_name:'researcher'});
t.updateSessionState({_claude_sound_alerts_received_at:200,session_id:'team-retask',hook_event_name:'UserPromptSubmit',prompt:'Ask researcher to dig deeper'});
let state=t.getSessionState({session_id:'team-retask'},false);
let completion=t.stopCompletionState(stop('team-retask',[{id:'task-unrelated',type:'teammate',status:'running',description:'Goal: dig deeper'}],[],{_claude_sound_alerts_received_at:300}),{state});
assert.strictEqual(completion.kind,'background','re-tasked teammate must still block Finished');
// Count-only teammate correlation is explicitly opt-in and defaults conservative.
t.clearTestState();
t.updateSessionState({_claude_sound_alerts_received_at:100,session_id:'team-count',hook_event_name:'TeammateIdle',agent_id:'agent-r',teammate_name:'researcher'});
state=t.getSessionState({session_id:'team-count'},false);
completion=t.stopCompletionState(stop('team-count',[{id:'task-unrelated',type:'teammate',status:'running',description:'Goal: prior work'}],[]),{state});
assert.strictEqual(completion.kind,'background','count-only teammate fallback must be off by default');
completion=t.stopCompletionState(stop('team-count',[{id:'task-unrelated',type:'teammate',status:'running',description:'Goal: prior work'}],[]),{state,teammateIdleCountFallback:true});
assert.strictEqual(completion.kind,'finished','explicit teammate count fallback may be enabled by the user');

// R4: non-continuation events after a final Stop must not suppress the real Finished sound.
(async()=>{
  const s=settings({stop:true});
  t.clearTestState();let played=0;
  await t.handleHookLocally(stop('idle-after-final',[],[],{_claude_sound_alerts_received_at:100}),{settings:s,deferOptions:{ms:35,play:()=>{played++;}}});
  await t.handleHookLocally({_claude_sound_alerts_received_at:110,session_id:'idle-after-final',hook_event_name:'TeammateIdle',agent_id:'a',teammate_name:'helper'},{settings:s,playProfile:()=>{}});
  await new Promise(r=>setTimeout(r,70));
  assert.strictEqual(played,1,'TeammateIdle after final Stop must not cancel Finished');

  t.clearTestState();played=0;
  await t.handleHookLocally(stop('auth-after-final',[],[],{_claude_sound_alerts_received_at:100}),{settings:s,deferOptions:{ms:35,play:()=>{played++;}}});
  await t.handleHookLocally({_claude_sound_alerts_received_at:110,session_id:'auth-after-final',hook_event_name:'Notification',notification_type:'auth_success'},{settings:s,playProfile:()=>{}});
  await new Promise(r=>setTimeout(r,70));
  assert.strictEqual(played,1,'unrelated Notification after final Stop must not cancel Finished');

  // R5/R6: waiting-language downgrade is clause-aware and catches high-confidence external waits.
  assert.strictEqual(t.stopCompletionState(stop('txt1',[],[],{last_assistant_message:'Not done yet: the test suite is still running.'})).kind,'background');
  assert.strictEqual(t.stopCompletionState(stop('txt2',[],[],{last_assistant_message:'No longer waiting; the job is still running in the background.'})).kind,'background');
  assert.strictEqual(t.stopCompletionState(stop('txt3',[],[],{last_assistant_message:'Summary: nothing is still running; all processes have exited.'})).kind,'finished');
  assert.strictEqual(t.stopCompletionState(stop('txt4',[],[],{last_assistant_message:'Waiting on the CI pipeline to finish; results should land in 10 minutes.'})).kind,'background');
  assert.strictEqual(t.stopCompletionState(stop('txt5',[],[],{last_assistant_message:'The test is running in the background via nohup; results should arrive in ~15 minutes.'})).kind,'background');
  assert.strictEqual(t.stopCompletionState(stop('txt6',[],[],{last_assistant_message:"I kicked off the deploy. I'll check back once it completes."})).kind,'background');
  assert.strictEqual(t.stopCompletionState(stop('txt7',[],[],{last_assistant_message:'All done. Waiting for your review.'})).kind,'finished');

  // R7: known system/self-resume prompt shapes preserve the background chain.
  assert.strictEqual(t.isSelfResumePrompt({prompt:'<task-notification>done</task-notification>'}),true);
  assert.strictEqual(t.isSelfResumePrompt({prompt:'<teammate-message teammate_id="dev-1">idle</teammate-message>'}),true);
  assert.strictEqual(t.isSelfResumePrompt({prompt:'<agent-message from="helper">report</agent-message>'}),true);
  assert.strictEqual(t.isSelfResumePrompt({prompt:'Another Claude session sent a message:\n<agent-message>hello</agent-message>'}),true);
  assert.strictEqual(t.isSelfResumePrompt({source:'schedule_wakeup',prompt:'wake'}),true);

  // R3/R10: Windows internal relay uses cmd/curl for fast UTF-8 forwarding, with UTF-8 PowerShell fallback.
  const url='http://127.0.0.1:47391/claude-code-sound-alerts/hook/abcdef123456';
  const wh=t.commandRelayHandler(url,'win32');
  assert.strictEqual(wh.type,'command');
  assert.strictEqual(wh.command,'cmd.exe');
  assert(wh.args.some(v=>String(v).includes('claude-sound-alerts-relay.cmd')),'Windows relay should invoke the .cmd helper');
  assert.strictEqual(t.handlerUrl(wh),url,'handlerUrl must extract only the embedded hook URL from cmd.exe args');
  const script=t.windowsRelayScript();
  assert(script.includes('where curl.exe'),'Windows relay should prefer built-in curl.exe');
  assert(script.includes('--data-binary @-'),'curl relay must forward stdin bytes');
  assert(script.includes('[Console]::InputEncoding=[Text.Encoding]::UTF8'),'PowerShell fallback must read UTF-8 stdin');
  assert(script.includes('[Text.Encoding]::UTF8.GetBytes($body)'),'PowerShell fallback must send UTF-8 bytes');

  // R2/package hygiene: source has no root WAV copies and .vscodeignore protects against them returning.
  const root=path.join(__dirname,'..'),media=path.join(root,'media');
  assert.strictEqual(fs.readdirSync(media).filter(n=>n.toLowerCase().endsWith('.wav')).length,0,'root media/*.wav duplicates must not exist');
  assert(fs.readFileSync(path.join(root,'.vscodeignore'),'utf8').split(/\r?\n/).includes('media/*.wav'),'.vscodeignore must exclude accidental root media WAVs');

  // R9: responsive primary cards use auto-fit and can wrap their controls.
  const source=fs.readFileSync(path.join(root,'extension.js'),'utf8');
  assert(source.includes('.primary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr))'), 'primary grid must be responsive');
  assert(source.includes('.event.primary .controlgrid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}'), 'primary controls must wrap instead of overflowing');

  console.log('v1.7.3 completion/routing regression tests passed.');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});

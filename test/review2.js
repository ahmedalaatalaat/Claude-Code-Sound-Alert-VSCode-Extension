'use strict';
const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (_k,d)=>d, inspect:()=>({}) }) },
      ConfigurationTarget: { Global: 1 },
      window: {}, Uri: {}, StatusBarAlignment: { Right: 2 }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.CLAUDE_SOUND_ALERTS_TEST = '1';
const extension = require('../extension.js');
Module._load = originalLoad;
const t = extension.__test;

const desired = {
  Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47391/claude-code-sound-alerts/hook/token', timeout: 2 }] }],
  PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: 'http://127.0.0.1:47391/claude-code-sound-alerts/hook/token', timeout: 2 }] }]
};

const shapes = [
  '{}',
  '{\n}',
  '{\r\n}',
  '{"a":1}',
  '{"a":1,}',
  '{\n  "a": 1\n}',
  '{\n  "a": 1,\n}',
  '{\n  // before\n  "a": 1\n}',
  '{\n  "a": 1 // tail a\n}',
  '{\n  "a": [1,2,3]\n}',
  '{\n  "a": {"b": 2}\n}',
  '{\n  "a": "comma, brace } and // text"\n}',
  '{\n  "a": true,\n  "b": false\n}',
  '{\n  "a": null,\n  "b": 1.25\n}',
  '{\n  "hooks": {}\n}',
  '{\n  "hooks": {},\n}',
  '{\n  "hooks": {}\n  // keep after hooks\n}',
  '{\n  "hooks": {} /* keep block after hooks */\n}',
  '{\n  "hooks": {},\n  "x": 1\n}',
  '{\n  "x": 1,\n  "hooks": {}\n}',
  '{\n  "x": 1,\n  "hooks": {}\n  // final note\n}',
  '{\n  "x": {"nested":[1,{"z":"}"}]},\n  "hooks": {}\n}',
  '{\n  /* root note */\n  "x": 1,\n  /* before hooks */\n  "hooks": {}\n}',
  '{\n\t"x": 1\n}',
  '{\r\n  "x": 1\r\n}',
  '{\n  "x": 1 /* x note */\n}',
  '{\n  "x": 1 /* x note */,\n  "y": 2\n}',
  '{\n  "x": "escaped \\\" quote",\n  "y": 2\n}',
  '{\n  "x": [/* c */1,2],\n  "y": {"q":true}\n}',
  '{\n  "x": 1, // comma comment\n  "y": 2\n}',
  '{\n  "x": 1,\n  "hooks": {"Stop": []},\n  "y": 2\n}'
];

for (let i=0;i<shapes.length;i++) {
  const input = shapes[i];
  const once = t.patchTopLevelHooks(input, desired);
  const twice = t.patchTopLevelHooks(once, desired);
  assert.strictEqual(twice, once, `shape ${i+1}: patch must be idempotent`);
  const parsed = t.parseClaudeSettingsText(once);
  assert(parsed.hooks && parsed.hooks.Stop && parsed.hooks.PreToolUse, `shape ${i+1}: hooks missing after patch`);
  const removed = t.patchTopLevelHooks(once, {});
  const removedParsed = t.parseClaudeSettingsText(removed);
  assert(!Object.prototype.hasOwnProperty.call(removedParsed, 'hooks'), `shape ${i+1}: hooks key should be removed`);
  if (input.includes('keep after hooks')) assert(removed.includes('keep after hooks'));
  if (input.includes('keep block after hooks')) assert(removed.includes('keep block after hooks'));
}

console.log(`Second-review regression tests passed (${shapes.length} JSONC shapes).`);

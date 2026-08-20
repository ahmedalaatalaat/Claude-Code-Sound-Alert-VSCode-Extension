'use strict';

const assert = require('assert');
const Module = require('module');

const orig = Module._load;
Module._load = function (r, p, m) {
  if (r === 'vscode') return {
    workspace: { getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }) },
    ConfigurationTarget: { Global: 1 }, window: {}, Uri: {}, StatusBarAlignment: { Right: 2 }
  };
  return orig.call(this, r, p, m);
};
process.env.CLAUDE_SOUND_ALERTS_TEST = '1';
const t = require('../extension.js').__test;
t.setTestStoragePath(require('path').join(require('os').tmpdir(),'claude-sound-alerts-test'));
Module._load = orig;

const H = { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:47391/claude-code-sound-alerts/hook/tok', timeout: 2 }] }] };

function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`FAIL - ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

async function checkAsync(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`FAIL - ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

const removalCases = [
  ['hooks only member',            '{\n  "hooks": {"Stop":[]}\n}\n',                       {}],
  ['hooks first, comma after',     '{\n  "hooks": {"Stop":[]},\n  "x": 1\n}\n',            { x: 1 }],
  ['hooks last, prev comma',       '{\n  "x": 1,\n  "hooks": {"Stop":[]}\n}\n',            { x: 1 }],
  ['hooks middle',                 '{\n  "a": 1,\n  "hooks": {},\n  "b": 2\n}\n',          { a: 1, b: 2 }],
  ['hooks last + trailing comma',  '{\n  "x": 1,\n  "hooks": {},\n}\n',                    { x: 1 }],
  ['hooks + tail line comment',    '{\n  "x": 1,\n  "hooks": {}\n  // keep\n}\n',          { x: 1 }],
  ['hooks + tail block comment',   '{\n  "x": 1,\n  "hooks": {} /* keep */\n}\n',          { x: 1 }],
  ['comment between key & value',  '{\n  "x": 1,\n  "hooks": /* c */ {}\n}\n',             { x: 1 }],
  ['CRLF, hooks last',             '{\r\n  "x": 1,\r\n  "hooks": {}\r\n}\r\n',             { x: 1 }],
  ['nested braces in string',      '{\n  "x": "}{",\n  "hooks": {}\n}\n',                  { x: '}{' }]
];

for (const [name, text, expectRest] of removalCases) {
  check('remove: ' + name, () => {
    const out = t.patchTopLevelHooks(text, {});
    const parsed = t.parseClaudeSettingsText(out);
    assert(!Object.prototype.hasOwnProperty.call(parsed, 'hooks'), 'hooks key survived');
    for (const k of Object.keys(expectRest)) assert.deepStrictEqual(parsed[k], expectRest[k], `key ${k} lost`);
    if (text.includes('// keep')) assert(out.includes('// keep'), 'line comment lost');
    if (text.includes('/* keep */')) assert(out.includes('/* keep */'), 'block comment lost');
    assert.strictEqual(t.patchTopLevelHooks(out, {}), out, 'removal is not idempotent');
  });
}

check('install/uninstall/install round trip is stable', () => {
  const base = '{\n  "model": "sonnet",\n  "permissions": {"allow":[]}\n}\n';
  const a = t.patchTopLevelHooks(base, H);
  const b = t.patchTopLevelHooks(a, {});
  const c = t.patchTopLevelHooks(b, H);
  assert.strictEqual(t.patchTopLevelHooks(c, H), c, 'reinstall not idempotent');
  const p = t.parseClaudeSettingsText(c);
  assert.strictEqual(p.model, 'sonnet');
  assert(p.hooks.Stop);
  const d = t.patchTopLevelHooks(c, {});
  assert.strictEqual(t.patchTopLevelHooks(d, {}), d, 'second uninstall not idempotent');
});

check('comma lands beside the value, not after a comment', () => {
  const out = t.patchTopLevelHooks('{\n  "a": 1 // note\n}\n', H);
  assert(out.includes('"a": 1, // note'), 'got:\n' + out);
  assert(!/1\s*\n\s*,/.test(out), 'comma on its own line');
  assert(out.includes('// note'), 'comment lost');
});

check('CRLF file does not gain LF-only lines', () => {
  const out = t.patchTopLevelHooks('{\r\n  "x": 1\r\n}\r\n', H);
  const lone = (out.match(/(?<!\r)\n/g) || []).length;
  assert.strictEqual(lone, 0, `introduced ${lone} LF-only line ending(s)`);
  assert(t.parseClaudeSettingsText(out).hooks.Stop, 'hooks missing');
});

check('removal leaves no whitespace-only line', () => {
  const out = t.patchTopLevelHooks('{\n  "x": 1,\n  "hooks": {}\n}\n', {});
  const blank = out.split('\n').filter(l => l.length && !l.trim()).length;
  assert.strictEqual(blank, 0, `left ${blank} whitespace-only line(s): ${JSON.stringify(out)}`);
  assert.strictEqual(t.parseClaudeSettingsText(out).x, 1);
});

check('empty object is treated as no stored event settings', () => {
  assert.strictEqual(t.hasStoredEventSettingsFromInspection({ globalValue: {} }), false);
  assert.strictEqual(t.hasStoredEventSettingsFromInspection({ globalValue: undefined }), false);
  assert.strictEqual(t.hasStoredEventSettingsFromInspection({ workspaceFolderValue: { stop: {} } }), true);
  assert.strictEqual(t.hasStoredEventSettingsFromInspection(undefined), false);
});

check('HTTP hooks use a 2s timeout', () => {
  const s = Object.fromEntries(t.EVENT_DEFS.map(d => [d.id, { enabled: false }]));
  s.stop = { enabled: true };
  const g = t.desiredHookGroups('http://u/claude-code-sound-alerts/hook/tok', s);
  assert.strictEqual(g.Stop[0].hooks[0].timeout, 2);
});

check('audio timeout grows with repeats, gaps, and WAV duration', () => {
  const one = t.audioPlaybackTimeoutMs(1, 0, 2000);
  const many = t.audioPlaybackTimeoutMs(5, 500, 2000);
  assert(one >= 13000, `unexpected single timeout ${one}`);
  assert(many > one, `repeat timeout ${many} should exceed ${one}`);
});


check('Windows first-run compiled helper is loaded before PlaySound', () => {
  const script = t.windowsAudioHostScript();
  assert(
    script.includes("Add-Type -TypeDefinition $src -OutputAssembly $dll; if (-not ('ClaudeSoundNative' -as [type])) { Add-Type -Path $dll }"),
    'freshly compiled helper DLL is not explicitly loaded into the current PowerShell session'
  );
});

check('Windows audio host self-heals stale DLL locks', () => {
  const script = t.windowsAudioHostScript();
  assert(script.includes('LastWriteTimeUtc'), 'stale-lock age check missing');
  assert(script.includes('TotalSeconds -gt 30'), '30-second stale-lock threshold missing');
  assert(script.includes('Remove-Item -LiteralPath $lock'), 'stale lock is not removed');
});

(async () => {
  await checkAsync('spawnCaptured times out a hung child process', async () => {
    const started = Date.now();
    await assert.rejects(
      t.spawnCaptured(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 80 }),
      error => error && error.code === 'ETIMEDOUT'
    );
    assert(Date.now() - started < 2000, 'timeout did not resolve promptly');
  });
  if (process.exitCode) process.exit(process.exitCode);
  console.log('Third-review regression tests passed.');
})();

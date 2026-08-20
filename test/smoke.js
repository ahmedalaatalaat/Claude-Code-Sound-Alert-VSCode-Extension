'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: () => ({ get: (_k,d)=>d }) },
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
assert(t, 'test API unavailable');
t.setTestStoragePath(path.join(require('os').tmpdir(),'claude-sound-alerts-test'));

// JSONC parsing and in-place hook patching preserve unrelated comments/order.
const jsonc = `{
  // keep this user comment
  "theme": "dark",
  "hooks": {
    "Stop": [{"hooks":[{"type":"http","url":"http://old"}]}]
  },
  "other": 7,
}
`;
const nextHooks = { Stop: [{ hooks: [{ type:'http', url:'http://127.0.0.1:47391/claude-code-sound-alerts/hook/token', timeout:2 }] }] };
const patched = t.patchTopLevelHooks(jsonc, nextHooks);
assert(patched.includes('// keep this user comment'));
assert(patched.indexOf('"theme"') < patched.indexOf('"hooks"'));
assert.strictEqual(t.parseClaudeSettingsText(patched).other, 7);
assert.strictEqual(t.parseClaudeSettingsText(patched).hooks.Stop[0].hooks[0].timeout, 2);
assert.strictEqual(t.patchTopLevelHooks(patched, nextHooks), patched, 'hook patching must be idempotent');

const noHooks = `{
  // existing formatting survives
  "foo": true,
}
`;
const added = t.patchTopLevelHooks(noHooks, nextHooks);
assert(added.includes('// existing formatting survives'));
assert(t.parseClaudeSettingsText(added).hooks.Stop);

assert(added.includes('"foo": true,'), 'new hooks member comma should stay with the previous value');
assert(!added.includes('true\n,'), 'comma must not be placed on its own line');

const hooksLastWithComment = `{
  "model": "sonnet",
  "hooks": {}
  // keep my note about hooks
}
`;
const patchedLast = t.patchTopLevelHooks(hooksLastWithComment, nextHooks);
assert(patchedLast.includes('// keep my note about hooks'), 'trailing hook comment must survive replacement');
assert.strictEqual(t.patchTopLevelHooks(patchedLast, nextHooks), patchedLast, 'last-member hook patch must be idempotent');
const removedHooks = t.patchTopLevelHooks(patchedLast, {});
assert(removedHooks.includes('// keep my note about hooks'), 'trailing hook comment must survive uninstall');
assert(!Object.prototype.hasOwnProperty.call(t.parseClaudeSettingsText(removedHooks), 'hooks'), 'empty managed hooks member should be removed');

// Fresh/default installs should not be treated as having stored event settings.
assert.strictEqual(t.hasStoredEventSettingsFromInspection({}), false);
assert.strictEqual(t.hasStoredEventSettingsFromInspection({globalValue:{}}), false);
assert.strictEqual(t.hasStoredEventSettingsFromInspection({globalValue:{stop:{enabled:true}}}), true);
assert.strictEqual(t.hasStoredEventSettingsFromInspection({workspaceValue:{askUserQuestion:{enabled:true}}}), true);

// Minimal/default hook install is exactly Question + Finished.
const settings = Object.fromEntries(t.EVENT_DEFS.map(d => [d.id, { enabled:false }]));
settings.askUserQuestion = { enabled:true };
settings.stop = { enabled:true };
const groups = t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/token', settings);
assert.deepStrictEqual(Object.keys(groups).sort(), ['PreToolUse','Stop']);
assert.strictEqual(groups.PreToolUse[0].matcher, 'AskUserQuestion');
assert.strictEqual(groups.PreToolUse[0].hooks[0].timeout, 2);

// All bundled alert WAVs are supported PCM and gain scaling remains valid.
const soundsDir = path.join(__dirname, '..', 'media', 'sounds');
const wavs = fs.readdirSync(soundsDir).filter(n => n.endsWith('.wav'));
assert(wavs.length >= 13, 'expected bundled sound library');
for (const name of wavs) {
  const buf = fs.readFileSync(path.join(soundsDir, name));
  const info = t.pcmWavInfo(buf);
  assert([8,16,24,32].includes(info.bits), `${name}: unsupported bits`);
}
const sample = fs.readFileSync(path.join(soundsDir, 'question-chime.wav'));
const boosted = t.scalePcmWav(sample, 150);
assert.strictEqual(boosted.length, sample.length);
t.pcmWavInfo(boosted);

// WAVE_FORMAT_EXTENSIBLE with PCM SubFormat is valid PCM and must be accepted.
function extensiblePcmWav() {
  const fmtSize = 40, dataSize = 2;
  const total = 12 + 8 + fmtSize + 8 + dataSize;
  const b = Buffer.alloc(total);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(total - 8, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(fmtSize, 16);
  const f = 20;
  b.writeUInt16LE(0xFFFE, f); b.writeUInt16LE(1, f + 2); b.writeUInt32LE(8000, f + 4);
  b.writeUInt32LE(16000, f + 8); b.writeUInt16LE(2, f + 12); b.writeUInt16LE(16, f + 14);
  b.writeUInt16LE(22, f + 16); b.writeUInt16LE(16, f + 18); b.writeUInt32LE(0, f + 20);
  Buffer.from([0x01,0x00,0x00,0x00,0x00,0x00,0x10,0x00,0x80,0x00,0x00,0xaa,0x00,0x38,0x9b,0x71]).copy(b, f + 24);
  const d = 20 + fmtSize;
  b.write('data', d, 'ascii'); b.writeUInt32LE(dataSize, d + 4); b.writeInt16LE(1234, d + 8);
  return b;
}
const extPcm = extensiblePcmWav();
assert.strictEqual(t.pcmWavInfo(extPcm).format, 0xFFFE);
t.pcmWavInfo(t.scalePcmWav(extPcm, 125));

// Manifest sanity checks for the stability/security release.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.strictEqual(pkg.version, '1.6.2');
assert.deepStrictEqual(pkg.activationEvents, ['onStartupFinished']);
assert.strictEqual(pkg.contributes.configuration.properties['claudeSoundAlerts.serverPort'].scope, 'machine');
assert.strictEqual(pkg.contributes.configuration.properties['claudeSoundAlerts.eventSettings'].scope, 'application');
assert(pkg.capabilities && pkg.capabilities.virtualWorkspaces);



// Platform-hook safety and manifest regression checks.
const byId = new Map(t.EVENT_DEFS.map(d => [d.id, d]));
assert.strictEqual(byId.get('askUserQuestion').defaultEnabled, true);
assert.strictEqual(byId.get('stop').defaultEnabled, true);
for (const d of t.EVENT_DEFS) {
  if (!['askUserQuestion','stop'].includes(d.id)) assert.strictEqual(d.defaultEnabled, false, `${d.id} should default off`);
}
assert.strictEqual(byId.get('worktreeCreate').unavailable, true, 'WorktreeCreate must remain safety-protected');

const deprecatedSettings = ['questionSound','finishedSound','questionVolume','finishedVolume','questionSoundEnabled','finishedSoundEnabled','questionSoundPath','finishedSoundPath'];
for (const key of deprecatedSettings) {
  assert(!pkg.contributes.configuration.properties[`claudeSoundAlerts.${key}`], `${key} must not be contributed`);
}
assert.strictEqual(pkg.contributes.configuration.properties['claudeSoundAlerts.listenerPortCount'].scope, 'machine');
assert.strictEqual(pkg.capabilities.untrustedWorkspaces.supported, true);
assert.strictEqual(pkg.capabilities.virtualWorkspaces.supported, 'limited');

const icon = fs.readFileSync(path.join(__dirname, '..', 'media', 'icon.png'));
assert.strictEqual(icon.toString('ascii',1,4), 'PNG');
assert.strictEqual(icon.readUInt32BE(16), 256);
assert.strictEqual(icon.readUInt32BE(20), 256);

const commandSettings = Object.fromEntries(t.EVENT_DEFS.map(d => [d.id, { enabled:false }]));
commandSettings.sessionStart = { enabled:true };
const commandGroups = t.desiredHookGroups('http://127.0.0.1:47391/claude-code-sound-alerts/hook/token', commandSettings);
const sessionHandler = commandGroups.SessionStart[0].hooks[0];
assert.strictEqual(sessionHandler.type, 'command');
assert.strictEqual(sessionHandler.timeout, 10);
assert.strictEqual(sessionHandler.async, true);
assert(Array.isArray(sessionHandler.args) && sessionHandler.args.length >= 2, 'SessionStart command hook should use exec-form args');

console.log(`Smoke tests passed (${wavs.length} bundled WAVs validated).`);

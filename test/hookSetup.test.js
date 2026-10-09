'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { HOOK_EVENTS, addHooks, removeHooks, hasHooks, install, uninstall, isInstalled, paths } = require('../src/hookSetup');

const existing = {
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay Funk.aiff' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'git-ai checkpoint' }] }],
  },
};

test('addHooks adds one entry per event and keeps existing hooks', () => {
  const next = addHooks(existing, '/home/me/.claude/claude-tabs/record-event.sh');
  assert.equal(next.model, 'opus');
  assert.deepEqual(next.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.equal(next.hooks.Stop.length, 2);
  assert.deepEqual(next.hooks.Stop[0], existing.hooks.Stop[0]);
  assert.deepEqual(next.hooks.Stop[1].hooks[0], {
    type: 'command',
    command: 'sh "/home/me/.claude/claude-tabs/record-event.sh" Stop',
    timeout: 5,
  });
  assert.equal(next.hooks.PostToolUse[0].matcher, '*');
  assert.equal(hasHooks(next), true);
  assert.equal(hasHooks(existing), false);
});

test('addHooks twice does not duplicate entries', () => {
  const once = addHooks(existing, '/x/claude-tabs/record-event.sh');
  assert.deepEqual(addHooks(once, '/x/claude-tabs/record-event.sh'), once);
});

test('removeHooks restores the original settings', () => {
  assert.deepEqual(removeHooks(addHooks(existing, '/x/claude-tabs/record-event.sh')), existing);
  assert.deepEqual(removeHooks(addHooks({}, '/x/claude-tabs/record-event.sh')), {});
});

test('install and uninstall edit settings.json, with a backup', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-hooks-'));
  const p = paths(base);
  fs.writeFileSync(p.settings, JSON.stringify(existing));

  await install(base);
  assert.equal(await isInstalled(base), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p.settings}.claude-tabs.bak`, 'utf8')), existing);
  assert.equal(fs.statSync(p.script).mode & 0o111, 0o111);

  await uninstall(base);
  assert.equal(await isInstalled(base), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settings, 'utf8')), existing);
});

test('install creates settings.json when there is none', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-hooks-'));
  await install(base);
  const settings = JSON.parse(fs.readFileSync(paths(base).settings, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
});

test('the hook script records only the status fields', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-hooks-'));
  const p = await install(base);
  const input = JSON.stringify({
    session_id: 'abc-123',
    transcript_path: '/Users/me/.claude/projects/-repo/abc-123.jsonl',
    cwd: '/repo',
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
    tool_input: { command: 'echo "session_id": "not-this-one"' },
  });
  execFileSync('sh', [p.script, 'Notification'], { input });
  execFileSync('sh', [p.script, 'Stop'], { input: '{"no":"session"}' });

  const lines = fs.readFileSync(p.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  const { at, ...rest } = lines[0];
  assert.deepEqual(rest, {
    session: 'abc-123',
    transcript: '/Users/me/.claude/projects/-repo/abc-123.jsonl',
    event: 'Notification',
    type: 'permission_prompt',
  });
  assert.ok(Math.abs(at - Date.now() / 1000) < 60);
});

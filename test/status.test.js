'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEvents, applyEvent, displayStatus, STALE_WORKING_SECONDS } = require('../src/status');

function replay(events) {
  const sessions = new Map();
  events.forEach((event) => applyEvent(sessions, event));
  return sessions;
}

const ev = (event, at, extra = {}) => ({ session: 's1', event, at, ...extra });

test('parseEvents skips blank, cut-off, and incomplete lines', () => {
  const text = [
    JSON.stringify(ev('Stop', 1)),
    '',
    '{"session":"s1","event":"Sto',
    JSON.stringify({ event: 'Stop', at: 2 }),
    JSON.stringify(ev('UserPromptSubmit', 3)),
  ].join('\n');
  assert.deepEqual(parseEvents(text).map((e) => e.event), ['Stop', 'UserPromptSubmit']);
});

test('a prompt or a finished tool means Claude is working', () => {
  assert.equal(replay([ev('UserPromptSubmit', 10)]).get('s1').state, 'working');
  assert.equal(replay([ev('Stop', 5), ev('PostToolUse', 10)]).get('s1').state, 'working');
});

test('permission and question prompts mean Claude is waiting for you', () => {
  assert.equal(replay([ev('UserPromptSubmit', 1), ev('Notification', 2, { type: 'permission_prompt' })]).get('s1').state, 'waiting');
  assert.equal(replay([ev('Notification', 2, { type: 'elicitation_dialog' })]).get('s1').state, 'waiting');
});

test('the idle reminder does not change the status or its time', () => {
  const sessions = replay([ev('Stop', 5), ev('Notification', 70, { type: 'idle_prompt' })]);
  assert.deepEqual(sessions.get('s1'), { state: 'done', at: 5, transcript: undefined });
});

test('approving a tool returns the session to working', () => {
  const sessions = replay([ev('Notification', 2, { type: 'permission_prompt' }), ev('PostToolUse', 3)]);
  assert.equal(sessions.get('s1').state, 'working');
});

test('the transcript path is kept from earlier events', () => {
  const sessions = replay([ev('UserPromptSubmit', 1, { transcript: '/t/s1.jsonl' }), ev('Stop', 2)]);
  assert.equal(sessions.get('s1').transcript, '/t/s1.jsonl');
});

test('displayStatus: working, then needs you until seen, then idle', () => {
  assert.equal(displayStatus({ state: 'working', at: 100 }, 0, 110), 'working');
  assert.equal(displayStatus({ state: 'done', at: 120 }, 100, 130), 'attention');
  assert.equal(displayStatus({ state: 'done', at: 120 }, 125, 130), 'idle');
  assert.equal(displayStatus({ state: 'done', at: 120 }, 120, 130), 'idle');
});

test('displayStatus: waiting needs you even after you looked', () => {
  assert.equal(displayStatus({ state: 'waiting', at: 100 }, 200, 210), 'attention');
});

test('displayStatus: a working session with no news for a long time shows idle', () => {
  assert.equal(displayStatus({ state: 'working', at: 0 }, 0, STALE_WORKING_SECONDS + 1), 'idle');
});

test('displayStatus: unknown sessions are idle', () => {
  assert.equal(displayStatus(undefined, 0, 1), 'idle');
});

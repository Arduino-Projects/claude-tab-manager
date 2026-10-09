'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionTracker, MAX_EVENTS_BYTES, KEEP_EVENTS_LINES } = require('../src/tracker');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-tracker-'));
  const events = path.join(dir, 'events.jsonl');
  const transcript = (id, ...titles) => {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, titles.map((t) => JSON.stringify({ type: 'ai-title', aiTitle: t })).join('\n') + '\n');
    return file;
  };
  const append = (...lines) => fs.appendFileSync(events, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  let now = 1000;
  const tracker = new SessionTracker(events, () => now);
  return { dir, events, transcript, append, tracker, setNow: (t) => (now = t) };
}

test('poll reads only new events and keeps a cut-off last line for later', async () => {
  const { events, append, tracker } = setup();
  assert.equal(await tracker.poll(), false);
  append({ session: 's1', event: 'UserPromptSubmit', at: 1 });
  assert.equal(await tracker.poll(), true);
  assert.equal(tracker.session('s1').state, 'working');
  assert.equal(await tracker.poll(), false);

  fs.appendFileSync(events, '{"session":"s1","event":"St');
  assert.equal(await tracker.poll(), false);
  fs.appendFileSync(events, 'op","at":2}\n');
  assert.equal(await tracker.poll(), true);
  assert.equal(tracker.session('s1').state, 'done');
});

test('poll starts over when the file was truncated', async () => {
  const { events, append, tracker } = setup();
  append({ session: 's1', event: 'Stop', at: 1 }, { session: 's2', event: 'Stop', at: 2 });
  await tracker.poll();
  fs.writeFileSync(events, `${JSON.stringify({ session: 's3', event: 'UserPromptSubmit', at: 3 })}\n`);
  await tracker.poll();
  assert.deepEqual([...tracker.sessions.keys()], ['s3']);
});

test('match maps tab labels to sessions by title, most recent first', async () => {
  const { append, transcript, tracker } = setup();
  append(
    { session: 'old', transcript: transcript('old', 'Same title'), event: 'Stop', at: 1 },
    { session: 'login', transcript: transcript('login', 'Fix login'), event: 'Stop', at: 2 },
    { session: 'new', transcript: transcript('new', 'Same title'), event: 'Stop', at: 3 },
  );
  await tracker.poll();
  await tracker.refreshTitles();
  assert.deepEqual(tracker.match(['Same title', 'Fix login', 'Same title', 'Other']), ['new', 'login', 'old', undefined]);
});

test('titles are re-read after a stop, but not after every tool call', async () => {
  const { append, transcript, tracker } = setup();
  const file = transcript('s1', 'First');
  append({ session: 's1', transcript: file, event: 'UserPromptSubmit', at: 1 });
  await tracker.poll();
  await tracker.refreshTitles();
  assert.deepEqual(tracker.match(['First']), ['s1']);

  transcript('s1', 'First', 'Second');
  append({ session: 's1', event: 'PostToolUse', at: 2 });
  await tracker.poll();
  await tracker.refreshTitles();
  assert.deepEqual(tracker.match(['Second']), [undefined]);

  append({ session: 's1', event: 'Stop', at: 3 });
  await tracker.poll();
  await tracker.refreshTitles();
  assert.deepEqual(tracker.match(['Second']), ['s1']);
});

test('matchWithRetry picks up a rename that no hook reported, once per new label', async () => {
  const { append, transcript, tracker } = setup();
  append({ session: 's1', transcript: transcript('s1', 'Before'), event: 'Stop', at: 990 });
  await tracker.poll();
  await tracker.refreshTitles();

  transcript('s1', 'Before', 'After');
  assert.deepEqual(await tracker.matchWithRetry(['After']), ['s1']);

  let reads = 0;
  const refresh = tracker.refreshTitles.bind(tracker);
  tracker.refreshTitles = async () => {
    reads++;
    return refresh();
  };
  assert.deepEqual(await tracker.matchWithRetry(['Nothing']), [undefined]);
  assert.deepEqual(await tracker.matchWithRetry(['Nothing']), [undefined]);
  assert.equal(reads, 1);
});

test('matchWithRetry does not re-read sessions with no recent activity', async () => {
  const { append, transcript, tracker, setNow } = setup();
  append({ session: 's1', transcript: transcript('s1', 'Before'), event: 'Stop', at: 1 });
  await tracker.poll();
  await tracker.refreshTitles();
  transcript('s1', 'Before', 'After');
  setNow(1 + 2 * 24 * 60 * 60);
  assert.deepEqual(await tracker.matchWithRetry(['After']), [undefined]);
});

test('compact keeps the newest lines of a large events file', async () => {
  const { events, tracker } = setup();
  const line = JSON.stringify({ session: 's', event: 'PostToolUse', at: 1, pad: 'x'.repeat(200) });
  const count = Math.ceil(MAX_EVENTS_BYTES / line.length) + 10;
  fs.writeFileSync(events, Array.from({ length: count }, () => line).join('\n') + '\n');
  await tracker.compact();
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, KEEP_EVENTS_LINES);
});

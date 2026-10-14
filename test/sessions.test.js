'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { labelMatchesTitle, titleFromTranscript } = require('../src/sessions');

const line = (record) => JSON.stringify(record);

function transcript(...records) {
  return Buffer.from(records.map(line).join('\n') + '\n');
}

test('labelMatchesTitle matches full titles and Claude Code\'s shortened titles', () => {
  assert.equal(labelMatchesTitle('Fix login', 'Fix login'), true);
  assert.equal(labelMatchesTitle('Fix  login ', 'Fix login'), true);
  assert.equal(labelMatchesTitle('Review PR #41500 and lea…', 'Review PR #41500 and leave comments'), true);
  assert.equal(labelMatchesTitle('Review PR #41500 and lea…', 'Review PR #41500 and lea'), false);
  assert.equal(labelMatchesTitle('Fix login', 'Fix login page'), false);
  assert.equal(labelMatchesTitle('', 'x'), false);
});

test('titleFromTranscript prefers the last custom title over AI titles', () => {
  const buffer = transcript(
    { type: 'user', message: 'mentions "ai-title" in text' },
    { type: 'ai-title', aiTitle: 'First AI title' },
    { type: 'custom-title', customTitle: 'Mine' },
    { type: 'ai-title', aiTitle: 'Later AI title' },
    { type: 'custom-title', customTitle: 'Mine, renamed' },
  );
  assert.equal(titleFromTranscript(buffer), 'Mine, renamed');
});

test('titleFromTranscript falls back to the last AI title', () => {
  assert.equal(titleFromTranscript(transcript({ type: 'ai-title', aiTitle: 'A' }, { type: 'ai-title', aiTitle: 'B' })), 'B');
  assert.equal(titleFromTranscript(transcript({ type: 'user' })), undefined);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSessionIds } = require('../src/sessions');

function makeProjects(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-'));
  let mtime = Date.now() / 1000 - 1000;
  for (const [project, sessionId, records] of sessions) {
    fs.mkdirSync(path.join(dir, project), { recursive: true });
    const file = path.join(dir, project, `${sessionId}.jsonl`);
    fs.writeFileSync(file, transcript(...records));
    fs.utimesSync(file, mtime, mtime);
    mtime += 10;
  }
  return dir;
}

test('findSessionIds maps tab titles to session ids, newest transcript first', async () => {
  const dir = makeProjects([
    ['-Users-me-repo', 'old-dup', [{ type: 'ai-title', aiTitle: 'Same title' }]],
    ['-Users-me-other', 's-login', [{ type: 'ai-title', aiTitle: 'Fix login' }]],
    ['-Users-me-repo', 'new-dup', [{ type: 'ai-title', aiTitle: 'Same title' }]],
    ['-Users-me-repo', 's-long', [{ type: 'custom-title', customTitle: 'Review PR #41500 and leave comments' }]],
  ]);
  const ids = await findSessionIds(['Fix login', 'Same title', 'Same title', 'Review PR #41500 and lea…', 'Nope'], { dir });
  assert.deepEqual(ids, ['s-login', 'new-dup', 'old-dup', 's-long', undefined]);
});

test('findSessionIds returns no matches when the projects folder is missing', async () => {
  assert.deepEqual(await findSessionIds(['x'], { dir: path.join(os.tmpdir(), 'does-not-exist-claude-tabs') }), [undefined]);
});

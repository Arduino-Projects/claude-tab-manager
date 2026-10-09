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

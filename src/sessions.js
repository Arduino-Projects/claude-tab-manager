'use strict';

// Reads a Claude Code session's title from its transcript, and matches it to
// a tab title. Only title records are parsed; the rest is skipped.

const TITLE_MARKERS = ['"custom-title"', '"ai-title"'];

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

// Claude Code shows titles longer than 25 characters as 24 characters and "…".
function labelMatchesTitle(label, title) {
  const shown = normalize(label);
  const full = normalize(title);
  if (!shown || !full) return false;
  if (!shown.endsWith('…')) return shown === full;
  const prefix = shown.slice(0, -1);
  return prefix !== '' && full !== prefix && full.startsWith(prefix);
}

function* linesContaining(buffer, markers) {
  const seen = new Set();
  for (const marker of markers) {
    let at = buffer.indexOf(marker);
    while (at >= 0) {
      const start = buffer.lastIndexOf(10, at) + 1;
      let end = buffer.indexOf(10, at);
      if (end < 0) end = buffer.length;
      if (!seen.has(start)) {
        seen.add(start);
        yield [start, buffer.subarray(start, end).toString('utf8')];
      }
      at = buffer.indexOf(marker, end);
    }
  }
}

// The last custom title wins; otherwise the last AI title.
function titleFromTranscript(buffer) {
  const lines = [...linesContaining(buffer, TITLE_MARKERS)].sort((a, b) => a[0] - b[0]);
  let custom;
  let ai;
  for (const [, line] of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === 'custom-title' && record.customTitle) custom = record.customTitle;
    else if (record.type === 'ai-title' && record.aiTitle) ai = record.aiTitle;
  }
  return custom ?? ai;
}

module.exports = { labelMatchesTitle, titleFromTranscript };

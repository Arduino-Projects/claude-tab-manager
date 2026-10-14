'use strict';

// Reads a Claude Code session's title from its transcript, and matches it to
// a tab title. Only title records are parsed; the rest is skipped.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

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

async function listTranscripts(dir) {
  const projects = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const project of projects.filter((p) => p.isDirectory())) {
    const projectDir = path.join(dir, project.name);
    for (const name of (await fs.readdir(projectDir).catch(() => [])).filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(projectDir, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat?.isFile()) files.push({ file, sessionId: name.slice(0, -'.jsonl'.length), mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

// One session id (or undefined) per title, newest transcript first. Each
// session is used once, so tabs with the same title get different sessions.
async function findSessionIds(labels, { dir = projectsDir(), maxFiles = 500 } = {}) {
  const result = labels.map(() => undefined);
  let remaining = labels.length;
  for (const { file, sessionId } of (await listTranscripts(dir)).slice(0, maxFiles)) {
    if (!remaining) break;
    const buffer = await fs.readFile(file).catch(() => undefined);
    const title = buffer && titleFromTranscript(buffer);
    if (!title) continue;
    const index = labels.findIndex((label, i) => result[i] === undefined && labelMatchesTitle(label, title));
    if (index >= 0) {
      result[index] = sessionId;
      remaining--;
    }
  }
  return result;
}

module.exports = { labelMatchesTitle, titleFromTranscript, findSessionIds };

'use strict';

// Follows the events file the hooks write, keeps each session's status, and
// matches sessions to open tabs by title.

const fs = require('fs/promises');
const { parseEvents, applyEvent } = require('./status');
const { labelMatchesTitle, titleFromTranscript } = require('./sessions');

const TITLE_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Notification']);
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const KEEP_EVENTS_LINES = 2000;
const RECENT_SECONDS = 24 * 60 * 60;

class SessionTracker {
  constructor(eventsFile, now = () => Math.floor(Date.now() / 1000)) {
    this.eventsFile = eventsFile;
    this.now = now;
    this.offset = 0;
    this.sessions = new Map();
    this.titles = new Map();
    this.staleTitles = new Set();
    this.triedLabels = new Set();
  }

  // Keeps the events file small. Runs once at startup.
  async compact() {
    const stat = await fs.stat(this.eventsFile).catch(() => undefined);
    if (!stat || stat.size <= MAX_EVENTS_BYTES) return;
    const lines = (await fs.readFile(this.eventsFile, 'utf8')).split('\n').filter(Boolean);
    await fs.writeFile(this.eventsFile, `${lines.slice(-KEEP_EVENTS_LINES).join('\n')}\n`);
  }

  // Reads events added since the last poll. Returns true when any arrived.
  async poll() {
    const stat = await fs.stat(this.eventsFile).catch(() => undefined);
    if (!stat) return false;
    if (stat.size < this.offset) {
      this.offset = 0;
      this.sessions.clear();
    }
    if (stat.size === this.offset) return false;
    const handle = await fs.open(this.eventsFile, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(stat.size - this.offset);
      await handle.read(buffer, 0, buffer.length, this.offset);
      const end = buffer.lastIndexOf(10) + 1;
      this.offset += end;
      text = buffer.subarray(0, end).toString('utf8');
    } finally {
      await handle.close();
    }
    const events = parseEvents(text);
    for (const event of events) {
      applyEvent(this.sessions, event);
      if (TITLE_EVENTS.has(event.event) || !this.titles.has(event.session)) this.staleTitles.add(event.session);
    }
    return events.length > 0;
  }

  async refreshTitles() {
    const stale = [...this.staleTitles];
    this.staleTitles.clear();
    for (const id of stale) {
      const transcript = this.sessions.get(id)?.transcript;
      if (!transcript) continue;
      const buffer = await fs.readFile(transcript).catch(() => undefined);
      if (buffer) this.titles.set(id, titleFromTranscript(buffer));
    }
  }

  // One session id (or undefined) per label. The most recently active session
  // wins when titles repeat.
  match(labels) {
    const candidates = [...this.sessions.entries()]
      .filter(([id]) => this.titles.get(id))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id]) => id);
    const used = new Set();
    return labels.map((label) => {
      const id = candidates.find((c) => !used.has(c) && labelMatchesTitle(label, this.titles.get(c)));
      if (id) used.add(id);
      return id;
    });
  }

  // Titles change without a hook event when a session is renamed, so a label
  // that matches nothing triggers one re-read of recent unmatched sessions.
  async matchWithRetry(labels) {
    let ids = this.match(labels);
    const fresh = labels.filter((label, i) => !ids[i] && !this.triedLabels.has(label));
    if (!fresh.length) return ids;
    fresh.forEach((label) => this.triedLabels.add(label));
    const now = this.now();
    const matched = new Set(ids);
    for (const [id, session] of this.sessions) {
      if (!matched.has(id) && now - session.at < RECENT_SECONDS) this.staleTitles.add(id);
    }
    if (!this.staleTitles.size) return ids;
    await this.refreshTitles();
    ids = this.match(labels);
    return ids;
  }

  session(id) {
    return id ? this.sessions.get(id) : undefined;
  }
}

module.exports = { SessionTracker, MAX_EVENTS_BYTES, KEEP_EVENTS_LINES };

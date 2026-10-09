'use strict';

// Turns Claude Code hook events into a per-session status, and decides what a
// tab shows: 'working', 'attention' (needs you), or 'idle'.

const STALE_WORKING_SECONDS = 30 * 60;
const ATTENTION_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event.session === 'string' && event.session && typeof event.event === 'string') events.push(event);
    } catch {
      // A line can be cut off while the hook is still writing it.
    }
  }
  return events;
}

// sessions: Map of sessionId -> { state, at, transcript }.
function applyEvent(sessions, event) {
  const previous = sessions.get(event.session);
  const next = { state: previous?.state, at: event.at, transcript: event.transcript || previous?.transcript };
  switch (event.event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      next.state = 'working';
      break;
    case 'Notification':
      if (!ATTENTION_NOTIFICATIONS.has(event.type)) next.at = previous?.at ?? event.at;
      else next.state = 'waiting';
      break;
    case 'Stop':
      next.state = 'done';
      break;
    default:
      return;
  }
  sessions.set(event.session, next);
}

function displayStatus(session, seenAt, now) {
  if (!session) return 'idle';
  if (session.state === 'waiting') return 'attention';
  if (session.state === 'working') return now - session.at < STALE_WORKING_SECONDS ? 'working' : 'idle';
  if (session.state === 'done') return session.at > (seenAt ?? 0) ? 'attention' : 'idle';
  return 'idle';
}

module.exports = { parseEvents, applyEvent, displayStatus, STALE_WORKING_SECONDS };

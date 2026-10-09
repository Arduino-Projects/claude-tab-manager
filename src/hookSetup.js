'use strict';

// Adds Claude Code hooks that record session status for the sidebar. The
// hooks run a small script that keeps only the session id, transcript path,
// event name, notification type, and time.

const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop'];
const SCRIPT_NAME = 'record-event.sh';

const SCRIPT = `#!/bin/sh
# Claude Tabs: records that a Claude Code session changed state.
# Keeps only the session id, transcript path, event name, notification type, and time.
dir=$(dirname "$0")
input=$(cat)
field() { printf '%s' "$input" | grep -o "\\"$1\\" *: *\\"[^\\"]*\\"" | head -n 1 | sed 's/.*: *"\\(.*\\)"$/\\1/'; }
session=$(field session_id)
[ -n "$session" ] || exit 0
printf '{"session":"%s","transcript":"%s","event":"%s","type":"%s","at":%s}\\n' \\
  "$session" "$(field transcript_path)" "$1" "$(field notification_type)" "$(date +%s)" >> "$dir/events.jsonl"
exit 0
`;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function paths(base = claudeDir()) {
  const dir = path.join(base, 'claude-tabs');
  return {
    dir,
    script: path.join(dir, SCRIPT_NAME),
    events: path.join(dir, 'events.jsonl'),
    settings: path.join(base, 'settings.json'),
  };
}

const isOurs = (hook) => typeof hook?.command === 'string' && hook.command.includes(`claude-tabs/${SCRIPT_NAME}`);

function hasHooks(settings) {
  return HOOK_EVENTS.every((event) => (settings?.hooks?.[event] ?? []).some((entry) => entry.hooks?.some(isOurs)));
}

function removeHooks(settings) {
  const next = { ...settings };
  if (!next.hooks) return next;
  next.hooks = { ...next.hooks };
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !isOurs(hook)) }))
      .filter((entry) => entry.hooks.length);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

function addHooks(settings, scriptPath) {
  const next = removeHooks(settings);
  next.hooks = { ...(next.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const hook = { type: 'command', command: `sh "${scriptPath}" ${event}`, timeout: 5 };
    const entry = event === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
    next.hooks[event] = [...(next.hooks[event] ?? []), entry];
  }
  return next;
}

async function readSettings(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

async function writeSettings(file, settings) {
  await fs.copyFile(file, `${file}.claude-tabs.bak`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

async function installScript(base) {
  const p = paths(base);
  await fs.mkdir(p.dir, { recursive: true });
  await fs.writeFile(p.script, SCRIPT, { mode: 0o755 });
  return p;
}

async function isInstalled(base) {
  return hasHooks(await readSettings(paths(base).settings).catch(() => ({})));
}

async function install(base) {
  const p = await installScript(base);
  const settings = await readSettings(p.settings);
  if (!hasHooks(settings)) await writeSettings(p.settings, addHooks(settings, p.script));
  return p;
}

async function uninstall(base) {
  const p = paths(base);
  const settings = await readSettings(p.settings);
  if (JSON.stringify(removeHooks(settings)) !== JSON.stringify(settings)) await writeSettings(p.settings, removeHooks(settings));
  return p;
}

module.exports = { HOOK_EVENTS, SCRIPT, paths, hasHooks, addHooks, removeHooks, installScript, isInstalled, install, uninstall };

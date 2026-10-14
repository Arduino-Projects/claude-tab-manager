'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fake, reset, dragAndDrop, tick } = require('./support/fake-vscode');
const extension = require('../src/extension');
const pkg = require('../package.json');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_KEY = 'claudeTabs.state';

let activeContext;

function start({ state, statusPrompt = false } = {}) {
  activeContext?.subscriptions.forEach((d) => d.dispose?.());
  activeContext = undefined;
  reset();
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tabs-ext-'));
  if (state) fake.globalStateData[STATE_KEY] = state;
  if (!statusPrompt) fake.globalStateData['claudeTabs.statusSetupAsked'] = true;
}

function activate() {
  activeContext = fake.context();
  extension.activate(activeContext);
  return fake.treeView.treeDataProvider;
}

function tree(provider) {
  return provider.getChildren().filter((section) => section.kind === 'group').map((section) => [
    provider.getTreeItem(section).label,
    provider.getChildren(section).map((child) => provider.getTreeItem(child).label),
  ]);
}

const sectionNamed = (provider, name) => provider.getChildren().find((s) => provider.getTreeItem(s).label === name);
const tabNamed = (provider, label) =>
  provider
    .getChildren()
    .flatMap((s) => provider.getChildren(s))
    .find((c) => c.kind === 'tab' && c.tab.label === label);

test('registers every command that package.json declares', () => {
  start();
  activate();
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  assert.deepEqual(Object.keys(fake.registered).sort(), declared);
});

test('dragging a tab onto a group moves it into that group', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: {} } });
  fake.openTab('Fix login');
  fake.openTab('Review PR', { split: 1 });
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'Review PR')], sectionNamed(provider, 'Bugs'));

  assert.deepEqual(tree(provider), [
    ['Bugs', ['Review PR']],
    ['Ungrouped', ['Fix login']],
  ]);
});

test('dragging several tabs onto Ungrouped removes them from their group', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1', b: 'g1', c: 'g1' } } });
  ['a', 'b', 'c'].forEach((label) => fake.openTab(label));
  fake.openTab('loose');
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'a'), tabNamed(provider, 'b')], sectionNamed(provider, 'Ungrouped'));

  assert.deepEqual(tree(provider), [
    ['Bugs', ['c']],
    ['Ungrouped', ['loose', 'a', 'b']],
  ]);
});

test('dropping a tab onto another tab moves it into that tab\'s group, just above it', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1' } } });
  fake.openTab('a');
  fake.openTab('b');
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'b')], tabNamed(provider, 'a'));

  assert.deepEqual(tree(provider), [['Bugs', ['b', 'a']]]);
});

test('dragging reorders tabs inside a group, and the order is saved', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1', b: 'g1', c: 'g1' } } });
  ['a', 'b', 'c'].forEach((label) => fake.openTab(label));
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'c')], tabNamed(provider, 'a'));
  assert.deepEqual(tree(provider), [['Bugs', ['c', 'a', 'b']]]);

  await dragAndDrop([tabNamed(provider, 'c')], sectionNamed(provider, 'Bugs'));
  assert.deepEqual(tree(provider), [['Bugs', ['a', 'b', 'c']]]);

  await dragAndDrop([tabNamed(provider, 'a'), tabNamed(provider, 'b')], tabNamed(provider, 'c'));
  assert.deepEqual(tree(provider), [['Bugs', ['a', 'b', 'c']]]);
  assert.deepEqual(fake.globalStateData[STATE_KEY].order, ['a', 'b', 'c']);
});

test('the saved order comes back after a reload', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1', b: 'g1' }, order: ['b', 'a'] } });
  fake.openTab('a');
  fake.openTab('b');
  const provider = activate();
  assert.deepEqual(tree(provider), [['Bugs', ['b', 'a']]]);
});

test('dropping a tab onto itself changes nothing', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1', b: 'g1' } } });
  fake.openTab('a');
  fake.openTab('b');
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'b')], tabNamed(provider, 'b'));

  assert.deepEqual(tree(provider), [['Bugs', ['a', 'b']]]);
});

test('dropping onto a tab in another group moves it there, above that tab', async () => {
  start({ state: twoGroups({ a: 'g1', b: 'g2', c: 'g2' }) });
  ['a', 'b', 'c'].forEach((label) => fake.openTab(label));
  const provider = activate();

  await dragAndDrop([tabNamed(provider, 'a')], tabNamed(provider, 'c'));

  assert.deepEqual(tree(provider), [
    ['Bugs', []],
    ['Reviews', ['b', 'a', 'c']],
  ]);
});

test('Move to Group creates a group for the active tab', async () => {
  start();
  fake.openTab('Fix login');
  const provider = activate();
  fake.answer.quickPick = (items) => items.find((i) => i.create) ?? items.find((i) => i.colorId === 'blue');
  fake.answer.inputBox = () => 'Bugs';

  await fake.vscode.commands.executeCommand('claudeTabs.moveToGroup');

  assert.deepEqual(tree(provider), [['Bugs', ['Fix login']]]);
  assert.equal(fake.globalStateData[STATE_KEY].groups[0].color, 'blue');
});

test('a tab keeps its group when Claude Code retitles it', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { 'Claude Code': 'g1' } } });
  const tab = fake.openTab('Claude Code');
  const provider = activate();

  fake.retitle(tab, 'Fix flaky spec');
  await tick();

  assert.deepEqual(tree(provider), [['Bugs', ['Fix flaky spec']]]);
  assert.deepEqual(fake.globalStateData[STATE_KEY].assignments, { 'Fix flaky spec': 'g1' });
});

test('Delete Group leaves its tabs open and ungrouped', async () => {
  start({ state: { groups: [{ id: 'g1', name: 'Bugs', color: 'red' }], assignments: { a: 'g1' } } });
  fake.openTab('a');
  const provider = activate();
  fake.answer.warning = () => 'Delete';

  await fake.vscode.commands.executeCommand('claudeTabs.deleteGroup', sectionNamed(provider, 'Bugs'));

  assert.deepEqual(tree(provider), [['Ungrouped', ['a']]]);
  assert.deepEqual(fake.layout(), [['a']]);
});

test('clicking a tab focuses its split and selects it', async () => {
  start();
  fake.openTab('a');
  fake.openTab('b', { split: 1 });
  fake.openTab('c', { split: 1 });
  const provider = activate();

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'b'));

  const active = fake.vscode.window.tabGroups.activeTabGroup;
  assert.equal(active.viewColumn, 2);
  assert.equal(active.activeTab.label, 'b');
});

test('Rename Tab focuses the tab before running Claude Code\'s rename', async () => {
  start();
  fake.openTab('a');
  fake.openTab('Untitled', { split: 1 });
  fake.openTab('c');
  const provider = activate();
  let renamed;
  fake.handlers['claude-vscode.renameSessionTab'] = () => {
    renamed = fake.vscode.window.tabGroups.activeTabGroup.activeTab.label;
  };

  await fake.vscode.commands.executeCommand('claudeTabs.renameTab', tabNamed(provider, 'Untitled'));

  assert.equal(renamed, 'Untitled');
});

test('Rename Tab does nothing when the tab cannot be focused', async () => {
  start();
  fake.openTab('b', { split: 1 });
  fake.openTab('a');
  const provider = activate();
  fake.handlers['workbench.action.focusSecondEditorGroup'] = () => {};
  let renamed = false;
  fake.handlers['claude-vscode.renameSessionTab'] = () => {
    renamed = true;
  };

  await fake.vscode.commands.executeCommand('claudeTabs.renameTab', tabNamed(provider, 'b'));

  assert.equal(renamed, false);
  assert.match(fake.messages.at(-1)[1], /Could not switch/);
});

test('a link opens a Claude tab and puts it in the named group', async () => {
  start();
  fake.openTab('Claude Code');
  const provider = activate();
  fake.handlers['claude-vscode.primaryEditor.open'] = () => setTimeout(() => fake.openTab('Claude Code'), 10);

  await fake.uriHandler.handleUri({ path: '/open', query: 'group=PR%20Reviews&color=blue&prompt=%2Fpr-review%2041500' });

  const open = fake.executed.find(([id]) => id === 'claude-vscode.primaryEditor.open');
  assert.deepEqual(open, ['claude-vscode.primaryEditor.open', undefined, '/pr-review 41500']);
  assert.deepEqual(tree(provider), [
    ['PR Reviews', ['Claude Code']],
    ['Ungrouped', ['Claude Code']],
  ]);
  assert.equal(fake.globalStateData[STATE_KEY].groups[0].color, 'blue');
});

// Writes session transcripts into the test's Claude folder. Call after start().
function useSessions(titles) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [sessionId, title] of Object.entries(titles)) {
    files[sessionId] = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(files[sessionId], `${JSON.stringify({ type: 'ai-title', aiTitle: title })}\n`);
  }
  return files;
}

const twoGroups = (assignments) => ({
  groups: [
    { id: 'g1', name: 'Bugs', color: 'red' },
    { id: 'g2', name: 'Reviews', color: 'blue' },
  ],
  assignments,
});

test('the active tab\'s group color drives the editor title dot', async () => {
  start({ state: twoGroups({ a: 'g2' }) });
  fake.openTab('a');
  activate();
  assert.equal(fake.contexts['claudeTabs.activeGroupColor'], 'blue');

  fake.openTab('b');
  await tick();
  assert.equal(fake.contexts['claudeTabs.activeGroupColor'], '');
});

const lastReveal = () => fake.view.revealed.at(-1);

test('the sidebar selects the active Claude tab without taking focus', async () => {
  start({ state: twoGroups({ a: 'g1' }) });
  fake.openTab('a');
  fake.openTab('b', { split: 1 });
  const provider = activate();

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'a'));
  await tick();

  assert.equal(lastReveal().element.tab.label, 'a');
  assert.deepEqual(lastReveal().options, { select: true, focus: false });
  assert.equal(lastReveal().element, tabNamed(provider, 'a'));
  assert.equal(provider.getParent(lastReveal().element), sectionNamed(provider, 'Bugs'));
});

test('tree elements keep their identity across refreshes', () => {
  start({ state: twoGroups({ a: 'g1' }) });
  fake.openTab('a');
  const provider = activate();
  const before = tabNamed(provider, 'a');
  provider.refresh();
  assert.equal(tabNamed(provider, 'a'), before);
  assert.equal(provider.getTreeItem(before).id, provider.getTreeItem(tabNamed(provider, 'a')).id);
});

test('the sidebar does not open itself to show the active tab', async () => {
  start();
  fake.openTab('a');
  activate();
  fake.view.setVisible(false);
  fake.view.revealed.length = 0;

  fake.openTab('b');
  await tick();
  assert.equal(fake.view.revealed.length, 0);

  fake.view.setVisible(true);
  await tick();
  assert.equal(lastReveal().element.tab.label, 'b');
});

test('switching to a non-Claude editor leaves the selection alone', async () => {
  start();
  fake.openTab('a');
  activate();
  fake.view.revealed.length = 0;

  fake.openTab('notes.md', { viewType: null });
  await tick();

  assert.equal(fake.view.revealed.length, 0);
});

function hookEvents(...events) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'claude-tabs');
  fs.mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  fs.appendFileSync(
    path.join(dir, 'events.jsonl'),
    events.map(([session, event, extra = {}]) => JSON.stringify({ session, event, at: now, ...extra })).join('\n') + '\n',
  );
}

const icon = (provider, label) => provider.getTreeItem(tabNamed(provider, label)).iconPath;

test('tab icons show working, needs-you, and idle in the group color', async () => {
  start({ state: twoGroups({ busy: 'g1', asks: 'g1', quiet: 'g1' }) });
  const files = useSessions({ s1: 'busy', s2: 'asks', s3: 'quiet', s4: 'loose' });
  fake.openTab('busy');
  fake.openTab('asks');
  fake.openTab('quiet');
  fake.openTab('loose');
  const provider = activate();
  hookEvents(
    ['s1', 'UserPromptSubmit', { transcript: files.s1 }],
    ['s2', 'Notification', { transcript: files.s2, type: 'permission_prompt' }],
    ['s3', 'Stop', { transcript: files.s3 }],
    ['s4', 'UserPromptSubmit', { transcript: files.s4 }],
  );
  fake.setWindowFocused(false);

  await provider.pollStatus();

  assert.deepEqual(
    ['busy', 'asks', 'quiet'].map((label) => [icon(provider, label).id, icon(provider, label).color.id]),
    [
      ['loading~spin', 'charts.red'],
      ['circle-filled', 'charts.red'],
      ['circle-filled', 'charts.red'],
    ],
  );
  assert.equal(icon(provider, 'loose').id, 'loading~spin');
  assert.equal(icon(provider, 'loose').color, undefined);
  assert.match(provider.getTreeItem(sectionNamed(provider, 'Bugs')).description, /2 need you/);
});

test('tabs with no status yet show an empty circle in the group color', () => {
  start({ state: twoGroups({ a: 'g2' }) });
  fake.openTab('a');
  const provider = activate();
  assert.equal(icon(provider, 'a').id, 'circle-outline');
  assert.equal(icon(provider, 'a').color.id, 'charts.blue');
});

test('a tab that finishes while it is the active tab is clear right away, focus or not', async () => {
  start({ state: twoGroups({ done: 'g1' }) });
  const files = useSessions({ s1: 'done' });
  fake.openTab('done');
  const provider = activate();
  fake.setWindowFocused(false);
  hookEvents(['s1', 'Stop', { transcript: files.s1 }]);

  await provider.pollStatus();

  assert.equal(icon(provider, 'done').id, 'circle-outline');
});

test('a tab waiting for approval stays marked after you look at it', async () => {
  start({ state: twoGroups({ asks: 'g1' }) });
  const files = useSessions({ s1: 'asks' });
  fake.openTab('asks');
  const provider = activate();
  hookEvents(['s1', 'Notification', { transcript: files.s1, type: 'permission_prompt' }]);

  await provider.pollStatus();
  provider.refresh();

  assert.equal(icon(provider, 'asks').id, 'circle-filled');
});

test('group titles are colored through a file decoration', async () => {
  start({ state: twoGroups({}) });
  const provider = activate();
  const item = provider.getTreeItem(sectionNamed(provider, 'Reviews'));
  assert.equal(fake.decorations.provideFileDecoration(item.resourceUri).color.id, 'charts.blue');
  assert.equal(fake.decorations.provideFileDecoration(fake.vscode.Uri.parse('file:///x')), undefined);
});

test('Set Up Session Status adds the hooks, and Remove takes them out', async () => {
  start();
  activate();
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus' }));
  fake.answer.info = (message, options, ...items) => (items.includes('Add Hooks') ? 'Add Hooks' : undefined);

  await fake.vscode.commands.executeCommand('claudeTabs.setupStatus');
  const added = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(Object.keys(added.hooks).sort(), ['Notification', 'PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(added.model, 'opus');

  await fake.vscode.commands.executeCommand('claudeTabs.removeStatus');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'opus' });
});

test('Set Up Session Status changes nothing when you cancel', async () => {
  start();
  activate();
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.writeFileSync(settings, '{"model":"opus"}');

  await fake.vscode.commands.executeCommand('claudeTabs.setupStatus');

  assert.equal(fs.readFileSync(settings, 'utf8'), '{"model":"opus"}');
});

test('the setup offer does not show when the hooks are already there', async () => {
  start({ statusPrompt: true });
  await require('../src/hookSetup').install();
  activate();
  await tick(20);
  assert.equal(fake.messages.filter(([, m]) => /working or need you/.test(m)).length, 0);
});

test('the sidebar shows a setup row while session status is off, and drops it once set up', async () => {
  start({ state: twoGroups({}) });
  const provider = activate();
  await provider.checkStatusSetup();
  const [first] = provider.getChildren();
  const item = provider.getTreeItem(first);
  assert.match(item.label, /Set up session status/);
  assert.equal(item.command.command, 'claudeTabs.setupStatus');

  fake.answer.info = (message, options, ...items) => (items.includes('Add Hooks') ? 'Add Hooks' : undefined);
  await fake.vscode.commands.executeCommand('claudeTabs.setupStatus');

  assert.deepEqual(tree(provider).map(([label]) => label), ['Bugs', 'Reviews']);
});

test('tab rows show no split or active text', () => {
  start();
  fake.openTab('a');
  fake.openTab('b', { split: 1 });
  const provider = activate();
  assert.equal(provider.getTreeItem(tabNamed(provider, 'a')).description, undefined);
  assert.equal(provider.getTreeItem(tabNamed(provider, 'b')).description, undefined);
});

test('the + on a group opens a new Claude tab in that group', async () => {
  start({ state: twoGroups({}) });
  fake.openTab('older');
  const provider = activate();
  fake.handlers['claude-vscode.editor.open'] = () => setTimeout(() => fake.openTab('Claude Code'), 5);

  await fake.vscode.commands.executeCommand('claudeTabs.newTabInGroup', sectionNamed(provider, 'Reviews'));

  assert.deepEqual(tree(provider), [
    ['Bugs', []],
    ['Reviews', ['Claude Code']],
    ['Ungrouped', ['older']],
  ]);
});

test('the + on Ungrouped opens a new tab with no group, even if its title was grouped before', async () => {
  start({ state: twoGroups({ 'Claude Code': 'g1' }) });
  fake.openTab('older');
  const provider = activate();
  fake.handlers['claude-vscode.editor.open'] = () => setTimeout(() => fake.openTab('Claude Code'), 5);

  await fake.vscode.commands.executeCommand('claudeTabs.newTabInGroup', sectionNamed(provider, 'Ungrouped'));

  assert.deepEqual(tree(provider).at(-1), ['Ungrouped', ['older', 'Claude Code']]);
});

const hooks = () => require('../src/hookSetup');

function answerFirstStart(choice) {
  const asked = [];
  fake.answer.info = (message, ...rest) => {
    const options = typeof rest[0] === 'object' ? rest.shift() : undefined;
    if (rest.includes('Allow')) {
      asked.push({ options, items: rest });
      return choice;
    }
    return undefined;
  };
  return asked;
}

test('first start asks in a small notification: Allow or Don\'t Allow', async () => {
  start({ statusPrompt: true });
  const asked = answerFirstStart(undefined);
  activate();
  await tick(20);

  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].items, ['Allow', "Don't Allow"]);
  assert.equal(asked[0].options?.modal, undefined);
  assert.equal(await hooks().isInstalled(), false);
});

test('Allow adds the hooks right away', async () => {
  start({ statusPrompt: true });
  answerFirstStart('Allow');
  const provider = activate();
  await tick(20);

  assert.equal(await hooks().isInstalled(), true);
  assert.equal(provider.getChildren().some((e) => e.kind === 'setup'), false);
});

test('Don\'t Allow adds nothing and does not ask again', async () => {
  start({ statusPrompt: true });
  const asked = answerFirstStart("Don't Allow");
  activate();
  await tick(20);
  activeContext.subscriptions.forEach((d) => d.dispose?.());
  activate();
  await tick(20);

  assert.equal(asked.length, 1);
  assert.equal(await hooks().isInstalled(), false);
});

test('closing the notification without a choice asks again next start', async () => {
  start({ statusPrompt: true });
  const asked = answerFirstStart(undefined);
  activate();
  await tick(20);
  activeContext.subscriptions.forEach((d) => d.dispose?.());
  activate();
  await tick(20);

  assert.equal(asked.length, 2);
});

test('clicking into a finished tab clears its mark, and it stays clear after you leave', async () => {
  start({ state: twoGroups({ done: 'g1', other: 'g1' }) });
  const files = useSessions({ s1: 'done', s2: 'other' });
  fake.openTab('done');
  fake.openTab('other');
  const provider = activate();
  hookEvents(['s1', 'Stop', { transcript: files.s1 }], ['s2', 'Stop', { transcript: files.s2 }]);
  await provider.pollStatus();
  assert.equal(icon(provider, 'done').id, 'circle-filled');

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'done'));
  await tick(10);
  assert.equal(icon(provider, 'done').id, 'circle-outline');

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'other'));
  await tick(10);
  await provider.pollStatus();
  assert.equal(icon(provider, 'done').id, 'circle-outline');
});

test('switching into a finished tab clears its mark even when the editor says the window has no focus', async () => {
  start({ state: twoGroups({ done: 'g1', other: 'g1' }) });
  const files = useSessions({ s1: 'done', s2: 'other' });
  fake.openTab('done');
  fake.openTab('other');
  const provider = activate();
  fake.setWindowFocused(false);
  hookEvents(['s1', 'Stop', { transcript: files.s1 }]);
  await provider.pollStatus();
  assert.equal(icon(provider, 'done').id, 'circle-filled');

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'done'));
  await tick(10);
  assert.equal(icon(provider, 'done').id, 'circle-outline');

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'other'));
  await tick(10);
  await provider.pollStatus();
  assert.equal(icon(provider, 'done').id, 'circle-outline');
});

const children = (provider, name) => provider.getChildren(sectionNamed(provider, name));
const rows = (provider, name) =>
  children(provider, name).map((e) => [e.kind, provider.getTreeItem(e).label, provider.getTreeItem(e).description ?? '']);

test('closing a grouped tab in the editor keeps it in its group as a closed row, in place', async () => {
  start({ state: twoGroups({ a: 'g1', b: 'g1', c: 'g1' }) });
  const [, b] = ['a', 'b', 'c'].map((label) => fake.openTab(label));
  const provider = activate();

  await fake.vscode.window.tabGroups.close(b);
  await tick();

  assert.deepEqual(rows(provider, 'Bugs'), [['tab', 'a', ''], ['closed', 'b', 'closed'], ['tab', 'c', '']]);
  assert.equal(provider.getTreeItem(sectionNamed(provider, 'Bugs')).description, '3');
});

test('closing an ungrouped tab keeps it under Ungrouped as a closed row', async () => {
  start({ state: twoGroups({}) });
  fake.openTab('keep');
  const loose = fake.openTab('loose');
  const provider = activate();

  await fake.vscode.window.tabGroups.close(loose);
  await tick();

  assert.deepEqual(rows(provider, 'Ungrouped'), [['tab', 'keep', ''], ['closed', 'loose', 'closed']]);
});

test('an ungrouped closed row shows even when no ungrouped tab is open, and reopens there', async () => {
  start({ state: twoGroups({}) });
  useSessions({ 's-loose': 'loose' });
  const loose = fake.openTab('loose');
  const provider = activate();
  await fake.vscode.window.tabGroups.close(loose);
  await tick();
  assert.deepEqual(rows(provider, 'Ungrouped'), [['closed', 'loose', 'closed']]);
  fake.handlers['claude-vscode.editor.open'] = () => setTimeout(() => fake.openTab('loose'), 5);

  await fake.vscode.commands.executeCommand('claudeTabs.reopenTab', children(provider, 'Ungrouped')[0]);

  assert.deepEqual(rows(provider, 'Ungrouped'), [['tab', 'loose', '']]);
});

test('untitled new tabs are not kept when closed', async () => {
  start({ state: twoGroups({ 'Claude Code': 'g1' }) });
  fake.openTab('keep');
  const untitled = fake.openTab('Claude Code');
  const provider = activate();

  await fake.vscode.window.tabGroups.close(untitled);
  await tick();

  assert.deepEqual(rows(provider, 'Bugs'), []);
  assert.deepEqual(rows(provider, 'Ungrouped'), [['tab', 'keep', '']]);
});

test('the sidebar X on an ungrouped tab closes it without keeping a row', async () => {
  start({ state: twoGroups({}) });
  fake.openTab('keep');
  fake.openTab('loose');
  const provider = activate();

  await fake.vscode.commands.executeCommand('claudeTabs.closeTab', tabNamed(provider, 'loose'));
  await tick();

  assert.deepEqual(rows(provider, 'Ungrouped'), [['tab', 'keep', '']]);
});

test('clicking a closed row reopens its session in the same group and place', async () => {
  start({ state: twoGroups({ a: 'g1', b: 'g1', c: 'g1' }) });
  const files = useSessions({ 's-b': 'b' });
  const [, b] = ['a', 'b', 'c'].map((label) => fake.openTab(label));
  const provider = activate();
  hookEvents(['s-b', 'Stop', { transcript: files['s-b'] }]);
  await provider.pollStatus();
  await fake.vscode.window.tabGroups.close(b);
  await tick();
  assert.deepEqual(fake.globalStateData[STATE_KEY].closed.g1, [{ label: 'b', title: 'b', sessionId: 's-b' }]);
  fake.handlers['claude-vscode.editor.open'] = (sessionId) => setTimeout(() => fake.openTab(sessionId === 's-b' ? 'b' : '?'), 5);

  const closedRow = children(provider, 'Bugs').find((e) => e.kind === 'closed');
  await fake.vscode.commands.executeCommand(provider.getTreeItem(closedRow).command.command, closedRow);
  await tick();

  assert.deepEqual(rows(provider, 'Bugs').map(([kind, label]) => [kind, label]), [['tab', 'a'], ['tab', 'b'], ['tab', 'c']]);
  assert.deepEqual(fake.globalStateData[STATE_KEY].closed, {});
});

test('a closed row with no known session finds it by title when clicked', async () => {
  start({ state: twoGroups({ b: 'g1' }) });
  useSessions({ 's-found': 'b' });
  const b = fake.openTab('b');
  const provider = activate();
  await fake.vscode.window.tabGroups.close(b);
  await tick();
  let opened;
  fake.handlers['claude-vscode.editor.open'] = (sessionId) => {
    opened = sessionId;
    setTimeout(() => fake.openTab('b'), 5);
  };

  await fake.vscode.commands.executeCommand('claudeTabs.reopenTab', children(provider, 'Bugs')[0]);

  assert.equal(opened, 's-found');
  assert.deepEqual(rows(provider, 'Bugs').map(([kind]) => kind), ['tab']);
});

test('the sidebar X closes a tab and removes it from its group', async () => {
  start({ state: twoGroups({ a: 'g1', b: 'g1' }) });
  fake.openTab('a');
  fake.openTab('b');
  const provider = activate();

  await fake.vscode.commands.executeCommand('claudeTabs.closeTab', tabNamed(provider, 'b'));
  await tick();

  assert.deepEqual(fake.layout(), [['a']]);
  assert.deepEqual(rows(provider, 'Bugs').map(([, label]) => label), ['a']);
  assert.equal(sectionNamed(provider, 'Ungrouped'), undefined);
  assert.deepEqual(fake.globalStateData[STATE_KEY].closed, {});
});

test('the sidebar X on a closed row removes the row', async () => {
  start({ state: twoGroups({ a: 'g1' }) });
  const a = fake.openTab('a');
  const provider = activate();
  await fake.vscode.window.tabGroups.close(a);
  await tick();

  await fake.vscode.commands.executeCommand('claudeTabs.closeTab', children(provider, 'Bugs')[0]);

  assert.deepEqual(rows(provider, 'Bugs'), []);
});

test('moving a tab to another split does not leave a closed row behind', async () => {
  start({ state: twoGroups({ a: 'g1' }) });
  fake.openTab('a');
  fake.openTab('other', { split: 1 });
  const provider = activate();

  await fake.vscode.commands.executeCommand('claudeTabs.focusTab', tabNamed(provider, 'a'));
  await fake.vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: 2 });
  await tick();

  assert.deepEqual(rows(provider, 'Bugs'), [['tab', 'a', '']]);
});

test('reopening a session some other way puts it back in its group', async () => {
  start({ state: twoGroups({ b: 'g1' }) });
  const b = fake.openTab('b');
  const provider = activate();
  await fake.vscode.window.tabGroups.close(b);
  await tick();

  fake.openTab('b');
  await tick();

  assert.deepEqual(rows(provider, 'Bugs'), [['tab', 'b', '']]);
});

test('closed rows come back after a reload', async () => {
  start({ state: { ...twoGroups({ a: 'g1', b: 'g1' }), closed: { g1: [{ label: 'b', sessionId: 's-b' }] }, order: ['b', 'a'] } });
  fake.openTab('a');
  const provider = activate();
  assert.deepEqual(rows(provider, 'Bugs'), [['closed', 'b', 'closed'], ['tab', 'a', '']]);
});

test('a tab dropped on a closed row goes just above it', async () => {
  start({ state: twoGroups({ a: 'g1', b: 'g1', c: 'g1' }) });
  const [, b] = ['a', 'b', 'c'].map((label) => fake.openTab(label));
  const provider = activate();
  await fake.vscode.window.tabGroups.close(b);
  await tick();

  await dragAndDrop([tabNamed(provider, 'c')], children(provider, 'Bugs').find((e) => e.kind === 'closed'));

  assert.deepEqual(rows(provider, 'Bugs').map(([, label]) => label), ['a', 'c', 'b']);
});

test('a closed row whose tab is open again after a reload goes away', async () => {
  start({ state: { ...twoGroups({ a: 'g1' }), closed: { g1: [{ label: 'a', sessionId: 's-a' }] } } });
  fake.openTab('a');
  const provider = activate();
  await tick();
  assert.deepEqual(rows(provider, 'Bugs'), [['tab', 'a', '']]);
  assert.deepEqual(fake.globalStateData[STATE_KEY].closed, {});
});

const label = (provider, name) => provider.getTreeItem(tabNamed(provider, name)).label;

test('a shortened tab title shows the full session title from status tracking', async () => {
  start({ state: twoGroups({}) });
  const files = useSessions({ s1: 'Review PR #41500 and leave comments' });
  fake.openTab('Review PR #41500 and lea…');
  fake.openTab('short');
  const provider = activate();
  hookEvents(['s1', 'Stop', { transcript: files.s1 }]);

  await provider.pollStatus();

  assert.equal(label(provider, 'Review PR #41500 and lea…'), 'Review PR #41500 and leave comments');
  assert.equal(label(provider, 'short'), 'short');
});

test('a shortened tab title with no status yet is looked up in the session files', async () => {
  start({ state: twoGroups({}) });
  useSessions({ s1: 'Investigate the flaky   checkout\nspec on CI' });
  fake.openTab('Investigate the flaky ch…');
  const provider = activate();

  await provider.pollStatus();
  await tick(20);

  assert.equal(label(provider, 'Investigate the flaky ch…'), 'Investigate the flaky checkout spec on CI');
});

test('a closed row keeps the full title', async () => {
  start({ state: twoGroups({ 'Review PR #41500 and lea…': 'g1' }) });
  const files = useSessions({ s1: 'Review PR #41500 and leave comments' });
  const tab = fake.openTab('Review PR #41500 and lea…');
  const provider = activate();
  hookEvents(['s1', 'Stop', { transcript: files.s1 }]);
  await provider.pollStatus();

  await fake.vscode.window.tabGroups.close(tab);
  await tick();

  assert.deepEqual(rows(provider, 'Bugs'), [['closed', 'Review PR #41500 and leave comments', 'closed']]);
});

'use strict';

const vscode = require('vscode');
const { COLORS, UNGROUPED, colorById, GroupStore, buildSections } = require('./store');
const { displayStatus } = require('./status');
const { findSessionIds } = require('./sessions');
const { SessionTracker } = require('./tracker');
const hookSetup = require('./hookSetup');

const STATE_KEY = 'claudeTabs.state';
const COLOR_CONTEXT_KEY = 'claudeTabs.activeGroupColor';
const SEEN_KEY = 'claudeTabs.seen';
const STATUS_SETUP_ASKED_KEY = 'claudeTabs.statusSetupAsked';
const SEEN_KEEP_SECONDS = 7 * 24 * 60 * 60;
const STATUS_ICONS = { working: 'loading~spin', attention: 'circle-filled', idle: 'circle-outline' };
const STATUS_TEXT = {
  working: 'Claude is working',
  attention: 'Claude needs you, or finished and you have not looked yet',
};
const VIEW_ID = 'claudeTabs.tree';
const DRAG_MIME = 'application/vnd.code.tree.claudetabs.tree';
const FOCUS_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

function isClaudeTab(tab) {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('claudeVSCodePanel');
}

function splitsInOrder() {
  return [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);
}

function openClaudeTabs() {
  return splitsInOrder().flatMap((group) => group.tabs.filter(isClaudeTab));
}

// Claude Code's title for a tab before its first prompt. Such a tab has no session to reopen.
const UNTITLED = 'Claude Code';

const nowSeconds = () => Math.floor(Date.now() / 1000);

const isFocused = (tab) => vscode.window.tabGroups.activeTabGroup.activeTab === tab;


// Group titles get their color from a file decoration on this made-up URI.
function groupUri(groupId) {
  return vscode.Uri.parse(`claude-tabs:/group/${groupId}`);
}

function themeColor(colorId) {
  return new vscode.ThemeColor(colorById(colorId).themeColor);
}

function waitForNewClaudeTab(existing, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (tab) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(tab);
    };
    const subscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
      const tab = event.opened.find((t) => isClaudeTab(t) && !existing.has(t));
      if (tab) finish(tab);
    });
    const timer = setTimeout(() => finish(undefined), timeoutMs);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function waitUntil(predicate, timeoutMs) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await settle()) {
    if (predicate()) return true;
  }
  return predicate();
}

// No API activates another extension's webview tab, so focus its editor
// group and then open the editor at its index in that group.
async function focusTab(tab) {
  const group = tab.group;
  let index = group.tabs.indexOf(tab);
  if (index < 0) index = group.tabs.findIndex((t) => t.label === tab.label);
  const focusGroup = FOCUS_GROUP_COMMANDS[group.viewColumn - 1];
  if (index < 0 || !focusGroup) return false;
  await vscode.commands.executeCommand(focusGroup);
  await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
  return true;
}

async function focusAndWait(tab) {
  if (isFocused(tab)) return true;
  return (await focusTab(tab)) && waitUntil(() => isFocused(tab), 1000);
}

class TabManager {
  constructor(context) {
    this.context = context;
    this.lastLabel = new WeakMap();
    // Open tabs keep their group by identity; the label map restores it after a reload.
    this.liveGroup = new WeakMap();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'claudeTabs.moveToGroup';
    this.dropMimeTypes = [DRAG_MIME];
    this.dragMimeTypes = [DRAG_MIME];
    this.dragCount = 0;
    // Tree elements are reused by key, so selection and reveal keep working across refreshes.
    this.elements = new Map();
    this.tabKeys = new WeakMap();
    this.tabCount = 0;
    this.tracker = new SessionTracker(hookSetup.paths().events);
    this.tabSessions = new WeakMap();
    this.decorationEmitter = new vscode.EventEmitter();
    // Tabs closed with the sidebar X, which are not kept as closed rows.
    this.discarding = new WeakSet();
    this.log = vscode.window.createOutputChannel('Claude Code Tab Manager', { log: true });
    this.trackOpenTabs();
    this.lastOrder = this.displayOrder();
  }

  // Titles in the order the sidebar shows them. A closing tab is already gone
  // when the editor reports it, so its place comes from the last copy of this.
  displayOrder() {
    const store = this.load();
    return buildSections(store, openClaudeTabs(), (tab) => this.groupIdOf(store, tab))
      .flatMap((section) => section.items)
      .map((item) => item.label);
  }

  load() {
    return new GroupStore(this.context.globalState.get(STATE_KEY));
  }

  async mutate(fn) {
    const store = this.load();
    const result = fn(store);
    await this.context.globalState.update(STATE_KEY, store.toJSON());
    this.decorationEmitter.fire(store.groups.map((g) => groupUri(g.id)));
    this.refresh();
    return result;
  }

  refresh() {
    this.lastOrder = this.displayOrder();
    this.markActiveSeen();
    this.emitter.fire();
    this.updateStatusBar();
    this.revealIfActiveChanged();
  }

  // The label map is read once per tab, when the tab is first seen.
  trackOpenTabs() {
    const store = this.load();
    for (const tab of openClaudeTabs()) {
      if (!this.liveGroup.has(tab)) this.liveGroup.set(tab, store.groupIdFor(tab.label));
      this.lastLabel.set(tab, tab.label);
    }
  }

  // Session status

  async pollStatus() {
    if (this.polling) return;
    this.polling = true;
    try {
      if (await this.tracker.poll()) await this.tracker.refreshTitles();
      const tabs = openClaudeTabs();
      const ids = await this.tracker.matchWithRetry(tabs.map((tab) => tab.label));
      tabs.forEach((tab, i) => this.tabSessions.set(tab, ids[i]));
      const key = tabs.map((tab) => `${this.tabKey(tab)}:${this.statusOf(tab)}`).join('|');
      if (key !== this.statusKey) {
        this.statusKey = key;
        this.log.info(
          `status: ${tabs.map((tab, i) => `"${tab.label}" -> ${ids[i]?.slice(0, 8) ?? 'no session'} ${this.statusOf(tab)}`).join('; ')}`,
        );
        this.refresh();
      }
    } catch (error) {
      this.log.error(`status poll failed: ${error.stack ?? error}`);
    } finally {
      this.polling = false;
    }
  }

  statusOf(tab) {
    const id = this.tabSessions.get(tab);
    const seen = this.context.globalState.get(SEEN_KEY) ?? {};
    return displayStatus(this.tracker.session(id), seen[id], nowSeconds());
  }

  // A finished session counts as seen while its tab is the active tab. Window
  // focus is not checked: Cursor reports no focus while you type in a Claude chat.
  markActiveSeen() {
    const tab = this.activeClaudeTab();
    if (!tab) return;
    const id = this.tabSessions.get(tab);
    const session = this.tracker.session(id);
    const seen = this.context.globalState.get(SEEN_KEY) ?? {};
    if (session?.state !== 'done' || (seen[id] ?? 0) >= session.at) return;
    this.log.info(`marked "${tab.label}" (${id.slice(0, 8)}) seen`);
    const cutoff = nowSeconds() - SEEN_KEEP_SECONDS;
    const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => at > cutoff));
    this.context.globalState.update(SEEN_KEY, { ...kept, [id]: session.at });
  }

  groupDecoration(uri) {
    if (uri.scheme !== 'claude-tabs') return undefined;
    const group = this.load().getGroup(uri.path.replace(/^\/group\//, ''));
    return group ? new vscode.FileDecoration(undefined, undefined, themeColor(group.color)) : undefined;
  }

  async checkStatusSetup() {
    this.statusInstalled = await hookSetup.isInstalled();
    this.refresh();
    return this.statusInstalled;
  }

  async setupStatus() {
    const p = hookSetup.paths();
    const choice = await vscode.window.showInformationMessage(
      'Show which Claude tabs are working or need you?',
      {
        modal: true,
        detail:
          `Claude Tabs adds hooks to ${p.settings} for ${hookSetup.HOOK_EVENTS.join(', ')}. ` +
          `Each hook runs ${p.script}, which records only the session id, transcript path, event name, and time in ${p.events}. ` +
          'A backup of settings.json is saved next to it. Remove the hooks with "Claude Tabs: Remove Session Status Hooks".',
      },
      'Add Hooks',
    );
    if (choice === 'Add Hooks') await this.installStatus();
  }

  async installStatus() {
    try {
      await hookSetup.install();
    } catch (error) {
      return vscode.window.showErrorMessage(`Claude Tabs could not add the hooks: ${error.message}`);
    } finally {
      await this.checkStatusSetup();
    }
    const reload = await vscode.window.showInformationMessage(
      'Session status is on for Claude sessions that start from now on. Reload the window to include the tabs that are open now.',
      'Reload Window',
    );
    if (reload === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async removeStatus() {
    try {
      await hookSetup.uninstall();
    } catch (error) {
      return vscode.window.showErrorMessage(`Claude Tabs could not remove the hooks: ${error.message}`);
    } finally {
      await this.checkStatusSetup();
    }
    vscode.window.showInformationMessage('Claude Tabs removed its hooks from your Claude settings.');
  }

  // Asks once, in a notification. Closing it without a choice asks again next start.
  async offerStatusSetup() {
    if (await this.checkStatusSetup()) {
      await hookSetup.installScript();
      return;
    }
    if (this.context.globalState.get(STATUS_SETUP_ASKED_KEY)) return;
    const choice = await vscode.window.showInformationMessage(
      `Claude Code Tab Manager can show which Claude tabs are working or need you. This adds a few hooks to ${hookSetup.paths().settings} (a backup is saved first).`,
      'Allow',
      "Don't Allow",
    );
    if (!choice) return;
    await this.context.globalState.update(STATUS_SETUP_ASKED_KEY, true);
    if (choice === 'Allow') await this.installStatus();
  }

  // Claude Code retitles a tab after the first prompt; keep its group.
  // A tab closed in the editor stays in its group (or under Ungrouped) as a closed
  // row. When a tab with that title opens again, the row goes and the tab takes its place.
  async onTabsChanged(event) {
    const renames = [];
    for (const tab of event.changed) {
      const previous = this.lastLabel.get(tab);
      if (isClaudeTab(tab) && previous !== undefined && previous !== tab.label) renames.push([previous, tab.label]);
    }
    const store = this.load();
    const kept = event.closed
      .filter((tab) => isClaudeTab(tab) && tab.label !== UNTITLED && !this.discarding.has(tab))
      .map((tab) => {
        const groupId = this.groupIdOf(store, tab);
        return {
          groupId: store.getGroup(groupId) ? groupId : UNGROUPED,
          entry: { label: tab.label, sessionId: this.tabSessions.get(tab) },
        };
      });
    const reopened = event.opened.filter(isClaudeTab).map((tab) => tab.label);
    const orderBefore = this.lastOrder;
    this.trackOpenTabs();
    this.pollStatus();
    if (renames.length || kept.length || reopened.some((label) => store.findClosed(label) || kept.some((k) => k.entry.label === label))) {
      await this.mutate((s) => {
        renames.forEach(([from, to]) => s.renameLabel(from, to));
        kept.forEach(({ groupId, entry }) => s.keepClosed(groupId, entry));
        if (kept.length) s.setOrder([...orderBefore, ...s.order.filter((label) => !orderBefore.includes(label))]);
        reopened.forEach((label) => {
          const found = s.findClosed(label);
          if (found) s.removeClosed(found.groupId, label);
        });
      });
    } else {
      this.refresh();
    }
  }

  // Tabs that are open after a reload no longer need their closed rows.
  async reconcileClosed() {
    const open = new Set(openClaudeTabs().map((tab) => tab.label));
    const store = this.load();
    const stale = Object.entries(store.closed).flatMap(([groupId, list]) =>
      list.filter((e) => open.has(e.label)).map((e) => [groupId, e.label]),
    );
    if (stale.length) await this.mutate((s) => stale.forEach(([groupId, label]) => s.removeClosed(groupId, label)));
  }

  groupIdOf(store, tab) {
    return this.liveGroup.has(tab) ? this.liveGroup.get(tab) : store.groupIdFor(tab.label);
  }

  activeClaudeTab() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && isClaudeTab(tab) ? tab : undefined;
  }

  // Tree commands get (clicked, selection); palette and keybindings get nothing.
  targetElements(element, selection) {
    return selection?.length ? selection : element ? [element] : [];
  }

  targetTabs(element, selection) {
    const tabs = this.targetElements(element, selection)
      .filter((e) => e.kind === 'tab')
      .map((e) => e.tab);
    if (tabs.length || element) return tabs;
    const active = this.activeClaudeTab();
    return active ? [active] : [];
  }

  // TreeDataProvider

  getChildren(element) {
    if (!element) return this.buildTree();
    return element.children ?? [];
  }

  getParent(element) {
    return element.parent;
  }

  tabKey(tab) {
    if (!this.tabKeys.has(tab)) this.tabKeys.set(tab, `tab:${++this.tabCount}`);
    return this.tabKeys.get(tab);
  }

  buildTree() {
    const store = this.load();
    const previous = this.elements;
    this.elements = new Map();
    const element = (key, fields) => {
      const e = Object.assign(previous.get(key) ?? { key }, fields);
      this.elements.set(key, e);
      return e;
    };
    const sections = buildSections(store, openClaudeTabs(), (tab) => this.groupIdOf(store, tab));
    const setup = this.statusInstalled === false ? [element('status-setup', { kind: 'setup' })] : [];
    return [...setup, ...sections.map(({ group, tabs, closed, items }) => {
      const parent = element(group ? `group:${group.id}` : 'group:ungrouped', { kind: 'group', group, tabs, closed, items });
      parent.children = items.map((item) =>
        item.kind === 'tab'
          ? element(this.tabKey(item.tab), { kind: 'tab', tab: item.tab, group, parent })
          : element(`closed:${group ? group.id : 'ungrouped'}:${item.label}`, { kind: 'closed', entry: item.entry, group, parent }),
      );
      return parent;
    })];
  }

  // Selects the active Claude tab in the sidebar, like the Explorer does for
  // the active file. Never opens the sidebar or takes focus from the editor.
  async revealActiveTab() {
    const tab = this.activeClaudeTab();
    if (!tab || !this.view?.visible) return;
    this.buildTree();
    const element = this.elements.get(this.tabKey(tab));
    if (element) await this.view.reveal(element, { select: true, focus: false }).then(undefined, () => {});
  }

  revealIfActiveChanged() {
    const tab = this.activeClaudeTab();
    const key = tab && this.tabKey(tab);
    if (!key || key === this.revealedKey) return;
    this.revealedKey = key;
    this.revealActiveTab();
  }

  getTreeItem(element) {
    if (element.kind === 'setup') return this.setupItem();
    if (element.kind === 'group') return this.groupItem(element);
    if (element.kind === 'closed') return this.closedItem(element);
    return this.tabItem(element);
  }

  groupItem({ group, tabs, closed }) {
    const item = new vscode.TreeItem(group ? group.name : 'Ungrouped', vscode.TreeItemCollapsibleState.Expanded);
    item.id = group ? `group:${group.id}` : 'group:ungrouped';
    if (group) item.resourceUri = groupUri(group.id);
    const needYou = tabs.filter((tab) => this.statusOf(tab) === 'attention').length;
    item.description = [
      `${tabs.length + closed.length}`,
      needYou && `${needYou} need${needYou === 1 ? 's' : ''} you`,
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = group
      ? new vscode.ThemeIcon('circle-large-filled', themeColor(group.color))
      : new vscode.ThemeIcon('circle-large-outline');
    item.contextValue = group ? `group${tabs.length ? '.open' : ''}` : 'ungrouped';
    return item;
  }

  setupItem() {
    const item = new vscode.TreeItem('Set up session status', vscode.TreeItemCollapsibleState.None);
    item.id = 'status-setup';
    item.description = 'shows which tabs are working or need you';
    item.iconPath = new vscode.ThemeIcon('bell');
    item.tooltip = 'Session status is off. Click to add the Claude Code hooks it needs.';
    item.contextValue = 'setup';
    item.command = { command: 'claudeTabs.setupStatus', title: 'Set Up Session Status' };
    return item;
  }

  closedItem(element) {
    const { entry, group } = element;
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
    item.id = element.key;
    item.description = 'closed';
    item.iconPath = new vscode.ThemeIcon('circle-outline', group ? themeColor(group.color) : undefined);
    item.tooltip = [entry.label, group && `Group: ${group.name}`, 'Closed. Click to reopen it.'].filter(Boolean).join('\n');
    item.contextValue = 'closed';
    item.command = { command: 'claudeTabs.reopenTab', title: 'Reopen Tab', arguments: [element] };
    return item;
  }

  tabItem(element) {
    const { tab, group } = element;
    const item = new vscode.TreeItem(tab.label, vscode.TreeItemCollapsibleState.None);
    item.id = this.tabKey(tab);
    const status = this.statusOf(tab);
    item.iconPath = new vscode.ThemeIcon(STATUS_ICONS[status], group ? themeColor(group.color) : undefined);
    item.tooltip = [tab.label, group && `Group: ${group.name}`, STATUS_TEXT[status]].filter(Boolean).join('\n');
    item.contextValue = group ? 'tab.grouped' : 'tab';
    item.command = { command: 'claudeTabs.focusTab', title: 'Open Tab', arguments: [element] };
    return item;
  }

  // TreeDragAndDropController

  // VS Code serializes drag data to JSON, and Tab objects are circular, so the
  // transfer carries an id and the tabs stay here.
  handleDrag(source, dataTransfer) {
    const tabs = source.filter((e) => e.kind === 'tab').map((e) => e.tab);
    if (!tabs.length) return;
    this.drag = { id: String(++this.dragCount), tabs };
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(this.drag.id));
  }

  async handleDrop(target, dataTransfer) {
    const id = dataTransfer.get(DRAG_MIME)?.value;
    if (!id || id !== this.drag?.id || target?.kind === 'setup') return;
    const { tabs } = this.drag;
    this.drag = undefined;
    await this.dropTabs(tabs, target);
  }

  // A tab dropped on a tab goes just above it; dropped on a group, it goes to
  // the end of that group.
  async dropTabs(tabs, target) {
    if (target?.kind === 'tab' && tabs.includes(target.tab)) return;
    const groupId = target?.group?.id ?? UNGROUPED;
    const sections = this.getChildren().filter((e) => e.kind === 'group');
    const moving = (item) => item.kind === 'tab' && tabs.includes(item.tab);
    const rest = sections.flatMap((section) => section.items).filter((item) => !moving(item));
    let index;
    if (target?.kind === 'tab') {
      index = rest.findIndex((item) => item.kind === 'tab' && item.tab === target.tab);
    } else if (target?.kind === 'closed') {
      index = rest.findIndex((item) => item.kind === 'closed' && item.label === target.entry.label);
    } else {
      const section = sections.find((s) => (s.group?.id ?? UNGROUPED) === groupId);
      const last = [...(section?.items ?? [])].reverse().find((item) => !moving(item));
      index = last ? rest.indexOf(last) + 1 : rest.length;
    }
    rest.splice(index, 0, ...tabs.map((tab) => ({ kind: 'tab', tab, label: tab.label })));
    for (const tab of tabs) this.liveGroup.set(tab, groupId);
    await this.mutate((store) => {
      tabs.forEach((tab) => store.assign(tab.label, groupId));
      store.setOrder(rest.map((item) => item.label));
    });
  }

  // Actions

  async assignTabs(tabs, groupId) {
    for (const tab of tabs) this.liveGroup.set(tab, groupId);
    await this.mutate((store) => tabs.forEach((tab) => store.assign(tab.label, groupId)));
  }

  async promptColor(current, placeHolder) {
    const items = COLORS.map((c) => ({
      label: `${c.emoji} ${c.label}`,
      description: c.id === current ? 'current' : undefined,
      colorId: c.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    return pick?.colorId;
  }

  async createGroupInteractive() {
    const name = await vscode.window.showInputBox({
      prompt: 'New group name',
      validateInput: (value) => (value.trim() ? undefined : 'Enter a group name'),
    });
    if (name === undefined) return undefined;
    const suggested = this.load().nextColor();
    const color = (await this.promptColor(suggested, `Color for "${name.trim()}"`)) || suggested;
    return this.mutate((store) => store.createGroup(name, color));
  }

  async pickGroup(placeHolder, currentId) {
    const store = this.load();
    const items = store.groups.map((g) => ({
      label: `${colorById(g.color).emoji} ${g.name}`,
      description: g.id === currentId ? 'current' : undefined,
      groupId: g.id,
    }));
    items.push({ label: '$(add) New group…', create: true });
    if (currentId) items.push({ label: '$(close) Remove from group', groupId: UNGROUPED });
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    if (!pick) return undefined;
    if (pick.create) return (await this.createGroupInteractive())?.id;
    return pick.groupId;
  }

  async moveToGroup(element, selection) {
    const tabs = this.targetTabs(element, selection);
    if (!tabs.length) return vscode.window.showInformationMessage('Focus a Claude Code tab first.');
    const store = this.load();
    const currentId = tabs.length === 1 ? this.groupIdOf(store, tabs[0]) : undefined;
    const placeHolder = tabs.length === 1 ? `Move "${tabs[0].label}" to group` : `Move ${tabs.length} tabs to group`;
    const groupId = await this.pickGroup(placeHolder, currentId);
    if (groupId) await this.assignTabs(tabs, groupId);
  }

  async removeFromGroup(element, selection) {
    await this.forgetClosed(element, selection);
    const tabs = this.targetTabs(element, selection);
    if (tabs.length) await this.assignTabs(tabs, UNGROUPED);
  }

  async forgetClosed(element, selection) {
    const rows = this.targetElements(element, selection).filter((e) => e.kind === 'closed');
    if (rows.length) {
      await this.mutate((store) => rows.forEach((e) => store.removeClosed(e.group?.id ?? UNGROUPED, e.entry.label)));
    }
  }

  async reopenTab(element) {
    const { entry, group } = element ?? {};
    if (!entry) return;
    const groupId = group?.id ?? UNGROUPED;
    const sessionId = entry.sessionId ?? (await findSessionIds([entry.label]))[0];
    if (!sessionId) {
      return vscode.window.showWarningMessage(`Claude Tabs could not find the Claude session for "${entry.label}".`);
    }
    const newTab = waitForNewClaudeTab(new Set(openClaudeTabs()), 15000);
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId);
    const tab = await newTab;
    if (!tab) return vscode.window.showWarningMessage(`Claude Tabs: "${entry.label}" did not reopen.`);
    this.liveGroup.set(tab, groupId);
    await this.mutate((store) => {
      store.removeClosed(groupId, entry.label);
      store.renameLabel(entry.label, tab.label);
      store.assign(tab.label, groupId);
    });
  }

  async focus(element) {
    if (!(await focusTab(element.tab))) {
      vscode.window.showWarningMessage(`Could not switch to "${element.tab.label}".`);
    }
  }

  // Claude Code renames only the focused session tab, and saves the name to the session.
  async renameTab(element) {
    const [tab] = this.targetTabs(element);
    if (!tab) return vscode.window.showInformationMessage('Focus a Claude Code tab first.');
    if (!isFocused(tab)) {
      if (!(await focusAndWait(tab))) {
        return vscode.window.showWarningMessage(`Could not switch to "${tab.label}" to rename it.`);
      }
      await settle();
    }
    await vscode.commands.executeCommand('claude-vscode.renameSessionTab');
  }

  // The sidebar X takes a tab out of its group and does not keep it as a closed row.
  async closeTabs(element, selection) {
    await this.forgetClosed(element, selection);
    const tabs = this.targetTabs(element, selection);
    if (!tabs.length) return;
    for (const tab of tabs) this.discarding.add(tab);
    await this.assignTabs(tabs, UNGROUPED);
    await vscode.window.tabGroups.close(tabs);
  }

  async renameGroup(element) {
    const group = element?.group;
    if (!group) return;
    const name = await vscode.window.showInputBox({
      prompt: 'Rename group',
      value: group.name,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a group name'),
    });
    if (name !== undefined) await this.mutate((store) => store.renameGroup(group.id, name));
  }

  async changeColor(element) {
    const group = element?.group;
    if (!group) return;
    const color = await this.promptColor(group.color, `Color for "${group.name}"`);
    if (color) await this.mutate((store) => store.setColor(group.id, color));
  }

  async deleteGroup(element) {
    const group = element?.group;
    if (!group) return;
    const detail = element.tabs.length ? `Its ${element.tabs.length} open tab(s) stay open and become ungrouped.` : undefined;
    const ok = await vscode.window.showWarningMessage(`Delete group "${group.name}"?`, { modal: true, detail }, 'Delete');
    if (ok === 'Delete') await this.mutate((store) => store.deleteGroup(group.id));
  }

  async moveGroup(element, delta) {
    if (element?.group) await this.mutate((store) => store.moveGroup(element.group.id, delta));
  }

  async closeGroupTabs(element) {
    if (!element?.tabs.length) return;
    const name = element.group ? `"${element.group.name}"` : 'Ungrouped';
    const ok = await vscode.window.showWarningMessage(
      `Close all ${element.tabs.length} tab(s) in ${name}?`,
      { modal: true, detail: 'They stay in the group as closed tabs. Click one to reopen it.' },
      'Close Tabs',
    );
    if (ok === 'Close Tabs') await vscode.window.tabGroups.close(element.tabs);
  }

  async newTabInGroup(element) {
    const groupId = element?.group?.id ?? UNGROUPED;
    const newTab = waitForNewClaudeTab(new Set(openClaudeTabs()), 15000);
    await vscode.commands.executeCommand('claude-vscode.editor.open');
    const tab = await newTab;
    if (!tab) return vscode.window.showWarningMessage('Claude Tabs: no new Claude tab appeared.');
    await this.assignTabs([tab], groupId);
  }

  // <scheme>://araadshams.claude-tab-manager/open?group=<name>&prompt=<text>[&session=<id>][&color=<color>]
  async handleUri(uri) {
    if (uri.path !== '/open') return;
    const params = new URLSearchParams(uri.query);
    const groupName = params.get('group')?.trim();
    const session = params.get('session') ?? undefined;
    const prompt = params.get('prompt') ?? undefined;

    const existing = new Set(openClaudeTabs());
    const newTab = waitForNewClaudeTab(existing, 15000);
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', session, prompt);
    if (!groupName) return;

    // Opening an existing session focuses its tab instead of opening a new one.
    const tab = (await newTab) ?? (session ? this.activeClaudeTab() : undefined);
    if (!tab) return vscode.window.showWarningMessage(`Claude Tabs: no new Claude tab appeared to add to "${groupName}".`);
    const group = await this.mutate((store) => store.ensureGroup(groupName, params.get('color')));
    await this.assignTabs([tab], group.id);
  }

  // The editor title bar shows a dot in the group's color through this context key.
  updateStatusBar() {
    const tab = this.activeClaudeTab();
    const store = this.load();
    const group = tab && store.getGroup(this.groupIdOf(store, tab));
    const color = group ? group.color : '';
    if (color !== this.contextColor) {
      this.contextColor = color;
      vscode.commands.executeCommand('setContext', COLOR_CONTEXT_KEY, color);
    }
    if (!tab) return this.status.hide();
    this.status.text = group ? `$(circle-filled) ${group.name}` : '$(circle-outline) No group';
    this.status.color = group ? themeColor(group.color) : undefined;
    this.status.tooltip = 'Claude tab group. Click to change.';
    this.status.show();
  }
}

function activate(context) {
  const manager = new TabManager(context);
  const view = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: manager,
    dragAndDropController: manager,
    canSelectMany: true,
  });
  manager.view = view;

  const commands = {
    'claudeTabs.newGroup': () => manager.createGroupInteractive(),
    'claudeTabs.moveToGroup': (e, s) => manager.moveToGroup(e, s),
    'claudeTabs.removeFromGroup': (e, s) => manager.removeFromGroup(e, s),
    'claudeTabs.focusTab': (e) => manager.focus(e),
    'claudeTabs.closeTab': (e, s) => manager.closeTabs(e, s),
    'claudeTabs.reopenTab': (e) => manager.reopenTab(e),
    'claudeTabs.renameTab': (e) => manager.renameTab(e),
    'claudeTabs.renameGroup': (e) => manager.renameGroup(e),
    'claudeTabs.changeColor': (e) => manager.changeColor(e),
    'claudeTabs.deleteGroup': (e) => manager.deleteGroup(e),
    'claudeTabs.moveGroupUp': (e) => manager.moveGroup(e, -1),
    'claudeTabs.moveGroupDown': (e) => manager.moveGroup(e, 1),
    'claudeTabs.closeGroupTabs': (e) => manager.closeGroupTabs(e),
    'claudeTabs.newTabInGroup': (e) => manager.newTabInGroup(e),
    'claudeTabs.setupStatus': () => manager.setupStatus(),
    'claudeTabs.removeStatus': () => manager.removeStatus(),
  };
  for (const color of COLORS) commands[`claudeTabs.groupDot.${color.id}`] = () => manager.moveToGroup();

  context.subscriptions.push(
    view,
    manager.status,
    manager.emitter,
    vscode.window.tabGroups.onDidChangeTabs((e) => manager.onTabsChanged(e)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => manager.refresh()),
    vscode.window.registerUriHandler({ handleUri: (uri) => manager.handleUri(uri) }),
    view.onDidChangeVisibility(({ visible }) => visible && manager.revealActiveTab()),
    manager.decorationEmitter,
    manager.log,
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: manager.decorationEmitter.event,
      provideFileDecoration: (uri) => manager.groupDecoration(uri),
    }),
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(id, fn)),
  );
  manager.updateStatusBar();
  manager.revealIfActiveChanged();
  manager.reconcileClosed();

  const timer = setInterval(() => manager.pollStatus(), 1000);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  manager.tracker.compact().then(() => manager.pollStatus());
  manager.offerStatusSetup();
}

function deactivate() {}

module.exports = { activate, deactivate };

'use strict';

// A small stand-in for the parts of the VS Code API the extension uses. Tab
// and group objects are built from getters like the real ones, so they are
// circular and fail JSON.stringify the same way.

const Module = require('module');

const CLAUDE_VIEW_TYPE = 'mainThreadWebview-claudeVSCodePanel';

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener) >>> 0, 1) };
    };
  }
  fire(event) {
    [...this.listeners].forEach((l) => l(event));
  }
  dispose() {
    this.listeners = [];
  }
}

class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}

class DataTransferItem {
  constructor(value) {
    this.value = value;
  }
  async asString() {
    return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
  }
}

class DataTransfer {
  constructor() {
    this.items = new Map();
  }
  get(mime) {
    return this.items.get(mime);
  }
  set(mime, item) {
    this.items.set(mime, item);
  }
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }
}

const fake = {};

function reset() {
  const groups = [];
  let activeGroup;
  const tabEvents = new EventEmitter();
  const groupEvents = new EventEmitter();
  const windowStateEvents = new EventEmitter();
  const windowState = { focused: true };

  function groupApi(g) {
    return (g.api ??= {
      get viewColumn() {
        return groups.indexOf(g) + 1;
      },
      get isActive() {
        return activeGroup === g;
      },
      get tabs() {
        return g.tabs.map((t) => t.api);
      },
      get activeTab() {
        return g.active?.api;
      },
    });
  }

  function makeTab(g, label, input) {
    const t = { label, input, group: g };
    t.api = {
      get label() {
        return t.label;
      },
      get input() {
        return t.input;
      },
      get isActive() {
        return t.group.active === t;
      },
      get group() {
        return groupApi(t.group);
      },
    };
    return t;
  }

  const stateOf = (api) => groups.flatMap((g) => g.tabs).find((t) => t.api === api);

  function newGroup(index = groups.length) {
    const g = { tabs: [], active: undefined };
    groups.splice(index, 0, g);
    groupEvents.fire({ opened: [groupApi(g)], closed: [], changed: [] });
    return g;
  }

  function removeTab(t) {
    const g = t.group;
    const i = g.tabs.indexOf(t);
    g.tabs.splice(i, 1);
    if (g.active === t) g.active = g.tabs[Math.min(i, g.tabs.length - 1)];
    tabEvents.fire({ opened: [], closed: [t.api], changed: [] });
    if (!g.tabs.length && groups.length > 1) {
      groups.splice(groups.indexOf(g), 1);
      if (activeGroup === g) activeGroup = groups[0];
      groupEvents.fire({ opened: [], closed: [groupApi(g)], changed: [] });
    }
  }

  function addTab(g, label, input) {
    const t = makeTab(g, label, input);
    g.tabs.push(t);
    g.active = t;
    activeGroup = g;
    tabEvents.fire({ opened: [t.api], closed: [], changed: [] });
    return t.api;
  }

  // Moving a tab closes it and opens a new tab object in the target group.
  function moveTab(t, target) {
    if (t.group === target) return;
    const { label, input } = t;
    removeTab(t);
    addTab(target, label, input);
  }

  const workbench = {
    'workbench.action.openEditorAtIndex': (index) => {
      const g = activeGroup;
      if (g?.tabs[index]) {
        g.active = g.tabs[index];
        tabEvents.fire({ opened: [], closed: [], changed: [g.active.api] });
      }
    },
    moveActiveEditor: ({ to, by, value }) => {
      const source = activeGroup;
      const t = source?.active;
      if (!t || by !== 'group') return;
      let target;
      if (to === 'position') target = groups[(value ?? 1) - 1];
      if (to === 'last') target = groups[groups.length - 1];
      if (to === 'right') target = groups[groups.indexOf(source) + 1] ?? newGroup(groups.indexOf(source) + 1);
      if (target) moveTab(t, target);
    },
  };
  ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].forEach((n, i) => {
    workbench[`workbench.action.focus${n}EditorGroup`] = () => {
      if (groups[i]) activeGroup = groups[i];
    };
  });

  Object.assign(fake, {
    groups,
    executed: [],
    messages: [],
    registered: {},
    // Per-test responders for prompts and for commands owned by other extensions.
    answer: { quickPick: () => undefined, inputBox: () => undefined, warning: () => undefined, info: () => undefined },
    decorations: undefined,
    setWindowFocused(focused) {
      windowState.focused = focused;
      windowStateEvents.fire({ focused });
    },
    handlers: {},
    contexts: {},
    treeView: undefined,
    uriHandler: undefined,
    globalStateData: {},

    split(index = groups.length) {
      return newGroup(index);
    },
    openTab(label, { split = 0, viewType = CLAUDE_VIEW_TYPE } = {}) {
      while (groups.length <= split) newGroup();
      return addTab(groups[split], label, viewType ? new TabInputWebview(viewType) : new TabInputText(label));
    },
    retitle(api, label) {
      stateOf(api).label = label;
      tabEvents.fire({ opened: [], closed: [], changed: [api] });
    },
    layout() {
      return groups.map((g) => g.tabs.map((t) => t.label));
    },
    // Bound to this test's storage, so work an earlier test left running
    // cannot read or write the next test's state.
    context() {
      const data = fake.globalStateData;
      return {
        subscriptions: [],
        globalState: {
          get: (k) => data[k],
          update: async (k, v) => {
            data[k] = JSON.parse(JSON.stringify(v));
          },
        },
      };
    },
  });

  fake.vscode = {
    EventEmitter,
    TabInputWebview,
    TabInputText,
    DataTransfer,
    DataTransferItem,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileDecoration: class {
      constructor(badge, tooltip, color) {
        Object.assign(this, { badge, tooltip, color });
      }
    },
    Uri: {
      parse: (text) => {
        const url = new URL(text);
        return { scheme: url.protocol.slice(0, -1), path: url.pathname, toString: () => text };
      },
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      state: windowState,
      onDidChangeWindowState: windowStateEvents.event,
      registerFileDecorationProvider: (provider) => {
        fake.decorations = provider;
        return { dispose() {} };
      },
      showErrorMessage: async (message) => {
        fake.messages.push(['error', message]);
      },
      tabGroups: {
        get all() {
          return groups.map(groupApi);
        },
        get activeTabGroup() {
          return groupApi(activeGroup ?? groups[0] ?? newGroup());
        },
        onDidChangeTabs: tabEvents.event,
        onDidChangeTabGroups: groupEvents.event,
        close: async (tabs) => {
          for (const api of [].concat(tabs)) {
            const t = stateOf(api);
            if (t) removeTab(t);
          }
          return true;
        },
      },
      createOutputChannel: () => {
        fake.log = [];
        const write = (level) => (message) => fake.log.push(`${level} ${message}`);
        return { info: write('info'), warn: write('warn'), error: write('error'), dispose() {} };
      },
      createStatusBarItem: () => ({ show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
      createTreeView: (id, options) => {
        fake.treeView = options;
        const visibility = new EventEmitter();
        const view = {
          visible: true,
          revealed: [],
          onDidChangeVisibility: visibility.event,
          setVisible(visible) {
            this.visible = visible;
            visibility.fire({ visible });
          },
          reveal: async (element, revealOptions) => {
            view.revealed.push({ element, options: revealOptions });
          },
          dispose() {},
        };
        fake.view = view;
        return view;
      },
      registerUriHandler: (handler) => {
        fake.uriHandler = handler;
        return { dispose() {} };
      },
      showQuickPick: async (items, options) => fake.answer.quickPick(items, options),
      showInputBox: async (options) => fake.answer.inputBox(options),
      showInformationMessage: async (message, ...rest) => {
        fake.messages.push(['info', message]);
        return fake.answer.info(message, ...rest);
      },
      showWarningMessage: async (message, ...rest) => {
        fake.messages.push(['warn', message]);
        return fake.answer.warning(message, ...rest);
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        fake.registered[id] = fn;
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        fake.executed.push([id, ...args]);
        if (id === 'setContext') {
          fake.contexts[args[0]] = args[1];
          return undefined;
        }
        const fn = fake.handlers[id] ?? workbench[id] ?? fake.registered[id];
        return fn?.(...args);
      },
    },
  };
}

// The extension holds on to the module object it required, so tests swap the
// contents in place instead of replacing it.
const vscodeProxy = new Proxy({}, { get: (_, key) => fake.vscode[key] });
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'vscode' ? vscodeProxy : originalLoad.call(this, request, ...rest);
};

// Mirrors VS Code: drag data is serialized when the drag starts, and a drop in
// the same tree gets the original items back.
async function dragAndDrop(sources, target) {
  const controller = fake.treeView.dragAndDropController;
  const transfer = new DataTransfer();
  await controller.handleDrag(sources, transfer, {});
  for (const [, item] of transfer) await item.asString();
  await controller.handleDrop(target, transfer, {});
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

reset();

module.exports = { fake, reset, dragAndDrop, tick, CLAUDE_VIEW_TYPE };

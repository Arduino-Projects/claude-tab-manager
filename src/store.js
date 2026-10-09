'use strict';

const COLORS = [
  { id: 'red', label: 'Red', themeColor: 'charts.red', emoji: '🔴' },
  { id: 'orange', label: 'Orange', themeColor: 'charts.orange', emoji: '🟠' },
  { id: 'yellow', label: 'Yellow', themeColor: 'charts.yellow', emoji: '🟡' },
  { id: 'green', label: 'Green', themeColor: 'charts.green', emoji: '🟢' },
  { id: 'blue', label: 'Blue', themeColor: 'charts.blue', emoji: '🔵' },
  { id: 'purple', label: 'Purple', themeColor: 'charts.purple', emoji: '🟣' },
];

const UNGROUPED = '__ungrouped__';

function colorById(id) {
  return COLORS.find((c) => c.id === id) || COLORS[0];
}

function defaultIdFactory() {
  return `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// Groups are ordered. Assignments map a tab label to a group id, because a
// tab label is the only identity that survives a window reload.
class GroupStore {
  constructor(raw, idFactory = defaultIdFactory) {
    this.groups = Array.isArray(raw?.groups) ? raw.groups.map((g) => ({ ...g })) : [];
    this.assignments = { ...(raw?.assignments || {}) };
    // Sidebar order of tabs, by label. Tabs not listed follow in editor order.
    this.order = Array.isArray(raw?.order) ? [...raw.order] : [];
    this.idFactory = idFactory;
    this.prune();
  }

  toJSON() {
    return { groups: this.groups, assignments: this.assignments, order: this.order };
  }

  getGroup(id) {
    return this.groups.find((g) => g.id === id);
  }

  nextColor() {
    return COLORS[this.groups.length % COLORS.length].id;
  }

  createGroup(name, color = this.nextColor()) {
    const group = { id: this.idFactory(), name: name.trim(), color: colorById(color).id };
    this.groups.push(group);
    return group;
  }

  findGroupByName(name) {
    const wanted = name.trim().toLowerCase();
    return this.groups.find((g) => g.name.toLowerCase() === wanted);
  }

  ensureGroup(name, color) {
    return this.findGroupByName(name) || this.createGroup(name, COLORS.some((c) => c.id === color) ? color : undefined);
  }

  renameGroup(id, name) {
    const group = this.getGroup(id);
    if (group) group.name = name.trim();
  }

  setColor(id, color) {
    const group = this.getGroup(id);
    if (group) group.color = colorById(color).id;
  }

  deleteGroup(id) {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.prune();
  }

  moveGroup(id, delta) {
    const from = this.groups.findIndex((g) => g.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= this.groups.length) return;
    const [group] = this.groups.splice(from, 1);
    this.groups.splice(to, 0, group);
  }

  assign(label, groupId) {
    if (!groupId || groupId === UNGROUPED || !this.getGroup(groupId)) {
      delete this.assignments[label];
    } else {
      this.assignments[label] = groupId;
    }
  }

  groupIdFor(label) {
    return this.assignments[label];
  }

  renameLabel(oldLabel, newLabel) {
    if (oldLabel === newLabel) return;
    this.order = this.order.map((label) => (label === oldLabel ? newLabel : label));
    if (!(oldLabel in this.assignments)) return;
    this.assignments[newLabel] = this.assignments[oldLabel];
    delete this.assignments[oldLabel];
  }

  setOrder(labels) {
    this.order = [...labels];
  }

  prune() {
    const ids = new Set(this.groups.map((g) => g.id));
    for (const [label, id] of Object.entries(this.assignments)) {
      if (!ids.has(id)) delete this.assignments[label];
    }
  }
}

// Returns the sections the tree shows: every group in order (also when it is
// empty), then an "Ungrouped" section when any tab has no group.
function buildSections(store, tabs, groupIdOf) {
  const sections = store.groups.map((group) => ({ group, tabs: [] }));
  const byId = new Map(sections.map((s) => [s.group.id, s]));
  const ungrouped = [];
  for (const tab of tabs) {
    const section = byId.get(groupIdOf(tab));
    (section ? section.tabs : ungrouped).push(tab);
  }
  if (ungrouped.length) sections.push({ group: null, tabs: ungrouped });
  const rank = (tab) => {
    const index = store.order.indexOf(tab.label);
    return index < 0 ? Infinity : index;
  };
  for (const section of sections) section.tabs.sort((a, b) => rank(a) - rank(b));
  return sections;
}

module.exports = { COLORS, UNGROUPED, colorById, GroupStore, buildSections };

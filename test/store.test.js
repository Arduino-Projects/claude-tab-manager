'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GroupStore, buildSections, UNGROUPED } = require('../src/store');

function newStore(raw) {
  let n = 0;
  return new GroupStore(raw, () => `g${++n}`);
}

test('createGroup cycles through the palette', () => {
  const store = newStore();
  const a = store.createGroup(' Bugs ');
  const b = store.createGroup('Reviews');
  assert.equal(a.name, 'Bugs');
  assert.equal(a.color, 'red');
  assert.equal(b.color, 'orange');
});

test('assign, move between groups, and remove', () => {
  const store = newStore();
  const a = store.createGroup('A');
  const b = store.createGroup('B');
  store.assign('Fix login', a.id);
  assert.equal(store.groupIdFor('Fix login'), a.id);
  store.assign('Fix login', b.id);
  assert.equal(store.groupIdFor('Fix login'), b.id);
  store.assign('Fix login', UNGROUPED);
  assert.equal(store.groupIdFor('Fix login'), undefined);
});

test('ensureGroup reuses a group by case-insensitive name', () => {
  const store = newStore();
  const reviews = store.createGroup('PR Reviews', 'blue');
  assert.equal(store.ensureGroup(' pr reviews ', 'green'), reviews);
  assert.equal(reviews.color, 'blue');
  assert.equal(store.groups.length, 1);
});

test('ensureGroup creates a missing group with the given or next color', () => {
  const store = newStore();
  assert.equal(store.ensureGroup('Bugs', 'purple').color, 'purple');
  assert.equal(store.ensureGroup('Spikes', 'not-a-color').color, 'orange');
});

test('assign to an unknown group removes the assignment', () => {
  const store = newStore();
  store.assign('x', 'nope');
  assert.deepEqual(store.assignments, {});
});

test('deleteGroup drops its assignments but keeps others', () => {
  const store = newStore();
  const a = store.createGroup('A');
  const b = store.createGroup('B');
  store.assign('one', a.id);
  store.assign('two', b.id);
  store.deleteGroup(a.id);
  assert.deepEqual(store.groups.map((g) => g.id), [b.id]);
  assert.deepEqual(store.assignments, { two: b.id });
});

test('renameLabel carries the assignment to the new title', () => {
  const store = newStore();
  const a = store.createGroup('A');
  store.assign('New session', a.id);
  store.renameLabel('New session', 'Fix flaky spec');
  assert.deepEqual(store.assignments, { 'Fix flaky spec': a.id });
});

test('moveGroup reorders and ignores out-of-range moves', () => {
  const store = newStore();
  const a = store.createGroup('A');
  const b = store.createGroup('B');
  store.moveGroup(b.id, -1);
  assert.deepEqual(store.groups.map((g) => g.name), ['B', 'A']);
  store.moveGroup(b.id, -1);
  assert.deepEqual(store.groups.map((g) => g.name), ['B', 'A']);
});

test('round-trips through JSON and prunes dangling assignments', () => {
  const store = newStore({
    groups: [{ id: 'g1', name: 'A', color: 'blue' }],
    assignments: { x: 'g1', y: 'gone' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(store)), {
    groups: [{ id: 'g1', name: 'A', color: 'blue' }],
    assignments: { x: 'g1' },
    order: [],
    closed: {},
  });
});

test('buildSections keeps group order, empty groups, and an ungrouped tail', () => {
  const store = newStore();
  const a = store.createGroup('A');
  const b = store.createGroup('B');
  store.assign('t1', b.id);
  const tabs = [{ label: 't1' }, { label: 't2' }];
  const sections = buildSections(store, tabs, (t) => store.groupIdFor(t.label));
  assert.deepEqual(
    sections.map((s) => [s.group?.name ?? null, s.tabs.map((t) => t.label)]),
    [['A', []], ['B', ['t1']], [null, ['t2']]],
  );
  assert.equal(sections[0].group.id, a.id);
});

test('buildSections omits the ungrouped section when every tab has a group', () => {
  const store = newStore();
  const a = store.createGroup('A');
  const sections = buildSections(store, [{ label: 't' }], () => a.id);
  assert.equal(sections.length, 1);
});

test('buildSections orders tabs by the saved order, unknown tabs last in editor order', () => {
  const store = newStore();
  const a = store.createGroup('A');
  ['t1', 't2', 't3', 't4'].forEach((label) => store.assign(label, a.id));
  store.setOrder(['t3', 't1']);
  const tabs = ['t1', 't2', 't3', 't4'].map((label) => ({ label }));
  const [section] = buildSections(store, tabs, (t) => store.groupIdFor(t.label));
  assert.deepEqual(section.tabs.map((t) => t.label), ['t3', 't1', 't2', 't4']);
});

test('renameLabel keeps a tab in its place in the saved order', () => {
  const store = newStore();
  store.setOrder(['one', 'New session', 'two']);
  store.renameLabel('New session', 'Fix flaky spec');
  assert.deepEqual(store.order, ['one', 'Fix flaky spec', 'two']);
});

test('the saved order round-trips through JSON', () => {
  const store = newStore();
  store.setOrder(['b', 'a']);
  assert.deepEqual(newStore(JSON.parse(JSON.stringify(store))).order, ['b', 'a']);
});

test('closed tabs are kept per group, one per title, and move to Ungrouped with their group', () => {
  const store = newStore();
  const a = store.createGroup('A');
  store.keepClosed(a.id, { label: 'Fix login', sessionId: 's1' });
  store.keepClosed(a.id, { label: 'Fix login', sessionId: 's2' });
  assert.deepEqual(store.closedIn(a.id), [{ label: 'Fix login', sessionId: 's2' }]);
  assert.deepEqual(store.findClosed('Fix login'), { groupId: a.id, entry: { label: 'Fix login', sessionId: 's2' } });
  store.removeClosed(a.id, 'Fix login');
  assert.deepEqual(store.closedIn(a.id), []);
  store.keepClosed(a.id, { label: 'Other' });
  store.deleteGroup(a.id);
  assert.equal(store.findClosed('Other').groupId, UNGROUPED);
});

test('buildSections lists open and closed tabs together in the saved order', () => {
  const store = newStore();
  const a = store.createGroup('A');
  ['one', 'two', 'three'].forEach((label) => store.assign(label, a.id));
  store.keepClosed(a.id, { label: 'two', sessionId: 's2' });
  store.setOrder(['three', 'two', 'one']);
  const [section] = buildSections(store, [{ label: 'one' }, { label: 'three' }], (t) => store.groupIdFor(t.label));
  assert.deepEqual(section.items.map((i) => [i.kind, i.label]), [['tab', 'three'], ['closed', 'two'], ['tab', 'one']]);
  assert.deepEqual(section.tabs.map((t) => t.label), ['three', 'one']);
  assert.deepEqual(section.closed.map((c) => c.label), ['two']);
});

test('ungrouped closed tabs are kept, and deleting a group moves its closed tabs there', () => {
  const store = newStore();
  const a = store.createGroup('A');
  store.keepClosed(UNGROUPED, { label: 'loose' });
  store.keepClosed(a.id, { label: 'grouped', sessionId: 's1' });
  store.deleteGroup(a.id);
  assert.deepEqual(store.closedIn(UNGROUPED).map((e) => e.label), ['loose', 'grouped']);
  const sections = buildSections(store, [], () => undefined);
  assert.deepEqual(sections.map((s) => [s.group?.name ?? null, s.items.map((i) => i.label)]), [[null, ['loose', 'grouped']]]);
});

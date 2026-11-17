'use strict';
// Dependency-free tests: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { parseTasks, checkLine, displayText } = require('../src/task-discovery');
const { TaskStore } = require('../src/task-storage');
const { TaskIndex } = require('../src/task-index');

// ---- discovery ----------------------------------------------------------
test('discovers -, *, + open checkboxes only; skips done, code fences, front matter', () => {
  const md = ['---', '- [ ] in frontmatter', '---', '- [ ] a', '* [ ] b', '+ [ ] c', '- [x] done', '- [X] DONE',
    '```', '- [ ] fenced', '```', '~~~js', '- [ ] tilde fenced', '~~~', '- [ ] after', '- [ ]', '- [ ]no space'].join('\n');
  const open = parseTasks(md).filter((t) => !t.checked).map((t) => t.text);
  assert.deepStrictEqual(open, ['a', 'b', 'c', 'after']);
});
test('nested tasks, callouts and CRLF', () => {
  const t = parseTasks('- [ ] parent\r\n  - [ ] child\r\n> - [ ] quoted\r\n').filter((x) => !x.checked);
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[1].depth, 1);
  assert.strictEqual(t[1].parentText, 'parent');
  assert.strictEqual(t[2].text, 'quoted');
});
test('checkLine ticks only the target line and preserves everything else', () => {
  const md = '- [ ] a\r\n  - [ ] b\n- [ ] a\n';
  assert.strictEqual(checkLine(md, 1), '- [ ] a\r\n  - [x] b\n- [ ] a\n');
  assert.strictEqual(checkLine(md, 5), null);
  assert.strictEqual(checkLine('plain', 0), null);
});
test('displayText flattens links', () => {
  assert.strictEqual(displayText('see [[Note|alias]] and [x](http://a) ^abc'), 'see alias and x');
});

// ---- index harness ------------------------------------------------------
function harness(files) {
  const mem = new Map(Object.entries(files));
  const stat = new Map([...mem.keys()].map((p) => [p, 1]));
  const mk = (p) => ({ path: p, extension: p.split('.').pop(), stat: { mtime: stat.get(p) } });
  const vault = {
    getMarkdownFiles: () => [...mem.keys()].filter((p) => p.endsWith('.md')).map(mk),
    getFiles: () => [...mem.keys()].map(mk),
    cachedRead: async (f) => mem.get(f.path),
    read: async (f) => mem.get(f.path),
    getAbstractFileByPath: (p) => (mem.has(p) ? mk(p) : null),
  };
  const events = { trigger() {} };
  const store = new TaskStore(null, () => {});
  const index = new TaskIndex({ vault }, store, events);
  const edit = async (p, c) => { mem.set(p, c); stat.set(p, (stat.get(p) || 0) + 1); await index.reindexFile(mk(p)); };
  const tasksOf = (p) => (index.byPath.get(p) || []).map((t) => t.text);
  const idOf = (text, p) => index.allTasks().find((t) => t.text === text && (!p || t.path === p)).id;
  return { mem, stat, mk, vault, store, index, edit, tasksOf, idOf };
}

test('initial scan, exclusions, no duplicates on rescan', async () => {
  const h = harness({ 'a.md': '- [ ] one\n- [ ] two', 'Archive/b.md': '- [ ] old', 'c.md': '- [ ] three' });
  h.store.setSetting('excludedFolders', ['Archive']);
  h.store.setSetting('excludedFiles', ['c']);
  await h.index.fullScan();
  assert.deepStrictEqual(h.index.allTasks().map((t) => t.text), ['one', 'two']);
  await h.index.fullScan({ force: true });
  assert.strictEqual(h.index.allTasks().length, 2);
  assert.strictEqual(Object.keys(h.store.tasks).length, 2);
  h.store.setSetting('excludedFolders', []);
  await h.index.fullScan();
  assert.strictEqual(h.index.allTasks().length, 3);
});

test('metadata survives line moves, edits and capitalisation changes', async () => {
  const h = harness({ 'a.md': '# T\n- [ ] Write the quarterly report\n- [ ] Water plants\n' });
  await h.index.fullScan();
  const id = h.idOf('Write the quarterly report');
  h.store.moveToLane(id, 'now');
  await h.edit('a.md', 'intro\n\nmore\n# T\n- [ ] Water plants\n- [ ] write the quarterly report\n');
  assert.strictEqual(h.idOf('write the quarterly report'), id);
  await h.edit('a.md', 'intro\n- [ ] Water plants\n- [ ] write the quarterly report for Q3\n');
  assert.strictEqual(h.idOf('write the quarterly report for Q3'), id, 'light edit keeps identity');
  assert.strictEqual(h.store.laneOf(id), 'now');
});

test('totally rewritten task gets a new identity but keeps its note lane', async () => {
  const h = harness({ 'a.md': '- [ ] Buy milk\n' });
  await h.index.fullScan();
  const id = h.idOf('Buy milk');
  h.store.moveToLane(id, 'now');
  await h.edit('a.md', '- [ ] Book the dentist\n');
  assert.notStrictEqual(h.idOf('Book the dentist'), id);
  assert.strictEqual(h.store.laneOf(h.idOf('Book the dentist')), 'now');
});

test('same description in several notes stays separate', async () => {
  const h = harness({ 'a.md': '- [ ] Buy milk', 'b.md': '- [ ] Buy milk' });
  await h.index.fullScan();
  const a = h.idOf('Buy milk', 'a.md');
  const b = h.idOf('Buy milk', 'b.md');
  assert.notStrictEqual(a, b);
  h.store.moveToLane(a, 'now');
  await h.edit('b.md', 'x\n- [ ] Buy milk');
  assert.strictEqual(h.store.laneOf(a), 'now');
  assert.strictEqual(h.store.laneOf(b), null);
});

test('identical duplicates in one note: completing one keeps the other\'s metadata', async () => {
  const h = harness({ 'd.md': '- [ ] Call plumber\n- [ ] Call plumber\n- [ ] Call plumber\n' });
  await h.index.fullScan();
  const [a, b, c] = h.index.allTasks().map((t) => t.id);
  h.store.moveToLane(c, 'later');
  // plugin-style completion of the first one
  const content = h.mem.get('d.md');
  assert.strictEqual(h.index.locate('d.md', content, a), 0);
  assert.strictEqual(h.index.locate('d.md', content, c), 2);
  h.index.pending.add(a);
  h.mem.set('d.md', checkLine(content, 0));
  h.index.pending.delete(a);
  h.store.deleteRecord(a);
  await h.index.reindexFile(h.mk('d.md'));
  assert.deepStrictEqual(h.index.allTasks().map((t) => t.id), [b, c]);
  assert.strictEqual(h.store.laneOf(c), 'later');
});

test('ambiguous duplicate removal does not transfer task identity', async () => {
  const h = harness({ 'd.md': 'x\n- [ ] Call plumber\n- [ ] Call plumber\n' });
  await h.index.fullScan();
  const [a, b] = h.index.allTasks().map((t) => t.id);
  h.store.moveToLane(a, 'now');
  await h.edit('d.md', 'x\n- [ ] Call plumber\n'); // one deleted externally; which one is unknowable? context says first
  const now = h.index.allTasks();
  assert.strictEqual(now.length, 1);
  // The note card keeps its lane, but the unmatched duplicate must not keep either task identity.
  assert.ok(![a, b].includes(now[0].id));
  assert.strictEqual(h.store.laneOf(now[0].id), 'now');
});

test('rename keeps metadata; delete marks missing; cut/paste to another note adopts it', async () => {
  const h = harness({ 'a.md': '- [ ] Ship release\n- [ ] other', 'b.md': 'empty' });
  await h.index.fullScan();
  const id = h.idOf('Ship release');
  h.store.moveToLane(id, 'someday');
  h.store.removeFromQueue(id);
  // rename
  h.mem.set('z.md', h.mem.get('a.md')); h.mem.delete('a.md'); h.stat.set('z.md', 5);
  h.index.handleRename(h.mk('z.md'), 'a.md', false);
  await h.index.reindexFile(h.mk('z.md'));
  assert.strictEqual(h.idOf('Ship release'), id);
  // cut from z.md, paste into b.md
  await h.edit('z.md', '- [ ] other');
  assert.ok(h.store.tasks[id].missingSince, 'vanished task is kept as missing');
  await h.edit('b.md', '- [ ] Ship release');
  assert.strictEqual(h.idOf('Ship release'), id);
  assert.strictEqual(h.store.laneOf(id), 'someday');
  assert.strictEqual(h.store.inQueue(id), false, 'queue removal preserved');
  assert.strictEqual(Object.keys(h.store.tasks).filter((k) => h.store.tasks[k].h === h.store.tasks[id].h).length, 1);
});

test('task completed outside reappears with metadata if un-ticked; stale data purged on demand', async () => {
  const h = harness({ 'a.md': '- [ ] Pay rent' });
  await h.index.fullScan();
  const id = h.idOf('Pay rent');
  h.store.moveToLane(id, 'now');
  await h.edit('a.md', '- [x] Pay rent');
  assert.strictEqual(h.index.allTasks().length, 0);
  await h.edit('a.md', '- [ ] Pay rent');
  assert.strictEqual(h.idOf('Pay rent'), id);
  await h.edit('a.md', '- [x] Pay rent');
  assert.strictEqual(h.store.purgeMissing(0), 1);
  assert.strictEqual(h.store.laneOf(id), null);
  assert.strictEqual(h.store.inQueue(id), false);
});

test('lane/queue ordering and ignore state', async () => {
  const h = harness({ 'a.md': '- [ ] a\n- [ ] b\n- [ ] c' });
  await h.index.fullScan();
  const [a, b, c] = h.index.allTasks().map((t) => t.id);
  h.store.moveToLane(a, 'now'); h.store.moveToLane(b, 'now'); h.store.moveToLane(c, 'now', a);
  // Lane placement belongs to the note card and retains the note's task order.
  assert.deepStrictEqual(h.store.lane('now'), [a, b, c]);
  h.store.moveToLane(a, 'later');
  assert.deepStrictEqual(h.store.lane('now'), []);
  assert.deepStrictEqual(h.store.lane('later'), [a, b, c]);
  h.store.placeInQueue(c, a);
  assert.deepStrictEqual(h.store.queueIds(), [c, a, b]);
  h.store.removeFromQueue(a);
  assert.strictEqual(h.store.laneOf(a), 'later', 'queue removal keeps lane');
  h.store.setIgnored(b, true);
  assert.ok(h.store.isIgnored(b));
  // persistence round-trip
  let saved;
  const s2 = new TaskStore(null, (d) => { saved = JSON.parse(JSON.stringify(d)); });
  Object.assign(s2.data, h.store.data); s2.flush();
  const s3 = new TaskStore(saved, () => {});
  assert.deepStrictEqual(s3.lane('now'), []);
  assert.ok(s3.isIgnored(b));
});

test('corrupt saved data is sanitised', () => {
  const s = new TaskStore({ tasks: { x: { path: 'a.md', h: '1' }, bad: 5 }, lanes: { now: ['x', 'x', 'ghost'] }, queue: ['x', 'ghost'], settings: { excludedFolders: 'nope' } }, () => {});
  assert.deepStrictEqual(s.lane('now'), ['x']);
  assert.deepStrictEqual(s.queueIds(), ['x']);
  assert.deepStrictEqual(s.settings.excludedFolders, []);
});

test('bundled main.js is current and loads with a stubbed obsidian module', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync('node', [require('node:path').join(__dirname, '..', 'scripts', 'build.js'), '--check']);
  const Module = require('node:module');
  const orig = Module._load;
  class Stub { constructor() {} }
  Module._load = function (req, ...r) {
    if (req === 'obsidian') return { Plugin: Stub, Events: Stub, Notice: Stub, TFile: Stub, TFolder: Stub, Keymap: Stub, ItemView: Stub, PluginSettingTab: Stub, Setting: Stub, setIcon() {} };
    return orig.call(this, req, ...r);
  };
  try {
    const P = require('../main.js');
    assert.strictEqual(typeof P, 'function');
    assert.strictEqual(typeof P.prototype.completeTask, 'function');
  } finally { Module._load = orig; }
});

test('lane titles can be renamed, reset and are sanitised', () => {
  const s = new TaskStore({ laneTitles: { now: '  Today ', later: 5, someday: 'Someday' } }, () => {});
  assert.equal(s.laneTitle('now'), 'Today');
  assert.equal(s.laneTitle('later'), 'Later');
  assert.equal(s.laneTitle('unassigned'), 'Inbox');
  s.setLaneTitle('later', 'This month');
  assert.equal(s.laneTitle('later'), 'This month');
  s.setLaneTitle('later', '   ');
  assert.equal(s.laneTitle('later'), 'Later');
});

test('moveTasksToLane moves a group together and keeps order; collapsed state persists', () => {
  const s = new TaskStore({ tasks: { a: { path: 'n.md', h: '1' }, b: { path: 'n.md', h: '2' }, c: { path: 'm.md', h: '3' } }, lanes: { now: ['c'] }, ui: { collapsed: { 'n.md': true, 'x.md': 'no' } } }, () => {});
  s.moveTasksToLane(['a', 'b'], 'now', 'c');
  assert.deepEqual(s.lane('now'), ['a', 'b', 'c']);
  s.moveTasksToLane(['a', 'b'], null);
  assert.deepEqual(s.lane('now'), ['c']);
  assert.equal(s.isCollapsed('n.md'), true);
  assert.equal(s.isCollapsed('x.md'), false);
  s.toggleCollapsed('n.md');
  assert.equal(s.isCollapsed('n.md'), false);
});

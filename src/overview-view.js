'use strict';
// Tab 1: Now / Later / Someday columns. Inside each column, open tasks are grouped
// into one card per note. Unassigned tasks sit below, also as note cards.
// A whole note card can be dragged to move all of its tasks at once.
const { setIcon } = require('obsidian');
const { LANES, TITLE_MAX } = require('./constants');
const { displayText } = require('./task-discovery');
const dnd = require('./dnd');


/** Group tasks by note. Keeps the order in which each note first appears. */
function groupByNote(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    if (!groups.has(t.path)) groups.set(t.path, { path: t.path, tasks: [] });
    groups.get(t.path).tasks.push(t);
  }
  return [...groups.values()];
}


/** Small coloured buttons that send tasks to another lane without dragging. */
function renderMoveButtons(view, parent, currentLane, ids, subject) {
  const { store } = view.plugin;
  const wrap = parent.createDiv({ cls: 'to-move-set' });
  for (const lane of [...LANES, 'unassigned']) {
    if (lane === currentLane) continue;
    const title = store.laneTitle(lane);
    const b = wrap.createEl('button', {
      cls: `to-move to-move-${lane}`,
      text: (title[0] || '?').toUpperCase(),
      attr: { 'aria-label': `Move ${subject} to ${title}`, title: `Move to ${title}` },
    });
    b.addEventListener('click', (e) => { e.stopPropagation(); store.moveTasksToLane(ids, lane === 'unassigned' ? null : lane); });
  }
}

function renderTask(view, parent, task) {
  const text = displayText(task.text);
  const row = parent.createDiv({
    cls: 'to-task',
    attr: { 'data-id': task.id, tabindex: '0', role: 'listitem', style: `--depth:${task.depth || 0}` },
  });
  view.makeCheckbox(row, task, text);
  const link = row.createEl('button', { cls: 'to-task-text', attr: { 'aria-label': `Open note: ${text}` } });
  link.createSpan({ text: text || '(empty)' });
  link.addEventListener('click', (e) => view.plugin.openTask(task.id, e));
  row.addEventListener('keydown', (e) => {
    if (e.target !== row) return;
    if (e.key === 'Enter') { view.plugin.openTask(task.id, e); return; }
  });
}

function renderNote(view, parent, group, laneKey) {
  const { store } = view.plugin;
  const first = group.tasks[0];
  const ids = group.tasks.map((t) => t.id);
  const name = view.sourceName({ path: group.path });
  const collapsed = store.isCollapsed(`note:${group.path}`) && !view.query;
  const card = parent.createDiv({
    cls: 'to-note' + (collapsed ? ' is-collapsed' : ''),
    attr: { 'data-id': first.id, role: 'group', 'aria-label': name },
  });
  const head = card.createDiv({ cls: 'to-note-head' });
  const chev = head.createEl('button', { cls: 'to-icon-btn to-chev', attr: { 'aria-label': collapsed ? `Expand ${name}` : `Collapse ${name}`, 'aria-expanded': String(!collapsed) } });
  setIcon(chev, 'chevron-down');
  chev.addEventListener('click', (e) => { e.stopPropagation(); store.toggleCollapsed(`note:${group.path}`); });
  const titles = head.createEl('button', { cls: 'to-note-title', attr: { 'aria-label': `Open note: ${name}` } });
  titles.createSpan({ cls: 'to-note-name', text: name });
  titles.addEventListener('click', (e) => view.plugin.openTask(first.id, e));
  const actions = head.createDiv({ cls: 'to-task-actions' });
  renderMoveButtons(view, actions, laneKey, ids, 'note');
  head.createSpan({ cls: 'to-count', text: String(group.tasks.length) });
  if (!collapsed) {
    const list = card.createDiv({ cls: 'to-note-tasks', attr: { role: 'list' } });
    for (const t of group.tasks) renderTask(view, list, t);
  }
  dnd.enableDrag(card, first.id, ids);
}

/** Lane title with a consistent, visible rename action. */
function renderTitle(view, head, key) {
  const { store } = view.plugin;
  const title = store.laneTitle(key);
  const h = head.createEl('h3', { cls: 'to-lane-title', text: title });
  const btn = head.createEl('button', { cls: 'to-icon-btn to-rename', attr: { 'aria-label': `Rename ${title}`, title: 'Rename' } });
  setIcon(btn, 'pencil');
  const edit = () => {
    const input = createEl('input', { cls: 'to-title-input', attr: { type: 'text', maxlength: String(TITLE_MAX), 'aria-label': 'Lane name', spellcheck: 'false' } });
    input.value = title;
    h.replaceWith(input);
    btn.hide();
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) store.setLaneTitle(key, input.value);
      view.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  };
  btn.addEventListener('click', edit);
}

function renderHead(view, parent, key, count) {
  const { store } = view.plugin;
  const head = parent.createDiv({ cls: 'to-lane-head' });
  const collapsed = store.isCollapsed(`lane:${key}`);
  const toggle = head.createEl('button', { cls: 'to-icon-btn to-lane-toggle', attr: { 'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${store.laneTitle(key)}`, 'aria-expanded': String(!collapsed) } });
  setIcon(toggle, 'chevron-down');
  toggle.addEventListener('click', () => store.toggleCollapsed(`lane:${key}`));
  head.createSpan({ cls: 'to-dot', attr: { 'aria-hidden': 'true' } });
  renderTitle(view, head, key);
  head.createSpan({ cls: 'to-count to-lane-count', text: String(count) });
}

function emptyState(parent, icon, text) {
  const box = parent.createDiv({ cls: 'to-empty' });
  const i = box.createSpan({ cls: 'to-empty-icon', attr: { 'aria-hidden': 'true' } });
  setIcon(i, icon);
  box.createSpan({ text });
}

function dropAll(store, key) {
  return (id, beforeId, ids) => store.moveTasksToLane(ids, key, beforeId);
}

function renderColumn(view, el, key, tasks) {
  const { store } = view.plugin;
  const title = store.laneTitle(key);
  const collapsed = store.isCollapsed(`lane:${key}`);
  const col = el.createEl('section', { cls: `to-col to-lane-${key}${collapsed ? ' is-collapsed' : ''}`, attr: { 'aria-label': title } });
  renderHead(view, col, key, tasks.length);
  const zone = col.createDiv({ cls: 'to-col-body', attr: { 'aria-label': `${title} tasks` } });
  if (!collapsed) {
    for (const g of groupByNote(tasks)) renderNote(view, zone, g, key);
    if (!tasks.length) {
      zone.addClass('is-empty');
      emptyState(zone, 'inbox', 'No tasks here yet. Drag a task or note card into this lane.');
    }
  }
  dnd.enableDrop(zone, { itemSelector: '.to-note', orientation: 'column', onDrop: dropAll(store, key === 'unassigned' ? null : key) });
}

function renderOverview(view, el) {
  const { store, index } = view.plugin;
  const q = (view.query || '').trim().toLowerCase();
  const matches = (t) => !q || displayText(t.text).toLowerCase().includes(q) || t.path.toLowerCase().includes(q);
  const all = index.allTasks().filter((t) => !store.isIgnored(t.id));
  const tasks = all.filter(matches);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const laneMap = store.laneMap();
  if (!index.scanning && !index.allTasks().length) {
    el.createDiv({ cls: 'to-notice', text: 'No open tasks found. Add "- [ ] something" to any note, or check your exclusions in the plugin settings.' });
  }
  const board = el.createDiv({ cls: 'to-board' });
  for (const lane of [...LANES, 'unassigned']) {
    const laneTasks = lane === 'unassigned'
      ? tasks.filter((t) => !laneMap.has(t.id))
      : store.lane(lane).map((id) => byId.get(id)).filter(Boolean);
    renderColumn(view, board, lane, laneTasks);
  }
  const hz = el.createDiv({ cls: 'to-hide-zone' });
  const icon = hz.createSpan({ cls: 'to-hide-icon' });
  setIcon(icon, 'eye-off');
  hz.createSpan({ text: 'Hide' });
  hz.createSpan({ cls: 'to-hide-hint', text: 'Drop tasks or notes here' });
  dnd.enableDrop(hz, { onDrop: (id, b, ids) => store.setIgnoredMany(ids, true) });
}

module.exports = { renderOverview };

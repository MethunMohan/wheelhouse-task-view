'use strict';
// Tab 2: manually ordered queue, independent of lane assignment.
const { setIcon } = require('obsidian');
const { displayText } = require('./task-discovery');
const dnd = require('./dnd');

function renderQueue(view, el) {
  const { store, index } = view.plugin;
  const tasks = index.allTasks().filter((t) => !store.isIgnored(t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queued = store.queueIds().map((id) => byId.get(id)).filter(Boolean);
  const queuedSet = new Set(queued.map((t) => t.id));

  const list = el.createEl('ol', { cls: 'to-queue', attr: { 'aria-label': 'Task queue' } });
  queued.forEach((task, i) => {
    const text = displayText(task.text);
    const li = list.createEl('li', { cls: 'to-q-item', attr: { 'data-id': task.id, tabindex: '0' } });
    li.createSpan({ cls: 'to-q-pos', text: String(i + 1) });
    const grip = li.createSpan({ cls: 'to-grip', attr: { 'aria-hidden': 'true' } });
    setIcon(grip, 'grip-vertical');
    view.makeCheckbox(li, task, text);
    const main = li.createDiv({ cls: 'to-card-main' });
    const link = main.createEl('button', { cls: 'to-card-text', text: text || '(empty)', attr: { 'aria-label': `Open note: ${text}` } });
    link.addEventListener('click', (e) => view.plugin.openTask(task.id, e));
    const meta = main.createDiv({ cls: 'to-card-meta' });
    meta.createSpan({ cls: 'to-source', text: view.sourceName(task) });
    dnd.enableDrag(li, task.id);
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter') { view.plugin.openTask(task.id, e); return; }
      if (!e.altKey) return;
      if (e.key === 'ArrowUp' && i > 0) store.placeInQueue(task.id, queued[i - 1].id);
      else if (e.key === 'ArrowDown' && i < queued.length - 1) store.placeInQueue(task.id, queued[i + 2] ? queued[i + 2].id : null);
      else return;
      e.preventDefault();
      view.focusId = task.id;
    });
  });
  if (!queued.length) list.createEl('li', { cls: 'to-empty', text: 'The queue is empty. Add tasks from the list below.' });
  dnd.enableDrop(list, {
    itemSelector: '.to-q-item',
    orientation: 'column',
    onDrop: (id, beforeId) => store.placeInQueue(id, beforeId),
  });

  const rest = tasks.filter((t) => !queuedSet.has(t.id));
  if (rest.length) {
    const det = el.createEl('details', { cls: 'to-notqueued' });
    if (view.showNotQueued) det.setAttribute('open', '');
    det.addEventListener('toggle', () => { view.showNotQueued = det.open; });
    det.createEl('summary', { text: `Not in queue (${rest.length})` });
    const ul = det.createEl('ul', { cls: 'to-plain-list' });
    for (const task of rest) {
      const li = ul.createEl('li');
      li.createSpan({ cls: 'to-card-text-static', text: displayText(task.text) });
      li.createSpan({ cls: 'to-source', text: view.sourceName(task) });
      const add = li.createEl('button', { text: 'Add to queue' });
      add.addEventListener('click', () => store.placeInQueue(task.id));
    }
  }
}

module.exports = { renderQueue };

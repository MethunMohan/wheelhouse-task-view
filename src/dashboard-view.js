'use strict';
// The dashboard leaf: header with tabs, plus Board / Queue / Hidden panels.
const { ItemView, setIcon } = require('obsidian');
const { PLUGIN_NAME, VIEW_TYPE, RIBBON_ICON } = require('./constants');
const { displayText } = require('./task-discovery');
const { renderOverview } = require('./overview-view');
const { renderQueue } = require('./queue-view');
const dnd = require('./dnd');

class DashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = plugin.store.ui.activeTab;
    this.focusId = null;
    this.query = '';
    this.searchOpen = false;
    this.showAllUnassigned = false;
    this.showNotQueued = false;
    this.sourceLabelCache = null;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return PLUGIN_NAME; }
  getIcon() { return RIBBON_ICON; }

  async onOpen() {
    this.contentEl.addClass('task-overview-root');
    this.registerEvent(this.plugin.events.on('changed', () => this.requestRender()));
    this.render();
  }

  requestRender() {
    if (dnd.isDragging()) { dnd.afterDrag(() => this.render()); return; }
    this.render();
  }

  // ---- helpers shared by the panels -----------------------------------------
  rowKeys() {
    return ['now', 'later', 'someday', 'unassigned'];
  }
  sourceName(task) {
    if (!this.sourceLabelCache) {
      const paths = [...new Set(this.plugin.index.allTasks().map((t) => t.path))];
      const groups = new Map();
      for (const path of paths) {
        const file = path.split('/').pop();
        const name = file.replace(/\.[^.]+$/, '');
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(path);
      }
      this.sourceLabelCache = new Map();
      for (const [name, sameName] of groups) for (const path of sameName) {
        if (sameName.length === 1) { this.sourceLabelCache.set(path, name); continue; }
        const parts = path.split('/');
        let depth = 1;
        let label = parts.length > 1 ? `${parts.at(-2)}/${name}` : parts.at(-1);
        while (depth < parts.length - 1 && sameName.some((other) => {
          if (other === path) return false;
          const otherParts = other.split('/');
          return otherParts.slice(-depth - 1, -1).join('/') === parts.slice(-depth - 1, -1).join('/');
        })) {
          depth++;
          label = `${parts.slice(-depth - 1, -1).join('/')}/${name}`;
        }
        this.sourceLabelCache.set(path, label);
      }
    }
    return this.sourceLabelCache.get(task.path) || task.path.split('/').pop().replace(/\.[^.]+$/, '');
  }
  makeCheckbox(parent, task, text) {
    const cb = parent.createEl('input', { cls: 'to-check', attr: { type: 'checkbox', 'aria-label': `Complete task: ${text}` } });
    cb.addEventListener('click', async (e) => {
      e.stopPropagation();
      cb.disabled = true;
      const ok = await this.plugin.completeTask(task.id);
      if (!ok) { cb.checked = false; cb.disabled = false; }
    });
    return cb;
  }

  // ---- rendering ----------------------------------------------------------
  render() {
    const root = this.contentEl;
    this.sourceLabelCache = null;
    for (const [lane, color] of Object.entries(this.plugin.store.settings.laneColors)) {
      root.style.setProperty(`--to-${lane}`, color);
    }
    root.style.setProperty('--to-queue', this.plugin.store.settings.queueColor);
    const old = root.querySelector('.to-body');
    const top = old ? old.scrollTop : 0;
    root.empty();
    this.renderHeader(root);
    this.renderBody(top);
  }

  /** Re-draw only the body (keeps the search box focused while typing). */
  renderBody(scrollTop) {
    const root = this.contentEl;
    const old = root.querySelector('.to-body');
    const top = scrollTop === undefined ? (old ? old.scrollTop : 0) : scrollTop;
    if (old) old.remove();
    const body = root.createDiv({ cls: 'to-body' });
    if (this.mode === 'queue') renderQueue(this, body);
    else if (this.mode === 'hidden') this.renderHidden(body);
    else renderOverview(this, body);
    body.scrollTop = top;
    if (this.focusId) {
      const el = root.querySelector(`[data-id="${CSS.escape(this.focusId)}"]`);
      if (el) el.focus();
      this.focusId = null;
    }
  }

  renderHeader(root) {
    const { store, index } = this.plugin;
    const head = root.createDiv({ cls: 'to-header' });
    const tabs = head.createDiv({ cls: 'to-tabs', attr: { role: 'tablist' } });
    const open = index.allTasks().filter((t) => !store.isIgnored(t.id));
    const queueCount = store.queueIds().filter((id) => open.some((t) => t.id === id)).length;
    const mk = (mode, label, count) => {
      const b = tabs.createEl('button', {
        cls: 'to-tab',
        attr: { role: 'tab', 'aria-selected': String(this.mode === mode || (this.mode === 'hidden' && mode === 'overview')) },
      });
      b.createSpan({ text: label });
      b.createSpan({ cls: 'to-count', text: String(count) });
      b.addEventListener('click', () => {
        this.mode = mode;
        store.setActiveTab(mode);
        this.render();
      });
    };
    mk('overview', 'Board', open.length);
    mk('queue', 'Task Queue', queueCount);
    const right = head.createDiv({ cls: 'to-header-right' });
    if (this.mode === 'overview') {
      const search = right.createEl('button', {
        cls: 'to-icon-btn to-search-toggle',
        attr: { 'aria-label': 'Search tasks and notes', title: 'Search', 'aria-expanded': String(this.searchOpen) },
      });
      setIcon(search, 'search');
      search.addEventListener('click', () => {
        this.searchOpen = !this.searchOpen;
        if (!this.searchOpen) this.query = '';
        this.render();
        const target = this.contentEl.querySelector(this.searchOpen ? '.to-search-input' : '.to-search-toggle');
        target?.focus();
      });
    }
    if (index.scanning) right.createSpan({ cls: 'to-status', text: 'Scanning vault…' });
    const rf = right.createEl('button', { cls: 'to-icon-btn', attr: { 'aria-label': 'Rescan vault', title: 'Rescan vault' } });
    setIcon(rf, 'refresh-cw');
    rf.addEventListener('click', () => this.plugin.index.fullScan({ force: true }));
    if (this.mode === 'overview' && this.searchOpen) {
      const box = head.createDiv({ cls: 'to-search-expanded' });
      const si = box.createSpan({ cls: 'to-search-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(si, 'search');
      const input = box.createEl('input', { cls: 'to-search-input', attr: { type: 'search', placeholder: 'Search tasks and notes', 'aria-label': 'Search tasks and notes', spellcheck: 'false' } });
      input.value = this.query;
      input.addEventListener('input', () => { this.query = input.value; this.renderBody(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.searchOpen = false;
          this.query = '';
          this.render();
          this.contentEl.querySelector('.to-search-toggle')?.focus();
        }
      });
    }
  }

  renderHidden(el) {
    const { store, index } = this.plugin;
    const hidden = index.allTasks().filter((t) => store.isIgnored(t.id));
    el.createEl('p', { cls: 'to-muted', text: 'Hidden tasks are only hidden here. Their notes are untouched.' });
    if (!hidden.length) { el.createDiv({ cls: 'to-empty', text: 'No hidden tasks.' }); return; }
    const all = el.createEl('button', { text: 'Restore all' });
    all.addEventListener('click', () => store.restoreAllIgnored());
    const groups = new Map();
    for (const task of hidden) {
      if (!groups.has(task.path)) groups.set(task.path, []);
      groups.get(task.path).push(task);
    }
    const list = el.createDiv({ cls: 'to-hidden-list' });
    for (const tasks of groups.values()) {
      const name = this.sourceName(tasks[0]);
      const card = list.createDiv({ cls: 'to-note to-hidden-note', attr: { role: 'group', 'aria-label': name } });
      const head = card.createDiv({ cls: 'to-note-head' });
      const title = head.createEl('button', { cls: 'to-note-title to-hidden-note-title', attr: { 'aria-label': `Open note: ${name}` } });
      title.createSpan({ cls: 'to-note-name', text: name });
      title.addEventListener('click', (e) => this.plugin.openTask(tasks[0].id, e));
      head.createSpan({ cls: 'to-count', text: String(tasks.length) });
      if (tasks.length > 1) {
        const restoreNote = head.createEl('button', { text: 'Restore note' });
        restoreNote.addEventListener('click', () => store.setIgnoredMany(tasks.map((task) => task.id), false));
      }
      const taskList = card.createDiv({ cls: 'to-note-tasks to-hidden-tasks' });
      for (const task of tasks) {
        const row = taskList.createDiv({ cls: 'to-hidden-task', attr: { style: `--depth:${task.depth || 0}` } });
        row.createSpan({ cls: 'to-hidden-task-text', text: displayText(task.text) || '(empty)' });
        const restore = row.createEl('button', { text: 'Restore' });
        restore.addEventListener('click', () => store.setIgnored(task.id, false));
      }
    }
  }
}

module.exports = { DashboardView };

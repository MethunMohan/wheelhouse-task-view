'use strict';
// Live in-memory index of open tasks, kept in sync with the vault. Combines
// discovery (parse) and identity (reconcile) and writes metadata via the store.
// Depends only on an `app`-like object (vault) so it can be tested without Obsidian.
const { parseTasks } = require('./task-discovery');
const { reconcile } = require('./task-identity');
const { STALE_MS, FRESH_MS } = require('./constants');

const trimSlashes = (s) => s.trim().replace(/^\/+|\/+$/g, '');
const yieldUi = () => new Promise((r) => setTimeout(r, 0));

class TaskIndex {
  constructor(app, store, events) {
    this.app = app;
    this.store = store;
    this.events = events;
    this.byPath = new Map(); // path -> [{id,path,line,text,depth,parentText}]
    this.mtimes = new Map();
    this.pending = new Set(); // ids being completed right now
    this.recentFresh = new Map(); // id -> timestamp, candidates to adopt moved-task metadata
    this.chains = new Map();
    this.timers = new Map();
    this.scanToken = 0;
    this.scanning = false;
    this._cache = null;
    this._emitTimer = null;
    this._scanTimer = null;
  }

  // ---- filtering ---------------------------------------------------------
  isExcluded(path) {
    const s = this.store.settings;
    for (const f of s.excludedFiles) {
      const n = trimSlashes(f);
      if (n && (path === n || path === n + '.md')) return true;
    }
    for (const f of s.excludedFolders) {
      const n = trimSlashes(f);
      if (n && path.startsWith(n + '/')) return true;
    }
    return false;
  }
  isScannable(file) {
    if (!file || typeof file.path !== 'string') return false;
    return file.extension === 'md' || (this.store.settings.scanNonMarkdown && file.extension === 'txt');
  }
  listFiles() {
    const vault = this.app.vault;
    const files = vault.getMarkdownFiles().slice();
    if (this.store.settings.scanNonMarkdown) files.push(...vault.getFiles().filter((f) => f.extension === 'txt'));
    return files.filter((f) => !this.isExcluded(f.path));
  }

  // ---- queries -----------------------------------------------------------
  allTasks() {
    if (!this._cache) {
      const list = [];
      const paths = [...this.byPath.keys()].sort((a, b) => a.localeCompare(b));
      for (const p of paths) list.push(...this.byPath.get(p));
      this._cache = { list, byId: new Map(list.map((t) => [t.id, t])) };
    }
    return this._cache.list;
  }
  getTask(id) { this.allTasks(); return this._cache.byId.get(id); }
  _invalidate() { this._cache = null; }

  emit() {
    this._invalidate();
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this.events.trigger('changed'), 60);
  }
  dispose() {
    clearTimeout(this._emitTimer);
    clearTimeout(this._scanTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.scanToken++;
  }

  // ---- scanning ----------------------------------------------------------
  async fullScan({ force = false } = {}) {
    const token = ++this.scanToken;
    this.scanning = true;
    this.emit();
    const files = this.listFiles();
    const keep = new Set(files.map((f) => f.path));
    for (const p of [...this.byPath.keys()]) {
      if (!keep.has(p)) { this.byPath.delete(p); this.mtimes.delete(p); }
    }
    let n = 0;
    for (const f of files) {
      if (token !== this.scanToken) return;
      const unchanged = this.byPath.has(f.path) && this.mtimes.get(f.path) === f.stat.mtime;
      if (!force && unchanged) continue;
      await this.reindexFile(f, { cached: true });
      if (++n % 40 === 0) await yieldUi();
    }
    if (token !== this.scanToken) return;
    this.cleanup();
    this.adoptOrphans();
    this.scanning = false;
    this.emit();
  }
  scheduleFullScan(delay = 400, opts) {
    clearTimeout(this._scanTimer);
    this._scanTimer = setTimeout(() => this.fullScan(opts), delay);
  }

  scheduleReindex(file, delay = 500) {
    if (!this.isScannable(file)) return;
    clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, setTimeout(() => {
      this.timers.delete(file.path);
      this.reindexFile(file);
    }, delay));
  }

  /** Re-read one file; serialised per path so concurrent triggers cannot interleave. */
  reindexFile(file, opts = {}) {
    const prev = this.chains.get(file.path) || Promise.resolve();
    const next = prev.then(() => this._reindex(file, opts)).catch((e) => console.error('[Wheelhouse Task View] reindex failed', file.path, e));
    this.chains.set(file.path, next);
    next.then(() => { if (this.chains.get(file.path) === next) this.chains.delete(file.path); });
    return next;
  }
  async _reindex(file, opts) {
    const path = file.path;
    if (!this.isScannable(file) || this.isExcluded(path)) { this.removeFromIndex(path); return; }
    const vault = this.app.vault;
    const content = opts.cached ? await vault.cachedRead(file) : await vault.read(file);
    if (file.path !== path) return; // renamed while reading; the rename handler re-queues it
    this.mtimes.set(path, file.stat.mtime);
    this.applyParsed(path, parseTasks(content));
  }

  removeFromIndex(path) {
    if (this.byPath.delete(path)) this.emit();
    this.mtimes.delete(path);
  }

  /** A file was deleted: remember its tasks as missing (they may reappear elsewhere). */
  handleDelete(path, isFolder) {
    const hit = isFolder ? [...this.byPath.keys(), ...this.store.knownPaths()].filter((p) => p.startsWith(path + '/')) : [path];
    for (const p of new Set(hit)) {
      for (const id of this.store.idsForPath(p)) this.store.markMissing(id);
      this.removeFromIndex(p);
    }
    this.emit();
  }

  handleRename(file, oldPath, isFolder) {
    if (isFolder) {
      this.store.movePrefix(oldPath + '/', file.path + '/');
      for (const p of [...this.byPath.keys()]) if (p.startsWith(oldPath + '/')) { this.byPath.delete(p); this.mtimes.delete(p); }
      this.scheduleFullScan(300);
      return;
    }
    this.store.movePath(oldPath, file.path);
    this.byPath.delete(oldPath);
    this.mtimes.delete(oldPath);
    this.reindexFile(file);
  }

  // ---- core reconciliation ----------------------------------------------
  applyParsed(path, parsed) {
    const store = this.store;
    const open = parsed.filter((t) => !t.checked);
    const live = [];
    const missing = [];
    for (const id of store.idsForPath(path)) {
      if (this.pending.has(id)) return; // a completion is in flight; it will re-index afterwards
      (store.tasks[id].missingSince ? missing : live).push(id);
    }
    const assigned = new Array(open.length).fill(null);
    const usedLive = new Set();
    reconcile(live.map((id) => store.tasks[id]), open).forEach((o, n) => {
      if (o >= 0) { assigned[n] = live[o]; usedLive.add(live[o]); }
    });
    // Previously vanished tasks of this file may reappear (e.g. un-ticked); exact text only.
    const left = [];
    assigned.forEach((a, n) => { if (!a) left.push(n); });
    if (left.length && missing.length) {
      reconcile(missing.map((id) => store.tasks[id]), left.map((n) => open[n]), { fuzzy: false }).forEach((o, k) => {
        if (o >= 0) assigned[left[k]] = missing[o];
      });
    }
    for (const id of live) if (!usedLive.has(id)) store.markMissing(id);
    const fresh = [];
    open.forEach((t, n) => {
      if (assigned[n]) store.updateRecord(assigned[n], path, t);
      else { assigned[n] = store.createRecord(path, t); fresh.push(assigned[n]); }
    });
    this.byPath.set(path, open.map((t, n) => ({
      id: assigned[n], path, line: t.line, text: t.text, depth: t.depth, parentText: t.parentText,
    })));
    store.syncNoteLane(path, assigned);
    const now = Date.now();
    for (const id of fresh) this.recentFresh.set(id, now);
    this.adoptOrphans();
    this.emit();
  }

  /**
   * A task cut from one place and pasted in another looks like "one task vanished,
   * one appeared". If exactly one new untouched task and exactly one vanished record
   * share the same text hash, the metadata follows the task. Anything ambiguous is left alone.
   */
  adoptOrphans() {
    const store = this.store;
    const now = Date.now();
    for (const [id, t] of this.recentFresh) {
      if (now - t > FRESH_MS || !store.tasks[id]) this.recentFresh.delete(id);
    }
    const fresh = new Map();
    for (const id of this.recentFresh.keys()) {
      const r = store.tasks[id];
      if (r.ignored || store.laneOf(id)) continue;
      if (!fresh.has(r.h)) fresh.set(r.h, []);
      fresh.get(r.h).push(id);
    }
    if (!fresh.size) return;
    const missing = new Map();
    for (const [id, r] of Object.entries(store.tasks)) {
      if (!r.missingSince || !fresh.has(r.h)) continue;
      if (!missing.has(r.h)) missing.set(r.h, []);
      missing.get(r.h).push(id);
    }
    for (const [h, fids] of fresh) {
      const mids = missing.get(h);
      if (fids.length !== 1 || !mids || mids.length !== 1) continue;
      const [fid, mid] = [fids[0], mids[0]];
      const path = store.tasks[fid].path;
      store.rebind(fid, mid);
      this.recentFresh.delete(fid);
      for (const t of this.byPath.get(path) || []) if (t.id === fid) t.id = mid;
      this._invalidate();
    }
  }

  /** Tasks whose files are gone become "missing"; long-missing metadata is purged. */
  cleanup() {
    for (const p of this.store.knownPaths()) {
      if (!this.app.vault.getAbstractFileByPath(p)) for (const id of this.store.idsForPath(p)) this.store.markMissing(id);
    }
    return this.store.purgeMissing(STALE_MS);
  }

  /** Line number of task `id` inside `content`, or -1 if it cannot be located unambiguously. */
  locate(path, content, id) {
    const store = this.store;
    const open = parseTasks(content).filter((t) => !t.checked);
    const live = store.idsForPath(path).filter((x) => !store.tasks[x].missingSince);
    const m = reconcile(live.map((x) => store.tasks[x]), open);
    const n = m.findIndex((o) => o >= 0 && live[o] === id);
    return n < 0 ? -1 : open[n].line;
  }
}

module.exports = { TaskIndex };

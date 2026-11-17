'use strict';
// Plugin metadata kept via loadData()/saveData(). Markdown stays the source of truth
// for task content; here we only keep identity fingerprints (hashes, never text),
// lane/queue ordering, hidden state and settings.
//
// Schema (version 1):
// {
//   version: 1,
//   tasks:  { [id]: { path, h, cp, cn, w, l, ignored?, missingSince? } },
//   lanes:  { now: [id...], later: [id...], someday: [id...] },   // task order within cards and card order within lanes
//   noteLanes: { [notePath]: lane|'unassigned' },                  // lane assignment belongs to the card
//   queue:  [id...],                                              // membership + order
//   laneTitles: { [lane|'unassigned']: string },                 // user renames only; defaults live in constants
//   ui:     { activeTab, collapsed: { [notePath]: true } },
//   settings: { excludedFolders, excludedFiles, scanNonMarkdown, showSourceNames,
//               showUnassigned, autoAddToQueue }
// }
const { LANES, LANE_LABELS, LANE_COLORS, QUEUE_COLOR, TITLE_MAX, STALE_MS } = require('./constants');

const defaults = () => ({
  version: 1,
  tasks: {},
  lanes: { now: [], later: [], someday: [] },
  noteLanes: {},
  queue: [],
  laneTitles: {},
  ui: { activeTab: 'overview', collapsed: {} },
  settings: {
    excludedFolders: [],
    excludedFiles: [],
    scanNonMarkdown: false,
    laneColors: { ...LANE_COLORS },
    queueColor: QUEUE_COLOR,
    showSourceNames: true,
    showUnassigned: true,
    autoAddToQueue: true,
  },
});

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const strArr = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);

function normalize(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;
  if (isObj(raw.tasks)) {
    for (const [id, r] of Object.entries(raw.tasks)) {
      if (isObj(r) && typeof r.path === 'string' && typeof r.h === 'string') d.tasks[id] = r;
    }
  }
  const seen = new Set();
  const take = (arr) => strArr(arr).filter((id) => d.tasks[id] && !seen.has(id) && seen.add(id));
  if (isObj(raw.lanes)) for (const lane of LANES) d.lanes[lane] = take(raw.lanes[lane]);
  if (isObj(raw.noteLanes)) for (const [path, lane] of Object.entries(raw.noteLanes)) {
    if (typeof path === 'string' && [...LANES, 'unassigned'].includes(lane)) d.noteLanes[path] = lane;
  }
  const seenQ = new Set();
  d.queue = strArr(raw.queue).filter((id) => d.tasks[id] && !seenQ.has(id) && seenQ.add(id));
  if (isObj(raw.laneTitles)) {
    for (const k of [...LANES, 'unassigned']) {
      const t = typeof raw.laneTitles[k] === 'string' ? raw.laneTitles[k].trim().slice(0, TITLE_MAX) : '';
      if (t && t !== LANE_LABELS[k]) d.laneTitles[k] = t;
    }
  }
  if (isObj(raw.ui) && ['overview', 'queue'].includes(raw.ui.activeTab)) d.ui.activeTab = raw.ui.activeTab;
  if (isObj(raw.ui) && isObj(raw.ui.collapsed)) {
    for (const [k, v] of Object.entries(raw.ui.collapsed)) if (v === true) d.ui.collapsed[k] = true;
  }
  if (isObj(raw.settings)) {
    const s = raw.settings;
    d.settings.excludedFolders = strArr(s.excludedFolders);
    d.settings.excludedFiles = strArr(s.excludedFiles);
    for (const k of ['scanNonMarkdown', 'showSourceNames', 'showUnassigned', 'autoAddToQueue']) {
      if (typeof s[k] === 'boolean') d.settings[k] = s[k];
    }
    if (isObj(s.laneColors)) for (const [lane, color] of Object.entries(LANE_COLORS)) {
      if (typeof s.laneColors[lane] === 'string' && /^#[\da-f]{6}$/i.test(s.laneColors[lane])) d.settings.laneColors[lane] = s.laneColors[lane];
    }
    if (typeof s.queueColor === 'string' && /^#[\da-f]{6}$/i.test(s.queueColor)) d.settings.queueColor = s.queueColor;
  }
  return d;
}

class TaskStore {
  constructor(raw, save, saveDelay = 800) {
    this.data = normalize(raw);
    this.tasks = this.data.tasks;
    this.save = save;
    this.saveDelay = saveDelay;
    this.onChange = null;
    this._timer = null;
    this._byPath = new Map();
    for (const [id, r] of Object.entries(this.tasks)) this._link(id, r.path);
  }

  // ---- persistence -------------------------------------------------------
  change() {
    if (!this._timer) this._timer = setTimeout(() => this.flush(), this.saveDelay);
    if (this.onChange) this.onChange();
  }
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    return this.save(this.data);
  }

  // ---- path index --------------------------------------------------------
  _link(id, path) {
    if (!this._byPath.has(path)) this._byPath.set(path, new Set());
    this._byPath.get(path).add(id);
  }
  _unlink(id, path) {
    const s = this._byPath.get(path);
    if (s) { s.delete(id); if (!s.size) this._byPath.delete(path); }
  }
  idsForPath(path) { return [...(this._byPath.get(path) || [])]; }
  knownPaths() { return [...this._byPath.keys()]; }

  // ---- records -----------------------------------------------------------
  _newId() {
    let id;
    do { id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); } while (this.tasks[id]);
    return id;
  }
  _fill(rec, t) { rec.h = t.h; rec.cp = t.cp; rec.cn = t.cn; rec.w = t.w; rec.l = t.line; }

  createRecord(path, t) {
    const id = this._newId();
    const rec = { path };
    this._fill(rec, t);
    this.tasks[id] = rec;
    this._link(id, path);
    const lane = this.data.noteLanes[path];
    if (lane && lane !== 'unassigned') this.data.lanes[lane].push(id);
    if (this.data.settings.autoAddToQueue) this.data.queue.push(id);
    this.change();
    return id;
  }
  updateRecord(id, path, t) {
    const rec = this.tasks[id];
    if (rec.path !== path) { this._unlink(id, rec.path); rec.path = path; this._link(id, path); }
    this._fill(rec, t);
    delete rec.missingSince;
    this.change();
  }
  markMissing(id) {
    const rec = this.tasks[id];
    if (rec && !rec.missingSince) { rec.missingSince = Date.now(); this.change(); }
  }
  deleteRecord(id) {
    const rec = this.tasks[id];
    if (!rec) return;
    this._unlink(id, rec.path);
    delete this.tasks[id];
    this._removeFromLanes(id);
    this._removeFromQueue(id);
    this.change();
  }
  /** A just-created record `freshId` turned out to be the moved task `oldId`: keep oldId's metadata. */
  rebind(freshId, oldId) {
    const fr = this.tasks[freshId];
    const od = this.tasks[oldId];
    if (od.path !== fr.path) { this._unlink(oldId, od.path); od.path = fr.path; this._link(oldId, od.path); }
    od.h = fr.h; od.cp = fr.cp; od.cn = fr.cn; od.w = fr.w; od.l = fr.l;
    delete od.missingSince;
    this.deleteRecord(freshId);
  }
  movePath(oldPath, newPath) {
    for (const id of this.idsForPath(oldPath)) {
      this._unlink(id, oldPath);
      this.tasks[id].path = newPath;
      this._link(id, newPath);
    }
    if (this.data.noteLanes[oldPath]) {
      this.data.noteLanes[newPath] = this.data.noteLanes[oldPath];
      delete this.data.noteLanes[oldPath];
    }
    this.change();
  }
  movePrefix(oldPrefix, newPrefix) {
    for (const p of this.knownPaths()) {
      if (p.startsWith(oldPrefix)) this.movePath(p, newPrefix + p.slice(oldPrefix.length));
    }
  }
  /** Drop metadata for tasks missing longer than `maxAge` ms (0 = all missing). Returns count. */
  purgeMissing(maxAge = STALE_MS) {
    const cutoff = Date.now() - maxAge;
    let n = 0;
    for (const [id, r] of Object.entries(this.tasks)) {
      if (r.missingSince && r.missingSince <= cutoff) { this.deleteRecord(id); n++; }
    }
    return n;
  }

  // ---- lanes -------------------------------------------------------------
  lane(name) { return this.data.lanes[name]; }
  laneMap() {
    const m = new Map();
    for (const lane of LANES) for (const id of this.data.lanes[lane]) m.set(id, lane);
    return m;
  }
  laneOf(id) { return this.laneMap().get(id) || null; }
  _removeFromLanes(id) {
    for (const lane of LANES) {
      const a = this.data.lanes[lane];
      const i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1);
    }
  }
  /** Place id in `lane` (or null = unassigned), before `beforeId` or at the end. */
  moveToLane(id, lane, beforeId = null) {
    if (!this.tasks[id]) return;
    this.moveTasksToLane(this.idsForPath(this.tasks[id].path), lane, beforeId);
  }

  /** Move several tasks together (a note card), keeping their order. */
  moveTasksToLane(ids, lane, beforeId = null) {
    const paths = new Set(ids.map((id) => this.tasks[id]?.path).filter(Boolean));
    const list = [...paths].flatMap((path) => this.idsForPath(path).filter((id) => !this.tasks[id].missingSince));
    if (!list.length) return;
    for (const id of list) this._removeFromLanes(id);
    for (const path of paths) this.data.noteLanes[path] = lane || 'unassigned';
    if (lane) {
      const a = this.data.lanes[lane];
      const i = beforeId ? a.indexOf(beforeId) : -1;
      if (i < 0) a.push(...list); else a.splice(i, 0, ...list);
    }
    this.change();
  }

  syncNoteLane(path, openIds) {
    const ids = openIds.filter((id) => this.tasks[id] && !this.tasks[id].missingSince);
    if (!ids.length) return;
    const assignments = this.laneMap();
    let lane = this.data.noteLanes[path];
    if (!lane) {
      const existing = new Set(ids.map((id) => assignments.get(id) || 'unassigned'));
      lane = existing.size === 1 ? existing.values().next().value : 'unassigned';
      this.data.noteLanes[path] = lane;
      this.change();
    }
    if (ids.every((id) => (assignments.get(id) || 'unassigned') === lane)) return;
    for (const id of ids) this._removeFromLanes(id);
    if (lane !== 'unassigned') this.data.lanes[lane].push(...ids);
    this.change();
  }

  // ---- queue -------------------------------------------------------------
  queueIds() { return this.data.queue; }
  inQueue(id) { return this.data.queue.includes(id); }
  _removeFromQueue(id) {
    const i = this.data.queue.indexOf(id);
    if (i >= 0) this.data.queue.splice(i, 1);
  }
  /** Add or move id within the queue, before `beforeId` or at the end. */
  placeInQueue(id, beforeId = null) {
    if (!this.tasks[id]) return;
    this._removeFromQueue(id);
    const i = beforeId ? this.data.queue.indexOf(beforeId) : -1;
    if (i < 0) this.data.queue.push(id); else this.data.queue.splice(i, 0, id);
    this.change();
  }
  removeFromQueue(id) { this._removeFromQueue(id); this.change(); }

  // ---- hidden ------------------------------------------------------------
  isIgnored(id) { return !!(this.tasks[id] && this.tasks[id].ignored); }
  setIgnored(id, v) {
    const r = this.tasks[id];
    if (!r) return;
    if (v) r.ignored = true; else delete r.ignored;
    this.change();
  }
  setIgnoredMany(ids, v) {
    for (const id of ids) {
      const r = this.tasks[id];
      if (!r) continue;
      if (v) r.ignored = true; else delete r.ignored;
    }
    this.change();
  }
  restoreAllIgnored() {
    let n = 0;
    for (const r of Object.values(this.tasks)) if (r.ignored) { delete r.ignored; n++; }
    if (n) this.change();
    return n;
  }

  // ---- lane titles -------------------------------------------------------
  laneTitle(key) { return this.data.laneTitles[key] || LANE_LABELS[key]; }
  /** Rename a lane. Empty text (or the default name) restores the default. */
  setLaneTitle(key, title) {
    const t = String(title || '').trim().slice(0, TITLE_MAX);
    if (!t || t === LANE_LABELS[key]) delete this.data.laneTitles[key];
    else this.data.laneTitles[key] = t;
    this.change();
  }

  // ---- settings / ui -----------------------------------------------------
  get settings() { return this.data.settings; }
  setSetting(key, value) { this.data.settings[key] = value; this.change(); }
  get ui() { return this.data.ui; }
  isCollapsed(path) { return !!this.data.ui.collapsed[path]; }
  toggleCollapsed(path) {
    if (this.data.ui.collapsed[path]) delete this.data.ui.collapsed[path]; else this.data.ui.collapsed[path] = true;
    this.change();
  }
  setActiveTab(tab) { this.data.ui.activeTab = tab; this.change(); }
}

module.exports = { TaskStore, normalize, defaults };

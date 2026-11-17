'use strict';
const { Plugin, Events, Notice, TFile, TFolder, Keymap } = require('obsidian');
const { PLUGIN_NAME, VIEW_TYPE, RIBBON_ICON } = require('./constants');
const { TaskStore } = require('./task-storage');
const { TaskIndex } = require('./task-index');
const { checkLine } = require('./task-discovery');
const { DashboardView } = require('./dashboard-view');
const { TaskOverviewSettingTab } = require('./settings');

module.exports = class TaskOverviewPlugin extends Plugin {
  async onload() {
    this.events = new Events();
    this.store = new TaskStore(await this.loadPluginData(), (d) => this.saveData(d));
    this.index = new TaskIndex(this.app, this.store, this.events);
    this.store.onChange = () => this.index.emit();

    this.registerView(VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.addRibbonIcon(RIBBON_ICON, `Open ${PLUGIN_NAME}`, () => this.activateView());
    this.addCommand({ id: 'open-dashboard', name: 'Open dashboard', callback: () => this.activateView() });
    this.addCommand({ id: 'rescan-vault', name: 'Rescan vault for tasks', callback: () => this.index.fullScan({ force: true }) });
    this.addCommand({
      id: 'cleanup-stale-data',
      name: 'Clean up stale task data',
      callback: () => new Notice(`${PLUGIN_NAME}: removed data for ${this.store.purgeMissing(0)} vanished task(s).`),
    });
    this.addSettingTab(new TaskOverviewSettingTab(this.app, this));

    // Wait for layout so we don't process a 'create' event for every existing file at startup.
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.index.fullScan();
    });
  }

  onunload() {
    this.index.dispose();
    this.store.flush();
  }

  async loadPluginData() {
    const data = await this.loadData();
    if (data != null) return data;
    try {
      const previous = JSON.parse(await this.app.vault.adapter.read('.obsidian/plugins/task-overview/data.json'));
      if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
        await this.saveData(previous);
        return previous;
      }
    } catch (_) { /* No previous installation to migrate. */ }
    return data;
  }

  registerVaultEvents() {
    const vault = this.app.vault;
    const idx = this.index;
    this.registerEvent(vault.on('modify', (f) => { if (f instanceof TFile) idx.scheduleReindex(f); }));
    this.registerEvent(vault.on('create', (f) => { if (f instanceof TFile) idx.scheduleReindex(f); }));
    this.registerEvent(vault.on('delete', (f) => idx.handleDelete(f.path, f instanceof TFolder)));
    this.registerEvent(vault.on('rename', (f, oldPath) => idx.handleRename(f, oldPath, f instanceof TFolder)));
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Tick the checkbox in the source note (atomically), then drop the task's metadata. */
  async completeTask(id) {
    const task = this.index.getTask(id);
    const file = task && this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      new Notice(`${PLUGIN_NAME}: that task's note no longer exists.`);
      return false;
    }
    let ok = false;
    this.index.pending.add(id);
    try {
      await this.app.vault.process(file, (data) => {
        const line = this.index.locate(file.path, data, id);
        const out = line < 0 ? null : checkLine(data, line);
        if (out === null) throw new Error('task could not be located');
        return out;
      });
      ok = true;
    } catch (e) {
      console.error(`[${PLUGIN_NAME}]`, e);
      new Notice(`${PLUGIN_NAME}: couldn't complete that task because the note changed. Rescanning; nothing was modified.`);
    } finally {
      this.index.pending.delete(id);
    }
    if (ok) this.store.deleteRecord(id);
    await this.index.reindexFile(file);
    return ok;
  }

  async openTask(id, evt) {
    const task = this.index.getTask(id);
    const file = task && this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return;
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType('markdown').find((l) => l.view.file && l.view.file.path === file.path);
    const leaf = existing && !Keymap.isModEvent(evt) ? existing : ws.getLeaf(Keymap.isModEvent(evt) || 'tab');
    await leaf.openFile(file, { eState: { line: task.line } });
    ws.revealLeaf(leaf);
  }
};

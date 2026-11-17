'use strict';
const { PluginSettingTab, Setting } = require('obsidian');
const { PLUGIN_NAME, LANES, LANE_LABELS, LANE_COLORS } = require('./constants');
const { displayText } = require('./task-discovery');

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

class TaskOverviewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const { store, index } = this.plugin;
    containerEl.empty();
    let timer = null;
    const setList = (key, value) => {
      store.setSetting(key, lines(value));
      clearTimeout(timer);
      timer = setTimeout(() => index.fullScan(), 600);
    };

    new Setting(containerEl).setName('Scanning').setHeading();
    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One folder per line, relative to the vault root. Tasks inside are ignored.')
      .addTextArea((t) => t.setPlaceholder('Archive\nTemplates').setValue(store.settings.excludedFolders.join('\n')).onChange((v) => setList('excludedFolders', v)));
    new Setting(containerEl)
      .setName('Excluded files')
      .setDesc('One file path per line, relative to the vault root (the .md extension is optional).')
      .addTextArea((t) => t.setPlaceholder('Inbox/scratch.md').setValue(store.settings.excludedFiles.join('\n')).onChange((v) => setList('excludedFiles', v)));
    new Setting(containerEl)
      .setName('Also scan .txt files')
      .setDesc('Markdown notes are always scanned. Turn this on to include plain-text (.txt) files. Attachments such as PDFs and images are never scanned.')
      .addToggle((t) => t.setValue(store.settings.scanNonMarkdown).onChange((v) => {
        store.setSetting('scanNonMarkdown', v);
        index.fullScan();
      }));

    new Setting(containerEl).setName('Display').setHeading();
    new Setting(containerEl).setName('Lane colors').setDesc('Choose the accent color used for each lane.');
    for (const lane of [...LANES, 'unassigned']) {
      new Setting(containerEl)
        .setName(LANE_LABELS[lane])
        .addColorPicker((picker) => picker
          .setValue(store.settings.laneColors[lane])
          .onChange((value) => {
            if (/^#[\da-f]{6}$/i.test(value)) store.setSetting('laneColors', { ...store.settings.laneColors, [lane]: value });
          }))
        .addButton((button) => button
          .setButtonText('Reset')
          .setTooltip(`Reset ${LANE_LABELS[lane]} color`)
          .onClick(() => store.setSetting('laneColors', { ...store.settings.laneColors, [lane]: LANE_COLORS[lane] })));
    }
    new Setting(containerEl)
      .setName('Add new tasks to the queue automatically')
      .setDesc('Newly discovered tasks join the end of the queue. They are never reordered for you.')
      .addToggle((t) => t.setValue(store.settings.autoAddToQueue).onChange((v) => store.setSetting('autoAddToQueue', v)));

    new Setting(containerEl).setName('Hidden tasks').setHeading();
    const hidden = index.allTasks().filter((t) => store.isIgnored(t.id));
    if (!hidden.length) containerEl.createEl('p', { cls: 'setting-item-description', text: 'No tasks are hidden.' });
    for (const task of hidden) {
      new Setting(containerEl)
        .setName(displayText(task.text))
        .setDesc(task.path)
        .addButton((b) => b.setButtonText('Restore').onClick(() => { store.setIgnored(task.id, false); this.display(); }));
    }
    if (hidden.length) {
      new Setting(containerEl).addButton((b) => b.setButtonText('Restore all').onClick(() => { store.restoreAllIgnored(); this.display(); }));
    }

    new Setting(containerEl).setName('Maintenance').setHeading();
    new Setting(containerEl)
      .setName('Rescan vault')
      .addButton((b) => b.setButtonText('Rescan').onClick(() => index.fullScan({ force: true })));
    new Setting(containerEl)
      .setName('Clean up stale data')
      .setDesc(`Forget lane, queue and hidden settings for tasks that disappeared from your notes. ${PLUGIN_NAME} otherwise keeps them for 30 days in case a task is moved or un-ticked.`)
      .addButton((b) => b.setButtonText('Clean up').onClick(() => {
        const n = store.purgeMissing(0);
        b.setButtonText(`Removed ${n}`);
      }));
  }
}

module.exports = { TaskOverviewSettingTab };

'use strict';
const { PluginSettingTab, Setting } = require('obsidian');
const { PLUGIN_NAME, LANES, LANE_LABELS, LANE_COLORS, QUEUE_COLOR } = require('./constants');
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
      .setDesc('Folders to skip when finding tasks. Use paths relative to the vault root; your notes are unchanged.')
      .addTextArea((t) => t.setPlaceholder('Archive\nTemplates').setValue(store.settings.excludedFolders.join('\n')).onChange((v) => setList('excludedFolders', v)));
    new Setting(containerEl)
      .setName('Excluded files')
      .setDesc('Files to skip when finding tasks. Use paths relative to the vault root; .md is optional.')
      .addTextArea((t) => t.setPlaceholder('Inbox/scratch.md').setValue(store.settings.excludedFiles.join('\n')).onChange((v) => setList('excludedFiles', v)));
    new Setting(containerEl)
      .setName('Also scan .txt files')
      .setDesc('Scan plain-text (.txt) files alongside Markdown notes.')
      .addToggle((t) => t.setValue(store.settings.scanNonMarkdown).onChange((v) => {
        store.setSetting('scanNonMarkdown', v);
        index.fullScan();
      }));

    new Setting(containerEl).setName('Display').setHeading();
    new Setting(containerEl).setName('Board colors').setDesc('Choose an accent color for each section.');
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
      .setName('Task queue background')
      .setDesc('Choose a background color for the queue.')
      .addColorPicker((picker) => picker.setValue(store.settings.queueColor).onChange((value) => {
        if (/^#[\da-f]{6}$/i.test(value)) store.setSetting('queueColor', value);
      }))
      .addButton((button) => button
        .setButtonText('Reset')
        .setTooltip('Reset task queue background')
        .onClick(() => store.setSetting('queueColor', QUEUE_COLOR)));
    new Setting(containerEl)
      .setName('Add new tasks to the queue automatically')
      .setDesc('New tasks go to the end. Existing tasks keep their order.')
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
      .setName('Clear saved data for missing tasks')
      .setDesc('The plugin keeps a missing task’s lane, queue position, and hidden status for 30 days in case it’s moved or reopened. Clear this data now; your notes won’t change.')
      .addButton((b) => b.setButtonText('Remove now').onClick(() => {
        const n = store.purgeMissing(0);
        b.setButtonText(`Removed data for ${n} task${n === 1 ? '' : 's'}`);
      }));
  }
}

module.exports = { TaskOverviewSettingTab };

import _ from 'lodash'
import { DateTime } from 'luxon'
import {
  App,
  Menu,
  Modal,
  Notice,
  Plugin,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
} from 'obsidian'
import { processImports } from './importer'

export default class NotionImport extends Plugin {
  onload() {
    this.registerEvent(
      app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return

        menu.addItem((item) => {
          item
            .setTitle('Convert Notion to Obsidian')
            .onClick(() => new ImportOptions(this.app, this, file.path).open())
        })
      })
    )
  }
}

class ImportOptions extends Modal {
  plugin: NotionImport
  targetDirectory: string
  addTags: boolean
  keepLinkMetadata: boolean

  constructor(app: App, plugin: NotionImport, targetDirectory: string) {
    super(app)
    this.plugin = plugin
    this.targetDirectory = targetDirectory
    this.addTags = false
  }

  onOpen(): void {
    let { contentEl } = this
    new Setting(contentEl)
      .setName('Target Directory')
      .addText(
        (text) =>
          (text
            .setValue(this.targetDirectory)
            .setDisabled(true).inputEl.style.width = '100%')
      )
    new Setting(contentEl).addButton((button) =>
      button.setButtonText('Convert').onClick(() => this.importFiles())
    )
  }

  async importFiles() {
    if (!confirm('Overwrite files in this folder?')) return

    this.contentEl.empty()
    const loadingDiv = this.contentEl.createDiv()
    this.contentEl.appendChild(loadingDiv)
    loadingDiv.setText('loading...')

    await processImports(this.app, this.targetDirectory, this.addTags)

    this.close()
    new Notice(
      `Converted ${this.targetDirectory} and subfolders to Obsidian format`
    )
  }
}

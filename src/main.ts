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
      .setName('Tags')
      .setDesc(
        'Convert database selects, multi-selects, and statuses to nested tags (example: Status: Done becomes #status/done)'
      )
      .addToggle((toggle) => toggle.onChange((value) => (this.addTags = value)))
    new Setting(contentEl)
      .setName('Relations in frontmatter')
      .setDesc(
        'Keep relations listed in frontmatter properties (will also store them as Obsidian links)'
      )
      .addToggle((toggle) =>
        toggle.onChange((value) => (this.keepLinkMetadata = value))
      )
    new Setting(contentEl).addButton((button) =>
      button.setButtonText('Convert').onClick(() => this.importFiles())
    )
  }

  private isNotionId = (id: string) => / ?[a-z0-9]{32}(\.(md|csv))?$/.test(id)

  private stripNotionId = (id: string) => {
    return id.replace(/ ?[a-z0-9]{32}(\.(md|csv))?$/, '')
  }

  private getNotionId = (id: string) => {
    return id.replace(/(\.(md|csv))?$/, '').match(/[a-z0-9]{32}$/)?.[0]
  }

  async importFiles() {
    if (!confirm('Overwrite files in this folder?')) return

    this.contentEl.empty()
    const loadingDiv = this.contentEl.createDiv()
    this.contentEl.appendChild(loadingDiv)
    loadingDiv.setText('loading...')

    const files = app.vault
      .getAllLoadedFiles()
      .filter(
        (file) =>
          file.path.startsWith(this.targetDirectory) &&
          file.path.endsWith('.md') &&
          this.isNotionId(file.path)
      )

    const idsToTitles: Record<string, string> = {}

    for (let file of files) {
      await new Promise((res) => {
        app.vault.read(file as TFile).then((text) => {
          const title = text.match(/^# (.*)\n/)?.[1]
          const id = this.getNotionId(file.name)

          if (!id || !title) {
            res(false)
            return
          }
          idsToTitles[id] = title.replace(/[\/\\:]/g, '-')
          res(true)
        })
      })
    }

    await Promise.all(
      files.map(
        (file) =>
          new Promise((res) =>
            app.vault.read(file as TFile).then((text) => {
              const id = this.getNotionId(file.name)
              if (!id) return
              const title = idsToTitles[id]

              const titleHeading = /^.*?\n\n/
              text = text.replace(titleHeading, '')
              let content = ''
              if (/\n\n/.test(text)) {
                content = text.slice(text.indexOf('\n\n') + 2)
                text = text.slice(0, text.indexOf('\n\n'))
              }
              let splitText = text.match(/^.+?: .*(\n!(.+?:).*)*?/gm) || []

              let lastProperty = splitText.findIndex(
                (prop, i) =>
                  !/^.+?: /.test(prop) &&
                  (!splitText[i + 1] || !/^.+?: /.test(splitText[i + 1]))
              )
              if (lastProperty === -1) lastProperty = splitText.length
              else lastProperty += 1
              // const content = splitText.slice(lastProperty)

              const propertiesFiltered = splitText
                .slice(0, lastProperty)
                .map((prop) => prop.match(/(^.+?): (.*)/)?.slice(1))
                .filter((x) => x && x.length === 2) as [string, string][]
              const propertyMap: Record<string, string> = {}
              const listedProperties: Record<string, string> = {}

              const tags: string[] = []

              propertiesFiltered.forEach(([title, prop]) => {
                prop = prop.replace('\n', ' ')
                if (!DateTime.fromFormat(prop, 'DDD t').invalidReason) {
                  // date
                  const time = DateTime.fromFormat(prop, 'DDD t')
                  propertyMap[title] =
                    time.hour === 0 && time.minute === 0
                      ? (time.toISODate() as string)
                      : (time.toISO({
                          includeOffset: false,
                          suppressMilliseconds: true,
                        }) as string)
                } else if (/^(Yes|No)$/.test(prop)) {
                  // checklist
                  propertyMap[title] = {
                    Yes: 'true',
                    No: 'false',
                  }[prop] as string
                } else if (
                  !prop
                    .split(', ')
                    .map((link) => this.isNotionId(link))
                    .includes(false)
                ) {
                  // relation
                  const relationProp = prop.split(', ').map((link) => {
                    const notionId = this.getNotionId(link)
                    if (!notionId) return link
                    return idsToTitles[notionId]
                  })
                  propertyMap[title] = relationProp
                    .map((x) => `[[${x}]]`)
                    .join(', ')
                } else {
                  // inline links
                  const matches = prop
                    .split(' ')
                    .filter((x) => this.isNotionId(x))

                  if (matches.length > 0) {
                    for (let match of matches) {
                      const id = this.getNotionId(decodeURI(match))
                      if (!id || !idsToTitles[id]) continue
                      prop = prop.replace(match, '[[' + idsToTitles[id] + ']]')
                    }
                    listedProperties[title] = prop
                  } else if (
                    /^([a-zA-Z0-9 ]+(, |$))+$/.test(prop) &&
                    this.addTags
                  ) {
                    // list
                    const thisTags = prop
                      .split(', ')
                      .filter((tag) => tag.split(/\s/).length < 3)
                    tags.push(
                      ...thisTags.map((tag) =>
                        `${title.split(' ').join('-')}/${tag
                          .split(' ')
                          .join('-')}`.toLowerCase()
                      )
                    )
                    if (thisTags.length > 1)
                      propertyMap[title] = thisTags
                        .map((tag) => `${tag}`)
                        .join('')
                    else if (thisTags.length === 1)
                      propertyMap[title] = thisTags[0]
                    else propertyMap[title] = prop
                  } else {
                    propertyMap[title] = prop
                  }
                }
              })

              if (this.addTags && tags.length > 0)
                propertyMap['tags'] = '[' + tags.join(', ') + ']'

              const newText =
                (_.keys(propertyMap).length > 0
                  ? '---\n' +
                    _.entries(propertyMap)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join('\n') +
                    '\n---\n\n'
                  : '') +
                (_.keys(listedProperties).length > 0
                  ? _.entries(listedProperties)
                      .map(([key, value]) => key + ':: ' + value)
                      .join(', ') + '\n'
                  : '') +
                content
              const newTitle = (file.parent?.path ?? '') + '/' + title + '.md'

              app.vault.modify(file as TFile, newText)
              app.vault.rename(file, newTitle)
              res(true)
            })
          )
      )
    )

    const folders = app.vault
      .getAllLoadedFiles()
      .filter(
        (file) =>
          file.path.startsWith(this.targetDirectory) &&
          this.isNotionId(file.path) &&
          !file.name.includes('.')
      )
    for (let folder of folders) {
      await app.vault.rename(
        folder,
        (folder.parent?.path ?? '') + '/' + this.stripNotionId(folder.name)
      )
    }

    const duplicateFiles = app.vault
      .getAllLoadedFiles()
      .filter(
        (file) =>
          file.path.startsWith(this.targetDirectory) &&
          this.isNotionId(file.path) &&
          file.path.endsWith('.md')
      )
    for (let file of duplicateFiles) {
      let i = 2
      while (true) {
        try {
          await app.vault.rename(
            file,
            `${file.parent?.path ?? ''}/${this.stripNotionId(
              file.name
            )} ${i}.md`
          )
          break
        } catch {
          i += 1
          if (i > 10) break
        }
      }
    }

    this.close()
    new Notice(
      `Converted ${this.targetDirectory} and subfolders to Obsidian format`
    )
  }
}

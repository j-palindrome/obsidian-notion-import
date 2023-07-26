import _ from 'lodash'
import { DateTime } from 'luxon'
import { App, TFile, TFolder, normalizePath } from 'obsidian'
import { parse } from 'papaparse'

const isNotionId = (id: string) => / ?[a-z0-9]{32}(\.(md|csv))?$/.test(id)

const stripNotionId = (id: string) => {
  return id.replace(/ ?[a-z0-9]{32}(\.(md|csv))?$/, '')
}

const getNotionId = (id: string) => {
  return id.replace(/(\.(md|csv))?$/, '').match(/[a-z0-9]{32}$/)?.[0]
}

type Property = (
  | { type: 'text'; content: string }
  | { type: 'date'; content: DateTime }
  | { type: 'number'; content: number }
  | { type: 'list'; content: string[] }
  | { type: 'checkbox'; content: boolean }
) & { title: string }

export async function processImports(app: App, targetDirectory: string) {
  const paths = app.vault
    .getAllLoadedFiles()
    .filter(
      (file) => file.path.startsWith(targetDirectory) && isNotionId(file.path)
    )

  const markdownFiles = paths.filter(
    (file) => file instanceof TFile && file.extension === 'md'
  ) as TFile[]
  const folders = paths.filter((file) => file instanceof TFolder) as TFolder[]

  const idsToTitles: Record<string, string> = {}
  await Promise.all(
    markdownFiles.map((file) => async () => {
      app.vault.read(file).then((text) => {
        const title = text.match(/^# (.*)\n/)?.[1]
        const id = getNotionId(file.name)

        if (!id || !title) {
          return
        }
        idsToTitles[id] = title.replace(/[\/\\:]/g, '-')
      })
    })
  )

  await Promise.all(
    markdownFiles.map((file) => processFile(file, { idsToTitles, app }))
  )

  for (let folder of folders) {
    await app.vault.rename(
      folder,
      (folder.parent?.path ?? '') + '/' + stripNotionId(folder.name)
    )
  }

  const duplicateFiles = app.vault
    .getAllLoadedFiles()
    .filter(
      (file) =>
        file.path.startsWith(targetDirectory) &&
        isNotionId(file.path) &&
        file.path.endsWith('.md')
    )

  for (let file of duplicateFiles) {
    let i = 2
    while (true) {
      try {
        await app.vault.rename(
          file,
          `${file.parent?.path ?? ''}/${stripNotionId(file.name)} ${i}.md`
        )
        break
      } catch {
        i += 1
        if (i > 10) break
      }
    }
  }
}

const processFile =
  (
    file: TFile,
    {
      idsToTitles,
      app,
    }: {
      idsToTitles: Record<string, string>
      app: App
    }
  ) =>
  async () => {
    let text = await app.vault.read(file)
    const id = getNotionId(file.name)
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

    const propertiesFiltered = splitText
      .slice(0, lastProperty)
      .map((prop) => prop.match(/(^.+?): (.*)/)?.slice(1))
      .filter((x) => x && x.length === 2) as [string, string][]
    const propertyMap: Record<string, string> = {}
    const listedProperties: Record<string, string> = {}

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
          .map((link) => isNotionId(link))
          .includes(false)
      ) {
        // relation
        const relationProp = prop.split(', ').map((link) => {
          const notionId = getNotionId(link)
          if (!notionId) return link
          return idsToTitles[notionId]
        })
        propertyMap[title] = relationProp.map((x) => `[[${x}]]`).join(', ')
      } else {
        // inline links
        const matches = prop.split(' ').filter((x) => isNotionId(x))

        if (matches.length > 0) {
          for (let match of matches) {
            const id = getNotionId(decodeURI(match))
            if (!id || !idsToTitles[id]) continue
            prop = prop.replace(match, '[[' + idsToTitles[id] + ']]')
          }
          listedProperties[title] = prop
        } else {
          propertyMap[title] = prop
        }
      }
    })

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
  }

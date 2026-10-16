/** Merge owned Cairn policy/roles without replacing unrelated user plugins. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseDocument, isMap, isSeq } from 'yaml'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] }
function rows(node) {
  if (!isSeq(node)) return []
  return node.items.flatMap(row => isMap(row) ? [row, ...rows(row.get('config', true))] : [])
}
function config(row, doc) {
  let value = row.get('config', true)
  if (!isMap(value)) { value = doc.createNode({}); row.set('config', value) }
  return value
}
export async function installPreset(home, dryRun = false) {
  const directory = join(home, '.agent-presets/cairn')
  const destination = join(directory, 'agent.cordis.yml')
  const source = await readFile(join(root, 'preset/agent.cordis.yml'), 'utf8')
  let previous
  try { previous = await readFile(destination, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const doc = parseDocument(previous ?? source, options)
  const template = parseDocument(source, options)
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Cairn preset is not a valid sequence; no files changed')
  const targetRows = rows(doc.contents)
  const sourceRows = rows(template.contents)
  const owned = ['persona', 'tool-subagent', 'tool-subagent-fork', 'cairn-search']
  for (const id of owned) {
    const incoming = sourceRows.find(row => row.get('id') === id)
    const existing = targetRows.find(row => row.get('id') === id)
    if (!existing) {
      // Do not invent optional providers in a customized delegation composition.
      if (id === 'cairn-search' || id === 'persona') doc.contents.add(incoming.clone())
      continue
    }
    const into = config(existing, doc)
    const from = config(incoming, template)
    if (id === 'cairn-search') {
      for (const key of ['maxOpenIntents', 'maxConcurrent', 'maxAttempts', 'maxExplorations']) if (!into.has(key)) into.set(key, from.get(key))
    } else {
      // Runtime enforces dispatch restrictions even in customized catalogs.
      // Copy only the role here: toolFilter names must match that deployment's tools.
      const key = id === 'persona' ? 'prefix' : 'persona'
      const next = from.get(key)
      const current = into.get(key)
      if (typeof current !== 'string' || !current.includes(next)) {
        const marker = 'Cairn protocol v2 replaces earlier bootstrap and delegation instructions:'
        const end = '[End of managed Cairn role]'
        let prefix = typeof current === 'string' ? current : ''
        let suffix = ''
        const start = prefix.indexOf(marker)
        if (start >= 0) {
          const finish = prefix.indexOf(end, start)
          if (finish >= 0) suffix = prefix.slice(finish + end.length)
          prefix = prefix.slice(0, start).trimEnd()
        }
        const value = doc.createNode(prefix ? `${prefix}\n\n${marker}\n${next}\n${end}${suffix}` : next)
        value.type = 'BLOCK_LITERAL'
        into.set(key, value)
      }
    }
  }
  const next = doc.toString()
  if (parseDocument(next, options).errors.length) throw new Error('Updated preset failed YAML validation; no files changed')
  const changes = []
  const stamp = `${Date.now()}-${process.pid}`
  async function update(path, text, old) {
    if (old === text) return
    changes.push(path)
    if (dryRun) return
    await mkdir(dirname(path), { recursive: true })
    if (old !== undefined) await copyFile(path, `${path}.${stamp}.bak`)
    await writeFile(path, text)
  }
  await update(destination, next, previous)
  for (const name of ['state-space-search', 'cairn-explorer']) {
    const path = join(directory, 'skills', name, 'SKILL.md')
    let old
    try { old = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await update(path, await readFile(join(root, 'preset/skills', name, 'SKILL.md'), 'utf8'), old)
  }
  return changes
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changes = await installPreset(process.env.DSH_HOME ?? join(homedir(), '.dsh'), process.argv.includes('--dry-run'))
  console.log(JSON.stringify({ changed: changes, dryRun: process.argv.includes('--dry-run'), reloadRequired: changes.length > 0 }, null, 2))
}

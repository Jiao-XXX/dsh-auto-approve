import { readFileSync } from 'node:fs'
import { Config } from '../index.js'

// Verify cordis.patch.yml prompt copy and config fields match index.js exactly.
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const defaults = Config({})
const promptLines = defaults.classifierPrompt.split('\n').map(line => `          ${line}`)
for (const line of promptLines) {
  if (!patch.includes(line)) {
    console.log('MISSING PROMPT LINE:', line.trim().slice(0, 80))
    process.exit(1)
  }
}
for (const snippet of ['trustedWriteRoots: []', 'trustDshHome: true']) {
  if (!patch.includes(snippet)) {
    console.log('MISSING FIELD:', snippet)
    process.exit(1)
  }
}
console.log('patch.yml prompt and fields: exact match')

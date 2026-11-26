#!/usr/bin/env node
/**
 * One-time migration: give the existing prediction errors a direction.
 *
 * Schema 2 makes a prediction error signed (better / worse). The old graph was
 * written before the field existed; its errors were negative by construction,
 * so they become `worse`. This is a format migration, not a correction, and it
 * is safe to run again: a schema-2 document is left alone.
 *
 * Usage:
 *   node scripts/migrate-peg.mjs [workspace] [--dry-run]
 *
 * A timestamped `.bak-…` copy is written beside the graph before the change.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { migratePegDocument } from '../lib/index.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((arg) => !arg.startsWith('--'))
const workspace = path.resolve(positional[0] ?? process.cwd())
const file = path.join(workspace, '.dsh', 'cognitive-model', 'graph.json')

if (!existsSync(file)) {
  console.error(`no graph at ${file}`)
  process.exitCode = 1
} else {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    console.error(`${file} is not valid JSON`)
    process.exitCode = 1
  }
  if (parsed !== undefined) {
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.events)) {
      console.error(`${file} is not a graph document`)
      process.exitCode = 1
    } else {
      const { doc, changed } = migratePegDocument(parsed)
      if (changed === 0 && parsed.schemaVersion === 2) {
        console.log(`already schema 2: ${file}`)
      } else if (dryRun) {
        console.log(`would migrate ${changed} error(s) to schema 2: ${file}`)
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = `${file}.bak-${stamp}`
        copyFileSync(file, backup)
        const tmp = `${file}.tmp-${process.pid}`
        writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
        renameSync(tmp, file)
        console.log(`migrated ${changed} error(s) to schema 2: ${file}`)
        console.log(`backup: ${backup}`)
      }
    }
  }
}

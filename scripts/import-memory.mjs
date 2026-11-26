#!/usr/bin/env node
/**
 * One-shot migration: copy an existing memory ledger into the graph.
 *
 * The memory ledger and the graph hold the same material — claims about the
 * work — so switching the recall from one to the other must not lose what is
 * already settled. This script imports the active facts, their relations, and
 * the prediction errors, preserving each record's own evidence and source.
 *
 * Usage:
 *   node scripts/import-memory.mjs [workspace] [--dry-run]
 *
 * It is safe to run again: a node the graph already knows and that is newer
 * than the fact is kept, and an error already recorded is reported as a
 * duplicate instead of being appended twice.
 */
import path from 'node:path'
import { DEFAULT_MODEL_CONFIG, GraphService, importMemoryLedger } from '../lib/index.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((arg) => !arg.startsWith('--'))
const workspace = path.resolve(positional[0] ?? process.cwd())

const service = new GraphService({ ...DEFAULT_MODEL_CONFIG })
const report = await importMemoryLedger(service, workspace, { dryRun })

const lines = [
  `workspace: ${workspace}`,
  `memory ledger: ${report.memory}, prediction errors: ${report.predictionErrors}`,
  `${dryRun ? 'would import' : 'imported'} ${report.imported}/${report.facts} fact(s), ` +
    `${report.edges} edge(s), ${report.errors} error(s)`,
  `skipped (graph newer): ${report.skippedNewer}; inactive: ${report.inactive}; ` +
    `error duplicates: ${report.errorDuplicates}`,
]
if (report.missingTargets.length > 0) {
  lines.push(`missing targets: ${report.missingTargets.join(', ')}`)
}
for (const problem of report.problems) {
  lines.push(`refused ${problem.id}: ${problem.code} — ${problem.message}`)
}
console.log(lines.join('\n'))
process.exitCode = report.problems.length > 0 ? 1 : 0

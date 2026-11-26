/**
 * A throwaway workspace for the tests, removed when the process exits.
 *
 * The suite creates a workspace per case; without the exit hook the temporary
 * directories accumulate (the 2026-11-23 review measured 1,228 leftovers).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const created = []
let registered = false

export function workspace(tag = 'cm-model') {
  const dir = mkdtempSync(path.join(tmpdir(), `${tag}-`))
  mkdirSync(path.join(dir, '.git'))
  created.push(dir)
  if (!registered) {
    registered = true
    process.on('exit', () => {
      for (const entry of created) {
        try {
          rmSync(entry, { recursive: true, force: true })
        } catch {
          // Best effort: a locked file must not fail the suite.
        }
      }
    })
  }
  return dir
}

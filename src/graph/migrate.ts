/**
 * One-time schema migration to the signed experience model.
 *
 * Schema 2 gives every prediction error a `direction`. The graph is
 * append-only during normal operation, but this is a format migration, not a
 * correction: the old records were negative by construction, so they become
 * `worse` and the rest of the log is untouched. The migration is idempotent;
 * running it again on a schema-2 document changes nothing.
 */
import type { GraphDocument } from './events.js'
import { isPredictionErrorDirection } from './prediction.js'

export interface PegMigrationResult {
  doc: GraphDocument
  /** Prediction errors that gained a direction. */
  changed: number
}

export function migratePegDocument(doc: GraphDocument): PegMigrationResult {
  let changed = 0
  const events = doc.events.map((event) => {
    if (event.op !== 'record_error' || event.error === undefined) return event
    if (isPredictionErrorDirection(event.error.direction)) return event
    changed += 1
    return { ...event, error: { ...event.error, direction: 'worse' as const } }
  })
  if (changed === 0 && doc.schemaVersion === 2) return { doc, changed }
  return { doc: { ...doc, schemaVersion: 2, events }, changed }
}

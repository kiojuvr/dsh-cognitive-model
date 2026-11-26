/**
 * One-time schema migration to the signed experience model.
 *
 * Schema 2 gives every prediction error a `direction`. The graph is
 * append-only during normal operation, but this is a format migration, not a
 * correction: the old records were negative by construction, so they become
 * `worse` and the rest of the log is untouched. The migration is idempotent;
 * running it again on a schema-2 document changes nothing.
 */
import type { GraphDocument } from './events.js';
export interface PegMigrationResult {
    doc: GraphDocument;
    /** Prediction errors that gained a direction. */
    changed: number;
}
export declare function migratePegDocument(doc: GraphDocument): PegMigrationResult;

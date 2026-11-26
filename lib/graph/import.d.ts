import type { GraphService } from './service.js';
import type { NodeType } from './schema.js';
export declare const MEMORY_AREA = "cognitive-memory";
export declare const MEMORY_FILE = "memory.json";
export declare const PREDICTION_ERROR_FILE = "prediction-errors.json";
export interface ImportProblem {
    id: string;
    code: string;
    message: string;
}
export interface ImportReport {
    memory: 'ready' | 'missing' | 'error';
    predictionErrors: 'ready' | 'missing' | 'error';
    facts: number;
    imported: number;
    /** Facts the graph already knew, newer than the fact. */
    skippedNewer: number;
    /** Facts that are not active in the memory ledger (superseded / retracted). */
    inactive: number;
    edges: number;
    missingTargets: string[];
    errors: number;
    errorDuplicates: number;
    problems: ImportProblem[];
    dryRun: boolean;
}
/** A stable id fragment that keeps non-ASCII subjects readable. */
export declare function slugOf(value: string): string;
/**
 * The node a fact becomes.
 *
 * Reserved subjects keep the graph's convention: `objective` / `objective/<path>`
 * for the goal, `task/current` and `task/<key>` for the position and the rest.
 * Everything else becomes `<type>/<slug>`, with the original subject kept as
 * the label.
 */
export declare function nodeIdOf(fact: {
    kind: string;
    subject: string;
}): {
    id: string;
    type: NodeType;
};
export declare function importMemoryLedger(service: GraphService, root: string, options?: {
    dryRun?: boolean;
}): Promise<ImportReport>;

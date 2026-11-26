/** Beside the graph, in the same reset-by-deletion area. */
export declare const RECALL_SEEN_FILE = "recall.json";
/** Keep the file bounded: the newest sessions, the newest ids within each. */
export declare const MAX_SEEN_SESSIONS = 32;
export declare const MAX_SEEN_ERRORS = 200;
export interface RecallSeenEntry {
    /** Error ids this session has already been shown. */
    seen: string[];
    /** ISO timestamp of the last update; the pruning order. */
    updatedAt: string;
}
export interface RecallSeenDocument {
    schemaVersion: number;
    workspace: string;
    sessions: Record<string, RecallSeenEntry>;
}
export declare function emptyRecallSeen(workspace: string): RecallSeenDocument;
/** Read the receipts; a missing or unreadable file is an empty state, not an error. */
export declare function readRecallSeen(file: string, workspace: string): RecallSeenDocument;
/** Replace the file atomically; the caller decides whether a failure matters. */
export declare function writeRecallSeen(file: string, doc: RecallSeenDocument): void;
/**
 * Record that this session has now seen these errors.
 *
 * Returns the document unchanged when every id was already present, so an
 * assembly that shows nothing new does not rewrite the file.
 */
export declare function markRecallSeen(doc: RecallSeenDocument, session: string, ids: readonly string[]): {
    doc: RecallSeenDocument;
    changed: boolean;
};

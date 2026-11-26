/**
 * Read receipts for the bird's-eye check, keyed by the reader.
 *
 * The check asks the reader to look up from the work, so "once" is once per
 * reader, not once per error: another session in the same workspace still gets
 * its own single check, and a restarted session must not be asked again for an
 * error it already saw. That makes the session the unit, and the receipt has to
 * outlive the process for the restart half to hold.
 *
 * This is bookkeeping, not a ledger. The graph document is append-only and its
 * history is never rewritten; this file is a small read-state map that can be
 * deleted at any time, and losing it only means one check is shown again. It is
 * written synchronously because the recall is assembled synchronously: by the
 * time the prompt is used, the receipt is already durable.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
/** Beside the graph, in the same reset-by-deletion area. */
export const RECALL_SEEN_FILE = 'recall.json';
/** Keep the file bounded: the newest sessions, the newest ids within each. */
export const MAX_SEEN_SESSIONS = 32;
export const MAX_SEEN_ERRORS = 200;
export function emptyRecallSeen(workspace) {
    return { schemaVersion: 1, workspace, sessions: {} };
}
/** Read the receipts; a missing or unreadable file is an empty state, not an error. */
export function readRecallSeen(file, workspace) {
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return emptyRecallSeen(workspace);
    }
    if (typeof parsed !== 'object' || parsed === null)
        return emptyRecallSeen(workspace);
    const sessions = parsed.sessions;
    if (typeof sessions !== 'object' || sessions === null)
        return emptyRecallSeen(workspace);
    const clean = {};
    for (const [session, value] of Object.entries(sessions)) {
        if (typeof value !== 'object' || value === null)
            continue;
        const raw = value;
        const seen = Array.isArray(raw.seen)
            ? raw.seen.filter((item) => typeof item === 'string' && item !== '')
            : [];
        clean[session] = {
            seen: seen.slice(-MAX_SEEN_ERRORS),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        };
    }
    return { schemaVersion: 1, workspace, sessions: clean };
}
/** Replace the file atomically; the caller decides whether a failure matters. */
export function writeRecallSeen(file, doc) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...doc, schemaVersion: 1, workspace: doc.workspace }, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}
/**
 * Record that this session has now seen these errors.
 *
 * Returns the document unchanged when every id was already present, so an
 * assembly that shows nothing new does not rewrite the file.
 */
export function markRecallSeen(doc, session, ids) {
    const current = doc.sessions[session];
    const seen = new Set(current?.seen ?? []);
    let changed = false;
    for (const id of ids) {
        if (seen.has(id))
            continue;
        seen.add(id);
        changed = true;
    }
    if (!changed)
        return { doc, changed: false };
    const updatedAt = new Date().toISOString();
    const sessions = {
        ...doc.sessions,
        [session]: { seen: [...seen].slice(-MAX_SEEN_ERRORS), updatedAt },
    };
    return {
        doc: { ...doc, sessions: pruneSessions(sessions) },
        changed: true,
    };
}
/** Keep the newest sessions; an old session's receipts are not worth the file. */
function pruneSessions(sessions) {
    const kept = Object.entries(sessions)
        .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
        .slice(0, MAX_SEEN_SESSIONS);
    return Object.fromEntries(kept);
}

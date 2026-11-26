import { SCHEMA_VERSION, isFunctional } from './schema.js';
import { isPredictionErrorDirection, } from './prediction.js';
/**
 * The coordinate a projection groups by.
 *
 * A functional relation groups by `(from, type)`, so writing a second target is
 * the same coordinate and the write path supersedes the first. A non-functional
 * relation also groups by `to`, so several targets coexist.
 */
export function projectionKeyOf(event) {
    if (event.node !== undefined)
        return `node:${event.node.id}`;
    if (event.error !== undefined)
        return `error:${event.error.id}`;
    const edge = event.edge;
    if (edge === undefined)
        return `event:${event.id}`;
    return isFunctional(edge.type)
        ? `edge:${edge.from}:${edge.type}`
        : `edge:${edge.from}:${edge.type}:${edge.to ?? '*'}`;
}
/** A one-line description, used by `graph_history` and by a conflict report. */
export function describeEvent(event) {
    if (event.node !== undefined) {
        const node = event.node;
        const verb = event.op === 'retract_node' ? 'retract' : 'set';
        return `${verb} ${node.type} ${node.id}: ${node.label}`;
    }
    if (event.error !== undefined) {
        return `record ${event.error.kind}/${event.error.direction} error ${event.error.subject}: expected ${event.error.predicted}`;
    }
    const edge = event.edge;
    if (edge === undefined)
        return event.op;
    const arrow = edge.to === undefined ? edge.from : `${edge.from} -${edge.type}-> ${edge.to}`;
    return event.op === 'retract_edge' ? `retract ${arrow}` : `set ${arrow}`;
}
export function emptyStats() {
    return { writes: 0, retractions: 0, rejections: 0, duplicates: 0 };
}
export function emptyDocument(workspace) {
    return { schemaVersion: 2, workspace, events: [], stats: emptyStats(), nextSeq: 1 };
}
/** Reject a document that is not this shape; the store then quarantines it. */
export function isGraphDocument(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    if (!Array.isArray(candidate.events))
        return false;
    if (typeof candidate.stats !== 'object' || candidate.stats === null)
        return false;
    return candidate.events.every((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return false;
        const event = entry;
        return typeof event.op === 'string' && typeof event.at === 'string' && Array.isArray(event.evidence);
    });
}
/**
 * Why a document cannot be read by this version.
 *
 * The migration is a one-time format change, not a compatibility branch: a
 * schema-1 document is refused instead of being projected with `undefined`
 * directions and then rewritten as schema 2 by the next save. The message
 * describes the state and does not name the command: the dashboard shows this
 * text to a human (D77: the UI does not hand out commands), while the tool
 * refusal appends `migrationCommand` for the agent.
 */
export function schemaProblem(doc) {
    if (doc.schemaVersion !== SCHEMA_VERSION) {
        return (`the graph is schema ${doc.schemaVersion}, not schema ${SCHEMA_VERSION}; ` +
            'it must be migrated before this version can read it');
    }
    for (const event of doc.events) {
        if (event.op !== 'record_error' || event.error === undefined)
            continue;
        if (!isPredictionErrorDirection(event.error.direction)) {
            return 'a prediction error has no direction; the graph must be migrated before this version can read it';
        }
    }
    return undefined;
}
/** The command the agent runs to migrate one workspace. */
export function migrationCommand(root) {
    return `node scripts/migrate-peg.mjs "${root}"`;
}

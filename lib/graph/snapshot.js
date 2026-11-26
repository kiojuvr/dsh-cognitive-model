/**
 * The graph as the browser can read it.
 *
 * The Host publishes one session projection (`cognitiveGraph`) whose wire view
 * is this snapshot. Keeping the projection here gives the tools and UI the
 * same rules for supersession, invalidation, valid time and conflict detection.
 *
 * The snapshot is deliberately flat and JSON-safe. It carries no score and no
 * ranking: it reports the nodes, the typed edges, the unresolved conflicts, and
 * the two inferences (owner, location) the graph exists to make. Sizing a node
 * by "investment" is the dashboard's responsibility.
 *
 * The recall block is the second payload of the same read (D108). It is text,
 * not structure, and it is what a session actually starts from; a reader that
 * wants to check the injection needs the block itself, not a second drawing of
 * the material behind it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { findProjectRoot, workspaceFile } from '@kioju/dsh-cognitive-core';
import { isGraphDocument, schemaProblem } from './events.js';
import { milestoneProgress, projectEvents } from './projection.js';
import { resolveLocation, resolveOwner } from './query.js';
import { recallText } from './recall.js';
import { AREA, GRAPH_FILE } from './service.js';
/** The wire payload is bounded: a view is not an export. */
export const MAX_SNAPSHOT_NODES = 200;
export const MAX_SNAPSHOT_EDGES = 400;
export const MAX_SNAPSHOT_INFERENCE = 20;
/**
 * The order a bounded payload keeps.
 *
 * The cap must not cut the structure a reader needs (the tree, the entities)
 * before the many decisions and facts; sorting by id alone did (P3 in the
 * 2026-11-23 review).
 */
const NODE_ORDER = [
    'objective',
    'component',
    'task',
    'entity',
    'decision',
    'constraint',
    'risk',
    'fact',
    'preference',
];
function nodeRank(type) {
    const rank = NODE_ORDER.indexOf(type);
    return rank === -1 ? NODE_ORDER.length : rank;
}
const cache = new Map();
export function graphFileFor(root) {
    return workspaceFile(root, AREA, GRAPH_FILE);
}
function emptySnapshot(state, root) {
    return {
        state,
        generatedAt: new Date().toISOString(),
        workspace: root,
        events: 0,
        counts: { nodes: 0, edges: 0, byType: {}, byEdge: {} },
        nodes: [],
        edges: [],
        conflicts: [],
        inference: [],
        truncated: { nodes: false, edges: false, inference: false },
    };
}
/** Read the document without touching the graph service's cache. */
export function readGraphDocument(root) {
    const file = graphFileFor(root);
    if (!existsSync(file))
        return { state: 'missing' };
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (!isGraphDocument(parsed))
            return { state: 'error' };
        return { state: 'ready', doc: parsed };
    }
    catch {
        return { state: 'error' };
    }
}
function countBy(items, keyOf) {
    const counts = {};
    for (const item of items) {
        const key = keyOf(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}
/** The entities worth an inference row: those with a relation to resolve. */
function inferenceOf(view) {
    const involved = new Set();
    for (const edge of view.edges) {
        if (edge.type === 'part_of' || edge.type === 'owned_by' || edge.type === 'located_in') {
            involved.add(edge.from);
            involved.add(edge.to);
        }
    }
    const rows = [];
    for (const id of [...involved].sort()) {
        const node = view.nodes.get(id);
        if (node === undefined || node.type !== 'entity')
            continue;
        const owner = resolveOwner(view, id);
        if (owner.owner !== undefined) {
            rows.push({
                entity: id,
                kind: 'owner',
                value: owner.owner,
                source: owner.source,
                path: owner.path,
            });
        }
        const location = resolveLocation(view, id);
        if (location.kind === 'resolved') {
            rows.push({
                entity: id,
                kind: 'location',
                value: location.location,
                source: location.source,
                path: location.path,
            });
        }
        else if (location.kind === 'conflict') {
            rows.push({
                entity: id,
                kind: 'location',
                source: 'conflict',
                path: [id],
                candidates: [...new Set(location.candidates.map((candidate) => candidate.location))].sort(),
            });
        }
    }
    return rows;
}
/**
 * The document's view, read once and cached by mtime and size.
 *
 * Stat before reading: the cache exists to keep the per-wire cost off the whole
 * log, so a cache hit must not read and parse the document first. A missing or
 * unreadable document is not cached — the next call re-stats it, because the
 * file may appear at any moment.
 */
function loadEntry(root) {
    const file = graphFileFor(root);
    let stamp;
    try {
        const info = statSync(file);
        stamp = { mtimeMs: info.mtimeMs, size: info.size };
    }
    catch {
        stamp = undefined;
    }
    if (stamp !== undefined) {
        const cached = cache.get(root);
        if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
            return cached;
        }
    }
    const read = readGraphDocument(root);
    if (read.state !== 'ready' || read.doc === undefined) {
        cache.delete(root);
        return { mtimeMs: 0, size: 0, read: { state: read.state, events: 0 } };
    }
    const doc = read.doc;
    const problem = schemaProblem(doc);
    if (problem !== undefined) {
        cache.delete(root);
        return {
            mtimeMs: 0,
            size: 0,
            read: { state: 'error', message: problem, events: doc.events.length },
        };
    }
    const entry = {
        mtimeMs: stamp?.mtimeMs ?? 0,
        size: stamp?.size ?? 0,
        read: {
            state: 'ready',
            view: projectEvents(doc.events, new Date()),
            events: doc.events.length,
        },
    };
    // A stat that failed after a successful read is a race, not a stamp to keep.
    if (stamp !== undefined)
        cache.set(root, entry);
    return entry;
}
function withMessage(snapshot, message) {
    return message === undefined ? snapshot : { ...snapshot, message };
}
/**
 * The projection, taken now.
 *
 * `root` is undefined when the session has no workspace; that is reported as
 * `missing` rather than as an empty graph, because the two mean different
 * things to a reader (F4: absence is not success).
 */
export function graphSnapshot(root) {
    if (root === undefined)
        return emptySnapshot('missing', null);
    const entry = loadEntry(root);
    const view = entry.read.view;
    if (entry.read.state !== 'ready' || view === undefined) {
        return withMessage(emptySnapshot(entry.read.state, root), entry.read.message);
    }
    if (entry.snapshot !== undefined) {
        return { ...entry.snapshot, generatedAt: new Date().toISOString() };
    }
    const nodes = [...view.nodes.values()].sort((left, right) => nodeRank(left.type) - nodeRank(right.type) || left.id.localeCompare(right.id));
    const edges = [...view.edges].sort((left, right) => `${left.from}\u0000${left.type}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.type}\u0000${right.to}`));
    const inference = inferenceOf(view);
    const snapshot = {
        state: 'ready',
        generatedAt: new Date().toISOString(),
        workspace: root,
        events: entry.read.events,
        counts: {
            nodes: nodes.length,
            edges: edges.length,
            byType: countBy(nodes, (node) => node.type),
            byEdge: countBy(edges, (edge) => edge.type),
        },
        nodes: nodes.slice(0, MAX_SNAPSHOT_NODES).map((node) => ({
            id: node.id,
            type: node.type,
            label: node.label,
            ...(node.value === undefined ? {} : { value: node.value }),
            paths: node.paths,
            docs: node.docs,
            acceptance: milestoneProgress(node),
            milestones: node.milestones.map((milestone) => ({
                text: milestone.text,
                done: milestone.done === true,
                ...(milestone.at === undefined ? {} : { at: milestone.at }),
            })),
            confidence: node.confidence,
            updatedAt: node.updatedAt,
        })),
        edges: edges.slice(0, MAX_SNAPSHOT_EDGES).map((edge) => ({
            from: edge.from,
            type: edge.type,
            to: edge.to,
        })),
        conflicts: view.conflicts.map((conflict) => ({
            key: conflict.key,
            kind: conflict.kind,
            candidates: conflict.candidates.map((candidate) => candidate.summary),
        })),
        inference: inference.slice(0, MAX_SNAPSHOT_INFERENCE),
        truncated: {
            nodes: nodes.length > MAX_SNAPSHOT_NODES,
            edges: edges.length > MAX_SNAPSHOT_EDGES,
            inference: inference.length > MAX_SNAPSHOT_INFERENCE,
        },
    };
    entry.snapshot = snapshot;
    return snapshot;
}
/**
 * The recall block, as the prompt receives it.
 *
 * A UI that shows what a session starts from reads this instead of assembling
 * the block again: the budget, the ordering and the per-session check stay one
 * implementation (D108). The block is assembled with no fresh revisits — a read
 * must not spend the reader's one bird's-eye check — so the check is absent
 * from this text while the rest of the block is byte-for-byte what the prompt
 * gets.
 *
 * `state` mirrors the snapshot: `missing` is a workspace with no ledger and
 * `error` carries the model's reason, so a card can say which of the two it is.
 */
export function recallSnapshot(root, limits) {
    const generatedAt = new Date().toISOString();
    if (root === undefined) {
        return { state: 'missing', generatedAt, workspace: null, events: 0, text: '' };
    }
    const entry = loadEntry(root);
    const view = entry.read.view;
    if (entry.read.state !== 'ready' || view === undefined) {
        return {
            state: entry.read.state,
            ...(entry.read.message === undefined ? {} : { message: entry.read.message }),
            generatedAt,
            workspace: root,
            events: entry.read.events,
            text: '',
        };
    }
    const cached = entry.recall;
    if (cached !== undefined &&
        cached.recallLimit === limits.recallLimit &&
        cached.contextLimit === limits.contextLimit) {
        return { state: 'ready', generatedAt, workspace: root, events: entry.read.events, text: cached.text };
    }
    const text = recallText(view, limits.recallLimit, [], limits.contextLimit);
    entry.recall = {
        recallLimit: limits.recallLimit,
        contextLimit: limits.contextLimit,
        text,
    };
    return { state: 'ready', generatedAt, workspace: root, events: entry.read.events, text };
}
/** Resolve the workspace root the way every cognitive plugin does. */
export function rootOf(cwd) {
    if (typeof cwd !== 'string' || cwd === '')
        return undefined;
    return findProjectRoot(cwd);
}

import { type GraphDocument } from './events.js';
import type { EdgeType, NodeType } from './schema.js';
/** The wire payload is bounded: a view is not an export. */
export declare const MAX_SNAPSHOT_NODES = 200;
export declare const MAX_SNAPSHOT_EDGES = 400;
export declare const MAX_SNAPSHOT_INFERENCE = 20;
export type SnapshotState = 'ready' | 'missing' | 'error';
/** One acceptance item, as a reader draws it. */
export interface SnapshotMilestone {
    text: string;
    done: boolean;
    at?: string;
}
export interface SnapshotNode {
    id: string;
    type: NodeType;
    label: string;
    value?: string;
    paths: string[];
    docs: string[];
    acceptance: {
        done: number;
        total: number;
    };
    /** The acceptance items themselves, so a reader can list them. */
    milestones: SnapshotMilestone[];
    confidence: string;
    updatedAt: string;
}
export interface SnapshotEdge {
    from: string;
    type: EdgeType;
    to: string;
}
export interface SnapshotConflict {
    key: string;
    kind: 'node' | 'edge';
    candidates: string[];
}
export interface SnapshotInference {
    entity: string;
    /** `owner` or `location`. */
    kind: 'owner' | 'location';
    /** The resolved value; absent when unknown or in conflict. */
    value?: string;
    /** `direct`, `part_of_derived`, `unknown`, or `conflict`. */
    source: string;
    /** The chain that produced the answer, from the entity outward. */
    path: string[];
    /** Competing candidates, when the direct and inherited answers disagree. */
    candidates?: string[];
}
export interface GraphSnapshot {
    state: SnapshotState;
    /** Why the read failed, when the state is `error`. */
    message?: string;
    /** The instant this read was served; a cached projection keeps its content. */
    generatedAt: string;
    workspace: string | null;
    /** Events in the log, so a reader can see the ledger is not being rewritten. */
    events: number;
    counts: {
        nodes: number;
        edges: number;
        byType: Record<string, number>;
        byEdge: Record<string, number>;
    };
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
    conflicts: SnapshotConflict[];
    inference: SnapshotInference[];
    truncated: {
        nodes: boolean;
        edges: boolean;
        inference: boolean;
    };
}
/**
 * The recall block as a reader can see it.
 *
 * `text` is the block itself, verbatim, so a UI shows the material the input
 * received instead of drawing a second approximation of it (D108). It is ''
 * whenever there is nothing to recall, and the state says which kind of
 * absence that is.
 */
export interface RecallSnapshot {
    state: SnapshotState;
    /** Why the read failed, when the state is `error`. */
    message?: string;
    generatedAt: string;
    workspace: string | null;
    events: number;
    text: string;
}
export declare function graphFileFor(root: string): string;
/** Read the document without touching the graph service's cache. */
export declare function readGraphDocument(root: string): {
    state: SnapshotState;
    doc?: GraphDocument;
};
/**
 * The projection, taken now.
 *
 * `root` is undefined when the session has no workspace; that is reported as
 * `missing` rather than as an empty graph, because the two mean different
 * things to a reader (F4: absence is not success).
 */
export declare function graphSnapshot(root: string | undefined): GraphSnapshot;
/** The budgets the recall block is assembled with (D103 / D107). */
export interface RecallLimits {
    /** How many facts the block shows. */
    recallLimit: number;
    /** How many objective-tree rows the block shows. */
    contextLimit: number;
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
export declare function recallSnapshot(root: string | undefined, limits: RecallLimits): RecallSnapshot;
/** Resolve the workspace root the way every cognitive plugin does. */
export declare function rootOf(cwd: string | undefined): string | undefined;

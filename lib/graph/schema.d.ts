/**
 * The graph's vocabulary.
 *
 * Two ontologies share one store, because the question "what is the work for,
 * and what is true about it" is asked once:
 *
 *   - the cognitive model: objective / component / task / decision
 *   - the epistemic record: constraint / risk / fact / preference
 *   - the world model: entity
 *
 * Findings are deliberately absent: a finding is a deferral queue, not
 * knowledge (`dsh-cognitive-findings`), and the ledger there is the single
 * store. The finding carries the reference to the objective or component it
 * belongs to; the graph does not carry the queue (D110).
 *
 * The first group is *structural*: it says how the work is shaped. The second
 * is *epistemic*: it says what may be believed about the work — a bound that
 * must not be crossed, a danger that is still open, a claim about the
 * repository, how the human wants things done. The memory ledger kept those as
 * flat `kind`s; here they are node types, so the same store answers both "what
 * is this part of" and "what is settled". Prediction errors — an expectation
 * that lost to reality — are not structure and not a claim, so they are an
 * event record, not a node (`events.ts`).
 *
 * The node and edge vocabulary is deliberately closed. `world_model` in
 * `cognitive-agent` carried exactly three relations (`part_of`, `owned_by`,
 * `located_in`) and two state dimensions; the cognitive side adds the four
 * references the memory ledger could only keep as strings (`serves`,
 * `requires`, `verifies`, `node`). Anything richer becomes a node, not a new
 * edge type.
 */
import type { Confidence, Evidence, FactSource } from 'dsh-cognitive-core';
import type { PredictionErrorDirection } from './prediction.js';
export declare const SCHEMA_VERSION = 2;
export type NodeType = 
/** The top node, or a sub-goal: `objective` / `objective/<path>`. */
'objective'
/** A means node that serves an objective: `component/<key>`. */
 | 'component'
/** A unit of work: `task/current` or `task/<key>`. */
 | 'task'
/** A choice already made, with its reason in `value`. */
 | 'decision'
/** A bound on the work: something that must not be done, or a limit on it. */
 | 'constraint'
/** An unresolved danger or doubt. */
 | 'risk'
/** A claim about the repository or the world; the claim is `value`. */
 | 'fact'
/** How the human wants things done. */
 | 'preference'
/** A conditional, revisable rule distilled from prediction errors. */
 | 'heuristic'
/** Something in the world the work is about. */
 | 'entity';
export declare const NODE_TYPES: readonly ["objective", "component", "task", "decision", "constraint", "risk", "fact", "preference", "heuristic", "entity"];
/** Node types that carry an acceptance record (`milestones`). */
export declare const MILESTONE_NODE_TYPES: readonly NodeType[];
export declare const NODE_TYPE_HINT: Record<NodeType, string>;
/** Node types whose `value` is a claim about the world, not structure. */
export declare const EPISTEMIC_NODE_TYPES: readonly NodeType[];
export type EdgeType = 
/** objective|component|task → objective|component. Functional. */
'serves'
/** component|task|decision → component. The node it depends on. */
 | 'requires'
/** component → component. The component it checks. */
 | 'verifies'
/** decision|fact|risk|constraint|preference|heuristic → objective|component. Functional. */
 | 'node'
/** entity → entity. The structural decomposition. Functional. */
 | 'part_of'
/** entity → entity. Functional. */
 | 'owned_by'
/** entity → entity. Functional. */
 | 'located_in';
export interface EdgeSpec {
    readonly type: EdgeType;
    readonly family: 'cognitive' | 'world';
    /**
     * A functional relation has at most one active target per `(from, type)`.
     * Writing a second target supersedes the first instead of accumulating.
     */
    readonly functional: boolean;
    /** How a reversed view reads, e.g. `owned_by` → "owns". */
    readonly inverse: string;
    /** Node types this relation may start at. */
    readonly from: readonly NodeType[];
    /** Node types this relation may point at. */
    readonly to: readonly NodeType[];
    readonly hint: string;
}
export declare const EDGE_SPECS: readonly EdgeSpec[];
export declare const EDGE_TYPES: EdgeType[];
export declare function edgeSpec(type: EdgeType): EdgeSpec;
export declare function isNodeType(value: unknown): value is NodeType;
export declare function isEdgeType(value: unknown): value is EdgeType;
/** Functional relations are keyed by `(from, type)`; the rest also by `to`. */
export declare function isFunctional(type: EdgeType): boolean;
export declare const MAX_NODES = 2000;
export declare const MAX_EDGES = 6000;
/** The event log is append-only; the supported reset is deleting the area. */
export declare const MAX_EVENTS = 20000;
export declare const MAX_ID = 120;
export declare const MAX_LABEL = 200;
export declare const MAX_VALUE = 600;
export declare const MAX_LINKS = 40;
export declare const MAX_MILESTONES = 20;
export declare const MAX_MILESTONE_TEXT = 200;
/** A heuristic's applicability, one sentence. */
export declare const MAX_CONDITIONS = 200;
/** How many source errors one heuristic may name. */
export declare const MAX_ERROR_IDS = 10;
export declare const DEFAULT_CONTEXT_LIMIT = 12;
/** How many facts the passive recall block shows. */
export declare const DEFAULT_RECALL_LIMIT = 12;
export declare const DEFAULT_QUERY_LIMIT = 50;
export declare const DEFAULT_MAX_DEPTH = 6;
export declare const DEFAULT_HISTORY_LIMIT = 20;
/** A node as the graph returns it. */
export interface GraphNode {
    id: string;
    type: NodeType;
    scope: string;
    label: string;
    value?: string;
    /** Heuristic nodes: whether the distilled rule is an encouragement or a warning. */
    direction?: PredictionErrorDirection;
    /** Heuristic nodes: when the rule applies. */
    conditions?: string;
    /** Heuristic nodes: the prediction errors this rule was distilled from. */
    errorIds: string[];
    paths: string[];
    docs: string[];
    milestones: import('dsh-cognitive-core').Milestone[];
    confidence: Confidence;
    source: FactSource;
    evidence: Evidence[];
    createdAt: string;
    updatedAt: string;
}
/** An edge as the graph returns it. */
export interface GraphEdge {
    from: string;
    type: EdgeType;
    to: string;
    scope: string;
    confidence: Confidence;
    source: FactSource;
    evidence: Evidence[];
    updatedAt: string;
}

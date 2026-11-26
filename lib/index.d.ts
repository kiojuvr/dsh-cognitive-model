import type { Context } from './cordis.js';
import { type GraphConfig } from './graph/service.js';
import { graphSnapshot, recallSnapshot } from './graph/snapshot.js';
import { type NodeType } from './graph/schema.js';
export declare const name = "cognitive-model";
/** Both services are provided by the base profile. */
export declare const inject: string[];
export interface ModelConfig {
    /** How many objective-tree rows the passive recall block shows. */
    contextLimit: number;
    /** How many facts the passive recall block shows. */
    recallLimit: number;
    /** Upper bound on a single `graph_query` result. */
    queryLimit: number;
    /** Upper bound on traversal depth, whatever the caller asks for. */
    maxDepth: number;
    /** Node types that may be written. Empty means every type. */
    writeTypes: NodeType[];
    /** Scopes that may be written. Empty means every scope. */
    writeScopes: string[];
}
export declare const DEFAULT_MODEL_CONFIG: ModelConfig;
interface ConfigIssue {
    message: string;
    path?: Array<string | number>;
}
/** Standard Schema validator; Cordis calls `Config['~standard'].validate`. */
export declare const Config: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(raw: unknown): {
            issues: ConfigIssue[];
        } | {
            value: ModelConfig;
        };
    };
};
export declare function apply(ctx: Context, rawConfig?: unknown): void;
/**
 * Publish the graph to other Host plugins.
 *
 * The session projection serves the browser; this serves a sibling Host plugin
 * that needs the same projection without importing this package or re-reading
 * the event log with a second implementation of supersession. The dashboard is
 * the first consumer: its objective tree is drawn from this snapshot, and its
 * recall card shows the block this plugin hands a session (D108).
 *
 * `snapshot(root)` and `recall(root)` are synchronous and take a workspace root,
 * so a caller that already resolved the root (a projection's `init`, a command)
 * can read them without a Session. A profile without `ctx.provide` simply has no
 * service; the caller treats that as "the model plugin is not installed".
 */
export declare function registerService(ctx: Context, config: GraphConfig): void;
/** The read face this plugin publishes to other Host plugins. */
export interface ModelService {
    /** The graph as a snapshot; `state` separates missing from empty. */
    snapshot(root: string | undefined): ReturnType<typeof graphSnapshot>;
    /**
     * The recall block as the prompt receives it, assembled with this plugin's
     * configured budgets.
     *
     * A read does not consume the per-session bird's-eye check, so the check is
     * absent from this text; the rest is byte-for-byte the block a session starts
     * from.
     */
    recall(root: string | undefined): ReturnType<typeof recallSnapshot>;
}
export { GraphService, AREA, DEFAULT_SCOPE, GRAPH_FILE } from './graph/service.js';
export type { GraphConfig, HistoryEntry, NodeInput, EdgeInput, WriteOutcome } from './graph/service.js';
export { EDGE_SPECS, EDGE_TYPES, EPISTEMIC_NODE_TYPES, NODE_TYPES, NODE_TYPE_HINT, edgeSpec, isEdgeType, isFunctional, isNodeType, } from './graph/schema.js';
export type { EdgeSpec, EdgeType, GraphEdge, GraphNode, NodeType } from './graph/schema.js';
export { projectEvents, groupActiveEvents, milestoneProgress, eventStatus, } from './graph/projection.js';
export type { EventStatus, GraphConflict, GraphView, ProjectedError } from './graph/projection.js';
export { PREDICTION_ERROR_DIRECTIONS, PREDICTION_ERROR_DIRECTION_HINT, PREDICTION_ERROR_KINDS, PREDICTION_ERROR_KIND_HINT, RECALL_ERROR_LIMIT, REVISIT_TARGETS, REVISIT_TARGET_HINT, checkPredictionError, isPredictionErrorDirection, isPredictionErrorKind, isRevisitTarget, predictionErrorKey, } from './graph/prediction.js';
export type { PredictionErrorDirection, PredictionErrorInput, PredictionErrorKind, PredictionErrorProblem, RevisitTarget, } from './graph/prediction.js';
export { describePredicate, evalPredicate, followChain, isPartOf, resolveLocation, resolveOwner, traverse, } from './graph/query.js';
export type { ChainResult, InferenceSource, LocationResolution, OwnerResolution, Predicate, TraverseOptions, TraverseResult, } from './graph/query.js';
export { contextText } from './graph/prompt.js';
export { FACT_ORDER, FACT_SECTION_LABEL, RECALL_DECISION_LIMIT, RECALL_FACT_LIMIT, RECALL_HEURISTIC_LIMIT, RECALL_PREFERENCE_LIMIT, REVISIT_LABEL, birdseyeText, currentPath, errorLine, heuristicLine, recentErrors, recallText, } from './graph/recall.js';
export type { FactSection } from './graph/recall.js';
export { migratePegDocument } from './graph/migrate.js';
export type { PegMigrationResult } from './graph/migrate.js';
export type { GraphDocument, GraphEvent, GraphOp, GraphStats } from './graph/events.js';
export { emptyDocument, emptyStats } from './graph/events.js';
export { MAX_SNAPSHOT_EDGES, MAX_SNAPSHOT_INFERENCE, MAX_SNAPSHOT_NODES, graphFileFor, graphSnapshot, readGraphDocument, recallSnapshot, rootOf, } from './graph/snapshot.js';
export type { GraphSnapshot, RecallLimits, RecallSnapshot, SnapshotConflict, SnapshotEdge, SnapshotInference, SnapshotNode, SnapshotState, } from './graph/snapshot.js';

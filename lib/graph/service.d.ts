import { type Evidence, type FactSource, type Milestone } from '@kioju/dsh-cognitive-core';
import { edgeSpec, type EdgeType, type NodeType } from './schema.js';
import { type PredictionErrorDirection, type PredictionErrorInput } from './prediction.js';
import { type EdgeRef, type GraphDocument, type GraphOp, type GraphStats } from './events.js';
import { type EventStatus, type GraphView, type ProjectedError } from './projection.js';
/** `<projectRoot>/.dsh/<area>/graph.json` — deleting the area is the reset. */
export declare const AREA = "cognitive-model";
export declare const GRAPH_FILE = "graph.json";
export declare const DEFAULT_SCOPE = "repo";
export interface GraphConfig {
    /** How many nodes the passive context shows. */
    contextLimit: number;
    /** How many facts the passive recall block shows. */
    recallLimit: number;
    /** Upper bound on a single query result. */
    queryLimit: number;
    /** Upper bound on traversal depth, whatever the caller asks for. */
    maxDepth: number;
    /** Node types that may be written. Empty means every type. */
    writeTypes: NodeType[];
    /** Scopes that may be written. Empty means every scope. */
    writeScopes: string[];
}
export declare const DEFAULT_CONFIG: GraphConfig;
export interface NodeInput {
    id: string;
    type: NodeType;
    label: string;
    value?: string;
    /** Heuristic nodes: better / worse. */
    direction?: PredictionErrorDirection;
    /** Heuristic nodes: when the rule applies. */
    conditions?: string;
    /** Heuristic nodes: the prediction errors it was distilled from. */
    errorIds?: string[];
    paths?: string[];
    docs?: string[];
    milestones?: Milestone[];
}
export interface EdgeInput {
    from: string;
    type: EdgeType;
    to: string;
}
export interface WriteInput {
    nodes: NodeInput[];
    edges: EdgeInput[];
    /** Prediction errors: expectations that lost to reality, recorded as events. */
    errors?: PredictionErrorInput[];
    evidence: Evidence[];
    source?: FactSource;
    scope?: string;
    session?: string;
    validFrom?: string;
    validTo?: string;
}
export type WriteOutcome = {
    kind: 'rejected';
    code: string;
    message: string;
} | {
    kind: 'written';
    nodes: string[];
    edges: string[];
    errors: string[];
    duplicates: string[];
};
export interface RetractInput {
    nodes: string[];
    edges: EdgeRef[];
    reason: string;
    evidence: Evidence[];
    source?: FactSource;
    scope?: string;
    session?: string;
}
export type RetractOutcome = {
    kind: 'rejected';
    code: string;
    message: string;
} | {
    kind: 'retracted';
    nodes: string[];
    edges: string[];
    missing: string[];
};
export interface HistoryEntry {
    id: string;
    at: string;
    op: GraphOp;
    summary: string;
    status: EventStatus;
    source: FactSource;
    confidence: string;
    evidence: Evidence[];
    reason?: string;
    scope: string;
}
export declare class GraphService {
    readonly config: GraphConfig;
    private readonly cache;
    private readonly stores;
    /** Read receipts for the bird's-eye check, keyed by workspace then session. */
    private readonly recallSeen;
    /** No session id means no "who" to key on: once per process, not persisted. */
    private readonly anonymousSeen;
    private lastRoot;
    constructor(config: GraphConfig);
    /** The nearest ancestor with `.git`, else the directory itself. */
    rootFor(cwd: string): string;
    fileFor(root: string): string;
    /** The refusal a full log returns, shared by writes and retractions. */
    private eventLogFull;
    /** The read receipts beside the graph; deleting the area resets them too. */
    recallFileFor(root: string): string;
    /** The last root this process touched; a fallback for an assembly with no agent. */
    currentRoot(): string | undefined;
    view(root: string): Promise<GraphView>;
    /**
     * The cached view, without touching the disk.
     *
     * A prompt context provider is synchronous, so it cannot await a read. The
     * `system-prompt/assemble` warm-up has already refreshed the cache by the time
     * this runs; before that it returns `undefined` and the block is simply absent.
     */
    currentView(root: string): GraphView | undefined;
    read(root: string): Promise<GraphDocument>;
    /** Whether the on-disk document changed since it was cached. */
    shouldRefresh(root: string): Promise<boolean>;
    /** Warm the cache so the synchronous context provider has a graph to show. */
    refresh(root: string): Promise<void>;
    /**
     * The errors that ask this reader for a bird's-eye check, and the receipt.
     *
     * "New" means unshown to *this session*, not newly recorded: the reader is
     * the session, so the receipt is keyed by session id and survives a restart
     * (D100). Another session in the same workspace still gets its own one check
     * for the error; without a session id there is no "who" to key on, so the
     * fallback is once per process for the workspace.
     *
     * The trigger is `revisit`, not the kind: a scope or estimate miss that
     * changes nothing about the objective is a calibration record, while a
     * belief or outcome that puts the objective, an acceptance item, or a
     * priority in question asks for the check. The display budget does not
     * decide this, and the returned errors carry the reason the check fired
     * (D93 / D100).
     */
    consumeFreshRevisit(root: string, session: string | undefined, errors: readonly ProjectedError[]): ProjectedError[];
    private recallSeenFor;
    /** A receipt is bookkeeping: a failed write must not break the prompt. */
    private persistRecallSeen;
    /**
     * Count a refused write in the document.
     *
     * A refusal appends no event — that is the point — so the counter is the only
     * durable sign that the policy ran. Recording it must not turn a refusal into
     * an error, so a failed bump is swallowed.
     */
    private countRejection;
    private load;
    private storeFor;
    private policyFor;
    write(root: string, input: WriteInput): Promise<WriteOutcome>;
    private writeOnce;
    retract(root: string, input: RetractInput): Promise<RetractOutcome>;
    private retractOnce;
    history(root: string, target: {
        node?: string;
        edge?: EdgeRef;
    }, limit: number): Promise<{
        entries: HistoryEntry[];
        total: number;
    }>;
    stats(root: string): Promise<GraphStats>;
    private validateNode;
    private validateErrors;
    private validateEdges;
}
export { edgeSpec };

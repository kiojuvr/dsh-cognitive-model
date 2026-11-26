/**
 * Event log → graph.
 *
 * The projection follows `state_projection_rules.md` in order, because the
 * order is the part that makes it stable:
 *
 *   1. collect the events
 *   2. partition by projection key
 *   3. resolve supersession   — an explicit replacement beats recency
 *   4. apply invalidation     — a withdrawn event never becomes current
 *   5. apply valid time       — an event may not cover this instant
 *   6. build the view
 *
 * When two events are still active on one key and neither supersedes the
 * other, the projection does **not** pick the newer one. It records a conflict
 * and leaves that key out of the view, so a silent guess cannot poison a later
 * read.
 */
import type { Confidence, Evidence, FactSource } from 'dsh-cognitive-core';
import { type GraphEdge, type GraphNode, type NodeType } from './schema.js';
import { type GraphEvent } from './events.js';
import type { PredictionErrorDirection, PredictionErrorKind, RevisitTarget } from './prediction.js';
export interface GraphConflict {
    key: string;
    kind: 'node' | 'edge';
    /** One line per competing event, newest first. */
    candidates: Array<{
        eventId: string;
        at: string;
        summary: string;
    }>;
}
/** A prediction error as a read returns it. */
export interface ProjectedError {
    id: string;
    kind: PredictionErrorKind;
    direction: PredictionErrorDirection;
    subject: string;
    predicted: string;
    observed: string;
    lesson?: string;
    factId?: string;
    /** What the error puts in question, when the writer recorded an impact. */
    revisit?: RevisitTarget;
    scope: string;
    confidence: Confidence;
    source: FactSource;
    evidence: Evidence[];
    /** When it was recorded. */
    at: string;
    /** Log order; the newest record has the highest seq. */
    seq: number;
}
export interface GraphView {
    /** Active nodes by id. */
    nodes: Map<string, GraphNode>;
    /** Active edges. */
    edges: GraphEdge[];
    /**
     * Nodes a retraction removed. Kept so a reference to one can be explained
     * ("it existed and was withdrawn") rather than looking like a typo.
     */
    retracted: Map<string, GraphNode>;
    /** Active prediction errors, oldest first. */
    errors: ProjectedError[];
    conflicts: GraphConflict[];
}
export type EventStatus = 'active' | 'superseded' | 'invalidated' | 'future' | 'expired';
/** Why an event is or is not current. Used by `graph_history`. */
export declare function eventStatus(event: GraphEvent, events: readonly GraphEvent[], now: Date): EventStatus;
/** `Confidence` follows from the source; a caller cannot claim more than it saw. */
export declare function confidenceOfSource(source: FactSource): Confidence;
export declare function projectEvents(events: readonly GraphEvent[], now: Date): GraphView;
/**
 * The events that are still current, grouped by projection key.
 *
 * Exported because the write path needs the same answer: which event a new
 * write must supersede, and which key is already in conflict and must not be
 * silently extended.
 */
export declare function groupActiveEvents(events: readonly GraphEvent[], now: Date): Map<string, GraphEvent[]>;
/** Acceptance progress, as a record rather than a score. */
export declare function milestoneProgress(node: GraphNode | undefined): {
    done: number;
    total: number;
};
/** The node types that may carry acceptance items. */
export declare function acceptsMilestones(type: NodeType): boolean;
/** Evidence a reader can follow, rendered as one short suffix. */
export declare function evidenceSuffix(evidence: readonly Evidence[]): string;

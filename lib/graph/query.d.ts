/**
 * Graph traversal and the two inferences the graph exists to make.
 *
 * `cognitive-agent`'s `world_model/src/inference.rs` carried the point of the
 * world model: `part_of` is not decoration, it is how an owner and a location
 * are *derived* when nobody set them directly. `resolve_owner` walks the
 * `part_of` chain until an ancestor has an owner; `resolve_location` prefers a
 * direct `located_in` but falls back to the chain, reports which of the two it
 * used, and reports a conflict when both exist and disagree instead of picking
 * one.
 *
 * Traversal is bounded and cycle-safe: the chain follows a functional edge, so
 * it can revisit a node, and a repeat is reported rather than followed again.
 */
import type { EdgeType, GraphEdge, GraphNode } from './schema.js';
import type { GraphView } from './projection.js';
export type FilterMode = 'include' | 'exclude';
/**
 * A filter over candidate nodes.
 *
 * This is the whole query language. `cognitive-agent` grew 50 command variants
 * (`WhatIsInsideUnionOwnedByNotPartOf`, …) that are all one `And`/`Or`/`Not`
 * tree over these leaves, so only the algebra is kept.
 */
export type Predicate = {
    type: 'true';
} | {
    type: 'false';
} | {
    type: 'owner';
    owner: string;
    mode: FilterMode;
} | {
    type: 'part_of';
    parent: string;
    mode: FilterMode;
} | {
    type: 'located_in';
    place: string;
    mode: FilterMode;
} | {
    type: 'node_type';
    nodeType: GraphNode['type'];
    mode: FilterMode;
} | {
    type: 'and';
    of: Predicate[];
} | {
    type: 'or';
    of: Predicate[];
} | {
    type: 'not';
    of: Predicate;
};
/** A chain followed along one functional relation. */
export interface ChainResult {
    /** The starting node first, then each ancestor, up to the repeat. */
    path: string[];
    /** True when the chain returned to a node it had already visited. */
    cycle: boolean;
}
export declare function followChain(view: GraphView, start: string, type: EdgeType): ChainResult;
/** The single active target of a functional relation, if there is one. */
export declare function targetOf(view: GraphView, from: string, type: EdgeType): string | undefined;
/** Every active target of a relation (functional ones have at most one). */
export declare function targetsOf(view: GraphView, from: string, type: EdgeType): string[];
/** The nodes pointing at `to` through `type`. */
export declare function sourcesOf(view: GraphView, to: string, type: EdgeType): string[];
export type InferenceSource = 'direct' | 'part_of_derived';
export interface OwnerResolution {
    entity: string;
    owner?: string;
    source: InferenceSource | 'unknown';
    /** `entity`, then each ancestor walked to reach the owner. */
    path: string[];
    cycle: boolean;
}
/**
 * Who owns an entity.
 *
 * A direct `owned_by` wins. Otherwise the owner is inherited from the nearest
 * ancestor on the `part_of` chain that has one — the entity is owned by whoever
 * owns what it is part of.
 */
export declare function resolveOwner(view: GraphView, entity: string): OwnerResolution;
export interface LocationCandidate {
    location: string;
    source: InferenceSource;
    path: string[];
}
export type LocationResolution = {
    kind: 'resolved';
    entity: string;
    location: string;
    source: InferenceSource;
    path: string[];
} | {
    kind: 'conflict';
    entity: string;
    candidates: LocationCandidate[];
} | {
    kind: 'unknown';
    entity: string;
    path: string[];
    cycle: boolean;
};
/**
 * Where an entity is.
 *
 * A direct `located_in` and an inherited one are both candidates. When they
 * name different places the result is a conflict — the projection rules are
 * explicit that an unresolved conflict must be surfaced rather than resolved by
 * recency.
 */
export declare function resolveLocation(view: GraphView, entity: string): LocationResolution;
/**
 * True when `entity` is a strict descendant of `parent` through `part_of`.
 *
 * Reflexive is not part of: `part_of` is a strict partial order, so "what is
 * inside X" never includes X itself. The original `entity_matches_part_of_parent`
 * made the same distinction, and `…NotPartOf` queries depend on it.
 */
export declare function isPartOf(view: GraphView, entity: string, parent: string): boolean;
export declare function evalPredicate(view: GraphView, nodeId: string, predicate: Predicate): boolean;
export interface TraverseOptions {
    start: string;
    via: EdgeType[];
    direction: 'out' | 'in' | 'both';
    /** Bounded by the caller and by the plugin's `maxDepth`. */
    depth: number;
}
export interface TraverseResult {
    /** Reached nodes in breadth-first order, `start` included. */
    reached: string[];
    /** Every `via` edge between two reached nodes — the induced subgraph. */
    walked: GraphEdge[];
    /** Chains that returned to a node already on their path. */
    cycles: string[][];
    truncated: boolean;
}
export declare function traverse(view: GraphView, options: TraverseOptions): TraverseResult;
/** Render a predicate back to the model, so a query can be read. */
export declare function describePredicate(predicate: Predicate): string;
/** A relation is functional if a second target replaces the first. */
export declare function isFunctionalEdge(type: EdgeType): boolean;

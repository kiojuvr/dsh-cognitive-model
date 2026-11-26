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
import type { EdgeType, GraphEdge, GraphNode } from './schema.js'
import { isFunctional } from './schema.js'
import type { GraphView } from './projection.js'

export type FilterMode = 'include' | 'exclude'

/**
 * A filter over candidate nodes.
 *
 * This is the whole query language. `cognitive-agent` grew 50 command variants
 * (`WhatIsInsideUnionOwnedByNotPartOf`, …) that are all one `And`/`Or`/`Not`
 * tree over these leaves, so only the algebra is kept.
 */
export type Predicate =
  | { type: 'true' }
  | { type: 'false' }
  | { type: 'owner'; owner: string; mode: FilterMode }
  | { type: 'part_of'; parent: string; mode: FilterMode }
  | { type: 'located_in'; place: string; mode: FilterMode }
  | { type: 'node_type'; nodeType: GraphNode['type']; mode: FilterMode }
  | { type: 'and'; of: Predicate[] }
  | { type: 'or'; of: Predicate[] }
  | { type: 'not'; of: Predicate }

/** A chain followed along one functional relation. */
export interface ChainResult {
  /** The starting node first, then each ancestor, up to the repeat. */
  path: string[]
  /** True when the chain returned to a node it had already visited. */
  cycle: boolean
}

export function followChain(view: GraphView, start: string, type: EdgeType): ChainResult {
  const path: string[] = [start]
  const seen = new Set<string>([start])
  let current = start
  for (;;) {
    const next = targetOf(view, current, type)
    if (next === undefined) return { path, cycle: false }
    if (seen.has(next)) {
      path.push(next)
      return { path, cycle: true }
    }
    seen.add(next)
    path.push(next)
    current = next
  }
}

/** The single active target of a functional relation, if there is one. */
export function targetOf(view: GraphView, from: string, type: EdgeType): string | undefined {
  for (const edge of view.edges) {
    if (edge.from === from && edge.type === type) return edge.to
  }
  return undefined
}

/** Every active target of a relation (functional ones have at most one). */
export function targetsOf(view: GraphView, from: string, type: EdgeType): string[] {
  return view.edges.filter((edge) => edge.from === from && edge.type === type).map((edge) => edge.to)
}

/** The nodes pointing at `to` through `type`. */
export function sourcesOf(view: GraphView, to: string, type: EdgeType): string[] {
  return view.edges.filter((edge) => edge.to === to && edge.type === type).map((edge) => edge.from)
}

export type InferenceSource = 'direct' | 'part_of_derived'

export interface OwnerResolution {
  entity: string
  owner?: string
  source: InferenceSource | 'unknown'
  /** `entity`, then each ancestor walked to reach the owner. */
  path: string[]
  cycle: boolean
}

/**
 * Who owns an entity.
 *
 * A direct `owned_by` wins. Otherwise the owner is inherited from the nearest
 * ancestor on the `part_of` chain that has one — the entity is owned by whoever
 * owns what it is part of.
 */
export function resolveOwner(view: GraphView, entity: string): OwnerResolution {
  const direct = targetOf(view, entity, 'owned_by')
  if (direct !== undefined) return { entity, owner: direct, source: 'direct', path: [entity], cycle: false }

  const chain = followChain(view, entity, 'part_of')
  for (const ancestor of chain.path.slice(1)) {
    const owner = targetOf(view, ancestor, 'owned_by')
    if (owner !== undefined) {
      return { entity, owner, source: 'part_of_derived', path: chain.path.slice(0, chain.path.indexOf(ancestor) + 1), cycle: chain.cycle }
    }
  }
  return { entity, source: 'unknown', path: chain.path, cycle: chain.cycle }
}

export interface LocationCandidate {
  location: string
  source: InferenceSource
  path: string[]
}

export type LocationResolution =
  | { kind: 'resolved'; entity: string; location: string; source: InferenceSource; path: string[] }
  | { kind: 'conflict'; entity: string; candidates: LocationCandidate[] }
  | { kind: 'unknown'; entity: string; path: string[]; cycle: boolean }

/**
 * Where an entity is.
 *
 * A direct `located_in` and an inherited one are both candidates. When they
 * name different places the result is a conflict — the projection rules are
 * explicit that an unresolved conflict must be surfaced rather than resolved by
 * recency.
 */
export function resolveLocation(view: GraphView, entity: string): LocationResolution {
  const chain = followChain(view, entity, 'part_of')
  const candidates: LocationCandidate[] = []

  const direct = targetOf(view, entity, 'located_in')
  if (direct !== undefined) candidates.push({ location: direct, source: 'direct', path: [entity] })

  for (const ancestor of chain.path.slice(1)) {
    const inherited = targetOf(view, ancestor, 'located_in')
    if (inherited === undefined) continue
    candidates.push({
      location: inherited,
      source: 'part_of_derived',
      path: chain.path.slice(0, chain.path.indexOf(ancestor) + 1),
    })
  }

  if (candidates.length === 0) {
    return { kind: 'unknown', entity, path: chain.path, cycle: chain.cycle }
  }
  const places = new Set(candidates.map((candidate) => candidate.location))
  if (places.size > 1) return { kind: 'conflict', entity, candidates }
  const chosen = candidates[0]
  if (chosen === undefined) return { kind: 'unknown', entity, path: chain.path, cycle: chain.cycle }
  return { kind: 'resolved', entity, location: chosen.location, source: chosen.source, path: chosen.path }
}

/**
 * True when `entity` is a strict descendant of `parent` through `part_of`.
 *
 * Reflexive is not part of: `part_of` is a strict partial order, so "what is
 * inside X" never includes X itself. The original `entity_matches_part_of_parent`
 * made the same distinction, and `…NotPartOf` queries depend on it.
 */
export function isPartOf(view: GraphView, entity: string, parent: string): boolean {
  return followChain(view, entity, 'part_of').path.slice(1).includes(parent)
}

export function evalPredicate(view: GraphView, nodeId: string, predicate: Predicate): boolean {
  const mode = 'mode' in predicate ? predicate.mode : 'include'
  const raw = evalRaw(view, nodeId, predicate)
  return mode === 'exclude' ? !raw : raw
}

function evalRaw(view: GraphView, nodeId: string, predicate: Predicate): boolean {
  switch (predicate.type) {
    case 'true':
      return true
    case 'false':
      return false
    case 'owner':
      return resolveOwner(view, nodeId).owner === predicate.owner
    case 'part_of':
      return isPartOf(view, nodeId, predicate.parent)
    case 'located_in': {
      const resolution = resolveLocation(view, nodeId)
      return resolution.kind === 'resolved' && resolution.location === predicate.place
    }
    case 'node_type':
      return view.nodes.get(nodeId)?.type === predicate.nodeType
    case 'and':
      return predicate.of.every((entry) => evalPredicate(view, nodeId, entry))
    case 'or':
      return predicate.of.some((entry) => evalPredicate(view, nodeId, entry))
    case 'not':
      return !evalPredicate(view, nodeId, predicate.of)
  }
}

export interface TraverseOptions {
  start: string
  via: EdgeType[]
  direction: 'out' | 'in' | 'both'
  /** Bounded by the caller and by the plugin's `maxDepth`. */
  depth: number
}

export interface TraverseResult {
  /** Reached nodes in breadth-first order, `start` included. */
  reached: string[]
  /** Every `via` edge between two reached nodes — the induced subgraph. */
  walked: GraphEdge[]
  /** Chains that returned to a node already on their path. */
  cycles: string[][]
  truncated: boolean
}

export function traverse(view: GraphView, options: TraverseOptions): TraverseResult {
  const via = new Set(options.via)
  const reached: string[] = []
  const seen = new Set<string>([options.start])
  let frontier: Array<{ id: string; path: string[] }> = [{ id: options.start, path: [options.start] }]
  let truncated = false

  for (let level = 0; level < options.depth; level += 1) {
    const next: Array<{ id: string; path: string[] }> = []
    for (const entry of frontier) {
      for (const edge of view.edges) {
        if (!via.has(edge.type)) continue
        const forward = edge.from === entry.id
        const backward = edge.to === entry.id
        if (!(forward || backward)) continue
        if (options.direction === 'out' && !forward) continue
        if (options.direction === 'in' && !backward) continue
        const neighbour = forward ? edge.to : edge.from
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        reached.push(neighbour)
        next.push({ id: neighbour, path: [...entry.path, neighbour] })
      }
    }
    if (next.length === 0) break
    frontier = next
    if (level === options.depth - 1) truncated = true
  }

  // The result is the subgraph the walk reached, not only the BFS tree: an edge
  // between two reached nodes is part of what the caller asked to see (P2-4).
  const all = [options.start, ...reached]
  const reachedSet = new Set(all)
  const walked = view.edges.filter(
    (edge) => via.has(edge.type) && reachedSet.has(edge.from) && reachedSet.has(edge.to),
  )

  return { reached: all, walked, cycles: findCycles(all, walked, options.direction), truncated }
}

/**
 * Cycles in the traversed subgraph.
 *
 * A depth-first search with a recursion stack, not "a node was seen twice":
 * in an undirected walk the edge back to the parent is not a cycle, and a
 * breadth-first path never revisits a node, so the earlier check reported the
 * parent edge as a cycle and missed real ones (P2-5).
 */
function findCycles(
  nodes: readonly string[],
  edges: readonly GraphEdge[],
  direction: TraverseOptions['direction'],
): string[][] {
  const adjacency = new Map<string, string[]>()
  for (const id of nodes) adjacency.set(id, [])
  for (const edge of edges) {
    if (direction === 'out' || direction === 'both') adjacency.get(edge.from)?.push(edge.to)
    if (direction === 'in' || direction === 'both') adjacency.get(edge.to)?.push(edge.from)
  }

  const state = new Map<string, 1 | 2>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seenCycles = new Set<string>()

  const visit = (node: string, parent: string | undefined): void => {
    state.set(node, 1)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      // An undirected walk sees the edge it came by; that is not a cycle.
      if (direction === 'both' && next === parent) continue
      const status = state.get(next)
      if (status === undefined) {
        visit(next, node)
      } else if (status === 1) {
        const start = stack.indexOf(next)
        const cycle = [...stack.slice(start), next]
        const key = cycle.join('>')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          cycles.push(cycle)
        }
      }
    }
    stack.pop()
    state.set(node, 2)
  }

  for (const id of nodes) {
    if (state.get(id) === undefined) visit(id, undefined)
  }
  return cycles
}

/** Render a predicate back to the model, so a query can be read. */
export function describePredicate(predicate: Predicate): string {
  switch (predicate.type) {
    case 'true':
      return 'true'
    case 'false':
      return 'false'
    case 'owner':
      return `${predicate.mode === 'exclude' ? 'not ' : ''}owned_by(${predicate.owner})`
    case 'part_of':
      return `${predicate.mode === 'exclude' ? 'not ' : ''}part_of(${predicate.parent})`
    case 'located_in':
      return `${predicate.mode === 'exclude' ? 'not ' : ''}located_in(${predicate.place})`
    case 'node_type':
      return `${predicate.mode === 'exclude' ? 'not ' : ''}type(${predicate.nodeType})`
    case 'and':
      return `and(${predicate.of.map(describePredicate).join(', ')})`
    case 'or':
      return `or(${predicate.of.map(describePredicate).join(', ')})`
    case 'not':
      return `not(${describePredicate(predicate.of)})`
  }
}

/** A relation is functional if a second target replaces the first. */
export function isFunctionalEdge(type: EdgeType): boolean {
  return isFunctional(type)
}

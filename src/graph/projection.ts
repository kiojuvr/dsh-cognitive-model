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
import type { Confidence, Evidence, FactSource, Milestone } from '@kioju/dsh-cognitive-core'
import { type GraphEdge, type GraphNode, type NodeType } from './schema.js'
import { type GraphEvent, type NodePayload, projectionKeyOf } from './events.js'
import type { PredictionErrorDirection, PredictionErrorKind, RevisitTarget } from './prediction.js'

export interface GraphConflict {
  key: string
  kind: 'node' | 'edge'
  /** One line per competing event, newest first. */
  candidates: Array<{ eventId: string; at: string; summary: string }>
}

/** A prediction error as a read returns it. */
export interface ProjectedError {
  id: string
  kind: PredictionErrorKind
  direction: PredictionErrorDirection
  subject: string
  predicted: string
  observed: string
  lesson?: string
  factId?: string
  /** What the error puts in question, when the writer recorded an impact. */
  revisit?: RevisitTarget
  scope: string
  confidence: Confidence
  source: FactSource
  evidence: Evidence[]
  /** When it was recorded. */
  at: string
  /** Log order; the newest record has the highest seq. */
  seq: number
}

export interface GraphView {
  /** Active nodes by id. */
  nodes: Map<string, GraphNode>
  /** Active edges. */
  edges: GraphEdge[]
  /**
   * Nodes a retraction removed. Kept so a reference to one can be explained
   * ("it existed and was withdrawn") rather than looking like a typo.
   */
  retracted: Map<string, GraphNode>
  /** Active prediction errors, oldest first. */
  errors: ProjectedError[]
  conflicts: GraphConflict[]
}

export type EventStatus = 'active' | 'superseded' | 'invalidated' | 'future' | 'expired'

function validAt(event: GraphEvent, now: Date): boolean {
  const instant = now.getTime()
  if (event.validFrom !== undefined && Date.parse(event.validFrom) > instant) return false
  if (event.validTo !== undefined && Date.parse(event.validTo) < instant) return false
  return true
}

/** Why an event is or is not current. Used by `graph_history`. */
export function eventStatus(event: GraphEvent, events: readonly GraphEvent[], now: Date): EventStatus {
  for (const other of events) {
    if (other.supersedes.includes(event.id)) return 'superseded'
    if (other.invalidates.includes(event.id)) return 'invalidated'
  }
  if (event.validFrom !== undefined && Date.parse(event.validFrom) > now.getTime()) return 'future'
  if (event.validTo !== undefined && Date.parse(event.validTo) < now.getTime()) return 'expired'
  return 'active'
}

function nodeFrom(
  payload: NodePayload,
  event: GraphEvent,
  createdAt: string,
): GraphNode {
  return {
    id: payload.id,
    type: payload.type,
    scope: event.scope,
    label: payload.label,
    ...(payload.value === undefined ? {} : { value: payload.value }),
    ...(payload.direction === undefined ? {} : { direction: payload.direction }),
    ...(payload.conditions === undefined ? {} : { conditions: payload.conditions }),
    errorIds: payload.errorIds ?? [],
    paths: payload.paths ?? [],
    docs: payload.docs ?? [],
    milestones: payload.milestones ?? [],
    confidence: confidenceOfSource(event.source),
    source: event.source,
    evidence: event.evidence,
    createdAt,
    updatedAt: event.at,
  }
}

/** `Confidence` follows from the source; a caller cannot claim more than it saw. */
export function confidenceOfSource(source: FactSource): Confidence {
  switch (source) {
    case 'verified_command':
      return 'verified'
    case 'tool_output':
    case 'executor_summary':
      return 'observed'
    case 'user_input':
    case 'human_instruction':
    case 'human_approval':
    case 'retrieved_memory':
      return 'reported'
    case 'agent_inference':
      return 'inferred'
  }
}

export function projectEvents(events: readonly GraphEvent[], now: Date): GraphView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  // The most recent payload for each coordinate, used to describe a retracted
  // node. Retractions carry no payload of their own.
  const latestNode = new Map<string, { payload: NodePayload; event: GraphEvent }>()
  const firstAt = new Map<string, string>()
  for (const event of ordered) {
    if (event.node !== undefined && event.op === 'upsert_node') {
      latestNode.set(event.node.id, { payload: event.node, event })
      if (!firstAt.has(`node:${event.node.id}`)) firstAt.set(`node:${event.node.id}`, event.at)
    }
  }

  const groups = groupActiveEvents(ordered, now)

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const retracted = new Map<string, GraphNode>()
  const errors: ProjectedError[] = []
  const conflicts: GraphConflict[] = []

  for (const [key, bucket] of groups) {
    if (bucket.length > 1) {
      conflicts.push({
        key,
        kind: key.startsWith('node:') ? 'node' : 'edge',
        candidates: [...bucket]
          .sort((a, b) => b.seq - a.seq)
          .map((event) => ({
            eventId: event.id,
            at: event.at,
            summary: describeEventSummary(event),
          })),
      })
      continue
    }
    const event = bucket[0]
    if (event === undefined) continue

    if (event.op === 'upsert_node' && event.node !== undefined) {
      const createdAt = firstAt.get(`node:${event.node.id}`) ?? event.at
      nodes.set(event.node.id, nodeFrom(event.node, event, createdAt))
      continue
    }
    if (event.op === 'retract_node' && event.node !== undefined) {
      const known = latestNode.get(event.node.id)
      if (known !== undefined) {
        retracted.set(
          known.payload.id,
          nodeFrom(known.payload, known.event, firstAt.get(`node:${known.payload.id}`) ?? known.event.at),
        )
      }
      continue
    }
    if (event.op === 'record_error' && event.error !== undefined) {
      errors.push({
        id: event.error.id,
        kind: event.error.kind,
        direction: event.error.direction,
        subject: event.error.subject,
        predicted: event.error.predicted,
        observed: event.error.observed,
        ...(event.error.lesson === undefined ? {} : { lesson: event.error.lesson }),
        ...(event.error.factId === undefined ? {} : { factId: event.error.factId }),
        ...(event.error.revisit === undefined ? {} : { revisit: event.error.revisit }),
        scope: event.scope,
        confidence: confidenceOfSource(event.source),
        source: event.source,
        evidence: event.evidence,
        at: event.at,
        seq: event.seq,
      })
      continue
    }
    if (event.op === 'set_edge' && event.edge?.to !== undefined) {
      edges.push({
        from: event.edge.from,
        type: event.edge.type,
        to: event.edge.to,
        scope: event.scope,
        confidence: confidenceOfSource(event.source),
        source: event.source,
        evidence: event.evidence,
        updatedAt: event.at,
      })
      continue
    }
    // A retraction that is current removes the edge and contributes nothing.
  }

  errors.sort((a, b) => a.seq - b.seq)
  return { nodes, edges, retracted, errors, conflicts }
}

/**
 * The events that are still current, grouped by projection key.
 *
 * Exported because the write path needs the same answer: which event a new
 * write must supersede, and which key is already in conflict and must not be
 * silently extended.
 */
export function groupActiveEvents(
  events: readonly GraphEvent[],
  now: Date,
): Map<string, GraphEvent[]> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const superseded = new Set<string>()
  const invalidated = new Set<string>()
  for (const event of ordered) {
    for (const id of event.supersedes) superseded.add(id)
    for (const id of event.invalidates) invalidated.add(id)
  }
  const active = ordered.filter(
    (event) => !superseded.has(event.id) && !invalidated.has(event.id) && validAt(event, now),
  )
  const groups = new Map<string, GraphEvent[]>()
  for (const event of active) {
    const key = projectionKeyOf(event)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [event])
    else bucket.push(event)
  }
  return groups
}

function describeEventSummary(event: GraphEvent): string {
  if (event.node !== undefined) return `${event.op} ${event.node.type} ${event.node.id}`
  if (event.error !== undefined) return `${event.op} ${event.error.kind} ${event.error.subject}`
  if (event.edge !== undefined) {
    return `${event.op} ${event.edge.from} -${event.edge.type}-> ${event.edge.to ?? '*'}`
  }
  return event.op
}

/** Acceptance progress, as a record rather than a score. */
export function milestoneProgress(node: GraphNode | undefined): { done: number; total: number } {
  const milestones: Milestone[] = node?.milestones ?? []
  return { done: milestones.filter((item) => item.done).length, total: milestones.length }
}

/** The node types that may carry acceptance items. */
export function acceptsMilestones(type: NodeType): boolean {
  return type === 'objective' || type === 'component'
}

/** Evidence a reader can follow, rendered as one short suffix. */
export function evidenceSuffix(evidence: readonly Evidence[]): string {
  const first = evidence[0]
  if (first === undefined) return ''
  return ` (${first.kind}: ${first.ref})`
}

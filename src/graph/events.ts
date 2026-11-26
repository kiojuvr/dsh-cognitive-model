/**
 * The event log the graph is projected from.
 *
 * `cognitive-agent`'s `state_projection_rules.md` is the rule this follows:
 * state is not stored directly as truth, it is projected from event history.
 * So the durable document holds events only — there is no `nodes` array to get
 * out of step with them — and every read folds the log.
 *
 * An event is never edited. A correction is a new event that names the events
 * it `supersedes` (an update) or `invalidates` (a withdrawal). A valid-time
 * window can also gate an event without touching it.
 */
import type { Evidence, FactSource, Milestone } from '@kioju/dsh-cognitive-core'
import { type EdgeType, type NodeType, SCHEMA_VERSION, isFunctional } from './schema.js'
import {
  isPredictionErrorDirection,
  type PredictionErrorDirection,
  type PredictionErrorKind,
  type RevisitTarget,
} from './prediction.js'

export type GraphOp =
  | 'upsert_node'
  | 'retract_node'
  | 'set_edge'
  | 'retract_edge'
  | 'record_error'

/**
 * A prediction error: an expectation that lost to reality.
 *
 * It is not a node, because it is not part of the structure and not a claim
 * about the world: it is the record of a claim (or an expectation) being
 * corrected. It is appended once and never superseded — a correction is a new
 * record, so the earlier expectation stays readable.
 */
export interface ErrorPayload {
  id: string
  kind: PredictionErrorKind
  /** Which way the outcome differed: better or worse than expected. */
  direction: PredictionErrorDirection
  /** Grouping key, e.g. `repo`, `task.phase4`. */
  subject: string
  /** What was expected, one sentence. */
  predicted: string
  /** What actually happened, one sentence. */
  observed: string
  /** What to do differently next time. */
  lesson?: string
  /** The node that now carries the correction, when one was written. */
  factId?: string
  /** What the error puts in question: the trigger for the bird's-eye check. */
  revisit?: RevisitTarget
}

export interface NodePayload {
  id: string
  type: NodeType
  label: string
  value?: string
  /** Heuristic nodes: better / worse. */
  direction?: PredictionErrorDirection
  /** Heuristic nodes: when the rule applies. */
  conditions?: string
  /** Heuristic nodes: the prediction errors it was distilled from. */
  errorIds?: string[]
  paths?: string[]
  docs?: string[]
  milestones?: Milestone[]
}

export interface EdgeRef {
  from: string
  type: EdgeType
  /** Required for `set_edge`; required for `retract_edge` on a non-functional relation. */
  to?: string
}

export interface GraphEvent {
  /** Monotonic; also the tie-breaker the projection uses for ordering. */
  seq: number
  id: string
  at: string
  session?: string
  op: GraphOp
  scope: string
  node?: NodePayload
  edge?: EdgeRef
  error?: ErrorPayload
  reason?: string
  evidence: Evidence[]
  source: FactSource
  /** Event ids this event replaces (a correction or an update). */
  supersedes: string[]
  /** Event ids this event withdraws without replacing. */
  invalidates: string[]
  validFrom?: string
  validTo?: string
}

/**
 * The coordinate a projection groups by.
 *
 * A functional relation groups by `(from, type)`, so writing a second target is
 * the same coordinate and the write path supersedes the first. A non-functional
 * relation also groups by `to`, so several targets coexist.
 */
export function projectionKeyOf(event: GraphEvent): string {
  if (event.node !== undefined) return `node:${event.node.id}`
  if (event.error !== undefined) return `error:${event.error.id}`
  const edge = event.edge
  if (edge === undefined) return `event:${event.id}`
  return isFunctional(edge.type)
    ? `edge:${edge.from}:${edge.type}`
    : `edge:${edge.from}:${edge.type}:${edge.to ?? '*'}`
}

/** A one-line description, used by `graph_history` and by a conflict report. */
export function describeEvent(event: GraphEvent): string {
  if (event.node !== undefined) {
    const node = event.node
    const verb = event.op === 'retract_node' ? 'retract' : 'set'
    return `${verb} ${node.type} ${node.id}: ${node.label}`
  }
  if (event.error !== undefined) {
    return `record ${event.error.kind}/${event.error.direction} error ${event.error.subject}: expected ${event.error.predicted}`
  }
  const edge = event.edge
  if (edge === undefined) return event.op
  const arrow = edge.to === undefined ? edge.from : `${edge.from} -${edge.type}-> ${edge.to}`
  return event.op === 'retract_edge' ? `retract ${arrow}` : `set ${arrow}`
}

export interface GraphStats {
  /** Durable writes accepted (events appended). */
  writes: number
  /** Retractions accepted. Counted inside `writes` too; this is the subset. */
  retractions: number
  /** Writes the policy refused. Zero would mean the policy is not doing anything. */
  rejections: number
  /** The same claim written twice; nothing was appended. */
  duplicates: number
}

export interface GraphDocument {
  schemaVersion: number
  workspace: string
  events: GraphEvent[]
  stats: GraphStats
  /** The next `seq` to hand out. Kept so a compacted log cannot reuse one. */
  nextSeq: number
}

export function emptyStats(): GraphStats {
  return { writes: 0, retractions: 0, rejections: 0, duplicates: 0 }
}

export function emptyDocument(workspace: string): GraphDocument {
  return { schemaVersion: 2, workspace, events: [], stats: emptyStats(), nextSeq: 1 }
}

/** Reject a document that is not this shape; the store then quarantines it. */
export function isGraphDocument(value: unknown): value is GraphDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { events?: unknown; stats?: unknown }
  if (!Array.isArray(candidate.events)) return false
  if (typeof candidate.stats !== 'object' || candidate.stats === null) return false
  return candidate.events.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const event = entry as { op?: unknown; at?: unknown; evidence?: unknown }
    return typeof event.op === 'string' && typeof event.at === 'string' && Array.isArray(event.evidence)
  })
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
export function schemaProblem(doc: GraphDocument): string | undefined {
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return (
      `the graph is schema ${doc.schemaVersion}, not schema ${SCHEMA_VERSION}; ` +
      'it must be migrated before this version can read it'
    )
  }
  for (const event of doc.events) {
    if (event.op !== 'record_error' || event.error === undefined) continue
    if (!isPredictionErrorDirection(event.error.direction)) {
      return 'a prediction error has no direction; the graph must be migrated before this version can read it'
    }
  }
  return undefined
}

/** The command the agent runs to migrate one workspace. */
export function migrationCommand(root: string): string {
  return `node scripts/migrate-peg.mjs "${root}"`
}

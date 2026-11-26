/**
 * The four model tools.
 *
 * Two write, two read. The split is deliberate: a graph is only useful if a
 * reader can ask "what is this part of, who owns it, where is it" without
 * having been told the answer, so the read side carries the traversal and the
 * two inferences rather than making the caller spell out every hop.
 */
import { parseEvidence, type Evidence, type FactSource, type Milestone } from '@kioju/dsh-cognitive-core'
import { sessionIdOf, type ContentBlock, type Context, type ToolRunContext } from '../cordis.js'
import {
  EDGE_TYPES,
  MAX_LINKS,
  MAX_MILESTONES,
  NODE_TYPES,
  NODE_TYPE_HINT,
  edgeSpec,
  isEdgeType,
  isNodeType,
  type EdgeType,
  type NodeType,
} from './schema.js'
import { type EdgeRef, type GraphOp } from './events.js'
import {
  PREDICTION_ERROR_DIRECTIONS,
  PREDICTION_ERROR_DIRECTION_HINT,
  PREDICTION_ERROR_KINDS,
  PREDICTION_ERROR_KIND_HINT,
  REVISIT_TARGETS,
  REVISIT_TARGET_HINT,
  isPredictionErrorDirection,
  isPredictionErrorKind,
  isRevisitTarget,
  type PredictionErrorDirection,
  type PredictionErrorInput,
  type PredictionErrorKind,
} from './prediction.js'
import { type GraphNode, type GraphEdge } from './schema.js'
import {
  evalPredicate,
  resolveLocation,
  resolveOwner,
  traverse,
  type Predicate,
} from './query.js'
import {
  milestoneProgress,
  type GraphView,
} from './projection.js'
import { GraphService, type EdgeInput, type NodeInput } from './service.js'
import type { DirectoryResolver } from '@kioju/dsh-cognitive-core'

const MAX_QUERY_LIMIT = 200
const MAX_HISTORY_LIMIT = 100

const EVIDENCE_SCHEMA = {
  type: 'array',
  description:
    'What you actually saw: a file you read, a command you ran, a url, or the human\'s own words. ' +
    'Without evidence the write is a guess and is refused.',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['file', 'command', 'url', 'note'] },
      ref: { type: 'string', description: 'Path, command, url, or a short quote.' },
      excerpt: { type: 'string', description: 'Short quoted excerpt. Keep it brief.' },
    },
    required: ['kind', 'ref'],
  },
} as const

const MILESTONE_SCHEMA = {
  type: 'array',
  description:
    'For an objective or component node: its acceptance items — what "done" means for it. ' +
    'A record, not a score.',
  items: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What is accepted, one line.' },
      done: { type: 'boolean', description: 'Whether it is met.' },
      at: { type: 'string', description: 'Optional. When it was met (ISO 8601).' },
      evidence: EVIDENCE_SCHEMA,
    },
    required: ['text', 'done'],
  },
} as const

const NODE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Stable key. Objective nodes use `objective` or `objective/<path>` (parent first); ' +
        'components `component/<key>`; tasks `task/current` or `task/<key>`; decisions, ' +
        'constraints, risks, facts and preferences their own key; entities the name they are known by.',
    },
    type: {
      type: 'string',
      enum: [...NODE_TYPES],
      description: NODE_TYPES.map((type) => `${type}: ${NODE_TYPE_HINT[type]}`).join('; '),
    },
    label: { type: 'string', description: 'A short human-readable name.' },
    value: {
      type: 'string',
      description:
        'What it is, one sentence. For a decision, put the reason here; for a fact, the claim; ' +
        'for a heuristic, the rule or action.',
    },
    direction: {
      type: 'string',
      enum: [...PREDICTION_ERROR_DIRECTIONS],
      description:
        'Heuristic only. Which way the distilled rule points: better (an encouragement) or worse ' +
        '(a warning). Required for a heuristic; refused on other node types.',
    },
    conditions: {
      type: 'string',
      description:
        'Heuristic only. When the rule applies, one sentence; use "always" when it is unconditional. ' +
        'Required for a heuristic; refused on other node types.',
    },
    errorIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Heuristic only. The prediction error ids the rule was distilled from (1-10, active). ' +
        'Record the errors first; their ids are returned by graph_write.',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: `Files or directories this objective or component covers (globs allowed). At most ${MAX_LINKS}.`,
    },
    docs: {
      type: 'array',
      items: { type: 'string' },
      description: `Documents that explain this node. At most ${MAX_LINKS}.`,
    },
    milestones: MILESTONE_SCHEMA,
  },
  required: ['id', 'type', 'label'],
} as const

const EDGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'The source node id.' },
    type: {
      type: 'string',
      enum: [...EDGE_TYPES],
      description: EDGE_TYPES.map((type) => `${type}: ${edgeSpec(type).hint}`).join('; '),
    },
    to: { type: 'string', description: 'The target node id.' },
  },
  required: ['from', 'type', 'to'],
} as const

const EDGE_REF_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'The source node id.' },
    type: { type: 'string', enum: [...EDGE_TYPES], description: 'The relation to remove.' },
    to: {
      type: 'string',
      description:
        'The target node id. For `requires` / `verifies`, name the target to remove one, or omit it to remove ' +
        'every target. For a functional relation, omit it (there is at most one target).',
    },
  },
  required: ['from', 'type'],
} as const

const ERROR_INPUT_SCHEMA = {
  type: 'object',
  description:
    'A prediction error: an expectation that differed from what happened (better or worse). It is ' +
    'recorded as an event, not a node, because it is not part of the structure and not a claim ' +
    'about the world.',
  properties: {
    kind: {
      type: 'string',
      enum: [...PREDICTION_ERROR_KINDS],
      description: PREDICTION_ERROR_KINDS.map((kind) => `${kind}: ${PREDICTION_ERROR_KIND_HINT[kind]}`).join('; '),
    },
    direction: {
      type: 'string',
      enum: [...PREDICTION_ERROR_DIRECTIONS],
      description: PREDICTION_ERROR_DIRECTIONS.map(
        (direction) => `${direction}: ${PREDICTION_ERROR_DIRECTION_HINT[direction]}`,
      ).join('; '),
    },
    subject: { type: 'string', description: 'Short key naming what the expectation was about.' },
    predicted: { type: 'string', description: 'What was expected, one sentence.' },
    observed: { type: 'string', description: 'What actually happened, one sentence.' },
    lesson: { type: 'string', description: 'What to do differently next time; optional.' },
    factId: { type: 'string', description: 'The node that now carries the correction, when one was written.' },
    revisit: {
      type: 'string',
      enum: [...REVISIT_TARGETS],
      description:
        'Optional. Set only when this error puts the current objective, an acceptance item, or a priority ' +
        'in question; the recall then asks for one non-binding bird\'s-eye check, carrying this error as the ' +
        'reason. The kind never triggers the check by itself: an estimate-only miss leaves this unset. ' +
        REVISIT_TARGETS.map((target) => `${target}: ${REVISIT_TARGET_HINT[target]}`).join('; '),
    },
    scope: { type: 'string', description: 'Optional. Defaults to the call\'s scope.' },
  },
  required: ['kind', 'direction', 'subject', 'predicted', 'observed'],
} as const

const PREDICATE_SCHEMA = {
  type: 'object',
  description:
    'A filter over candidate nodes. Leaves: {type:"owner", owner, mode?}, {type:"part_of", parent, mode?}, ' +
    '{type:"located_in", place, mode?}, {type:"node_type", nodeType, mode?}. Composites: ' +
    '{type:"and"|"or", of:[...]}, {type:"not", of:{...}}. Constants: {type:"true"}, {type:"false"}. ' +
    'mode is "include" (default) or "exclude". Owner and location follow the part_of chain.',
} as const

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) throw new Error('arguments must be an object')
  return args as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`)
  return value
}

function resolveRoot(service: GraphService, exec: ToolRunContext, directoryOf: DirectoryResolver): string {
  const cwd = directoryOf(exec.agent)
  if (typeof cwd === 'string' && cwd !== '') return service.rootFor(cwd)
  const fallback = service.currentRoot()
  if (fallback !== undefined) return fallback
  throw new Error('cannot resolve the workspace directory for this call')
}

function parseMilestones(value: unknown): Milestone[] {
  if (!Array.isArray(value)) throw new Error('milestones must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`milestones[${index}] must be an object`)
    const raw = entry as { text?: unknown; done?: unknown; at?: unknown; evidence?: unknown }
    if (typeof raw.text !== 'string' || raw.text.trim() === '') {
      throw new Error(`milestones[${index}].text must be a non-empty string`)
    }
    if (typeof raw.done !== 'boolean') throw new Error(`milestones[${index}].done must be a boolean`)
    const milestone: Milestone = { text: raw.text.trim(), done: raw.done }
    if (typeof raw.at === 'string' && raw.at !== '') milestone.at = raw.at
    if (raw.evidence !== undefined && raw.evidence !== null) {
      const parsed = parseEvidence(raw.evidence)
      if (!parsed.ok) throw new Error(`milestones[${index}].${parsed.message}`)
      if (parsed.evidence.length > 0) milestone.evidence = parsed.evidence
    }
    return milestone
  })
}

function parseNodes(value: unknown): NodeInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('nodes must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`nodes[${index}] must be an object`)
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new Error(`nodes[${index}].id is required`)
    if (!isNodeType(raw.type)) throw new Error(`nodes[${index}].type must be one of ${NODE_TYPES.join(', ')}`)
    if (typeof raw.label !== 'string' || raw.label.trim() === '') {
      throw new Error(`nodes[${index}].label is required`)
    }
    const node: NodeInput = { id: raw.id.trim(), type: raw.type as NodeType, label: raw.label.trim() }
    if (typeof raw.value === 'string' && raw.value !== '') node.value = raw.value
    const direction = optionalString(raw, 'direction')
    if (direction !== undefined) {
      if (!isPredictionErrorDirection(direction)) {
        throw new Error(
          `nodes[${index}].direction must be one of ${PREDICTION_ERROR_DIRECTIONS.join(', ')}`,
        )
      }
      node.direction = direction
    }
    const conditions = optionalString(raw, 'conditions')
    if (conditions !== undefined) node.conditions = conditions
    const errorIds = optionalStringArray(raw, 'errorIds')
    if (errorIds !== undefined) node.errorIds = errorIds
    const paths = optionalStringArray(raw, 'paths')
    if (paths !== undefined) node.paths = paths
    const docs = optionalStringArray(raw, 'docs')
    if (docs !== undefined) node.docs = docs
    if (raw.milestones !== undefined && raw.milestones !== null) {
      const milestones = parseMilestones(raw.milestones)
      if (milestones.length > MAX_MILESTONES) throw new Error(`nodes[${index}] has too many milestones`)
      node.milestones = milestones
    }
    return node
  })
}

function parseEdges(value: unknown): EdgeInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('edges must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`edges[${index}] must be an object`)
    const raw = entry as Record<string, unknown>
    if (typeof raw.from !== 'string' || raw.from.trim() === '') throw new Error(`edges[${index}].from is required`)
    if (!isEdgeType(raw.type)) throw new Error(`edges[${index}].type must be one of ${EDGE_TYPES.join(', ')}`)
    if (typeof raw.to !== 'string' || raw.to.trim() === '') throw new Error(`edges[${index}].to is required`)
    return { from: raw.from.trim(), type: raw.type as EdgeType, to: raw.to.trim() }
  })
}

function parseEdgeRefs(value: unknown): EdgeRef[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('edges must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`edges[${index}] must be an object`)
    const raw = entry as Record<string, unknown>
    if (typeof raw.from !== 'string' || raw.from.trim() === '') throw new Error(`edges[${index}].from is required`)
    if (!isEdgeType(raw.type)) throw new Error(`edges[${index}].type must be one of ${EDGE_TYPES.join(', ')}`)
    const ref: EdgeRef = { from: raw.from.trim(), type: raw.type as EdgeType }
    if (typeof raw.to === 'string' && raw.to.trim() !== '') ref.to = raw.to.trim()
    return ref
  })
}

function parseErrors(value: unknown): PredictionErrorInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('errors must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`errors[${index}] must be an object`)
    const raw = entry as Record<string, unknown>
    if (!isPredictionErrorKind(raw.kind)) {
      throw new Error(`errors[${index}].kind must be one of ${PREDICTION_ERROR_KINDS.join(', ')}`)
    }
    if (!isPredictionErrorDirection(raw.direction)) {
      throw new Error(
        `errors[${index}].direction must be one of ${PREDICTION_ERROR_DIRECTIONS.join(', ')}`,
      )
    }
    const error: PredictionErrorInput = {
      kind: raw.kind as PredictionErrorKind,
      direction: raw.direction,
      subject: requireString(raw, 'subject'),
      predicted: requireString(raw, 'predicted'),
      observed: requireString(raw, 'observed'),
    }
    const lesson = optionalString(raw, 'lesson')
    if (lesson !== undefined) error.lesson = lesson
    const factId = optionalString(raw, 'factId')
    if (factId !== undefined) error.factId = factId
    const revisit = optionalString(raw, 'revisit')
    if (revisit !== undefined) {
      if (!isRevisitTarget(revisit)) {
        throw new Error(`errors[${index}].revisit must be one of ${REVISIT_TARGETS.join(', ')}`)
      }
      error.revisit = revisit
    }
    const scope = optionalString(raw, 'scope')
    if (scope !== undefined) error.scope = scope
    return error
  })
}

function parsePredicate(value: unknown): Predicate {
  if (typeof value !== 'object' || value === null) throw new Error('predicate must be an object')
  const raw = value as Record<string, unknown>
  const type = raw.type
  const mode = raw.mode === undefined || raw.mode === null ? 'include' : raw.mode
  if (mode !== 'include' && mode !== 'exclude') throw new Error('predicate.mode must be include or exclude')

  switch (type) {
    case 'true':
      return { type: 'true' }
    case 'false':
      return { type: 'false' }
    case 'owner':
      return { type: 'owner', owner: requireString(raw, 'owner'), mode }
    case 'part_of':
      return { type: 'part_of', parent: requireString(raw, 'parent'), mode }
    case 'located_in':
      return { type: 'located_in', place: requireString(raw, 'place'), mode }
    case 'node_type': {
      if (!isNodeType(raw.nodeType)) throw new Error(`predicate.nodeType must be one of ${NODE_TYPES.join(', ')}`)
      return { type: 'node_type', nodeType: raw.nodeType, mode }
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(raw.of)) throw new Error(`predicate.${String(type)}.of must be an array`)
      return { type, of: raw.of.map((entry) => parsePredicate(entry)) }
    }
    case 'not':
      return { type: 'not', of: parsePredicate(raw.of) }
    default:
      throw new Error(
        'predicate.type must be one of true, false, owner, part_of, located_in, node_type, and, or, not',
      )
  }
}

function compactNode(node: GraphNode): Record<string, unknown> {
  const progress = milestoneProgress(node)
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    ...(node.value === undefined ? {} : { value: node.value }),
    ...(node.direction === undefined ? {} : { direction: node.direction }),
    ...(node.conditions === undefined ? {} : { conditions: node.conditions }),
    ...(node.errorIds.length === 0 ? {} : { errorIds: node.errorIds }),
    ...(node.paths.length === 0 ? {} : { paths: node.paths }),
    ...(node.docs.length === 0 ? {} : { docs: node.docs }),
    ...(progress.total === 0 ? {} : { milestones: { done: progress.done, total: progress.total } }),
    scope: node.scope,
    confidence: node.confidence,
    updatedAt: node.updatedAt,
  }
}

function compactEdge(edge: GraphEdge): Record<string, unknown> {
  return { from: edge.from, type: edge.type, to: edge.to }
}

export function registerGraphTools(
  ctx: Context,
  service: GraphService,
  directoryOf: DirectoryResolver,
): () => void {
  const disposers: Array<() => void> = []

  disposers.push(
    ctx.tools.register({
      name: 'graph_write',
      description:
        'Add or update nodes and edges in this workspace\'s graph, and record prediction errors. One store ' +
        'holds the cognitive model (objective / component / task / decision), the epistemic record ' +
        '(constraint / risk / fact / preference) and the world model (entity). ' +
        'A durable write needs evidence: a guess is refused. Writing a node, or a second target of a ' +
        'functional relation such as `part_of` or `owned_by`, replaces the earlier claim — the earlier ' +
        'value stays in `graph_history`. Both endpoints of an edge must exist: write them in this call ' +
        'or an earlier one. A prediction error needs evidence for what actually happened — a command, ' +
        'file, or url, not only a note — and a `direction` (better or worse). A heuristic node is a ' +
        'conditional rule distilled from those errors; it needs `direction`, `conditions`, `errorIds`, ' +
        'and usually a `node` edge to the objective or component it serves. Add `revisit` only when the ' +
        'error puts the objective, an acceptance item, or a priority in question: that is what asks for ' +
        'one bird\'s-eye check, and the kind alone never does.',
      parameters: {
        type: 'object',
        properties: {
          nodes: { type: 'array', items: NODE_INPUT_SCHEMA, description: 'Nodes to add or update.' },
          edges: {
            type: 'array',
            items: EDGE_INPUT_SCHEMA,
            description: 'Relations to set. A functional relation keeps one target per (from, type).',
          },
          errors: {
            type: 'array',
            items: ERROR_INPUT_SCHEMA,
            description: 'Prediction errors to record: expectations that differed from what happened.',
          },
          evidence: EVIDENCE_SCHEMA,
          source: {
            type: 'string',
            description:
              'Optional. Derived from the evidence when omitted. agent_inference is always refused.',
          },
          scope: { type: 'string', description: 'Optional. Defaults to "repo".' },
          validFrom: { type: 'string', description: 'Optional. When the claim starts to hold (ISO 8601).' },
          validTo: { type: 'string', description: 'Optional. When it stops holding (ISO 8601).' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nodes: { type: 'array', items: { type: 'string' } },
            edges: { type: 'array', items: { type: 'string' } },
            errors: { type: 'array', items: { type: 'string' } },
            duplicates: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = value as {
            ok?: boolean
            nodes?: string[]
            edges?: string[]
            errors?: string[]
            duplicates?: string[]
            error?: string
          }
          if (result.ok === false) return text(`not written: ${result.error ?? 'unknown reason'}`)
          const parts: string[] = []
          if ((result.nodes?.length ?? 0) > 0) parts.push(`${result.nodes?.length ?? 0} node(s)`)
          if ((result.edges?.length ?? 0) > 0) parts.push(`${result.edges?.length ?? 0} edge(s)`)
          if ((result.errors?.length ?? 0) > 0) parts.push(`${result.errors?.length ?? 0} error(s)`)
          if ((result.duplicates?.length ?? 0) > 0) parts.push(`${result.duplicates?.length ?? 0} unchanged`)
          return text(parts.length === 0 ? 'nothing to write' : `written: ${parts.join(', ')}`)
        },
      },
      async execute(rawArgs, exec): Promise<unknown> {
        const args = asRecord(rawArgs)
        const nodes = parseNodes(args.nodes)
        const edges = parseEdges(args.edges)
        const errors = parseErrors(args.errors)
        if (nodes.length === 0 && edges.length === 0 && errors.length === 0) {
          throw new Error('give at least one node, one edge, or one error')
        }
        const evidence = parseEvidence(args.evidence)
        if (!evidence.ok) throw new Error(evidence.message)
        const source = optionalString(args, 'source')
        const scope = optionalString(args, 'scope')
        const validFrom = optionalString(args, 'validFrom')
        const validTo = optionalString(args, 'validTo')

        const root = resolveRoot(service, exec, directoryOf)
        const session = sessionIdOf(exec.agent)
        const outcome = await service.write(root, {
          nodes,
          edges,
          errors,
          evidence: evidence.evidence,
          ...(source === undefined ? {} : { source: source as FactSource }),
          ...(scope === undefined ? {} : { scope }),
          ...(validFrom === undefined ? {} : { validFrom }),
          ...(validTo === undefined ? {} : { validTo }),
          ...(session === undefined ? {} : { session }),
        })
        if (outcome.kind === 'rejected') return { ok: false, code: outcome.code, error: outcome.message }
        return {
          ok: true,
          nodes: outcome.nodes,
          edges: outcome.edges,
          errors: outcome.errors,
          duplicates: outcome.duplicates,
        }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'graph_retract',
      description:
        'Withdraw a node or a relation from the graph. The event that created it is not erased: the ' +
        'retraction supersedes it and both stay in `graph_history`. Retracting a node also withdraws the ' +
        'edges that point at it, so no relation is left dangling.',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Node ids to withdraw.',
          },
          edges: { type: 'array', items: EDGE_REF_SCHEMA, description: 'Relations to withdraw.' },
          reason: { type: 'string', description: 'Why it is no longer true. Required.' },
          evidence: EVIDENCE_SCHEMA,
          source: { type: 'string', description: 'Optional. Derived from the evidence when omitted.' },
          scope: { type: 'string', description: 'Optional. Defaults to "repo".' },
        },
        required: ['reason'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nodes: { type: 'array', items: { type: 'string' } },
            edges: { type: 'array', items: { type: 'string' } },
            missing: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = value as {
            ok?: boolean
            nodes?: string[]
            edges?: string[]
            missing?: string[]
            error?: string
          }
          if (result.ok === false) return text(`not retracted: ${result.error ?? 'unknown reason'}`)
          const parts: string[] = []
          if ((result.nodes?.length ?? 0) > 0) parts.push(`${result.nodes?.length ?? 0} node(s)`)
          if ((result.edges?.length ?? 0) > 0) parts.push(`${result.edges?.length ?? 0} edge(s)`)
          if ((result.missing?.length ?? 0) > 0) parts.push(`${result.missing?.length ?? 0} not found`)
          return text(parts.length === 0 ? 'nothing to retract' : `retracted: ${parts.join(', ')}`)
        },
      },
      async execute(rawArgs, exec): Promise<unknown> {
        const args = asRecord(rawArgs)
        const nodes = optionalStringArray(args, 'nodes') ?? []
        const edges = parseEdgeRefs(args.edges)
        if (nodes.length === 0 && edges.length === 0) {
          throw new Error('give at least one node or one edge')
        }
        const reason = requireString(args, 'reason')
        const evidence = parseEvidence(args.evidence)
        if (!evidence.ok) throw new Error(evidence.message)
        const source = optionalString(args, 'source')
        const scope = optionalString(args, 'scope')

        const root = resolveRoot(service, exec, directoryOf)
        const session = sessionIdOf(exec.agent)
        const outcome = await service.retract(root, {
          nodes,
          edges,
          reason,
          evidence: evidence.evidence,
          ...(source === undefined ? {} : { source: source as FactSource }),
          ...(scope === undefined ? {} : { scope }),
          ...(session === undefined ? {} : { session }),
        })
        if (outcome.kind === 'rejected') return { ok: false, code: outcome.code, error: outcome.message }
        return { ok: true, nodes: outcome.nodes, edges: outcome.edges, missing: outcome.missing }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'graph_query',
      description:
        'Read the graph. With `start`, walk the relations you name and return the subgraph reached; ' +
        'without it, list nodes matching the predicate. With `infer`, answer the two questions the graph ' +
        'exists for: who owns this, and where is it. A direct `owned_by` wins; the owner is inherited ' +
        'through `part_of` only when nobody set one. A direct `located_in` and an inherited one are both ' +
        'candidates, and a disagreement is reported as a conflict, not resolved. ' +
        'With `errors`, list the recorded prediction errors instead. ' +
        'Unresolved conflicts in the graph are returned with every result.',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'The node to start from.' },
          via: {
            type: 'array',
            items: { type: 'string', enum: [...EDGE_TYPES] },
            description: 'Relations to walk. Defaults to every relation.',
          },
          direction: {
            type: 'string',
            enum: ['out', 'in', 'both'],
            description: 'Walk outgoing, incoming, or both. Defaults to both.',
          },
          depth: { type: 'number', description: 'How many hops. Defaults to 2; capped by the plugin config.' },
          predicate: PREDICATE_SCHEMA,
          infer: {
            type: 'string',
            enum: ['owner', 'location'],
            description: 'Resolve this inference for `start` instead of traversing.',
          },
          errors: {
            type: 'boolean',
            description:
              'List the recorded prediction errors, newest first, instead of graph nodes. ' +
              'The log keeps every record; a correction is a newer record.',
          },
          limit: { type: 'number', description: 'Maximum nodes to return.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            nodes: { type: 'array', items: { type: 'object' } },
            edges: { type: 'array', items: { type: 'object' } },
            errors: { type: 'array', items: { type: 'object' } },
            conflicts: { type: 'array', items: { type: 'object' } },
            inferred: { type: 'object' },
            cycles: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            truncated: { type: 'boolean' },
            note: { type: 'string' },
            error: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = value as {
            ok?: boolean
            nodes?: Array<Record<string, unknown>>
            errors?: Array<{ kind?: string; direction?: string; subject?: string; predicted?: string; observed?: string; lesson?: string; revisit?: string }>
            inferred?: Record<string, unknown>
            conflicts?: unknown[]
            note?: string
            error?: string
          }
          if (result.ok === false) return text(`query failed: ${result.error ?? 'unknown reason'}`)
          const lines: string[] = []
          if (result.errors !== undefined) {
            const errors = result.errors
            lines.push(`${errors.length} prediction error(s)`)
            for (const error of errors.slice(0, 10)) {
              const lesson =
                typeof error.lesson === 'string' && error.lesson !== '' ? `; lesson: ${error.lesson}` : ''
              const revisit =
                typeof error.revisit === 'string' && error.revisit !== ''
                  ? `; revisit: ${error.revisit}`
                  : ''
              lines.push(
                `- [${String(error.kind)}/${String(error.direction)}] ${String(error.subject)}: expected ${String(error.predicted)}` +
                  ` — actually ${String(error.observed)}${revisit}${lesson}`,
              )
            }
            if (errors.length > 10) lines.push(`… ${errors.length - 10} more`)
          } else if (result.inferred !== undefined) {
            lines.push(describeInference(result.inferred))
          } else {
            const nodes = result.nodes ?? []
            lines.push(`${nodes.length} node(s)`)
            for (const node of nodes.slice(0, 20)) {
              const value = node.value === undefined ? '' : ` — ${String(node.value)}`
              lines.push(`- ${String(node.id)} (${String(node.type)}) ${String(node.label)}${value}`)
            }
            if (nodes.length > 20) lines.push(`… ${nodes.length - 20} more`)
          }
          if ((result.conflicts?.length ?? 0) > 0) {
            lines.push(`${result.conflicts?.length ?? 0} unresolved conflict(s)`)
          }
          if (result.note !== undefined) lines.push(result.note)
          return text(lines.join('\n'))
        },
      },
      async execute(rawArgs, exec): Promise<unknown> {
        const args = asRecord(rawArgs)
        const start = optionalString(args, 'start')
        const infer = optionalString(args, 'infer')
        const predicate = args.predicate === undefined || args.predicate === null
          ? undefined
          : parsePredicate(args.predicate)
        const limit = Math.min(
          optionalInt(args, 'limit', 1, MAX_QUERY_LIMIT) ?? service.config.queryLimit,
          MAX_QUERY_LIMIT,
        )
        const depth = Math.min(optionalInt(args, 'depth', 0, 32) ?? 2, service.config.maxDepth)
        const via = optionalStringArray(args, 'via') ?? [...EDGE_TYPES]
        for (const type of via) {
          if (!isEdgeType(type)) throw new Error(`via must list ${EDGE_TYPES.join(', ')}`)
        }
        const direction = optionalString(args, 'direction') ?? 'both'
        if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
          throw new Error('direction must be out, in, or both')
        }

        const root = resolveRoot(service, exec, directoryOf)
        const view = await service.view(root)
        const conflicts = view.conflicts.map((conflict) => ({
          key: conflict.key,
          kind: conflict.kind,
          candidates: conflict.candidates.map((candidate) => candidate.summary),
        }))

        if (args.errors === true) {
          const errors = [...view.errors]
            .sort((left, right) => right.seq - left.seq)
            .slice(0, limit)
            .map((error) => ({
              id: error.id,
              kind: error.kind,
              direction: error.direction,
              subject: error.subject,
              predicted: error.predicted,
              observed: error.observed,
              ...(error.lesson === undefined ? {} : { lesson: error.lesson }),
              ...(error.factId === undefined ? {} : { factId: error.factId }),
              ...(error.revisit === undefined ? {} : { revisit: error.revisit }),
              scope: error.scope,
              at: error.at,
              confidence: error.confidence,
            }))
          return {
            ok: true,
            nodes: [],
            edges: [],
            errors,
            conflicts,
            truncated: view.errors.length > errors.length,
          }
        }

        if (infer !== undefined) {
          if (start === undefined) throw new Error('infer needs start')
          if (infer === 'owner') {
            const resolution = resolveOwner(view, start)
            return {
              ok: true,
              inferred: { ...resolution },
              nodes: [],
              edges: [],
              conflicts,
              truncated: false,
            }
          }
          if (infer === 'location') {
            const resolution = resolveLocation(view, start)
            return {
              ok: true,
              inferred: { kind: 'location', entity: start, resolution },
              nodes: [],
              edges: [],
              conflicts,
              truncated: false,
            }
          }
          throw new Error('infer must be owner or location')
        }

        if (start === undefined) {
          const candidates = [...view.nodes.values()].filter(
            (node) => predicate === undefined || evalForView(view, node.id, predicate),
          )
          const limited = candidates.slice(0, limit)
          return {
            ok: true,
            nodes: limited.map(compactNode),
            edges: [],
            conflicts,
            truncated: candidates.length > limited.length,
          }
        }

        if (!view.nodes.has(start)) {
          const was = view.retracted.get(start)
          return {
            ok: true,
            nodes: [],
            edges: [],
            conflicts,
            truncated: false,
            note:
              was === undefined
                ? `${start} is not in the graph`
                : `${start} existed (${was.type}) and was withdrawn`,
          }
        }

        const walked = traverse(view, {
          start,
          via: via as EdgeType[],
          direction,
          depth,
        })
        const nodes = walked.reached
          .filter((id) => view.nodes.has(id))
          .filter((id) => predicate === undefined || evalForView(view, id, predicate))
          .slice(0, limit)
          .map((id) => compactNode(view.nodes.get(id) as GraphNode))
        const nodeIds = new Set(nodes.map((node) => node.id))
        const edges = walked.walked
          .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
          .map(compactEdge)

        return {
          ok: true,
          nodes,
          edges,
          conflicts,
          cycles: walked.cycles,
          truncated: walked.truncated || walked.reached.length > limit,
        }
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'graph_history',
      description:
        'Read the event chain behind one node or one relation: every write, every replacement, and every ' +
        'retraction, newest first, each with the source and the evidence that supported it and whether it ' +
        'is still current. Use it to see how a claim changed rather than only what it says now.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string', description: 'A node id.' },
          edge: EDGE_REF_SCHEMA,
          limit: { type: 'number', description: 'Maximum events to return. Defaults to 20.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            entries: { type: 'array', items: { type: 'object' } },
            total: { type: 'number' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = value as {
            ok?: boolean
            entries?: Array<{ at: string; summary: string; status: string; confidence: string }>
            error?: string
          }
          if (result.ok === false) return text(`history failed: ${result.error ?? 'unknown reason'}`)
          const entries = result.entries ?? []
          if (entries.length === 0) return text('no events for that target')
          return text(
            entries
              .map((entry) => `${entry.at} ${entry.summary} [${entry.status}, ${entry.confidence}]`)
              .join('\n'),
          )
        },
      },
      async execute(rawArgs, exec): Promise<unknown> {
        const args = asRecord(rawArgs)
        const node = optionalString(args, 'node')
        const edge = parseEdgeRefs(args.edge === undefined ? [] : [args.edge])[0]
        if (node === undefined && edge === undefined) throw new Error('give node or edge')
        const limit = Math.min(
          optionalInt(args, 'limit', 1, MAX_HISTORY_LIMIT) ?? 20,
          MAX_HISTORY_LIMIT,
        )
        const root = resolveRoot(service, exec, directoryOf)
        const history = await service.history(
          root,
          node === undefined ? { edge: edge as EdgeRef } : { node },
          limit,
        )
        return { ok: true, entries: history.entries, total: history.total }
      },
    }),
  )

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function describeInference(inferred: Record<string, unknown>): string {
  if (inferred.kind === 'location') {
    const entity = String(inferred.entity)
    const resolution = inferred.resolution as
      | { kind: 'resolved'; location: string; source: string; path: string[] }
      | { kind: 'conflict'; candidates: Array<{ location: string; source: string }> }
      | { kind: 'unknown'; path: string[]; cycle: boolean }
    if (resolution.kind === 'resolved') {
      return `${entity} is located in ${resolution.location} (${resolution.source}, via ${resolution.path.join(' > ')})`
    }
    if (resolution.kind === 'conflict') {
      const candidates = resolution.candidates
        .map((candidate) => `${candidate.location} (${candidate.source})`)
        .join(' vs ')
      return `${entity} has conflicting locations: ${candidates}`
    }
    return `${entity} has no known location`
  }
  const entity = String(inferred.entity)
  const owner = inferred.owner
  if (typeof owner !== 'string') return `${entity} has no known owner`
  const path = Array.isArray(inferred.path) ? inferred.path.join(' > ') : entity
  return `${entity} is owned by ${owner} (${String(inferred.source)}, via ${path})`
}

/** `evalPredicate` needs the view; kept as a thin alias so the import stays local. */
function evalForView(view: GraphView, nodeId: string, predicate: Predicate): boolean {
  return evalPredicate(view, nodeId, predicate)
}

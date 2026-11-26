/**
 * dsh-cognitive-model — the cognitive model and the world model as one graph.
 *
 * Typed edges connect objectives, tasks, claims and world entities. Ownership
 * and location can be inferred through `part_of`.
 *
 * The design source is `cognitive-agent`'s `world_model` plus its
 * `state_projection_rules.md`, which is the part the Rust implementation never
 * finished: state is projected from an append-only event log, supersession
 * beats recency, invalidation and valid time gate truth, and an unresolved
 * conflict is surfaced rather than silently resolved.
 */
import { createDirectoryResolver, type DirectoryResolver } from '@kioju/dsh-cognitive-core'
import type { Context } from './cordis.js'
import { registerPrompt } from './graph/prompt.js'
import { DEFAULT_CONFIG, GraphService, type GraphConfig } from './graph/service.js'
import {
  MAX_SNAPSHOT_EDGES,
  MAX_SNAPSHOT_INFERENCE,
  MAX_SNAPSHOT_NODES,
  graphFileFor,
  graphSnapshot,
  readGraphDocument,
  recallSnapshot,
  rootOf,
} from './graph/snapshot.js'
import { registerGraphTools } from './graph/tools.js'
import { NODE_TYPES, isNodeType, type NodeType } from './graph/schema.js'

export const name = 'cognitive-model'

/** Both services are provided by the base profile. */
export const inject = ['tools', 'systemPrompt']

export interface ModelConfig {
  /** How many objective-tree rows the passive recall block shows. */
  contextLimit: number
  /** How many facts the passive recall block shows. */
  recallLimit: number
  /** Upper bound on a single `graph_query` result. */
  queryLimit: number
  /** Upper bound on traversal depth, whatever the caller asks for. */
  maxDepth: number
  /** Node types that may be written. Empty means every type. */
  writeTypes: NodeType[]
  /** Scopes that may be written. Empty means every scope. */
  writeScopes: string[]
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = { ...DEFAULT_CONFIG }

const MAX_CONTEXT_LIMIT = 50
const MAX_RECALL_LIMIT = 50
const MAX_QUERY_LIMIT = 200
const MAX_DEPTH_LIMIT = 32

interface ConfigIssue {
  message: string
  path?: Array<string | number>
}

function normalizeConfig(raw: unknown): { config: ModelConfig } | { issues: ConfigIssue[] } {
  if (raw === undefined || raw === null) return { config: { ...DEFAULT_MODEL_CONFIG } }
  if (typeof raw !== 'object') return { issues: [{ message: 'config must be an object', path: [] }] }

  const input = raw as Record<string, unknown>
  const issues: ConfigIssue[] = []
  const contextLimit = readInt(input.contextLimit, 'contextLimit', 1, MAX_CONTEXT_LIMIT, issues)
  const recallLimit = readInt(input.recallLimit, 'recallLimit', 1, MAX_RECALL_LIMIT, issues)
  const queryLimit = readInt(input.queryLimit, 'queryLimit', 1, MAX_QUERY_LIMIT, issues)
  const maxDepth = readInt(input.maxDepth, 'maxDepth', 1, MAX_DEPTH_LIMIT, issues)
  const writeTypes = readTypes(input.writeTypes, issues)
  const writeScopes = readScopes(input.writeScopes, issues)
  if (issues.length > 0) return { issues }

  return {
    config: {
      contextLimit: contextLimit ?? DEFAULT_MODEL_CONFIG.contextLimit,
      recallLimit: recallLimit ?? DEFAULT_MODEL_CONFIG.recallLimit,
      queryLimit: queryLimit ?? DEFAULT_MODEL_CONFIG.queryLimit,
      maxDepth: maxDepth ?? DEFAULT_MODEL_CONFIG.maxDepth,
      writeTypes: writeTypes ?? [],
      writeScopes: writeScopes ?? [],
    },
  }
}

function readInt(
  value: unknown,
  key: string,
  min: number,
  max: number,
  issues: ConfigIssue[],
): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) {
    issues.push({ message: `${key} must be an integer`, path: [key] })
    return undefined
  }
  if (value < min || value > max) {
    issues.push({ message: `${key} must be between ${min} and ${max}`, path: [key] })
    return undefined
  }
  return value
}

function readTypes(value: unknown, issues: ConfigIssue[]): NodeType[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    issues.push({ message: 'writeTypes must be an array', path: ['writeTypes'] })
    return undefined
  }
  const types: NodeType[] = []
  for (const [index, entry] of value.entries()) {
    if (!isNodeType(entry)) {
      issues.push({
        message: `writeTypes[${index}] must be one of ${NODE_TYPES.join(', ')}`,
        path: ['writeTypes', index],
      })
      continue
    }
    types.push(entry)
  }
  return types
}

function readScopes(value: unknown, issues: ConfigIssue[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    issues.push({ message: 'writeScopes must be an array', path: ['writeScopes'] })
    return undefined
  }
  const scopes: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push({
        message: `writeScopes[${index}] must be a non-empty string`,
        path: ['writeScopes', index],
      })
      continue
    }
    scopes.push(entry.trim())
  }
  return scopes
}

/** Standard Schema validator; Cordis calls `Config['~standard'].validate`. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-cognitive-model',
    validate(raw: unknown) {
      const result = normalizeConfig(raw)
      if ('issues' in result) return result
      return { value: result.config }
    },
  },
}

export function apply(ctx: Context, rawConfig?: unknown): void {
  const normalized = normalizeConfig(rawConfig)
  if ('issues' in normalized) {
    throw new Error(`invalid config: ${normalized.issues.map((issue) => issue.message).join('; ')}`)
  }
  const config: GraphConfig = normalized.config
  const service = new GraphService(config)
  const directoryOf: DirectoryResolver = createDirectoryResolver(() => ctx.get?.('workingDirectory'))
  registerGraphTools(ctx, service, directoryOf)
  registerPrompt(ctx, service, directoryOf)
  registerProjection(ctx)
  registerService(ctx, config)
}

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
export function registerService(ctx: Context, config: GraphConfig): void {
  if (typeof ctx.provide !== 'function') return
  const service: ModelService = {
    snapshot: (root) => graphSnapshot(root),
    recall: (root) =>
      recallSnapshot(root, {
        recallLimit: config.recallLimit,
        contextLimit: config.contextLimit,
      }),
  }
  ctx.provide('cognitiveGraph', service)
}

/** The read face this plugin publishes to other Host plugins. */
export interface ModelService {
  /** The graph as a snapshot; `state` separates missing from empty. */
  snapshot(root: string | undefined): ReturnType<typeof graphSnapshot>
  /**
   * The recall block as the prompt receives it, assembled with this plugin's
   * configured budgets.
   *
   * A read does not consume the per-session bird's-eye check, so the check is
   * absent from this text; the rest is byte-for-byte the block a session starts
   * from.
   */
  recall(root: string | undefined): ReturnType<typeof recallSnapshot>
}

/**
 * Events after which the ledgers on disk may have changed. The projection
 * re-reads the graph then, instead of polling.
 */
const RELEVANT_EVENTS = new Set(['tool/result', 'turn/end', 'user/message', 'command/done'])

/** Both the state and the wire view are produced here, so the schema is a pass-through. */
const passthrough = { parse: (value: unknown) => value }

/**
 * Publish the graph as a session projection.
 *
 * This is the read path a UI uses. Keeping it here means the browser sees the
 * same projection the tools use — one implementation of supersession,
 * invalidation, valid time and conflict detection — and a UI plugin needs no
 * import of this package to draw it.
 *
 * Optional: a profile without `sessionProjections` keeps the tools and the
 * prompt, and simply has no published view.
 */
function registerProjection(ctx: Context): void {
  const register = (scoped: Context): void => {
    const projections = scoped.sessionProjections
    if (projections === undefined) return
    void projections.register({
      key: 'cognitiveGraph',
      stateVersion: 1,
      stateSchema: passthrough,
      init: (header) => ({ root: rootOf(header?.cwd), version: 0 }),
      apply: (state, event) =>
        RELEVANT_EVENTS.has(event?.type ?? '') ? { ...state, version: state.version + 1 } : state,
      wire: {
        viewSchema: passthrough,
        view: (state) => graphSnapshot(state.root),
      },
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['sessionProjections'], register)
  else register(ctx)
}

export { GraphService, AREA, DEFAULT_SCOPE, GRAPH_FILE } from './graph/service.js'
export type { GraphConfig, HistoryEntry, NodeInput, EdgeInput, WriteOutcome } from './graph/service.js'
export {
  EDGE_SPECS,
  EDGE_TYPES,
  EPISTEMIC_NODE_TYPES,
  NODE_TYPES,
  NODE_TYPE_HINT,
  edgeSpec,
  isEdgeType,
  isFunctional,
  isNodeType,
} from './graph/schema.js'
export type { EdgeSpec, EdgeType, GraphEdge, GraphNode, NodeType } from './graph/schema.js'
export {
  projectEvents,
  groupActiveEvents,
  milestoneProgress,
  eventStatus,
} from './graph/projection.js'
export type { EventStatus, GraphConflict, GraphView, ProjectedError } from './graph/projection.js'
export {
  PREDICTION_ERROR_DIRECTIONS,
  PREDICTION_ERROR_DIRECTION_HINT,
  PREDICTION_ERROR_KINDS,
  PREDICTION_ERROR_KIND_HINT,
  RECALL_ERROR_LIMIT,
  REVISIT_TARGETS,
  REVISIT_TARGET_HINT,
  checkPredictionError,
  isPredictionErrorDirection,
  isPredictionErrorKind,
  isRevisitTarget,
  predictionErrorKey,
} from './graph/prediction.js'
export type {
  PredictionErrorDirection,
  PredictionErrorInput,
  PredictionErrorKind,
  PredictionErrorProblem,
  RevisitTarget,
} from './graph/prediction.js'
export {
  describePredicate,
  evalPredicate,
  followChain,
  isPartOf,
  resolveLocation,
  resolveOwner,
  traverse,
} from './graph/query.js'
export type {
  ChainResult,
  InferenceSource,
  LocationResolution,
  OwnerResolution,
  Predicate,
  TraverseOptions,
  TraverseResult,
} from './graph/query.js'
export { contextText } from './graph/prompt.js'
export {
  FACT_ORDER,
  FACT_SECTION_LABEL,
  RECALL_DECISION_LIMIT,
  RECALL_FACT_LIMIT,
  RECALL_HEURISTIC_LIMIT,
  RECALL_PREFERENCE_LIMIT,
  REVISIT_LABEL,
  birdseyeText,
  currentPath,
  errorLine,
  heuristicLine,
  recentErrors,
  recallText,
} from './graph/recall.js'
export type { FactSection } from './graph/recall.js'
export { migratePegDocument } from './graph/migrate.js'
export type { PegMigrationResult } from './graph/migrate.js'
export type { GraphDocument, GraphEvent, GraphOp, GraphStats } from './graph/events.js'
export { emptyDocument, emptyStats } from './graph/events.js'
export {
  MAX_SNAPSHOT_EDGES,
  MAX_SNAPSHOT_INFERENCE,
  MAX_SNAPSHOT_NODES,
  graphFileFor,
  graphSnapshot,
  readGraphDocument,
  recallSnapshot,
  rootOf,
} from './graph/snapshot.js'
export type {
  GraphSnapshot,
  RecallLimits,
  RecallSnapshot,
  SnapshotConflict,
  SnapshotEdge,
  SnapshotInference,
  SnapshotNode,
  SnapshotState,
} from './graph/snapshot.js'

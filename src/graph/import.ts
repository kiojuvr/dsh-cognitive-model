/**
 * Import an existing memory ledger into the graph.
 *
 * This is a migration, not a product surface: the memory ledger held the same
 * material as flat facts with string references, and the graph holds it as
 * nodes and typed edges. The import preserves the claim, the evidence, and the
 * source that the fact was recorded with — it does not upgrade trust, and a
 * fact that the write policy would refuse today is reported, not forced in.
 *
 * The graph wins when both stores know a node: a node already in the graph that
 * is newer than the fact is kept, and the fact is counted as skipped. That is
 * what makes the import safe to run again after the switch.
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  isFactSource,
  normalizeKey,
  parseMilestones,
  workspaceFile,
  type Evidence,
  type FactSource,
} from 'dsh-cognitive-core'
import {
  isPredictionErrorDirection,
  isPredictionErrorKind,
  type PredictionErrorInput,
} from './prediction.js'
import type { EdgeInput, GraphService, NodeInput } from './service.js'
import type { NodeType } from './schema.js'

export const MEMORY_AREA = 'cognitive-memory'
export const MEMORY_FILE = 'memory.json'
export const PREDICTION_ERROR_FILE = 'prediction-errors.json'

interface MemoryFact {
  id?: unknown
  kind?: unknown
  subject?: unknown
  value?: unknown
  scope?: unknown
  status?: unknown
  source?: unknown
  evidence?: unknown
  serves?: unknown
  requires?: unknown
  verifies?: unknown
  paths?: unknown
  docs?: unknown
  milestones?: unknown
  updatedAt?: unknown
}

interface MemoryError {
  kind?: unknown
  direction?: unknown
  scope?: unknown
  subject?: unknown
  predicted?: unknown
  observed?: unknown
  lesson?: unknown
  factId?: unknown
  evidence?: unknown
}

export interface ImportProblem {
  id: string
  code: string
  message: string
}

export interface ImportReport {
  memory: 'ready' | 'missing' | 'error'
  predictionErrors: 'ready' | 'missing' | 'error'
  facts: number
  imported: number
  /** Facts the graph already knew, newer than the fact. */
  skippedNewer: number
  /** Facts that are not active in the memory ledger (superseded / retracted). */
  inactive: number
  edges: number
  missingTargets: string[]
  errors: number
  errorDuplicates: number
  problems: ImportProblem[]
  dryRun: boolean
}

const KIND_TO_TYPE: Record<string, NodeType> = {
  constraint: 'constraint',
  decision: 'decision',
  risk: 'risk',
  task_state: 'task',
  repo_fact: 'fact',
  user_preference: 'preference',
}

const TYPE_PREFIX: Partial<Record<NodeType, string>> = {
  constraint: 'constraint',
  risk: 'risk',
  fact: 'fact',
  preference: 'preference',
  decision: 'decision',
}

/** A stable id fragment that keeps non-ASCII subjects readable. */
export function slugOf(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug === '' ? 'item' : slug
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return items.length === 0 ? undefined : items
}

function evidenceOf(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return []
  const items: Evidence[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as { kind?: unknown; ref?: unknown; excerpt?: unknown }
    if (raw.kind !== 'file' && raw.kind !== 'command' && raw.kind !== 'url' && raw.kind !== 'note') continue
    if (typeof raw.ref !== 'string' || raw.ref === '') continue
    items.push({
      kind: raw.kind,
      ref: raw.ref,
      ...(typeof raw.excerpt === 'string' && raw.excerpt !== '' ? { excerpt: raw.excerpt } : {}),
    })
  }
  return items
}

/**
 * The node a fact becomes.
 *
 * Reserved subjects keep the graph's convention: `objective` / `objective/<path>`
 * for the goal, `task/current` and `task/<key>` for the position and the rest.
 * Everything else becomes `<type>/<slug>`, with the original subject kept as
 * the label.
 */
export function nodeIdOf(fact: { kind: string; subject: string }): { id: string; type: NodeType } {
  const subject = normalizeKey(fact.subject)
  const type = KIND_TO_TYPE[fact.kind]
  if (type === undefined) return { id: subject, type: 'fact' }
  if (type === 'task') {
    if (subject === 'current task' || subject === 'current') return { id: 'task/current', type }
    if (subject.startsWith('task/')) return { id: subject, type }
    return { id: `task/${slugOf(subject)}`, type }
  }
  if (type === 'decision') {
    if (subject === 'objective' || subject.startsWith('objective/')) {
      return { id: subject, type: 'objective' }
    }
    // The memory ledger stored a component as a `decision` fact whose subject
    // is `component/<key>`. It is a component node, not a decision: the old
    // tree and the `requires` / `verifies` targets refer to `component/<key>`
    // (P1-2 in the 2026-11-23 review).
    if (subject.startsWith('component/')) {
      return { id: subject, type: 'component' }
    }
    return { id: `decision/${slugOf(subject)}`, type }
  }
  return { id: `${TYPE_PREFIX[type] ?? 'fact'}/${slugOf(subject)}`, type }
}

function readJson(file: string): { state: 'ready' | 'missing' | 'error'; value?: unknown } {
  if (!existsSync(file)) return { state: 'missing' }
  try {
    return { state: 'ready', value: JSON.parse(readFileSync(file, 'utf8')) as unknown }
  } catch {
    return { state: 'error' }
  }
}

function factsOf(value: unknown): MemoryFact[] {
  if (typeof value !== 'object' || value === null) return []
  const facts = (value as { facts?: unknown }).facts
  return Array.isArray(facts) ? (facts as MemoryFact[]) : []
}

function errorsOf(value: unknown): MemoryError[] {
  if (typeof value !== 'object' || value === null) return []
  const errors = (value as { errors?: unknown }).errors
  return Array.isArray(errors) ? (errors as MemoryError[]) : []
}

interface PlannedNode {
  node: NodeInput
  fact: MemoryFact
}

export async function importMemoryLedger(
  service: GraphService,
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const memory = readJson(workspaceFile(root, MEMORY_AREA, MEMORY_FILE))
  const errorDoc = readJson(workspaceFile(root, MEMORY_AREA, PREDICTION_ERROR_FILE))
  const report: ImportReport = {
    memory: memory.state,
    predictionErrors: errorDoc.state,
    facts: 0,
    imported: 0,
    skippedNewer: 0,
    inactive: 0,
    edges: 0,
    missingTargets: [],
    errors: 0,
    errorDuplicates: 0,
    problems: [],
    dryRun: options.dryRun === true,
  }

  const view = await service.view(root)
  const facts = factsOf(memory.value)
  report.facts = facts.length

  // Pass 1: which facts become nodes. A node the graph already knows and that
  // is at least as new as the fact is kept, so a re-run cannot roll the graph
  // back to an older claim.
  const planned: PlannedNode[] = []
  const plannedIds = new Set<string>()
  /** Every active fact that maps to a node, including the ones already newer in the graph. */
  const linkable: PlannedNode[] = []
  const takenIds = new Set<string>()
  /** Memory fact id (`mem_…`) → graph node id, for the errors' promotion links. */
  const factIdMap = new Map<string, string>()
  for (const [index, fact] of facts.entries()) {
    const kind = typeof fact.kind === 'string' ? fact.kind : ''
    const subject = typeof fact.subject === 'string' ? fact.subject : ''
    const label = `${kind || '(empty)'}:${subject || '(empty)'}`
    if (KIND_TO_TYPE[kind] === undefined) {
      report.problems.push({ id: label, code: 'unknown_kind', message: `kind ${kind || '(empty)'} has no graph type` })
      continue
    }
    if (subject === '') {
      report.problems.push({ id: label, code: 'empty_subject', message: 'a fact without a subject has no id' })
      continue
    }
    const { id: nodeId, type } = nodeIdOf({ kind, subject })
    // The ledger's errors point at a fact by its memory id; the graph names the
    // same claim by its node id, so the link has to be translated or the
    // import would refuse every promotion link (P1-2, second half).
    if (typeof fact.id === 'string' && fact.id !== '') factIdMap.set(fact.id, nodeId)
    if (fact.status !== undefined && fact.status !== 'active') {
      report.inactive += 1
      continue
    }
    const existing = view.nodes.get(nodeId)
    const value = typeof fact.value === 'string' ? fact.value : ''
    const node: NodeInput = {
      id: nodeId,
      type,
      label: existing?.label ?? (subject.length > 200 ? `${subject.slice(0, 199)}…` : subject),
      ...(value === '' ? {} : { value }),
    }
    const paths = stringsOf(fact.paths)
    if (paths !== undefined) node.paths = paths
    const docs = stringsOf(fact.docs)
    if (docs !== undefined) node.docs = docs
    if (type === 'objective' || type === 'component') {
      const parsed = parseMilestones(fact.milestones)
      if (parsed.ok && parsed.milestones.length > 0) node.milestones = parsed.milestones
    }
    // Relations come from every active fact, not only from the facts this run
    // writes: a re-run after an import fix must still add the edges the graph
    // is missing.
    linkable.push({ node, fact })

    const updatedAt = typeof fact.updatedAt === 'string' ? fact.updatedAt : ''
    if (existing !== undefined && (updatedAt === '' || existing.updatedAt >= updatedAt)) {
      report.skippedNewer += 1
      continue
    }
    if (takenIds.has(nodeId)) {
      report.problems.push({
        id: `${nodeId}#${index}`,
        code: 'duplicate_id',
        message: `two facts map to ${nodeId}; the first was kept`,
      })
      continue
    }
    takenIds.add(nodeId)
    planned.push({ node, fact })
    plannedIds.add(nodeId)
  }

  // Pass 2: the relations, now that every planned node is known.
  const edges: EdgeInput[] = []
  const known = (id: string): boolean => view.nodes.has(id) || plannedIds.has(id)
  for (const { node, fact } of linkable) {
    const link = (relation: 'serves' | 'requires' | 'verifies', target: string): void => {
      const to = normalizeKey(target)
      if (to === '') return
      if (!known(to)) {
        report.missingTargets.push(`${node.id} -${relation}-> ${to}`)
        return
      }
      if (edges.some((edge) => edge.from === node.id && edge.type === relation && edge.to === to)) return
      edges.push({ from: node.id, type: relation, to })
    }
    const explicitServes = typeof fact.serves === 'string' ? normalizeKey(fact.serves) : ''
    if (explicitServes !== '') {
      link('serves', explicitServes)
    } else if (node.type === 'objective' && node.id.startsWith('objective/')) {
      // The memory ledger kept the objective tree in the subject path
      // (`objective/<path>`); the graph keeps it as a `serves` edge, so the
      // parent has to be made explicit or the imported tree is flat.
      const parent = node.id.slice(0, node.id.lastIndexOf('/'))
      if (parent !== '' && known(parent)) link('serves', parent)
    }
    for (const target of stringsOf(fact.requires) ?? []) link('requires', target)
    for (const target of stringsOf(fact.verifies) ?? []) link('verifies', target)
  }

  // One call per fact: a fact the policy refuses is reported and the rest land.
  const rejected = new Set<string>()
  for (const { node, fact } of planned) {
    if (report.dryRun) {
      report.imported += 1
      continue
    }
    const outcome = await service.write(root, {
      nodes: [node],
      edges: [],
      evidence: evidenceOf(fact.evidence),
      source: isFactSource(fact.source) ? (fact.source as FactSource) : 'retrieved_memory',
      ...(typeof fact.scope === 'string' && fact.scope !== '' ? { scope: fact.scope } : {}),
    })
    if (outcome.kind === 'rejected') {
      rejected.add(node.id)
      report.problems.push({ id: node.id, code: outcome.code, message: outcome.message })
      continue
    }
    report.imported += 1
  }

  const written = edges.filter((edge) => !rejected.has(edge.from) && !rejected.has(edge.to))
  if (report.dryRun) {
    report.edges = written.length
  } else if (written.length > 0) {
    const evidence = [{ kind: 'note' as const, ref: 'imported from the memory ledger' }]
    const outcome = await service.write(root, {
      nodes: [],
      edges: written,
      evidence,
      source: 'retrieved_memory',
    })
    if (outcome.kind === 'rejected') {
      // One relation the graph refuses must not drop the rest: retry each one
      // and report the ones that are still refused.
      for (const edge of written) {
        const single = await service.write(root, {
          nodes: [],
          edges: [edge],
          evidence,
          source: 'retrieved_memory',
        })
        if (single.kind === 'rejected') {
          report.problems.push({
            id: `${edge.from} -${edge.type}-> ${edge.to}`,
            code: single.code,
            message: single.message,
          })
        } else if (single.edges.length > 0) {
          report.edges += 1
        }
      }
    } else {
      report.edges = outcome.edges.length
    }
  }

  for (const error of errorsOf(errorDoc.value)) {
    if (!isPredictionErrorKind(error.kind)) {
      report.problems.push({ id: 'error', code: 'unknown_kind', message: `error kind ${String(error.kind)} is unknown` })
      continue
    }
    if (
      typeof error.subject !== 'string' ||
      typeof error.predicted !== 'string' ||
      typeof error.observed !== 'string'
    ) {
      report.problems.push({ id: 'error', code: 'invalid_error', message: 'an error record is missing a field' })
      continue
    }
    const factId =
      typeof error.factId === 'string' && error.factId !== ''
        ? (factIdMap.get(error.factId) ?? error.factId)
        : undefined
    const input: PredictionErrorInput = {
      kind: error.kind,
      // The memory ledger predates the signed record: its errors were negative.
      direction: isPredictionErrorDirection(error.direction) ? error.direction : 'worse',
      subject: error.subject,
      predicted: error.predicted,
      observed: error.observed,
      ...(typeof error.lesson === 'string' && error.lesson !== '' ? { lesson: error.lesson } : {}),
      ...(factId === undefined ? {} : { factId }),
    }
    if (report.dryRun) {
      report.errors += 1
      continue
    }
    const outcome = await service.write(root, {
      nodes: [],
      edges: [],
      errors: [input],
      evidence: evidenceOf(error.evidence),
      ...(typeof error.scope === 'string' && error.scope !== '' ? { scope: error.scope } : {}),
    })
    if (outcome.kind === 'rejected') {
      report.problems.push({ id: `error:${input.subject}`, code: outcome.code, message: outcome.message })
      continue
    }
    if (outcome.errors.length > 0) report.errors += 1
    else report.errorDuplicates += outcome.duplicates.length
  }

  return report
}

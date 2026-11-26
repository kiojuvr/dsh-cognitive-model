/**
 * The graph service: the durable document, the write policy, and the cache.
 *
 * The durable document holds events only. A read folds them; a write appends
 * one event and, where the write replaces something, names the event it
 * supersedes. That is what makes "state is projected, not stored" true in the
 * code rather than only in the design note.
 */
import { stat } from 'node:fs/promises';
import { JsonStore, confidenceOf, deriveSource, findProjectRoot, newId, scopeAllowed, sourceSupportedBy, validateWrite, workspaceFile, } from '@kioju/dsh-cognitive-core';
import { DEFAULT_MAX_DEPTH, DEFAULT_QUERY_LIMIT, DEFAULT_CONTEXT_LIMIT, DEFAULT_RECALL_LIMIT, EDGE_TYPES, MAX_EDGES, MAX_EVENTS, MAX_ID, MAX_LABEL, MAX_LINKS, MAX_MILESTONES, MAX_MILESTONE_TEXT, MAX_NODES, MAX_CONDITIONS, MAX_ERROR_IDS, MAX_VALUE, MILESTONE_NODE_TYPES, NODE_TYPES, SCHEMA_VERSION, edgeSpec, isEdgeType, isFunctional, isNodeType, } from './schema.js';
import { checkPredictionError, isPredictionErrorDirection, isPredictionErrorKind, normalizeText, predictionErrorKey, OBSERVED_KINDS, PREDICTION_ERROR_DIRECTIONS, PREDICTION_ERROR_KINDS, } from './prediction.js';
import { describeEvent, emptyDocument, emptyStats, isGraphDocument, migrationCommand, projectionKeyOf, schemaProblem, } from './events.js';
import { eventStatus, groupActiveEvents, projectEvents, } from './projection.js';
import { recentErrors } from './recall.js';
import { RECALL_SEEN_FILE, markRecallSeen, readRecallSeen, writeRecallSeen, } from './recall-state.js';
/** `<projectRoot>/.dsh/<area>/graph.json` — deleting the area is the reset. */
export const AREA = 'cognitive-model';
export const GRAPH_FILE = 'graph.json';
export const DEFAULT_SCOPE = 'repo';
export const DEFAULT_CONFIG = {
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    recallLimit: DEFAULT_RECALL_LIMIT,
    queryLimit: DEFAULT_QUERY_LIMIT,
    maxDepth: DEFAULT_MAX_DEPTH,
    writeTypes: [],
    writeScopes: [],
};
/** Every source except a bare guess. A guess is never durable. */
const DURABLE_SOURCES = [
    'user_input',
    'human_instruction',
    'human_approval',
    'tool_output',
    'verified_command',
    'executor_summary',
    'retrieved_memory',
];
const HUMAN_SOURCES = [
    'user_input',
    'human_instruction',
    'human_approval',
];
const MODEL_SOURCES = [
    'tool_output',
    'verified_command',
    'executor_summary',
    'retrieved_memory',
];
/**
 * Which sources may write each kind durably.
 *
 * The structural types accept every durable source. The epistemic ones are
 * narrower, because "what may be believed" is the question they answer: a
 * constraint or a decision may rest on the human's word or on something the
 * agent saw, a risk may also come from an executor's summary, a fact may rest
 * on any model-side observation, and a preference can only be reported by the
 * human — evidence cannot settle what somebody prefers.
 */
const TRUST = {
    objective: { sources: DURABLE_SOURCES },
    component: { sources: DURABLE_SOURCES },
    task: { sources: [...HUMAN_SOURCES, ...MODEL_SOURCES] },
    decision: { sources: [...HUMAN_SOURCES, 'tool_output', 'verified_command'] },
    constraint: { sources: [...HUMAN_SOURCES, 'tool_output', 'verified_command'] },
    risk: { sources: [...HUMAN_SOURCES, 'tool_output', 'verified_command', 'executor_summary'] },
    fact: { sources: [...HUMAN_SOURCES, ...MODEL_SOURCES] },
    preference: { sources: [...HUMAN_SOURCES] },
    heuristic: { sources: [...HUMAN_SOURCES, ...MODEL_SOURCES] },
    entity: { sources: DURABLE_SOURCES },
    edge: { sources: DURABLE_SOURCES },
};
export class GraphService {
    config;
    cache = new Map();
    stores = new Map();
    /** Read receipts for the bird's-eye check, keyed by workspace then session. */
    recallSeen = new Map();
    /** No session id means no "who" to key on: once per process, not persisted. */
    anonymousSeen = new Map();
    lastRoot;
    constructor(config) {
        this.config = config;
    }
    /** The nearest ancestor with `.git`, else the directory itself. */
    rootFor(cwd) {
        return findProjectRoot(cwd);
    }
    fileFor(root) {
        return workspaceFile(root, AREA, GRAPH_FILE);
    }
    /** The refusal a full log returns, shared by writes and retractions. */
    eventLogFull(root) {
        return (`the event log is capped at ${MAX_EVENTS} events; the log is append-only, so the supported ` +
            `reset is deleting ${this.fileFor(root)} (the graph is a working memory, not an archive)`);
    }
    /** The read receipts beside the graph; deleting the area resets them too. */
    recallFileFor(root) {
        return workspaceFile(root, AREA, RECALL_SEEN_FILE);
    }
    /** The last root this process touched; a fallback for an assembly with no agent. */
    currentRoot() {
        return this.lastRoot;
    }
    async view(root) {
        this.lastRoot = root;
        return (await this.load(root)).view;
    }
    /**
     * The cached view, without touching the disk.
     *
     * A prompt context provider is synchronous, so it cannot await a read. The
     * `system-prompt/assemble` warm-up has already refreshed the cache by the time
     * this runs; before that it returns `undefined` and the block is simply absent.
     */
    currentView(root) {
        return this.cache.get(root)?.view;
    }
    async read(root) {
        this.lastRoot = root;
        return (await this.load(root)).doc;
    }
    /** Whether the on-disk document changed since it was cached. */
    async shouldRefresh(root) {
        const cached = this.cache.get(root);
        if (cached === undefined)
            return true;
        return cached.mtimeMs !== (await mtimeOf(this.fileFor(root)));
    }
    /** Warm the cache so the synchronous context provider has a graph to show. */
    async refresh(root) {
        this.cache.delete(root);
        await this.load(root);
    }
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
    consumeFreshRevisit(root, session, errors) {
        const latest = recentErrors(errors, errors.length);
        if (session === undefined) {
            const seen = this.anonymousSeen.get(root) ?? new Set();
            this.anonymousSeen.set(root, seen);
            const fresh = latest.filter((error) => error.revisit !== undefined && !seen.has(error.id));
            for (const error of latest)
                seen.add(error.id);
            return fresh;
        }
        const doc = this.recallSeenFor(root);
        const already = new Set(doc.sessions[session]?.seen ?? []);
        const fresh = latest.filter((error) => error.revisit !== undefined && !already.has(error.id));
        const marked = markRecallSeen(doc, session, latest.map((error) => error.id));
        if (marked.changed) {
            this.recallSeen.set(root, marked.doc);
            this.persistRecallSeen(root, marked.doc);
        }
        return fresh;
    }
    recallSeenFor(root) {
        const existing = this.recallSeen.get(root);
        if (existing !== undefined)
            return existing;
        const doc = readRecallSeen(this.recallFileFor(root), root);
        this.recallSeen.set(root, doc);
        return doc;
    }
    /** A receipt is bookkeeping: a failed write must not break the prompt. */
    persistRecallSeen(root, doc) {
        try {
            writeRecallSeen(this.recallFileFor(root), doc);
        }
        catch {
            // The in-memory receipt still keeps this process quiet; the next assembly
            // tries again. Losing the file only means one check may be shown twice.
        }
    }
    /**
     * Count a refused write in the document.
     *
     * A refusal appends no event — that is the point — so the counter is the only
     * durable sign that the policy ran. Recording it must not turn a refusal into
     * an error, so a failed bump is swallowed.
     */
    async countRejection(root) {
        try {
            await this.storeFor(root).mutate((doc) => ({
                doc: { ...doc, stats: { ...doc.stats, rejections: doc.stats.rejections + 1 } },
                result: undefined,
            }));
            this.cache.delete(root);
        }
        catch {
            // Bookkeeping only: the refusal itself already reached the caller.
        }
    }
    async load(root) {
        this.lastRoot = root;
        const file = this.fileFor(root);
        const mtimeMs = await mtimeOf(file);
        const cached = this.cache.get(root);
        if (cached !== undefined && cached.mtimeMs === mtimeMs)
            return cached;
        const doc = await this.storeFor(root).read();
        const problem = schemaProblem(doc);
        if (problem !== undefined) {
            throw new Error(`${problem}; run \`${migrationCommand(root)}\``);
        }
        const entry = { mtimeMs, doc, view: projectEvents(doc.events, new Date()) };
        this.cache.set(root, entry);
        return entry;
    }
    storeFor(root) {
        const existing = this.stores.get(root);
        if (existing !== undefined)
            return existing;
        const store = new JsonStore({
            file: this.fileFor(root),
            schemaVersion: SCHEMA_VERSION,
            workspace: root,
            empty: emptyDocument,
            validate: isGraphDocument,
        });
        this.stores.set(root, store);
        return store;
    }
    policyFor(kind) {
        return {
            // The configured type filter applies to nodes. An edge is not a type the
            // caller chose, so it is never filtered out from under the graph.
            writeKinds: kind === 'edge' ? [] : this.config.writeTypes,
            writeScopes: this.config.writeScopes,
        };
    }
    async write(root, input) {
        const outcome = await this.writeOnce(root, input);
        if (outcome.kind === 'rejected')
            await this.countRejection(root);
        return outcome;
    }
    async writeOnce(root, input) {
        const scope = input.scope ?? DEFAULT_SCOPE;
        const evidence = input.evidence;
        const source = input.source ?? deriveSource(evidence);
        const errors = input.errors ?? [];
        const windowProblem = validateWindow(input.validFrom, input.validTo);
        if (windowProblem !== undefined)
            return windowProblem;
        // Validate the whole call before appending anything: a batch that is half
        // applied is a graph nobody can reason about. The view is read first
        // because a heuristic's errorIds must name active prediction errors.
        const view = await this.view(root);
        const nodeProblems = input.nodes.map((node) => this.validateNode(node, scope, source, evidence, view));
        const problem = nodeProblems.find((entry) => entry !== undefined);
        if (problem !== undefined)
            return problem;
        const incoming = new Map(input.nodes.map((node) => [node.id, node.type]));
        const edgeProblem = this.validateEdges(input.edges, view, incoming, scope, source, evidence);
        if (edgeProblem !== undefined)
            return edgeProblem;
        const errorProblem = this.validateErrors(errors, scope, source, evidence, view, incoming);
        if (errorProblem !== undefined)
            return errorProblem;
        if (view.nodes.size + input.nodes.length > MAX_NODES) {
            return reject('too_many_nodes', `the graph is capped at ${MAX_NODES} active nodes`);
        }
        if (view.edges.length + input.edges.length > MAX_EDGES) {
            return reject('too_many_edges', `the graph is capped at ${MAX_EDGES} active edges`);
        }
        const outcome = await this.storeFor(root).mutate((doc) => {
            // A batch may append one event per node, edge, and error. Refuse when the
            // log would pass the cap, not after it already has (P3).
            const incoming = input.nodes.length + input.edges.length + errors.length;
            if (doc.events.length + incoming > MAX_EVENTS) {
                return {
                    doc,
                    result: reject('event_log_full', this.eventLogFull(root)),
                };
            }
            const now = new Date();
            const at = now.toISOString();
            const groups = groupActiveEvents(doc.events, now);
            // Events appended by this call. A batch may name the same node or edge
            // twice; the second entry must supersede the first one in the batch, not
            // become a second active event on the same projection key (which the
            // projection would report as an unresolvable conflict and hide).
            const pending = new Map();
            const events = [];
            const writtenNodes = [];
            const writtenEdges = [];
            const writtenErrors = [];
            const duplicates = [];
            let seq = doc.nextSeq;
            for (const node of input.nodes) {
                const key = `node:${node.id}`;
                const current = pending.get(key) ?? groups.get(key)?.[0];
                if (current !== undefined &&
                    current.op === 'upsert_node' &&
                    sameNodePayload(current.node, node) &&
                    sameProvenance(current, scope, source, evidence)) {
                    duplicates.push(key);
                    continue;
                }
                const event = {
                    seq: seq++,
                    id: newId('evt'),
                    at,
                    ...(input.session === undefined ? {} : { session: input.session }),
                    op: 'upsert_node',
                    scope,
                    node: { ...node },
                    evidence,
                    source,
                    supersedes: current === undefined ? [] : [current.id],
                    invalidates: [],
                    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
                    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
                };
                events.push(event);
                pending.set(key, event);
                writtenNodes.push(node.id);
            }
            for (const edge of input.edges) {
                const key = projectionKeyOf({
                    seq: 0,
                    id: '',
                    at,
                    op: 'set_edge',
                    scope,
                    edge,
                    evidence: [],
                    source,
                    supersedes: [],
                    invalidates: [],
                });
                const current = pending.get(key) ?? groups.get(key)?.[0];
                if (current !== undefined &&
                    current.op === 'set_edge' &&
                    current.edge?.to === edge.to &&
                    sameProvenance(current, scope, source, evidence)) {
                    duplicates.push(key);
                    continue;
                }
                const event = {
                    seq: seq++,
                    id: newId('evt'),
                    at,
                    ...(input.session === undefined ? {} : { session: input.session }),
                    op: 'set_edge',
                    scope,
                    edge,
                    evidence,
                    source,
                    supersedes: current === undefined ? [] : [current.id],
                    invalidates: [],
                };
                events.push(event);
                pending.set(key, event);
                writtenEdges.push(`${edge.from} -${edge.type}-> ${edge.to}`);
            }
            // A prediction error is append-only: the same record twice is a repeat,
            // not a new symptom, so it is reported as a duplicate instead.
            const activeErrorKeys = new Set();
            for (const [, bucket] of groups) {
                const active = bucket[0];
                if (active?.op !== 'record_error' || active.error === undefined)
                    continue;
                activeErrorKeys.add(predictionErrorKey({ scope: active.scope, ...active.error }));
            }
            for (const error of errors) {
                const errorScope = error.scope ?? scope;
                const payload = {
                    kind: error.kind,
                    direction: error.direction,
                    subject: normalizeText(error.subject),
                    predicted: normalizeText(error.predicted),
                    observed: normalizeText(error.observed),
                    ...(error.lesson === undefined || normalizeText(error.lesson) === ''
                        ? {}
                        : { lesson: normalizeText(error.lesson) }),
                    ...(error.factId === undefined || normalizeText(error.factId) === ''
                        ? {}
                        : { factId: normalizeText(error.factId) }),
                    ...(error.revisit === undefined ? {} : { revisit: error.revisit }),
                };
                const key = predictionErrorKey({ scope: errorScope, ...payload });
                if (activeErrorKeys.has(key)) {
                    duplicates.push(`error:${payload.subject}`);
                    continue;
                }
                activeErrorKeys.add(key);
                const id = newId('pre');
                events.push({
                    seq: seq++,
                    id: newId('evt'),
                    at,
                    ...(input.session === undefined ? {} : { session: input.session }),
                    op: 'record_error',
                    scope: errorScope,
                    error: { id, ...payload },
                    evidence,
                    source,
                    supersedes: [],
                    invalidates: [],
                });
                writtenErrors.push(id);
            }
            if (events.length === 0) {
                return {
                    doc: {
                        ...doc,
                        stats: { ...doc.stats, duplicates: doc.stats.duplicates + duplicates.length },
                    },
                    result: { kind: 'written', nodes: [], edges: [], errors: [], duplicates },
                };
            }
            const stats = {
                ...doc.stats,
                writes: doc.stats.writes + events.length,
                duplicates: doc.stats.duplicates + duplicates.length,
            };
            return {
                doc: { ...doc, events: [...doc.events, ...events], stats, nextSeq: seq },
                result: {
                    kind: 'written',
                    nodes: writtenNodes,
                    edges: writtenEdges,
                    errors: writtenErrors,
                    duplicates,
                },
            };
        });
        this.cache.delete(root);
        return outcome;
    }
    async retract(root, input) {
        const outcome = await this.retractOnce(root, input);
        if (outcome.kind === 'rejected')
            await this.countRejection(root);
        return outcome;
    }
    async retractOnce(root, input) {
        if (input.reason.trim() === '')
            return reject('reason_required', 'a retraction needs a reason');
        if (input.evidence.length === 0) {
            return reject('evidence_required', 'a retraction is a change too: cite a file, a command, a url, or the human\'s words');
        }
        const scope = input.scope ?? DEFAULT_SCOPE;
        const source = input.source ?? deriveSource(input.evidence);
        if (source === 'agent_inference') {
            return reject('source_not_trusted', 'a guess is not a retraction; verify it first');
        }
        if (!sourceSupportedBy(input.evidence, source)) {
            return reject('source_not_supported', `a ${source} cannot be proved by the evidence given`);
        }
        if (!scopeAllowed(this.config.writeScopes, scope)) {
            return reject('scope_not_allowed', `scope ${scope} is outside the configured write scopes`);
        }
        // An unmigrated document is refused before the store's mutate would stamp
        // it with the current schema version and write it back.
        await this.read(root);
        const outcome = await this.storeFor(root).mutate((doc) => {
            const now = new Date();
            const at = now.toISOString();
            const groups = groupActiveEvents(doc.events, now);
            const events = [];
            const retractedNodes = [];
            const retractedEdges = [];
            const missing = [];
            const seenNodes = new Set();
            const seenEdges = new Set();
            let seq = doc.nextSeq;
            for (const nodeId of input.nodes) {
                // A duplicate id in one call would append two retractions on the same
                // key: neither supersedes the other, so the projection would report a
                // conflict and the node would never be explained as withdrawn.
                if (seenNodes.has(nodeId))
                    continue;
                seenNodes.add(nodeId);
                const current = groups.get(`node:${nodeId}`)?.[0];
                if (current === undefined) {
                    missing.push(`node:${nodeId}`);
                    continue;
                }
                // A retracted node must not leave edges pointing at it. The incident
                // edges are withdrawn by the same event, so history keeps them together.
                const incident = new Set();
                for (const [key, bucket] of groups) {
                    if (!key.startsWith('edge:'))
                        continue;
                    const event = bucket[0];
                    if (event?.edge === undefined)
                        continue;
                    if (event.edge.from === nodeId || event.edge.to === nodeId)
                        incident.add(event.id);
                }
                events.push({
                    seq: seq++,
                    id: newId('evt'),
                    at,
                    ...(input.session === undefined ? {} : { session: input.session }),
                    op: 'retract_node',
                    scope,
                    node: { id: nodeId, type: current.node?.type ?? 'entity', label: current.node?.label ?? nodeId },
                    reason: input.reason,
                    evidence: input.evidence,
                    source,
                    supersedes: [current.id],
                    invalidates: [...incident],
                });
                retractedNodes.push(nodeId);
            }
            for (const ref of input.edges) {
                const refKey = isFunctional(ref.type)
                    ? `edge:${ref.from}:${ref.type}`
                    : `edge:${ref.from}:${ref.type}:${ref.to ?? '*'}`;
                if (seenEdges.has(refKey))
                    continue;
                seenEdges.add(refKey);
                if (!isEdgeType(ref.type)) {
                    missing.push(`edge:${ref.from}:${ref.type}`);
                    continue;
                }
                if (isFunctional(ref.type)) {
                    const key = `edge:${ref.from}:${ref.type}`;
                    const current = groups.get(key)?.[0];
                    if (current === undefined) {
                        missing.push(key);
                        continue;
                    }
                    events.push({
                        seq: seq++,
                        id: newId('evt'),
                        at,
                        ...(input.session === undefined ? {} : { session: input.session }),
                        op: 'retract_edge',
                        scope,
                        edge: { from: ref.from, type: ref.type },
                        reason: input.reason,
                        evidence: input.evidence,
                        source,
                        supersedes: [current.id],
                        invalidates: [],
                    });
                    retractedEdges.push(`${ref.from} -${ref.type}-> ${current.edge?.to ?? '*'}`);
                    continue;
                }
                // A non-functional relation names its target; omitting it retracts all
                // of them, which is what "remove this dependency" means.
                const targets = ref.to === undefined
                    ? [...groups.keys()]
                        .filter((key) => key.startsWith(`edge:${ref.from}:${ref.type}:`))
                        .map((key) => groups.get(key)?.[0])
                        .filter((event) => event !== undefined)
                    : [groups.get(`edge:${ref.from}:${ref.type}:${ref.to}`)?.[0]].filter((event) => event !== undefined);
                if (targets.length === 0) {
                    missing.push(`edge:${ref.from}:${ref.type}:${ref.to ?? '*'}`);
                    continue;
                }
                for (const target of targets) {
                    events.push({
                        seq: seq++,
                        id: newId('evt'),
                        at,
                        ...(input.session === undefined ? {} : { session: input.session }),
                        op: 'retract_edge',
                        scope,
                        edge: { from: ref.from, type: ref.type, to: target.edge?.to },
                        reason: input.reason,
                        evidence: input.evidence,
                        source,
                        supersedes: [target.id],
                        invalidates: [],
                    });
                    retractedEdges.push(`${ref.from} -${ref.type}-> ${target.edge?.to ?? '*'}`);
                }
            }
            if (events.length === 0) {
                return {
                    doc,
                    result: { kind: 'retracted', nodes: [], edges: [], missing },
                };
            }
            // A retraction appends too: a node and its incident edges are one event
            // each. Check the exact count, since incident edges are only known here.
            if (doc.events.length + events.length > MAX_EVENTS) {
                return { doc, result: reject('event_log_full', this.eventLogFull(root)) };
            }
            const retractions = events.filter((event) => event.op.startsWith('retract')).length;
            const stats = {
                ...doc.stats,
                writes: doc.stats.writes + events.length,
                retractions: doc.stats.retractions + retractions,
            };
            return {
                doc: { ...doc, events: [...doc.events, ...events], stats, nextSeq: seq },
                result: { kind: 'retracted', nodes: retractedNodes, edges: retractedEdges, missing },
            };
        });
        this.cache.delete(root);
        return outcome;
    }
    async history(root, target, limit) {
        const doc = await this.read(root);
        const now = new Date();
        const key = targetKeyOf(target);
        const matching = doc.events
            .filter((event) => projectionKeyOf(event) === key)
            .sort((a, b) => b.seq - a.seq);
        const entries = matching.slice(0, limit).map((event) => ({
            id: event.id,
            at: event.at,
            op: event.op,
            summary: describeEvent(event),
            status: eventStatus(event, doc.events, now),
            source: event.source,
            confidence: confidenceOf(event.source),
            evidence: event.evidence,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            scope: event.scope,
        }));
        return { entries, total: matching.length };
    }
    async stats(root) {
        const doc = await this.read(root);
        return doc.stats ?? emptyStats();
    }
    validateNode(node, scope, source, evidence, view) {
        if (!isNodeType(node.type)) {
            return reject('unknown_node_type', `type must be one of ${NODE_TYPES.join(', ')}`);
        }
        if (node.id.trim() === '')
            return reject('invalid_node', 'a node needs an id');
        if (node.id.length > MAX_ID)
            return reject('invalid_node', `a node id is at most ${MAX_ID} characters`);
        if (node.label.trim() === '')
            return reject('invalid_node', `node ${node.id} needs a label`);
        if (node.label.length > MAX_LABEL) {
            return reject('invalid_node', `node ${node.id} has a label longer than ${MAX_LABEL} characters`);
        }
        if (node.value !== undefined && node.value.length > MAX_VALUE) {
            return reject('invalid_node', `node ${node.id} has a value longer than ${MAX_VALUE} characters`);
        }
        if ((node.paths?.length ?? 0) > MAX_LINKS || (node.docs?.length ?? 0) > MAX_LINKS) {
            return reject('invalid_node', `node ${node.id} may carry at most ${MAX_LINKS} paths and docs`);
        }
        if ((node.milestones?.length ?? 0) > MAX_MILESTONES) {
            return reject('invalid_node', `node ${node.id} may carry at most ${MAX_MILESTONES} milestones`);
        }
        if ((node.milestones?.length ?? 0) > 0 && !MILESTONE_NODE_TYPES.includes(node.type)) {
            return reject('invalid_node', `only ${MILESTONE_NODE_TYPES.join(' / ')} nodes carry acceptance items; ${node.id} is ${node.type}`);
        }
        for (const milestone of node.milestones ?? []) {
            if (milestone.text.length > MAX_MILESTONE_TEXT) {
                return reject('invalid_node', `a milestone of ${node.id} is longer than ${MAX_MILESTONE_TEXT} characters`);
            }
        }
        if (node.type === 'heuristic') {
            if (node.direction === undefined || !isPredictionErrorDirection(node.direction)) {
                return reject('unknown_direction', `direction must be one of ${PREDICTION_ERROR_DIRECTIONS.join(', ')}`);
            }
            if (node.conditions === undefined || node.conditions.trim() === '') {
                return reject('conditions_required', 'a heuristic needs the conditions it applies under; use "always" when it is unconditional');
            }
            if (node.conditions.length > MAX_CONDITIONS) {
                return reject('conditions_too_long', `conditions must be at most ${MAX_CONDITIONS} characters`);
            }
            const errorIds = node.errorIds ?? [];
            if (errorIds.length === 0) {
                return reject('error_ids_required', 'a heuristic needs at least one prediction error id it was distilled from');
            }
            if (errorIds.length > MAX_ERROR_IDS) {
                return reject('too_many_error_ids', `a heuristic may name at most ${MAX_ERROR_IDS} prediction errors`);
            }
            if (new Set(errorIds).size !== errorIds.length) {
                return reject('duplicate_error_ids', 'a heuristic must name each prediction error once; duplicates would inflate the observation count');
            }
            const active = new Set(view.errors.map((error) => error.id));
            for (const id of errorIds) {
                if (!active.has(id)) {
                    return reject('error_not_found', `the prediction error ${id} is not in the graph; record it first`);
                }
            }
            if (MODEL_SOURCES.includes(source) &&
                !evidence.some((item) => OBSERVED_KINDS.includes(item.kind))) {
                return reject('observation_required', 'a heuristic distilled by the model needs the command, file, or url that showed the difference');
            }
        }
        else if (node.direction !== undefined ||
            node.conditions !== undefined ||
            node.errorIds !== undefined) {
            return reject('heuristic_fields_only', 'direction / conditions / errorIds are only for heuristic nodes');
        }
        const decision = validateWrite({ kind: node.type, scope, source, evidence }, this.policyFor(node.type), TRUST);
        if (!decision.accepted) {
            const first = decision.diagnostics[0];
            return reject(first?.code ?? 'rejected', first?.message ?? 'the write was refused');
        }
        return undefined;
    }
    validateErrors(errors, scope, source, evidence, view, incoming) {
        for (const error of errors) {
            if (!isPredictionErrorKind(error.kind)) {
                return reject('unknown_error_kind', `kind must be one of ${PREDICTION_ERROR_KINDS.join(', ')}`);
            }
            // docs/07 §4 E4: the promotion link is structural evidence that the
            // correction reached the graph, so it must name a node that exists.
            const factId = error.factId === undefined ? '' : normalizeText(error.factId);
            if (factId !== '' && !incoming.has(factId) && !view.nodes.has(factId)) {
                return reject('fact_not_found', `the fact ${factId} does not exist; write it in this call or an earlier one`);
            }
            if (!scopeAllowed(this.config.writeScopes, error.scope ?? scope)) {
                return reject('scope_not_allowed', `scope ${error.scope ?? scope} is outside the configured write scopes`);
            }
            const problem = checkPredictionError({
                subject: normalizeText(error.subject),
                predicted: normalizeText(error.predicted),
                observed: normalizeText(error.observed),
                direction: error.direction,
                ...(error.lesson === undefined ? {} : { lesson: normalizeText(error.lesson) }),
                ...(error.revisit === undefined ? {} : { revisit: error.revisit }),
                evidence,
            });
            if (problem !== undefined)
                return reject(problem.code, problem.message);
        }
        if (errors.length === 0)
            return undefined;
        if (source === 'agent_inference') {
            return reject('source_not_trusted', 'a guess is not a prediction error; verify it first');
        }
        if (!sourceSupportedBy(evidence, source)) {
            return reject('source_not_supported', `a ${source} cannot be proved by the evidence given`);
        }
        return undefined;
    }
    validateEdges(edges, view, incoming, scope, source, evidence) {
        for (const edge of edges) {
            if (!isEdgeType(edge.type)) {
                return reject('unknown_edge_type', `type must be one of ${EDGE_TYPES.join(', ')}`);
            }
            if (edge.from === edge.to) {
                return reject('invalid_edge', `${edge.from} cannot be its own ${edge.type} target`);
            }
            const typeOf = (id) => incoming.get(id) ?? view.nodes.get(id)?.type;
            const fromType = typeOf(edge.from);
            const toType = typeOf(edge.to);
            if (fromType === undefined) {
                return reject('missing_endpoint', `${edge.from} does not exist; write the node first, in this call or an earlier one`);
            }
            if (toType === undefined) {
                return reject('missing_endpoint', `${edge.to} does not exist; write the node first, in this call or an earlier one`);
            }
            // The vocabulary is closed: a relation has a set of node types it may
            // join. Without this, a `serves` from a fact or a `part_of` into an
            // objective would be stored and then silently ignored by the tree.
            const spec = edgeSpec(edge.type);
            if (!spec.from.includes(fromType)) {
                return reject('invalid_edge_endpoint', `${edge.type} cannot start at a ${fromType} (${edge.from}); it starts at ${spec.from.join(' / ')}`);
            }
            if (!spec.to.includes(toType)) {
                return reject('invalid_edge_endpoint', `${edge.type} cannot point at a ${toType} (${edge.to}); it points at ${spec.to.join(' / ')}`);
            }
            if (edge.type === 'serves' && fromType === 'objective' && toType !== 'objective') {
                return reject('invalid_edge_endpoint', `${edge.from} is an objective and can only serve another objective (its parent), not a ${toType}`);
            }
            const decision = validateWrite({ kind: 'edge', scope, source, evidence }, this.policyFor('edge'), TRUST);
            if (!decision.accepted) {
                const first = decision.diagnostics[0];
                return reject(first?.code ?? 'rejected', first?.message ?? 'the write was refused');
            }
        }
        return undefined;
    }
}
function reject(code, message) {
    return { kind: 'rejected', code, message };
}
function sameNodePayload(existing, next) {
    if (existing === undefined)
        return false;
    if (existing.type !== next.type || existing.label !== next.label)
        return false;
    if ((existing.value ?? '') !== (next.value ?? ''))
        return false;
    if ((existing.direction ?? '') !== (next.direction ?? ''))
        return false;
    if ((existing.conditions ?? '') !== (next.conditions ?? ''))
        return false;
    if ((existing.errorIds ?? []).join('\u0000') !== (next.errorIds ?? []).join('\u0000'))
        return false;
    if ((existing.paths ?? []).join('\u0000') !== (next.paths ?? []).join('\u0000'))
        return false;
    if ((existing.docs ?? []).join('\u0000') !== (next.docs ?? []).join('\u0000'))
        return false;
    return JSON.stringify(existing.milestones ?? []) === JSON.stringify(next.milestones ?? []);
}
/**
 * Whether a new write says the same thing in the same way as the current one.
 *
 * The claim alone is not the whole record: the source and the evidence are what
 * a reader is asked to trust. A re-write that adds a command where the current
 * event has a note is a correction and must supersede it, or the label could
 * never move from "reported" to "verified" (P1-3 in the 2026-11-23 review).
 */
function sameProvenance(event, scope, source, evidence) {
    return event.scope === scope && event.source === source && sameEvidence(event.evidence, evidence);
}
function sameEvidence(left, right) {
    if (left.length !== right.length)
        return false;
    return left.every((item, index) => {
        const other = right[index];
        return (other !== undefined &&
            item.kind === other.kind &&
            item.ref === other.ref &&
            (item.excerpt ?? '') === (other.excerpt ?? ''));
    });
}
/**
 * A valid-time window must be an instant, and it must not end before it starts.
 *
 * `Date.parse` returning NaN would otherwise make every comparison false, so a
 * typo would mean "always valid" and an inverted window would silently hide the
 * claim forever.
 */
function validateWindow(validFrom, validTo) {
    const from = validFrom === undefined ? undefined : Date.parse(validFrom);
    const to = validTo === undefined ? undefined : Date.parse(validTo);
    if (validFrom !== undefined && !Number.isFinite(from)) {
        return reject('invalid_valid_time', `validFrom must be an ISO 8601 instant; got ${validFrom}`);
    }
    if (validTo !== undefined && !Number.isFinite(to)) {
        return reject('invalid_valid_time', `validTo must be an ISO 8601 instant; got ${validTo}`);
    }
    if (from !== undefined && to !== undefined && from > to) {
        return reject('invalid_valid_time', 'validFrom must not be after validTo');
    }
    return undefined;
}
function targetKeyOf(target) {
    if (target.node !== undefined)
        return `node:${target.node}`;
    const edge = target.edge;
    if (edge === undefined)
        return 'node:';
    return isFunctional(edge.type)
        ? `edge:${edge.from}:${edge.type}`
        : `edge:${edge.from}:${edge.type}:${edge.to ?? '*'}`;
}
async function mtimeOf(file) {
    try {
        return (await stat(file)).mtimeMs;
    }
    catch {
        return 0;
    }
}
export { edgeSpec };

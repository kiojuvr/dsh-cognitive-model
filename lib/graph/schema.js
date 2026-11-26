export const SCHEMA_VERSION = 2;
export const NODE_TYPES = [
    'objective',
    'component',
    'task',
    'decision',
    'constraint',
    'risk',
    'fact',
    'preference',
    'heuristic',
    'entity',
];
/** Node types that carry an acceptance record (`milestones`). */
export const MILESTONE_NODE_TYPES = ['objective', 'component'];
export const NODE_TYPE_HINT = {
    objective: 'what the work is for; id `objective` or `objective/<path>`, parent first',
    component: 'a means that serves an objective, e.g. `component/graph`; needs a `serves` edge',
    task: 'a unit of work, e.g. `task/current`; needs a `serves` edge to the node it serves',
    decision: 'a choice already made; put the reason in `value`',
    constraint: 'a bound on the work: something that must not be done, or a limit on it',
    risk: 'an unresolved danger or doubt',
    fact: 'a claim about the repository or the world; put the claim in `value`',
    preference: 'how the human wants things done',
    heuristic: 'a conditional, revisable rule distilled from prediction errors; direction, conditions and ' +
        'errorIds are required; link it with a `node` edge to what it serves',
    entity: 'something in the world: a repository area, a file, a service, a concept',
};
/** Node types whose `value` is a claim about the world, not structure. */
export const EPISTEMIC_NODE_TYPES = [
    'constraint',
    'risk',
    'fact',
    'preference',
];
export const EDGE_SPECS = [
    {
        type: 'serves',
        family: 'cognitive',
        functional: true,
        inverse: 'served by',
        from: ['objective', 'component', 'task'],
        to: ['objective', 'component'],
        hint: 'what this node is for, e.g. task/graph serves component/graph; an objective serves only its parent objective',
    },
    {
        type: 'requires',
        family: 'cognitive',
        functional: false,
        inverse: 'required by',
        from: ['component', 'task', 'decision'],
        to: ['component'],
        hint: 'a dependency on a component; what breaks if it is removed',
    },
    {
        type: 'verifies',
        family: 'cognitive',
        functional: false,
        inverse: 'verified by',
        from: ['component'],
        to: ['component'],
        hint: 'a component that checks another, e.g. component/verification verifies component/graph',
    },
    {
        type: 'node',
        family: 'cognitive',
        functional: true,
        inverse: 'has record',
        from: ['decision', 'fact', 'risk', 'constraint', 'preference', 'heuristic'],
        to: ['objective', 'component'],
        hint: 'the objective or component a decision, fact, risk, constraint, preference or heuristic ' +
            'belongs to',
    },
    {
        type: 'part_of',
        family: 'world',
        functional: true,
        inverse: 'has part',
        from: ['entity'],
        to: ['entity'],
        hint: 'the structural parent; owner and location are inferred through it',
    },
    {
        type: 'owned_by',
        family: 'world',
        functional: true,
        inverse: 'owns',
        from: ['entity'],
        to: ['entity'],
        hint: 'who owns the entity',
    },
    {
        type: 'located_in',
        family: 'world',
        functional: true,
        inverse: 'contains',
        from: ['entity'],
        to: ['entity'],
        hint: 'where the entity is',
    },
];
export const EDGE_TYPES = EDGE_SPECS.map((spec) => spec.type);
const EDGE_SPEC_BY_TYPE = new Map(EDGE_SPECS.map((spec) => [spec.type, spec]));
export function edgeSpec(type) {
    const spec = EDGE_SPEC_BY_TYPE.get(type);
    if (spec === undefined)
        throw new Error(`unknown edge type: ${type}`);
    return spec;
}
export function isNodeType(value) {
    return typeof value === 'string' && NODE_TYPES.includes(value);
}
export function isEdgeType(value) {
    return typeof value === 'string' && EDGE_TYPES.includes(value);
}
/** Functional relations are keyed by `(from, type)`; the rest also by `to`. */
export function isFunctional(type) {
    return edgeSpec(type).functional;
}
export const MAX_NODES = 2_000;
export const MAX_EDGES = 6_000;
/** The event log is append-only; the supported reset is deleting the area. */
export const MAX_EVENTS = 20_000;
export const MAX_ID = 120;
export const MAX_LABEL = 200;
export const MAX_VALUE = 600;
export const MAX_LINKS = 40;
export const MAX_MILESTONES = 20;
export const MAX_MILESTONE_TEXT = 200;
/** A heuristic's applicability, one sentence. */
export const MAX_CONDITIONS = 200;
/** How many source errors one heuristic may name. */
export const MAX_ERROR_IDS = 10;
export const DEFAULT_CONTEXT_LIMIT = 12;
/** How many facts the passive recall block shows. */
export const DEFAULT_RECALL_LIMIT = 12;
export const DEFAULT_QUERY_LIMIT = 50;
export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_HISTORY_LIMIT = 20;

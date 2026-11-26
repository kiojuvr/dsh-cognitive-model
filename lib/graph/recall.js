import { DEFAULT_CONTEXT_LIMIT } from './schema.js';
import { milestoneProgress } from './projection.js';
import { RECALL_ERROR_LIMIT, REVISIT_TARGETS } from './prediction.js';
/** The order facts are shown in: narrow the working set first, decorate last. */
export const FACT_ORDER = ['constraint', 'decision', 'risk', 'fact', 'preference'];
export const FACT_SECTION_LABEL = {
    constraint: 'Constraints',
    decision: 'Decisions',
    risk: 'Open risks',
    fact: 'Facts',
    preference: 'Preferences',
};
const MAX_TREE_DEPTH = 3;
const MAX_TREE_ROWS = 24;
/** Other open tasks shown in the block; the structure has its own budget. */
const REMAINING_LIMIT = 4;
/** How many distilled rules the passive recall shows. */
export const RECALL_HEURISTIC_LIMIT = 3;
/** How many decisions the block shows; the rest are one query away. */
export const RECALL_DECISION_LIMIT = 3;
/** How many path-linked facts the block shows. */
export const RECALL_FACT_LIMIT = 3;
/** How many preferences the block shows; they are few and they shape behavior. */
export const RECALL_PREFERENCE_LIMIT = 3;
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/** `serves` is functional, so one target per node. */
function servesMap(view) {
    const map = new Map();
    for (const edge of view.edges) {
        if (edge.type === 'serves')
            map.set(edge.from, edge.to);
    }
    return map;
}
/** Walk `serves` up from a node; root first. Stops on a cycle. */
export function pathOf(view, id, serves = servesMap(view)) {
    const path = [];
    const seen = new Set();
    let current = id;
    while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        path.push(current);
        current = serves.get(current);
    }
    return path.reverse();
}
/**
 * The current path: the task in hand and the chain it serves, root first.
 *
 * `task/current` is the position by convention. When it is absent the path is
 * the objective alone: the newest task is *not* promoted to the position, so
 * the block cannot assert a place the ledger never marked (D109).
 */
export function currentPath(view, serves = servesMap(view)) {
    const now = view.nodes.get('task/current');
    if (now !== undefined)
        return pathOf(view, now.id, serves);
    const root = objectiveRootOf(view, serves);
    return root === undefined ? [] : [root.id];
}
function objectiveRootOf(view, serves) {
    const direct = view.nodes.get('objective');
    if (direct !== undefined && direct.type === 'objective')
        return direct;
    return [...view.nodes.values()]
        .filter((node) => node.type === 'objective' && !serves.has(node.id))
        .sort((left, right) => left.id.localeCompare(right.id))[0];
}
function childrenOf(view) {
    const serves = servesMap(view);
    const children = new Map();
    for (const node of view.nodes.values()) {
        if (node.type !== 'objective' && node.type !== 'component')
            continue;
        const parent = serves.get(node.id);
        if (parent === undefined)
            continue;
        const bucket = children.get(parent);
        if (bucket === undefined)
            children.set(parent, [node]);
        else
            bucket.push(node);
    }
    for (const bucket of children.values())
        bucket.sort((left, right) => left.id.localeCompare(right.id));
    return children;
}
function taskCounts(view, serves) {
    const counts = new Map();
    for (const node of view.nodes.values()) {
        if (node.type !== 'task')
            continue;
        for (const step of pathOf(view, node.id, serves)) {
            counts.set(step, (counts.get(step) ?? 0) + 1);
        }
    }
    return counts;
}
/**
 * The provenance a section shows.
 *
 * Only the weak claim carries a label: an `observed` or `verified` item is the
 * default, and printing it on every row trains the eye to skip the one label
 * that asks for a check. A preference or an objective is intent, so evidence
 * cannot settle it and the "unverified" caveat would ask for a check that
 * cannot happen (D45).
 */
function supportOf(node) {
    if (node.confidence !== 'reported')
        return node.confidence;
    return node.type === 'preference' || node.type === 'objective' ? 'reported' : 'reported, unverified';
}
/** The label a section prints; empty for an evidence-backed item. */
function markOf(node) {
    return node.confidence === 'reported' ? ` (${supportOf(node)})` : '';
}
function displayOf(node, max = 200) {
    const value = node.value;
    // The label names the node; the value says what it is. A tree row is read as
    // a name first, so the description follows it instead of replacing it.
    if (value === undefined || value === '' || value === node.label)
        return truncate(node.label, max);
    return truncate(`${node.label} — ${value}`, max);
}
/** Acceptance is shown only while something is unmet; a finished count is history. */
function acceptanceText(node) {
    const progress = milestoneProgress(node);
    return progress.total === 0 || progress.done >= progress.total
        ? ''
        : ` [受入: ${progress.done}/${progress.total}]`;
}
function taskCountText(counts, id) {
    const count = counts.get(id) ?? 0;
    return count > 0 ? ` [tasks: ${count}]` : '';
}
function unmetOf(node) {
    return (node.milestones ?? []).filter((milestone) => !milestone.done);
}
function recency(left, right) {
    if (left.updatedAt !== right.updatedAt)
        return left.updatedAt < right.updatedAt ? 1 : -1;
    return left.id.localeCompare(right.id);
}
/**
 * How near a node is to the current position: the index of the path node it
 * belongs to. A fact linked to the component in hand outranks one linked to
 * the root, whatever the write times say.
 */
function closenessOf(path, targets, node) {
    const target = targets.get(node.id);
    return target === undefined ? -1 : path.indexOf(target);
}
/** One epistemic row: `- label: value (weak mark)`. */
function lineOf(node, max) {
    const value = node.value === undefined || node.value === '' || node.value === node.label
        ? ''
        : `: ${truncate(node.value, max)}`;
    return `- ${truncate(node.label, 60)}${value}${markOf(node)}`;
}
/**
 * The map: the objective tree, compressed.
 *
 * The root objective is printed in full above. Each branch keeps its name and
 * a short description; a branch off the current path lists its children as
 * names only, because the point is to remember that the choice exists, not to
 * re-read it. Rows on the current path keep a description, since that is the
 * work in hand.
 */
function mapText(view, root, pathSet, counts, budget) {
    const children = childrenOf(view);
    const rows = [];
    const inline = new Map();
    let omitted = 0;
    const subtreeCount = (node, depth) => {
        if (depth > MAX_TREE_DEPTH)
            return 0;
        let total = 1;
        for (const child of children.get(node.id) ?? [])
            total += subtreeCount(child, depth + 1);
        return total;
    };
    const walk = (node, depth, anchor) => {
        if (depth > MAX_TREE_DEPTH) {
            omitted++;
            return;
        }
        const onPath = pathSet.has(node.id);
        if (!onPath && depth > 1) {
            // An off-path descendant: a name under the nearest rendered ancestor.
            if (anchor === undefined)
                omitted++;
            else {
                const names = inline.get(anchor) ?? [];
                // The row already names the branch; a child is only a name, so the
                // `component/` prefix is noise here.
                names.push(node.label.replace(/^(component|objective)\//, ''));
                inline.set(anchor, names);
            }
            for (const child of children.get(node.id) ?? [])
                walk(child, depth + 1, anchor);
            return;
        }
        if (rows.length >= budget) {
            omitted += subtreeCount(node, depth);
            return;
        }
        rows.push({ node, depth, onPath });
        for (const child of children.get(node.id) ?? [])
            walk(child, depth + 1, node.id);
    };
    for (const child of children.get(root.id) ?? [])
        walk(child, 1, undefined);
    const lines = rows.map((row) => {
        const names = inline.get(row.node.id);
        const hidden = names === undefined
            ? ''
            : ` (${names.slice(0, 8).join(' · ')}${names.length > 8 ? ` · +${names.length - 8}` : ''})`;
        return (`${'  '.repeat(row.depth)}- ${displayOf(row.node, row.onPath ? 90 : 60)}` +
            `${taskCountText(counts, row.node.id)}${acceptanceText(row.node)}${markOf(row.node)}${hidden}`);
    });
    return { lines, omitted, nodes: rows.map((row) => row.node) };
}
/**
 * The newest error per (scope, subject, kind): a correction replaces what the
 * reader sees, while the log keeps every record.
 */
export function recentErrors(errors, limit) {
    const newestFirst = [...errors].sort((left, right) => right.seq - left.seq);
    const seen = new Set();
    const shown = [];
    for (const error of newestFirst) {
        const key = `${error.scope}\u0000${error.subject.toLowerCase()}\u0000${error.kind}\u0000${error.direction}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        shown.push(error);
        if (shown.length >= limit)
            break;
    }
    return shown;
}
export function errorLine(error) {
    const lesson = error.lesson === undefined || error.lesson === '' ? '' : `; lesson: ${truncate(error.lesson, 80)}`;
    const promoted = error.factId === undefined ? '' : ` → ${error.factId}`;
    const revisit = error.revisit === undefined ? '' : `; revisit: ${error.revisit}`;
    return (`- [${error.kind}/${error.direction}] ${truncate(error.subject, 40)} (${error.scope}): ` +
        `expected ${truncate(error.predicted, 100)}` +
        ` — actually ${truncate(error.observed, 120)}${revisit}${lesson}${promoted}`);
}
/**
 * One experience rule, as the input sees it.
 *
 * The rule is conditional and revisable: it names when it applies, how many
 * observations support it, and the errors it came from. It is material, not a
 * command.
 */
export function heuristicLine(node, target) {
    const direction = node.direction ?? 'worse';
    const conditions = node.conditions ?? 'always';
    const value = truncate(node.value === undefined || node.value === '' ? node.label : node.value, 160);
    const ids = node.errorIds.slice(0, 2).join(', ');
    const more = node.errorIds.length > 2 ? `, +${node.errorIds.length - 2}` : '';
    const where = target === undefined ? ' [unlinked]' : ` [for ${target}]`;
    // The conditions are shown in full: a truncated exception at the end would
    // widen the rule exactly when the exception matters most.
    return (`- [${direction}] ${truncate(node.label, 60)} (${node.scope}; ${conditions}): ` +
        `${value} — ${node.errorIds.length} observation(s) (${ids}${more}), ${supportOf(node)}${where}`);
}
/**
 * What a `revisit` value names, in the words the check uses.
 *
 * The kind says what went wrong; this says what the reader should look at.
 * Keeping them apart is the point: a `scope` miss can be a calibration record,
 * and a `belief` miss can be the reason the objective is in doubt (D100).
 */
export const REVISIT_LABEL = {
    objective: 'the objective',
    acceptance: 'the acceptance items',
    priority: 'the priorities',
};
function listOf(items) {
    if (items.length <= 1)
        return items[0] ?? '';
    if (items.length === 2)
        return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
/**
 * The bird's-eye check: one non-binding request to look up from the work.
 *
 * It carries the reason it fired — the subject of the triggering error and the
 * predicted/observed difference — because the decision is independent of the
 * three errors the block happens to show: the trigger may be outside that
 * budget, and the reader should not have to guess which record asked (D100).
 *
 * It adds no verdict and no approval: the block already carries the objective
 * and the current position, and this asks the reader to compare them and
 * re-decide. Continuing is a normal answer, and refining the objective by
 * agreement is not drift (D48). It appears once per reader per error, not on
 * every assembly: a line that repeats becomes background noise (D65).
 */
export function birdseyeText(errors) {
    const targets = [
        ...new Set(errors
            .map((error) => error.revisit)
            .filter((target) => target !== undefined)),
    ].sort((left, right) => REVISIT_TARGETS.indexOf(left) - REVISIT_TARGETS.indexOf(right));
    const what = targets.length === 0 ? 'the work' : listOf(targets.map((target) => REVISIT_LABEL[target]));
    const lead = errors.length === 1
        ? `Why this check — a recorded prediction error puts ${what} in question:`
        : `Why this check — recorded prediction errors put ${what} in question:`;
    const reasons = errors.slice(0, RECALL_ERROR_LIMIT).map((error) => `- [${error.kind}/${error.direction}] ${truncate(error.subject, 60)} (${error.scope}; revisit: ${error.revisit ?? 'unrecorded'}): ` +
        `expected ${truncate(error.predicted, 120)} — actually ${truncate(error.observed, 140)}`);
    const omitted = errors.length - reasons.length;
    if (omitted > 0)
        reasons.push(`  (+${omitted} more; graph_query with errors lists them)`);
    return [
        'Before continuing: does the work in hand still serve the objective?',
        lead,
        ...reasons,
        'Compare the objective, the current position, and the other unfinished parts',
        '(if the block names none, they are unrecorded — not absent), then decide to continue, change, or hold.',
        'Refining the objective or the approach is allowed, and earlier decisions can be re-examined;',
        'this is a check, not a gate.',
    ].join('\n');
}
const CAVEAT = 'Labels say how each item was recorded, not that its content was re-checked; ' +
    'an unmarked item cites a file, command or url. (reported, unverified) was said, not checked: ' +
    'check one when a detail matters, then record the correction with evidence.';
/**
 * The recall block, or '' when there is nothing to recall.
 *
 * The order is the handoff: objective, current path, position, what else is
 * open, the map, the constraints, the preferences, the decisions, the linked
 * facts, the rules distilled from errors, the one-shot check, the conflicts,
 * and a one-line index of the error log. `limit` bounds each settled section;
 * `treeLimit` bounds the map. The tree has its own budget on purpose: a deep
 * tree must not push the constraints and the decisions out of the block (F2 in
 * the 2026-11-23 review). The root, the current task, and a few remaining
 * tasks are always shown, and the error section keeps its own small budget.
 *
 * `revisits` are the fresh errors that ask for the bird's-eye check; they carry
 * their own reason lines, so the check does not depend on the error section's
 * budget.
 */
export function recallText(view, limit, revisits = [], treeLimit = DEFAULT_CONTEXT_LIMIT) {
    if (view.nodes.size === 0 && view.errors.length === 0)
        return '';
    const factBudget = Math.max(1, Math.trunc(limit));
    const treeBudget = Math.max(1, Math.min(Math.trunc(treeLimit), MAX_TREE_ROWS));
    const serves = servesMap(view);
    const root = objectiveRootOf(view, serves);
    const now = view.nodes.get('task/current');
    const path = now !== undefined ? pathOf(view, now.id, serves) : root === undefined ? [] : [root.id];
    const pathSet = new Set(path);
    const counts = taskCounts(view, serves);
    const nodeTargets = new Map();
    for (const edge of view.edges) {
        if (edge.type === 'node')
            nodeTargets.set(edge.from, edge.to);
    }
    const printed = [];
    // Experience rules: the rules linked to the current path come first, then the
    // rest by recency. A rule linked elsewhere is not hidden; it is shown after
    // the path-linked ones, with its target.
    const heuristics = [...view.nodes.values()]
        .filter((node) => node.type === 'heuristic')
        .sort(recency);
    const linkedHeuristics = heuristics.filter((node) => {
        const target = nodeTargets.get(node.id);
        return target !== undefined && pathSet.has(target);
    });
    const linkedIds = new Set(linkedHeuristics.map((node) => node.id));
    const shownHeuristics = [
        ...linkedHeuristics,
        ...heuristics.filter((node) => !linkedIds.has(node.id)),
    ].slice(0, RECALL_HEURISTIC_LIMIT);
    const tasks = [...view.nodes.values()].filter((node) => node.type === 'task').sort(recency);
    const remaining = tasks.filter((task) => task !== now);
    const lines = [
        'Working memory for this workspace, projected from the event log — build on it instead of re-deriving it:',
    ];
    if (root !== undefined) {
        lines.push(`Objective: ${displayOf(root)}${taskCountText(counts, root.id)}${acceptanceText(root)}${markOf(root)}`);
        printed.push(root);
    }
    else if (view.nodes.size > 0) {
        lines.push('Objective: none recorded (write an `objective` node to start one).');
    }
    const pathWithoutTask = now === undefined ? path : path.filter((id) => id !== now.id);
    if (pathWithoutTask.length > 1)
        lines.push(`Path: ${pathWithoutTask.join(' → ')}`);
    if (now !== undefined) {
        lines.push(`Now: ${displayOf(now)}${markOf(now)}`);
        printed.push(now);
        for (const milestone of unmetOf(now).slice(0, 2))
            lines.push(`  - 未達: ${milestone.text}`);
    }
    else {
        lines.push('Now: not recorded.');
    }
    // Remaining: the other tasks, and every recorded unmet acceptance item. The
    // three absences stay apart: nothing recorded, items recorded, and items cut
    // by the budget.
    const unmetElsewhere = [...view.nodes.values()]
        .filter((node) => node !== now && unmetOf(node).length > 0)
        .sort((left, right) => {
        const distance = closenessOf(path, nodeTargets, right) - closenessOf(path, nodeTargets, left);
        return distance !== 0 ? distance : recency(left, right);
    });
    const remainingTasks = remaining.slice(0, REMAINING_LIMIT);
    if (remainingTasks.length === 0 && unmetElsewhere.length === 0) {
        lines.push('Remaining: none recorded — this does not mean nothing else remains.');
    }
    else {
        lines.push('Remaining:');
        for (const task of remainingTasks) {
            const parent = serves.get(task.id);
            lines.push(`- ${parent === undefined ? '[unlinked]' : `[${parent}]`} ${displayOf(task)}${markOf(task)}`);
            printed.push(task);
        }
        const omittedTasks = remaining.length - remainingTasks.length;
        if (omittedTasks > 0)
            lines.push(`  (+${omittedTasks} more task(s) not shown; graph_query)`);
        const shownUnmet = unmetElsewhere.slice(0, 3);
        for (const node of shownUnmet) {
            for (const milestone of unmetOf(node).slice(0, 2)) {
                lines.push(`- 未達 [${node.id}] ${milestone.text}`);
            }
            printed.push(node);
        }
        const omittedUnmet = unmetElsewhere.length - shownUnmet.length;
        if (omittedUnmet > 0) {
            lines.push(`  (+${omittedUnmet} more node(s) with unmet items; graph_query)`);
        }
    }
    if (root !== undefined) {
        const map = mapText(view, root, pathSet, counts, treeBudget);
        if (map.lines.length > 0) {
            lines.push('Map:');
            lines.push(...map.lines);
            printed.push(...map.nodes);
            if (map.omitted > 0) {
                lines.push(`  (+${map.omitted} more node${map.omitted === 1 ? '' : 's'} not shown; graph_query)`);
            }
        }
    }
    // Constraints, risks and preferences have their own frames: they narrow the
    // working set, so they do not compete with the facts for a budget.
    const byType = (type) => [...view.nodes.values()].filter((node) => node.type === type).sort(recency);
    const section = (type, cap, max) => {
        const nodes = byType(type);
        if (nodes.length === 0)
            return;
        lines.push(`${FACT_SECTION_LABEL[type]}:`);
        for (const node of nodes.slice(0, cap)) {
            lines.push(lineOf(node, max));
            printed.push(node);
        }
        if (nodes.length > cap)
            lines.push(`  (+${nodes.length - cap} more; graph_query with node_type=${type})`);
    };
    section('constraint', factBudget, 160);
    section('risk', factBudget, 160);
    section('preference', Math.min(RECALL_PREFERENCE_LIMIT, factBudget), 140);
    // Decisions: the current path first (a `node` edge), then recency. A
    // decision is settled context; the reader needs the ones that touch the work
    // in hand, not the newest chronological neighbours.
    const decisions = byType('decision');
    const onPath = decisions.filter((node) => pathSet.has(nodeTargets.get(node.id) ?? '')).sort(recency);
    const offPath = decisions.filter((node) => !onPath.includes(node)).sort(recency);
    const shownDecisions = [...onPath, ...offPath].slice(0, Math.min(RECALL_DECISION_LIMIT, factBudget));
    if (shownDecisions.length > 0) {
        lines.push('Decisions:');
        for (const node of shownDecisions) {
            lines.push(lineOf(node, 160));
            printed.push(node);
        }
        const omitted = decisions.length - shownDecisions.length;
        if (omitted > 0)
            lines.push(`  (+${omitted} more; graph_query with node_type=decision)`);
    }
    // Facts: only the ones linked to the current path, nearest first. Recency is
    // not relevance: the newest fact is usually an operational detail, and a
    // block that fills its fact frame with those crowds out what the work needs.
    // With no link, the block says how many are recorded and how to read them
    // rather than showing an unrelated sample (D109).
    const facts = byType('fact');
    const linkedFacts = facts
        .filter((node) => pathSet.has(nodeTargets.get(node.id) ?? ''))
        .sort((left, right) => closenessOf(path, nodeTargets, right) - closenessOf(path, nodeTargets, left) ||
        recency(left, right));
    if (linkedFacts.length > 0) {
        lines.push('Facts:');
        for (const node of linkedFacts.slice(0, RECALL_FACT_LIMIT)) {
            lines.push(lineOf(node, 160));
            printed.push(node);
        }
        const omitted = facts.length - Math.min(linkedFacts.length, RECALL_FACT_LIMIT);
        if (omitted > 0)
            lines.push(`  (+${omitted} more; graph_query with node_type=fact)`);
    }
    else if (facts.length > 0) {
        lines.push(`Facts: ${facts.length} recorded, none linked to the current path ` +
            '(graph_query with node_type=fact lists them).');
    }
    if (shownHeuristics.length > 0) {
        lines.push('Experience (rules distilled from earlier prediction errors; conditional and revisable, ' +
            'not a rule for this case):');
        for (const node of shownHeuristics) {
            lines.push(heuristicLine(node, nodeTargets.get(node.id)));
            printed.push(node);
        }
    }
    // The bird's-eye check: a fresh revisit asks the reader to look up from the
    // work once, with the reason it fired (D65 / D93 / D100).
    if (revisits.length > 0)
        lines.push(birdseyeText(revisits));
    if (view.conflicts.length > 0) {
        const keys = view.conflicts.slice(0, 3).map((conflict) => conflict.key);
        lines.push(`Unresolved conflicts (${view.conflicts.length}): ${keys.join(', ')}` +
            (view.conflicts.length > keys.length ? ', …' : ''));
    }
    // The error log is an index, not a warning: the count says the history is
    // there to read, and the distilled rules are already above (D109).
    if (view.errors.length > 0) {
        lines.push(`Prediction errors: ${view.errors.length} recorded (graph_query errors=true).`);
    }
    if (printed.some((node) => node.confidence === 'reported' && node.type !== 'preference' && node.type !== 'objective')) {
        lines.push(CAVEAT);
    }
    return lines.join('\n');
}

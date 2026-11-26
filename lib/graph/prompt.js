/**
 * The prompt contribution: one short instruction, and the recall block that is
 * assembled fresh on every step.
 *
 * The block is deliberately small. It answers the questions a session would
 * otherwise re-derive — what the work is for, where the current path runs, what
 * is still open, what may be believed, and where an earlier expectation lost to
 * reality — and it names an unresolved conflict rather than hiding it, because
 * a conflict is the one thing a reader must not be quietly wrong about.
 *
 * It replaces the earlier "graph context" block: the recall is the same
 * projection with the epistemic nodes and the error records folded in, so there
 * is one block and one implementation of supersession behind it.
 */
import { sessionIdOf } from '../cordis.js';
import { milestoneProgress } from './projection.js';
import { currentPath, recallText } from './recall.js';
export { currentPath };
const INSTRUCTION = [
    'This workspace keeps one graph: the cognitive model (objective / component / task / decision),',
    'the epistemic record (constraint / risk / fact / preference) and the world model (entity), joined by typed edges.',
    'A finding is not a graph node: it is a deferral queue item, recorded in the findings ledger (`finding_add`)',
    'with its `node` field pointing back at the objective or component it belongs to.',
    'What must survive the session — a constraint, a decision already made, a verified fact, where the work stands',
    '(`task/current`), or what else remains (one task node per task) — is recorded with graph_write and the evidence',
    'you actually saw: a guess is refused. An objective node is `objective` or `objective/<path>` with its parent linked by `serves`;',
    'a component is `component/<key>` serving an objective; a task is `task/current` or `task/<key>` serving the node',
    'it serves. A task\'s value says where the work stands and what is still unconfirmed for the next decision, not',
    'what is finished. World entities are `entity` nodes joined by `part_of` / `owned_by` / `located_in` — set the direct',
    'relation only when you know it, because owner and location are inherited through `part_of`. When an expectation',
    'differs — better or worse — record it with graph_write `errors`, a `direction`, and the command, file, or url that',
    'showed it: a note alone is a report, not an observation. A conditional rule distilled from those errors is a',
    '`heuristic` node with `direction`, `conditions`, `errorIds`, and a `node` edge to what it serves. Add `revisit` only',
    'when the error puts the current objective, an acceptance item, or a priority in question: that is what asks for one',
    'bird\'s-eye check, and an estimate-only miss does not. A fact reaches the recall block only when a `node` edge',
    'links it to the objective or component it constrains; link it there when the next session should see it. Writing the',
    'same node again replaces it, and the earlier value stays in',
    'graph_history; withdraw with graph_retract, never by rewriting history. The recall block is compressed context',
    'from earlier sessions: build on it instead of re-deriving what is already settled, and re-check a label when a',
    'detail matters. Do not record work that belongs to the current task — just do it. The graph is a reference,',
    'not a gate: it never blocks the work, and an unresolved conflict is reported rather than silently resolved.',
].join(' ');
function resolveRoot(service, assembly, directoryOf) {
    const agent = assembly?.agent;
    const cwd = directoryOf(agent);
    if (typeof cwd === 'string' && cwd !== '')
        return service.rootFor(cwd);
    return service.currentRoot();
}
/**
 * The terse graph view, kept as a library export.
 *
 * The passive block uses `recallText`, which carries the same structure plus
 * the epistemic nodes and the error records; this function stays available for
 * callers that want the structure alone.
 */
export function contextText(view, limit) {
    if (view.nodes.size === 0)
        return '';
    const lines = [];
    lines.push(`Graph: ${view.nodes.size} nodes, ${view.edges.length} edges.`);
    const path = currentPath(view);
    if (path.length > 0) {
        lines.push(`Current path: ${path.join(' → ')}`);
    }
    else {
        lines.push('Current path: none recorded (write an `objective` node to start one).');
    }
    const acceptance = path
        .map((id) => view.nodes.get(id))
        .filter((node) => node !== undefined)
        .map((node) => ({ node, progress: milestoneProgress(node) }))
        .filter((entry) => entry.progress.total > 0);
    if (acceptance.length > 0) {
        lines.push(`Acceptance: ${acceptance
            .map((entry) => `${entry.node.id} ${entry.progress.done}/${entry.progress.total}`)
            .join(', ')}`);
    }
    const unmet = [...view.nodes.values()]
        .filter((node) => !path.includes(node.id))
        .map((node) => ({ node, progress: milestoneProgress(node) }))
        .filter((entry) => entry.progress.total > entry.progress.done)
        .slice(0, limit);
    if (unmet.length > 0) {
        lines.push(`Also unmet: ${unmet
            .map((entry) => `${entry.node.id} ${entry.progress.done}/${entry.progress.total}`)
            .join(', ')}`);
    }
    if (view.conflicts.length > 0) {
        const keys = view.conflicts.slice(0, 3).map((conflict) => conflict.key);
        lines.push(`Unresolved conflicts (${view.conflicts.length}): ${keys.join(', ')}` +
            (view.conflicts.length > keys.length ? ', …' : ''));
    }
    return lines.join('\n');
}
export function registerPrompt(ctx, service, directoryOf) {
    const disposers = [];
    // Warm the cache before the synchronous context provider runs. Without this
    // the first assembly of a session renders nothing — exactly when recall
    // matters most.
    disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const root = resolveRoot(service, context, directoryOf);
        if (root !== undefined) {
            try {
                if (await service.shouldRefresh(root))
                    await service.refresh(root);
            }
            catch {
                // Reading is best-effort; a failure must not break the prompt.
            }
        }
        return await next();
    }, { prepend: true }));
    disposers.push(ctx.systemPrompt.section({
        name: 'cognitive-model:instruction',
        order: 890,
        text: INSTRUCTION,
    }));
    disposers.push(ctx.systemPrompt.context({
        name: 'cognitive-model:recall',
        order: 881,
        required: false,
        text: (assembly) => {
            const root = resolveRoot(service, assembly, directoryOf);
            if (root === undefined)
                return '';
            const view = service.currentView(root);
            if (view === undefined)
                return '';
            // A fresh error that puts the objective, an acceptance item, or a
            // priority in question asks the reader to look up once per session for
            // that error; the service owns the receipts, so a repeated assembly is
            // quiet and another session is still asked.
            const revisits = service.consumeFreshRevisit(root, sessionIdOf(assembly?.agent), view.errors);
            return recallText(view, service.config.recallLimit, revisits, service.config.contextLimit);
        },
    }));
    return () => {
        for (const dispose of disposers.reverse())
            dispose();
    };
}

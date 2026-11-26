/**
 * The recall block: what earlier sessions settled, projected from the graph.
 *
 * This is the compressed context a new session starts from. It answers the
 * questions a reader would otherwise re-derive: what the work is for, where the
 * current path runs, what is still open, what may be believed, and where an
 * earlier expectation lost to reality.
 *
 * It is assembled from the projected graph, not from a second ledger: the
 * objective tree is the `serves` chain, the "now" line is `task/current`, the
 * facts are the epistemic nodes, and the errors are the log's error records.
 * The block is a reference, not a gate — it shows, it does not bind.
 *
 * The block is a handoff for the next decision, not a reduced ledger (D109).
 * The material that narrows the choice — the objective, the current path, the
 * position, the constraints, the preferences, the rules distilled from errors
 * — stays; the reference material and the raw log are one `graph_query` away.
 */
import type { GraphNode } from './schema.js';
import { type GraphView, type ProjectedError } from './projection.js';
import { type RevisitTarget } from './prediction.js';
/** The order facts are shown in: narrow the working set first, decorate last. */
export declare const FACT_ORDER: readonly ["constraint", "decision", "risk", "fact", "preference"];
export type FactSection = (typeof FACT_ORDER)[number];
export declare const FACT_SECTION_LABEL: Record<FactSection, string>;
/** How many distilled rules the passive recall shows. */
export declare const RECALL_HEURISTIC_LIMIT = 3;
/** How many decisions the block shows; the rest are one query away. */
export declare const RECALL_DECISION_LIMIT = 3;
/** How many path-linked facts the block shows. */
export declare const RECALL_FACT_LIMIT = 3;
/** How many preferences the block shows; they are few and they shape behavior. */
export declare const RECALL_PREFERENCE_LIMIT = 3;
/** Walk `serves` up from a node; root first. Stops on a cycle. */
export declare function pathOf(view: GraphView, id: string, serves?: Map<string, string>): string[];
/**
 * The current path: the task in hand and the chain it serves, root first.
 *
 * `task/current` is the position by convention. When it is absent the path is
 * the objective alone: the newest task is *not* promoted to the position, so
 * the block cannot assert a place the ledger never marked (D109).
 */
export declare function currentPath(view: GraphView, serves?: Map<string, string>): string[];
/**
 * The newest error per (scope, subject, kind): a correction replaces what the
 * reader sees, while the log keeps every record.
 */
export declare function recentErrors(errors: readonly ProjectedError[], limit: number): ProjectedError[];
export declare function errorLine(error: ProjectedError): string;
/**
 * One experience rule, as the input sees it.
 *
 * The rule is conditional and revisable: it names when it applies, how many
 * observations support it, and the errors it came from. It is material, not a
 * command.
 */
export declare function heuristicLine(node: GraphNode, target: string | undefined): string;
/**
 * What a `revisit` value names, in the words the check uses.
 *
 * The kind says what went wrong; this says what the reader should look at.
 * Keeping them apart is the point: a `scope` miss can be a calibration record,
 * and a `belief` miss can be the reason the objective is in doubt (D100).
 */
export declare const REVISIT_LABEL: Record<RevisitTarget, string>;
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
export declare function birdseyeText(errors: readonly ProjectedError[]): string;
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
export declare function recallText(view: GraphView, limit: number, revisits?: readonly ProjectedError[], treeLimit?: number): string;

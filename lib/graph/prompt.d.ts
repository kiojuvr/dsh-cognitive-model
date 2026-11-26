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
import { type Context } from '../cordis.js';
import type { DirectoryResolver } from '@kioju/dsh-cognitive-core';
import { type GraphView } from './projection.js';
import { currentPath } from './recall.js';
import type { GraphService } from './service.js';
export { currentPath };
/**
 * The terse graph view, kept as a library export.
 *
 * The passive block uses `recallText`, which carries the same structure plus
 * the epistemic nodes and the error records; this function stays available for
 * callers that want the structure alone.
 */
export declare function contextText(view: GraphView, limit: number): string;
export declare function registerPrompt(ctx: Context, service: GraphService, directoryOf: DirectoryResolver): () => void;

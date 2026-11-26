/**
 * Prediction errors: the places where an expectation differed from what happened.
 *
 * A node is a claim about the workspace; a prediction error is the record of a
 * claim (or an expectation) differing from reality. The difference is signed:
 * the outcome can be better or worse than expected, and both are material for
 * the next decision. Recording the difference makes it available to later
 * sessions rather than leaving them with only the updated claim.
 *
 * It is an event, not a node: it has no place in the structure and no edge to
 * anything, and it is never superseded — a correction is a new record, so the
 * expectation that differed stays readable.
 */
import type { Evidence } from '@kioju/dsh-cognitive-core';
export declare const PREDICTION_ERROR_KINDS: readonly ["belief", "outcome", "estimate", "scope"];
export type PredictionErrorKind = (typeof PREDICTION_ERROR_KINDS)[number];
export declare const PREDICTION_ERROR_KIND_HINT: Record<PredictionErrorKind, string>;
/**
 * Which way the outcome differed from the expectation.
 *
 * A prediction error is a signed residual, not a failure record. `better` means
 * the outcome beat the expectation (it worked, was faster, or was smaller);
 * `worse` means it fell short. Both feed the same distillation: a positive
 * residual can widen a boundary or raise confidence, a negative one can narrow
 * it or add a check.
 */
export declare const PREDICTION_ERROR_DIRECTIONS: readonly ["better", "worse"];
export type PredictionErrorDirection = (typeof PREDICTION_ERROR_DIRECTIONS)[number];
export declare const PREDICTION_ERROR_DIRECTION_HINT: Record<PredictionErrorDirection, string>;
/**
 * What a prediction error puts in question, when it puts anything in question.
 *
 * The kind describes the error; this field describes its bearing on the work.
 * They are separate on purpose: a `scope` miss can be a harmless calibration
 * note, and a `belief` miss can invalidate an acceptance item. The recall asks
 * for a bird's-eye check only when this field is set, so the trigger is the
 * impact the writer observed, not the kind of the miss or its size.
 */
export declare const REVISIT_TARGETS: readonly ["objective", "acceptance", "priority"];
export type RevisitTarget = (typeof REVISIT_TARGETS)[number];
export declare const REVISIT_TARGET_HINT: Record<RevisitTarget, string>;
/** How many errors the passive recall shows. */
export declare const RECALL_ERROR_LIMIT = 3;
export declare const MAX_PREDICTED = 300;
export declare const MAX_OBSERVED = 400;
export declare const MAX_LESSON = 300;
export declare const MAX_ERROR_SUBJECT = 120;
/**
 * Evidence kinds that show an outcome rather than repeating one.
 *
 * A note is what somebody said. The point of this record is that reality
 * disagreed, so a record supported only by talk is refused: an error that is
 * only reported is indistinguishable from an opinion.
 */
export declare const OBSERVED_KINDS: readonly Evidence['kind'][];
export interface PredictionErrorInput {
    kind: PredictionErrorKind;
    direction: PredictionErrorDirection;
    subject: string;
    predicted: string;
    observed: string;
    lesson?: string;
    factId?: string;
    /** Set when this error puts the objective, an acceptance item, or a priority in question. */
    revisit?: RevisitTarget;
    scope?: string;
}
export interface PredictionErrorProblem {
    code: string;
    message: string;
}
export declare function isPredictionErrorKind(value: unknown): value is PredictionErrorKind;
export declare function isPredictionErrorDirection(value: unknown): value is PredictionErrorDirection;
export declare function isRevisitTarget(value: unknown): value is RevisitTarget;
export declare function normalizeText(value: string): string;
/**
 * Identity: the observation plus the takeaway.
 *
 * The same expectation differing the same way twice is one error, but a
 * correction is not a repeat: changing `lesson` or `factId` writes a new record
 * and the old one stays as history. The direction is part of the identity: a
 * positive and a negative residual with the same subject are different lessons.
 */
export declare function predictionErrorKey(error: {
    scope: string;
    subject: string;
    kind: string;
    direction: string;
    predicted: string;
    observed: string;
    lesson?: string;
    factId?: string;
    revisit?: string;
}): string;
/**
 * The write policy for an error record.
 *
 * It is deliberately stricter than a node's: a node may rest on the human's
 * word, an error may not. "It differed" is only worth recalling if something
 * other than the reporter showed it.
 */
export declare function checkPredictionError(input: {
    subject: string;
    predicted: string;
    observed: string;
    direction: string;
    lesson?: string;
    revisit?: string;
    evidence: readonly Evidence[];
}): PredictionErrorProblem | undefined;

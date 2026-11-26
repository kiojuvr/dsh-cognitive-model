export const PREDICTION_ERROR_KINDS = ['belief', 'outcome', 'estimate', 'scope'];
export const PREDICTION_ERROR_KIND_HINT = {
    belief: 'a remembered claim differed from the repository: memory said X, the repository says Y',
    outcome: 'an action did not produce the expected result (better or worse)',
    estimate: 'the effort or size differed from the estimate: one step was expected, it took five (or one)',
    scope: 'the extent of the task differed from the expectation: what looked incidental was the work (or the reverse)',
};
/**
 * Which way the outcome differed from the expectation.
 *
 * A prediction error is a signed residual, not a failure record. `better` means
 * the outcome beat the expectation (it worked, was faster, or was smaller);
 * `worse` means it fell short. Both feed the same distillation: a positive
 * residual can widen a boundary or raise confidence, a negative one can narrow
 * it or add a check.
 */
export const PREDICTION_ERROR_DIRECTIONS = ['better', 'worse'];
export const PREDICTION_ERROR_DIRECTION_HINT = {
    better: 'the outcome was better than expected: it worked, was faster, or was smaller',
    worse: 'the outcome was worse than expected: it failed, was slower, or was larger',
};
/**
 * What a prediction error puts in question, when it puts anything in question.
 *
 * The kind describes the error; this field describes its bearing on the work.
 * They are separate on purpose: a `scope` miss can be a harmless calibration
 * note, and a `belief` miss can invalidate an acceptance item. The recall asks
 * for a bird's-eye check only when this field is set, so the trigger is the
 * impact the writer observed, not the kind of the miss or its size.
 */
export const REVISIT_TARGETS = ['objective', 'acceptance', 'priority'];
export const REVISIT_TARGET_HINT = {
    objective: 'the current objective itself needs a second look',
    acceptance: 'an acceptance item may be unreachable, already met, or the wrong one',
    priority: 'the choice or order of what matters next may be wrong',
};
/** How many errors the passive recall shows. */
export const RECALL_ERROR_LIMIT = 3;
export const MAX_PREDICTED = 300;
export const MAX_OBSERVED = 400;
export const MAX_LESSON = 300;
export const MAX_ERROR_SUBJECT = 120;
/**
 * Evidence kinds that show an outcome rather than repeating one.
 *
 * A note is what somebody said. The point of this record is that reality
 * disagreed, so a record supported only by talk is refused: an error that is
 * only reported is indistinguishable from an opinion.
 */
export const OBSERVED_KINDS = ['command', 'file', 'url'];
export function isPredictionErrorKind(value) {
    return typeof value === 'string' && PREDICTION_ERROR_KINDS.includes(value);
}
export function isPredictionErrorDirection(value) {
    return (typeof value === 'string' && PREDICTION_ERROR_DIRECTIONS.includes(value));
}
export function isRevisitTarget(value) {
    return typeof value === 'string' && REVISIT_TARGETS.includes(value);
}
export function normalizeText(value) {
    return value.trim().replace(/\s+/g, ' ');
}
/**
 * Identity: the observation plus the takeaway.
 *
 * The same expectation differing the same way twice is one error, but a
 * correction is not a repeat: changing `lesson` or `factId` writes a new record
 * and the old one stays as history. The direction is part of the identity: a
 * positive and a negative residual with the same subject are different lessons.
 */
export function predictionErrorKey(error) {
    return [
        error.scope,
        normalizeText(error.subject).toLowerCase(),
        error.kind,
        error.direction,
        normalizeText(error.predicted),
        normalizeText(error.observed),
        normalizeText(error.lesson ?? ''),
        normalizeText(error.factId ?? ''),
        normalizeText(error.revisit ?? ''),
    ].join('\u0000');
}
/**
 * The write policy for an error record.
 *
 * It is deliberately stricter than a node's: a node may rest on the human's
 * word, an error may not. "It differed" is only worth recalling if something
 * other than the reporter showed it.
 */
export function checkPredictionError(input) {
    if (input.subject === '') {
        return { code: 'empty_subject', message: 'subject must not be empty' };
    }
    if (input.subject.length > MAX_ERROR_SUBJECT) {
        return { code: 'subject_too_long', message: `subject must be at most ${MAX_ERROR_SUBJECT} characters` };
    }
    if (!isPredictionErrorDirection(input.direction)) {
        return {
            code: 'unknown_direction',
            message: `direction must be one of ${PREDICTION_ERROR_DIRECTIONS.join(', ')}`,
        };
    }
    if (input.revisit !== undefined && !isRevisitTarget(input.revisit)) {
        return { code: 'unknown_revisit', message: `revisit must be one of ${REVISIT_TARGETS.join(', ')}` };
    }
    if (input.predicted === '') {
        return { code: 'empty_predicted', message: 'predicted must not be empty' };
    }
    if (input.predicted.length > MAX_PREDICTED) {
        return { code: 'predicted_too_long', message: `predicted must be at most ${MAX_PREDICTED} characters` };
    }
    if (input.observed === '') {
        return { code: 'empty_observed', message: 'observed must not be empty' };
    }
    if (input.observed.length > MAX_OBSERVED) {
        return { code: 'observed_too_long', message: `observed must be at most ${MAX_OBSERVED} characters` };
    }
    if (input.lesson !== undefined && input.lesson.length > MAX_LESSON) {
        return { code: 'lesson_too_long', message: `lesson must be at most ${MAX_LESSON} characters` };
    }
    if (input.evidence.length === 0) {
        return {
            code: 'evidence_required',
            message: 'a prediction error needs evidence for what actually happened; a guess is refused',
        };
    }
    if (!input.evidence.some((item) => OBSERVED_KINDS.includes(item.kind))) {
        return {
            code: 'observation_required',
            message: 'note evidence alone is a report, not an observation: cite the command, file, or url ' +
                'that showed the difference',
        };
    }
    return undefined;
}

/**
 * Prediction errors: the places where an expectation differed from what happened.
 *
 * A node is a claim about the workspace; a prediction error is the record of a
 * claim (or an expectation) differing from reality. The difference is signed:
 * the outcome can be better or worse than expected, and both are material for
 * the next decision. The memory ledger already corrected its facts with
 * evidence, but the correction was silent: the next session saw the new value
 * and not what it cost. This record makes the difference visible and recallable.
 *
 * It is an event, not a node: it has no place in the structure and no edge to
 * anything, and it is never superseded — a correction is a new record, so the
 * expectation that differed stays readable.
 */
import type { Evidence } from 'dsh-cognitive-core'

export const PREDICTION_ERROR_KINDS = ['belief', 'outcome', 'estimate', 'scope'] as const

export type PredictionErrorKind = (typeof PREDICTION_ERROR_KINDS)[number]

export const PREDICTION_ERROR_KIND_HINT: Record<PredictionErrorKind, string> = {
  belief: 'a remembered claim differed from the repository: memory said X, the repository says Y',
  outcome: 'an action did not produce the expected result (better or worse)',
  estimate: 'the effort or size differed from the estimate: one step was expected, it took five (or one)',
  scope: 'the extent of the task differed from the expectation: what looked incidental was the work (or the reverse)',
}

/**
 * Which way the outcome differed from the expectation.
 *
 * A prediction error is a signed residual, not a failure record. `better` means
 * the outcome beat the expectation (it worked, was faster, or was smaller);
 * `worse` means it fell short. Both feed the same distillation: a positive
 * residual can widen a boundary or raise confidence, a negative one can narrow
 * it or add a check.
 */
export const PREDICTION_ERROR_DIRECTIONS = ['better', 'worse'] as const

export type PredictionErrorDirection = (typeof PREDICTION_ERROR_DIRECTIONS)[number]

export const PREDICTION_ERROR_DIRECTION_HINT: Record<PredictionErrorDirection, string> = {
  better: 'the outcome was better than expected: it worked, was faster, or was smaller',
  worse: 'the outcome was worse than expected: it failed, was slower, or was larger',
}

/**
 * What a prediction error puts in question, when it puts anything in question.
 *
 * The kind describes the error; this field describes its bearing on the work.
 * They are separate on purpose: a `scope` miss can be a harmless calibration
 * note, and a `belief` miss can invalidate an acceptance item. The recall asks
 * for a bird's-eye check only when this field is set, so the trigger is the
 * impact the writer observed, not the kind of the miss or its size.
 */
export const REVISIT_TARGETS = ['objective', 'acceptance', 'priority'] as const

export type RevisitTarget = (typeof REVISIT_TARGETS)[number]

export const REVISIT_TARGET_HINT: Record<RevisitTarget, string> = {
  objective: 'the current objective itself needs a second look',
  acceptance: 'an acceptance item may be unreachable, already met, or the wrong one',
  priority: 'the choice or order of what matters next may be wrong',
}

/** How many errors the passive recall shows. */
export const RECALL_ERROR_LIMIT = 3

export const MAX_PREDICTED = 300
export const MAX_OBSERVED = 400
export const MAX_LESSON = 300
export const MAX_ERROR_SUBJECT = 120

/**
 * Evidence kinds that show an outcome rather than repeating one.
 *
 * A note is what somebody said. The point of this record is that reality
 * disagreed, so a record supported only by talk is refused: an error that is
 * only reported is indistinguishable from an opinion.
 */
export const OBSERVED_KINDS: readonly Evidence['kind'][] = ['command', 'file', 'url']

export interface PredictionErrorInput {
  kind: PredictionErrorKind
  direction: PredictionErrorDirection
  subject: string
  predicted: string
  observed: string
  lesson?: string
  factId?: string
  /** Set when this error puts the objective, an acceptance item, or a priority in question. */
  revisit?: RevisitTarget
  scope?: string
}

export interface PredictionErrorProblem {
  code: string
  message: string
}

export function isPredictionErrorKind(value: unknown): value is PredictionErrorKind {
  return typeof value === 'string' && (PREDICTION_ERROR_KINDS as readonly string[]).includes(value)
}

export function isPredictionErrorDirection(value: unknown): value is PredictionErrorDirection {
  return (
    typeof value === 'string' && (PREDICTION_ERROR_DIRECTIONS as readonly string[]).includes(value)
  )
}

export function isRevisitTarget(value: unknown): value is RevisitTarget {
  return typeof value === 'string' && (REVISIT_TARGETS as readonly string[]).includes(value)
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Identity: the observation plus the takeaway.
 *
 * The same expectation differing the same way twice is one error, but a
 * correction is not a repeat: changing `lesson` or `factId` writes a new record
 * and the old one stays as history. The direction is part of the identity: a
 * positive and a negative residual with the same subject are different lessons.
 */
export function predictionErrorKey(error: {
  scope: string
  subject: string
  kind: string
  direction: string
  predicted: string
  observed: string
  lesson?: string
  factId?: string
  revisit?: string
}): string {
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
  ].join('\u0000')
}

/**
 * The write policy for an error record.
 *
 * It is deliberately stricter than a node's: a node may rest on the human's
 * word, an error may not. "It differed" is only worth recalling if something
 * other than the reporter showed it.
 */
export function checkPredictionError(input: {
  subject: string
  predicted: string
  observed: string
  direction: string
  lesson?: string
  revisit?: string
  evidence: readonly Evidence[]
}): PredictionErrorProblem | undefined {
  if (input.subject === '') {
    return { code: 'empty_subject', message: 'subject must not be empty' }
  }
  if (input.subject.length > MAX_ERROR_SUBJECT) {
    return { code: 'subject_too_long', message: `subject must be at most ${MAX_ERROR_SUBJECT} characters` }
  }
  if (!isPredictionErrorDirection(input.direction)) {
    return {
      code: 'unknown_direction',
      message: `direction must be one of ${PREDICTION_ERROR_DIRECTIONS.join(', ')}`,
    }
  }
  if (input.revisit !== undefined && !isRevisitTarget(input.revisit)) {
    return { code: 'unknown_revisit', message: `revisit must be one of ${REVISIT_TARGETS.join(', ')}` }
  }
  if (input.predicted === '') {
    return { code: 'empty_predicted', message: 'predicted must not be empty' }
  }
  if (input.predicted.length > MAX_PREDICTED) {
    return { code: 'predicted_too_long', message: `predicted must be at most ${MAX_PREDICTED} characters` }
  }
  if (input.observed === '') {
    return { code: 'empty_observed', message: 'observed must not be empty' }
  }
  if (input.observed.length > MAX_OBSERVED) {
    return { code: 'observed_too_long', message: `observed must be at most ${MAX_OBSERVED} characters` }
  }
  if (input.lesson !== undefined && input.lesson.length > MAX_LESSON) {
    return { code: 'lesson_too_long', message: `lesson must be at most ${MAX_LESSON} characters` }
  }
  if (input.evidence.length === 0) {
    return {
      code: 'evidence_required',
      message: 'a prediction error needs evidence for what actually happened; a guess is refused',
    }
  }
  if (!input.evidence.some((item) => OBSERVED_KINDS.includes(item.kind))) {
    return {
      code: 'observation_required',
      message:
        'note evidence alone is a report, not an observation: cite the command, file, or url ' +
        'that showed the difference',
    }
  }
  return undefined
}

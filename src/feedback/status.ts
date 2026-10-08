/**
 * Lifecycle of a feedback item:
 *
 *   RECEIVED -> ANALYZING -> DONE
 *                        \-> FAILED -> RECEIVED (explicit retry)
 *
 * The transitions themselves are enforced in FeedbackRepository as conditional
 * UPDATEs, so an item can never skip a state or be processed twice.
 */
export const FEEDBACK_STATUSES = ['RECEIVED', 'ANALYZING', 'DONE', 'FAILED'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

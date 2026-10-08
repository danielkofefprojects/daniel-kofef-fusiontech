import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { AnalysisResult } from '../analysis/schema.js';
import { hashContent } from './hash.js';
import type { FeedbackStatus } from './status.js';

export interface FeedbackRow {
  id: string;
  content: string;
  content_hash: string;
  status: FeedbackStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** A feedback row joined with its validated analysis (present only when DONE). */
export interface FeedbackWithAnalysisRow extends FeedbackRow {
  result_json: string | null;
}

export interface AttemptRow {
  id: string;
  feedback_id: string;
  attempt: number;
  model: string;
  raw_response: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
}

export type AttemptOutcome =
  | { ok: true; rawResponse: string; result: AnalysisResult }
  | { ok: false; rawResponse: string | null; error: string };

export interface ListOptions {
  status?: FeedbackStatus;
  /** Case-insensitive substring match on the feedback content. */
  q?: string;
  /** Sentiment of the validated analysis; items without an analysis never match. */
  sentiment?: 'positive' | 'neutral' | 'negative';
  limit: number;
  offset: number;
}

const now = () => new Date().toISOString();

const SELECT_WITH_ANALYSIS = `
  SELECT f.*, a.result_json
  FROM feedback f
  LEFT JOIN analysis_attempts a
    ON a.feedback_id = f.id
   AND a.attempt = (
     SELECT MAX(attempt) FROM analysis_attempts
     WHERE feedback_id = f.id AND result_json IS NOT NULL
   )
`;

export class FeedbackRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Inserts new feedback, or returns the existing item when identical content
   * was already submitted. The UNIQUE index on content_hash makes this safe
   * against concurrent duplicate submissions.
   */
  create(content: string): { feedback: FeedbackRow; created: boolean } {
    const hash = hashContent(content);
    const timestamp = now();
    return this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT INTO feedback (id, content, content_hash, status, created_at, updated_at)
           VALUES (?, ?, ?, 'RECEIVED', ?, ?)
           ON CONFLICT (content_hash) DO NOTHING`,
        )
        .run(randomUUID(), content, hash, timestamp, timestamp);
      const feedback = this.db
        .prepare('SELECT * FROM feedback WHERE content_hash = ?')
        .get(hash) as FeedbackRow;
      return { feedback, created: inserted.changes === 1 };
    })();
  }

  findById(id: string): FeedbackWithAnalysisRow | undefined {
    return this.db.prepare(`${SELECT_WITH_ANALYSIS} WHERE f.id = ?`).get(id) as
      | FeedbackWithAnalysisRow
      | undefined;
  }

  list({ status, q, sentiment, limit, offset }: ListOptions): { items: FeedbackWithAnalysisRow[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (status) {
      conditions.push('f.status = ?');
      params.push(status);
    }
    if (q) {
      // instr() avoids LIKE wildcard escaping; unicode_lower (see db.ts) folds case beyond ASCII.
      conditions.push('instr(unicode_lower(f.content), ?) > 0');
      params.push(q.toLowerCase());
    }
    if (sentiment) {
      conditions.push(`json_extract(a.result_json, '$.sentiment') = ?`);
      params.push(sentiment);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const items = this.db
      .prepare(`${SELECT_WITH_ANALYSIS} ${where} ORDER BY f.created_at DESC, f.rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as FeedbackWithAnalysisRow[];
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM (${SELECT_WITH_ANALYSIS} ${where})`)
      .get(...params) as { total: number };
    return { items, total };
  }

  listAttempts(feedbackId: string): AttemptRow[] {
    return this.db
      .prepare('SELECT * FROM analysis_attempts WHERE feedback_id = ? ORDER BY attempt')
      .all(feedbackId) as AttemptRow[];
  }

  /**
   * RECEIVED -> ANALYZING. Returns the claimed row, or undefined if the item
   * is not in RECEIVED (already claimed, finished, or unknown), in which case
   * the caller must not analyze it.
   */
  claimForAnalysis(id: string): FeedbackRow | undefined {
    return this.db
      .prepare(
        `UPDATE feedback
         SET status = 'ANALYZING', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'RECEIVED'
         RETURNING *`,
      )
      .get(now(), id) as FeedbackRow | undefined;
  }

  /**
   * ANALYZING -> DONE | FAILED, recording the attempt in the same transaction
   * so the status and the stored analysis can never disagree.
   */
  completeAttempt(feedback: FeedbackRow, model: string, outcome: AttemptOutcome): void {
    const timestamp = now();
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE feedback
           SET status = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND status = 'ANALYZING' AND attempts = ?`,
        )
        .run(
          outcome.ok ? 'DONE' : 'FAILED',
          outcome.ok ? null : outcome.error,
          timestamp,
          feedback.id,
          feedback.attempts,
        );
      if (updated.changes !== 1) {
        throw new Error(`Feedback ${feedback.id} is no longer in ANALYZING for attempt ${feedback.attempts}`);
      }
      this.db
        .prepare(
          `INSERT INTO analysis_attempts
             (id, feedback_id, attempt, model, raw_response, result_json, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          feedback.id,
          feedback.attempts,
          model,
          outcome.rawResponse,
          outcome.ok ? JSON.stringify(outcome.result) : null,
          outcome.ok ? null : outcome.error,
          timestamp,
        );
    })();
  }

  /** FAILED -> RECEIVED. Returns false if the item is not currently FAILED. */
  requeueFailed(id: string): boolean {
    const updated = this.db
      .prepare(
        `UPDATE feedback SET status = 'RECEIVED', last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'FAILED'`,
      )
      .run(now(), id);
    return updated.changes === 1;
  }

  /**
   * Called once at startup. Items left in ANALYZING belong to a process that
   * died mid-request, so they go back to RECEIVED; the interrupted attempt
   * keeps its number and simply has no attempt row. Returns every item
   * waiting for analysis, oldest first.
   */
  recoverPending(): string[] {
    return this.db.transaction(() => {
      this.db
        .prepare(`UPDATE feedback SET status = 'RECEIVED', updated_at = ? WHERE status = 'ANALYZING'`)
        .run(now());
      const rows = this.db
        .prepare(`SELECT id FROM feedback WHERE status = 'RECEIVED' ORDER BY created_at, rowid`)
        .all() as { id: string }[];
      return rows.map((row) => row.id);
    })();
  }
}

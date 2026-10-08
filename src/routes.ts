import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AnalysisQueue } from './analysis/queue.js';
import type { AnalysisResult } from './analysis/schema.js';
import type { AttemptRow, FeedbackRepository, FeedbackWithAnalysisRow, FeedbackRow } from './feedback/repository.js';
import { FEEDBACK_STATUSES } from './feedback/status.js';

export const MAX_CONTENT_LENGTH = 5000;

const submitBodySchema = z.strictObject({
  content: z
    .string()
    .max(MAX_CONTENT_LENGTH)
    .refine((value) => value.trim().length > 0, 'must not be empty'),
});

const listQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function badRequest(reply: FastifyReply, error: z.ZodError) {
  const details = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return reply.code(400).send({ error: 'Invalid request', details });
}

function toFeedbackDto(row: FeedbackRow & { result_json?: string | null }) {
  return {
    id: row.id,
    content: row.content,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    analysis: row.result_json ? (JSON.parse(row.result_json) as AnalysisResult) : null,
  };
}

function toAttemptDto(row: AttemptRow) {
  return {
    attempt: row.attempt,
    model: row.model,
    raw_response: row.raw_response,
    result: row.result_json ? (JSON.parse(row.result_json) as AnalysisResult) : null,
    error: row.error,
    created_at: row.created_at,
  };
}

export function registerRoutes(
  app: FastifyInstance,
  { repository, queue }: { repository: FeedbackRepository; queue: AnalysisQueue },
): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/feedback', async (request, reply) => {
    const body = submitBodySchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);

    const { feedback, created } = repository.create(body.data.content);
    if (!created) {
      // Identical content was submitted before: return that item (with its
      // analysis, if finished) instead of paying for another LLM call.
      const existing = repository.findById(feedback.id) as FeedbackWithAnalysisRow;
      return reply.code(200).send({ ...toFeedbackDto(existing), duplicate: true });
    }
    queue.enqueue(feedback.id);
    return reply.code(201).send({ ...toFeedbackDto(feedback), duplicate: false });
  });

  app.get('/feedback', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return badRequest(reply, query.error);

    const { items, total } = repository.list(query.data);
    return { items: items.map(toFeedbackDto), total, limit: query.data.limit, offset: query.data.offset };
  });

  app.get<{ Params: { id: string } }>('/feedback/:id', async (request, reply) => {
    const feedback = repository.findById(request.params.id);
    if (!feedback) return reply.code(404).send({ error: 'Feedback not found' });
    return {
      ...toFeedbackDto(feedback),
      attempt_history: repository.listAttempts(feedback.id).map(toAttemptDto),
    };
  });

  app.post<{ Params: { id: string } }>('/feedback/:id/retry', async (request, reply) => {
    const { id } = request.params;
    if (!repository.requeueFailed(id)) {
      const feedback = repository.findById(id);
      if (!feedback) return reply.code(404).send({ error: 'Feedback not found' });
      return reply
        .code(409)
        .send({ error: `Only FAILED feedback can be retried; current status is ${feedback.status}` });
    }
    queue.enqueue(id);
    return reply.code(202).send(toFeedbackDto(repository.findById(id) as FeedbackWithAnalysisRow));
  });
}

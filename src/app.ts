import Fastify from 'fastify';
import { Analyzer } from './analysis/analyzer.js';
import type { LlmClient } from './analysis/llmClient.js';
import { AnalysisQueue } from './analysis/queue.js';
import type { Db } from './db.js';
import { FeedbackRepository } from './feedback/repository.js';
import { registerRoutes } from './routes.js';

export interface AppOptions {
  db: Db;
  llmClient: LlmClient;
  analysisConcurrency?: number;
  logger?: boolean;
}

export function buildApp({ db, llmClient, analysisConcurrency = 2, logger = false }: AppOptions) {
  const app = Fastify({ logger });
  // One error shape for everything: { error, details? }. Client errors Fastify
  // raises itself (malformed JSON, wrong content type) are reported as such;
  // anything else is logged and hidden behind a generic 500.
  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'Internal server error' });
    }
    return reply.code(status).send({ error: 'Invalid request', details: [err.message] });
  });
  const repository = new FeedbackRepository(db);
  const analyzer = new Analyzer(repository, llmClient);
  const queue = new AnalysisQueue(
    (feedbackId) => analyzer.analyze(feedbackId),
    analysisConcurrency,
    // The analyzer turns LLM failures into FAILED itself, so reaching this
    // means the outcome could not be persisted. The item stays ANALYZING
    // and is recovered on the next startup.
    (feedbackId, err) => app.log.error({ err, feedbackId }, 'analysis attempt could not be recorded'),
  );
  registerRoutes(app, { repository, queue });
  return { app, repository, queue };
}

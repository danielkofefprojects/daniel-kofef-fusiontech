import { GroqLlmClient } from './analysis/llmClient.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const llmClient = new GroqLlmClient({
  apiKey: config.groqApiKey,
  model: config.groqModel,
  timeoutMs: config.llmTimeoutMs,
  maxRetries: config.llmMaxRetries,
});
const { app, repository, queue } = buildApp({
  db,
  llmClient,
  analysisConcurrency: config.analysisConcurrency,
  logger: true,
});

// The queue lives in memory, so work that was queued or in flight when the
// previous process exited is picked up again from the database.
const pending = repository.recoverPending();
for (const feedbackId of pending) queue.enqueue(feedbackId);
if (pending.length > 0) app.log.info({ count: pending.length }, 'recovered pending feedback');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  queue.stop();
  await queue.onIdle();
  db.close();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });

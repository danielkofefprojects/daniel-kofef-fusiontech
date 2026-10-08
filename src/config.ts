export interface Config {
  host: string;
  port: number;
  dbPath: string;
  groqApiKey: string;
  groqModel: string;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  analysisConcurrency: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const groqApiKey = env.GROQ_API_KEY;
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY is not set. Copy .env.example to .env and fill it in.');
  }
  return {
    host: env.HOST || '127.0.0.1',
    port: intFromEnv(env, 'PORT', 3000, 1),
    dbPath: env.DB_PATH || './data/feedback.db',
    groqApiKey,
    groqModel: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    llmTimeoutMs: intFromEnv(env, 'LLM_TIMEOUT_MS', 20_000, 1),
    llmMaxRetries: intFromEnv(env, 'LLM_MAX_RETRIES', 2, 0),
    analysisConcurrency: intFromEnv(env, 'ANALYSIS_CONCURRENCY', 2, 1),
  };
}

import { describe, expect, it } from 'vitest';
import { GroqLlmClient } from '../src/analysis/llmClient.js';
import { AnalysisQueue } from '../src/analysis/queue.js';
import { loadConfig } from '../src/config.js';
import { Analyzer } from '../src/analysis/analyzer.js';
import { openDb } from '../src/db.js';
import { FeedbackRepository } from '../src/feedback/repository.js';
import { FakeLlmClient, VALID_ANALYSIS, createTestApp } from './helpers.js';

const submit = (app: ReturnType<typeof createTestApp>['app'], content: unknown) =>
  app.inject({ method: 'POST', url: '/feedback', payload: { content } });

describe('AnalysisQueue', () => {
  it('never runs more than the concurrency cap and drops queued ids on stop()', async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const queue = new AnalysisQueue(
      (id) => {
        started.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((resolve) => releases.push(() => { active--; resolve(); }));
      },
      2,
      () => {},
    );
    ['a', 'b', 'c', 'd'].forEach((id) => queue.enqueue(id));
    expect(started).toEqual(['a', 'b']);

    queue.stop();
    queue.enqueue('e');
    const idle = queue.onIdle();
    releases.forEach((release) => release());
    await idle;

    expect(started).toEqual(['a', 'b']);
    expect(maxActive).toBe(2);
  });

  it('reports worker errors and keeps going', async () => {
    const errors: string[] = [];
    const done: string[] = [];
    const queue = new AnalysisQueue(
      async (id) => { if (id === 'bad') throw new Error('boom'); done.push(id); },
      1,
      (id) => errors.push(id),
    );
    queue.enqueue('bad');
    queue.enqueue('good');
    await queue.onIdle();
    expect(errors).toEqual(['bad']);
    expect(done).toEqual(['good']);
  });
});

describe('loadConfig', () => {
  it('requires GROQ_API_KEY and applies defaults', () => {
    expect(() => loadConfig({})).toThrow(/GROQ_API_KEY/);
    expect(loadConfig({ GROQ_API_KEY: 'k' })).toMatchObject({
      port: 3000, groqModel: 'openai/gpt-oss-120b', llmMaxRetries: 2, analysisConcurrency: 2,
    });
  });

  it('rejects invalid numbers', () => {
    expect(() => loadConfig({ GROQ_API_KEY: 'k', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ GROQ_API_KEY: 'k', ANALYSIS_CONCURRENCY: '0' })).toThrow(/ANALYSIS_CONCURRENCY/);
    expect(loadConfig({ GROQ_API_KEY: 'k', LLM_MAX_RETRIES: '0' }).llmMaxRetries).toBe(0);
  });
});

describe('GroqLlmClient', () => {
  const clientReturning = (choice: unknown) =>
    ({ chat: { completions: { create: async () => ({ choices: [choice] }) } } }) as never;
  const make = (choice: unknown) =>
    new GroqLlmClient({ apiKey: 'k', model: 'm', timeoutMs: 1, maxRetries: 0, client: clientReturning(choice) });

  it('returns the message content', async () => {
    const llm = make({ finish_reason: 'stop', message: { content: '{"a":1}' } });
    await expect(llm.complete({ system: 's', user: 'u' })).resolves.toBe('{"a":1}');
  });

  it('throws when there is no content or the output was truncated', async () => {
    await expect(make({ finish_reason: 'stop', message: { content: null } }).complete({ system: 's', user: 'u' }))
      .rejects.toThrow(/no message content/);
    await expect(make({ finish_reason: 'length', message: { content: '{"sent' } }).complete({ system: 's', user: 'u' }))
      .rejects.toThrow(/truncated/);
  });
});

describe('Analyzer error handling', () => {
  it('truncates stored errors to 1000 characters but keeps the full raw response', async () => {
    const repository = new FeedbackRepository(openDb(':memory:'));
    const raw = 'x'.repeat(5000);
    const { feedback } = repository.create('hello');
    await new Analyzer(repository, new FakeLlmClient(new Error('e'.repeat(3000)))).analyze(feedback.id);
    expect(repository.findById(feedback.id)!.last_error!.length).toBe(1000);

    const second = repository.create('world').feedback;
    await new Analyzer(repository, new FakeLlmClient(raw)).analyze(second.id);
    expect(repository.listAttempts(second.id)[0]!.raw_response).toBe(raw);
  });
});

describe('HTTP edge cases', () => {
  it('serves /health and 404s for unknown ids', async () => {
    const { app } = createTestApp();
    expect((await app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/feedback/nope' })).statusCode).toBe(404);
  });

  it('returns the failed item for a duplicate of a FAILED item without re-analyzing', async () => {
    const llm = new FakeLlmClient('not json');
    const { app, queue } = createTestApp(llm);
    await submit(app, 'broken one');
    await queue.onIdle();
    const dup = await submit(app, 'Broken   One');
    await queue.onIdle();
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ duplicate: true, status: 'FAILED' });
    expect(llm.requests).toHaveLength(1);
  });

  it('returns the in-flight item for a duplicate submitted during analysis', async () => {
    let release!: (raw: string) => void;
    const llm = new FakeLlmClient(() => new Promise<string>((resolve) => (release = resolve)));
    const { app, queue } = createTestApp(llm);
    const first = await submit(app, 'slow one');
    const dup = await submit(app, 'slow one');
    expect(dup.json()).toMatchObject({ id: first.json().id, duplicate: true, status: 'ANALYZING' });
    release(JSON.stringify(VALID_ANALYSIS));
    await queue.onIdle();
    expect(llm.requests).toHaveLength(1);
  });

  it('searches without treating LIKE wildcards specially and folds non-ASCII case', async () => {
    const { app, queue } = createTestApp();
    await submit(app, '100% great');
    await submit(app, 'Ünïcode Über feature');
    await queue.onIdle();
    const names = async (q: string) =>
      (await app.inject({ url: `/feedback?q=${encodeURIComponent(q)}` })).json().items.map((i: { content: string }) => i.content);
    expect(await names('%')).toEqual(['100% great']);
    expect(await names('_')).toEqual([]);
    expect(await names('üBER')).toEqual(['Ünïcode Über feature']);
  });

  it('rejects an empty or whitespace-only q, and ignores unknown query params', async () => {
    const { app } = createTestApp();
    const bad = await app.inject({ url: '/feedback?q=%20%20' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'Invalid request', details: [expect.stringContaining('q:')] });
    expect((await app.inject({ url: '/feedback?whatever=1' })).statusCode).toBe(200);
  });

  it('sentiment filter excludes items without an analysis', async () => {
    const { app, queue } = createTestApp(new FakeLlmClient('not json'));
    await submit(app, 'no analysis');
    await queue.onIdle();
    const res = (await app.inject({ url: '/feedback?sentiment=positive' })).json();
    expect(res.total).toBe(0);
  });
});

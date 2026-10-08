import { describe, expect, it } from 'vitest';
import { AnalysisQueue } from '../src/analysis/queue.js';
import { loadConfig } from '../src/config.js';
import { FakeLlmClient, createTestApp } from './helpers.js';

describe('error responses', () => {
  it('reports malformed JSON in the same shape as validation errors', async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid request', details: [expect.any(String)] });
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['offset=-1', 'offset'],
    ['status=NOPE', 'status'],
    ['sentiment=happy', 'sentiment'],
  ])('rejects invalid list query %s', async (qs, field) => {
    const { app } = createTestApp();
    const response = await app.inject({ url: `/feedback?${qs}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().details[0]).toContain(field);
  });
});

describe('GET /feedback filters', () => {
  it('matches q case-insensitively, combines filters, and ignores LIKE wildcards', async () => {
    const { app, queue } = createTestApp(new FakeLlmClient(new Error('boom')));
    for (const content of ['Add DARK mode', '100% broken', 'Export is slow']) {
      await app.inject({ method: 'POST', url: '/feedback', payload: { content } });
    }
    await queue.onIdle();

    const list = async (qs: string) => (await app.inject({ url: `/feedback?${qs}` })).json();
    expect((await list('q=dark')).total).toBe(1);
    expect((await list('q=%25')).total).toBe(1); // literal "%", not a wildcard
    expect((await list('q=dark&status=FAILED')).total).toBe(1);
    expect((await list('q=dark&status=DONE')).total).toBe(0);
    // Failed items have no analysis, so a sentiment filter excludes them.
    expect((await list('sentiment=positive')).total).toBe(0);
    const paged = await list('limit=2&offset=2');
    expect(paged).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(paged.items).toHaveLength(1);
  });
});

describe('AnalysisQueue', () => {
  it('never runs more than the concurrency limit and drains everything', async () => {
    let running = 0;
    let peak = 0;
    const done: string[] = [];
    const queue = new AnalysisQueue(
      async (id) => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        done.push(id);
      },
      2,
      () => {},
    );
    for (const id of ['a', 'b', 'c', 'd', 'e']) queue.enqueue(id);
    await queue.onIdle();
    expect(peak).toBe(2);
    expect(done.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('reports worker errors and keeps processing', async () => {
    const errors: string[] = [];
    const done: string[] = [];
    const queue = new AnalysisQueue(
      async (id) => {
        if (id === 'bad') throw new Error('nope');
        done.push(id);
      },
      1,
      (id) => errors.push(id),
    );
    for (const id of ['bad', 'good']) queue.enqueue(id);
    await queue.onIdle();
    expect(errors).toEqual(['bad']);
    expect(done).toEqual(['good']);
  });

  it('stop() drops queued ids, ignores new ones, and waits for in-flight work', async () => {
    let release!: () => void;
    const started: string[] = [];
    const queue = new AnalysisQueue(
      (id) => {
        started.push(id);
        return new Promise<void>((r) => (release = r));
      },
      1,
      () => {},
    );
    queue.enqueue('first');
    queue.enqueue('second');
    queue.stop();
    queue.enqueue('third');

    let idle = false;
    void queue.onIdle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(idle).toBe(false);
    release();
    await queue.onIdle();
    expect(started).toEqual(['first']);
  });
});

describe('loadConfig', () => {
  const base = { GROQ_API_KEY: 'k' };

  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      llmMaxRetries: 2,
      analysisConcurrency: 2,
    });
  });

  it('reads HOST and numeric overrides', () => {
    expect(loadConfig({ ...base, HOST: '0.0.0.0', PORT: '8080', LLM_MAX_RETRIES: '0' })).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      llmMaxRetries: 0,
    });
  });

  it('requires an API key and rejects bad numbers', () => {
    expect(() => loadConfig({})).toThrow(/GROQ_API_KEY/);
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, ANALYSIS_CONCURRENCY: '0' })).toThrow(/ANALYSIS_CONCURRENCY/);
  });
});

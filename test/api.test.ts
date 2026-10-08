import { describe, expect, it } from 'vitest';
import { FakeLlmClient, VALID_ANALYSIS, createTestApp } from './helpers.js';

const submit = (app: ReturnType<typeof createTestApp>['app'], content: unknown) =>
  app.inject({ method: 'POST', url: '/feedback', payload: { content } });

describe('POST /feedback', () => {
  it('responds before analysis has run, then the item moves RECEIVED -> ANALYZING -> DONE', async () => {
    let release!: (raw: string) => void;
    const llm = new FakeLlmClient(() => new Promise<string>((resolve) => (release = resolve)));
    const { app, queue } = createTestApp(llm);

    const created = await submit(app, 'Love it, please add dark mode');
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'RECEIVED', analysis: null, duplicate: false });
    const { id } = created.json();

    // The LLM call is still pending.
    const inFlight = await app.inject({ url: `/feedback/${id}` });
    expect(inFlight.json()).toMatchObject({ status: 'ANALYZING', attempts: 1, analysis: null });

    release(JSON.stringify(VALID_ANALYSIS));
    await queue.onIdle();

    const done = await app.inject({ url: `/feedback/${id}` });
    expect(done.json()).toMatchObject({ status: 'DONE', last_error: null, analysis: VALID_ANALYSIS });
    expect(done.json().attempt_history).toEqual([
      expect.objectContaining({
        attempt: 1,
        model: 'fake-model',
        raw_response: JSON.stringify(VALID_ANALYSIS),
        result: VALID_ANALYSIS,
        error: null,
      }),
    ]);
  });

  it.each([
    ['missing content', {}],
    ['non-string content', { content: 42 }],
    ['blank content', { content: '   ' }],
    ['oversized content', { content: 'x'.repeat(5001) }],
    ['unknown field', { content: 'ok', extra: true }],
  ])('rejects %s with 400', async (_name, payload) => {
    const llm = new FakeLlmClient();
    const { app, queue } = createTestApp(llm);
    const response = await app.inject({ method: 'POST', url: '/feedback', payload });
    await queue.onIdle();
    expect(response.statusCode).toBe(400);
    expect(llm.requests).toHaveLength(0);
  });

  it('deduplicates identical feedback and does not call the LLM again', async () => {
    const llm = new FakeLlmClient();
    const { app, queue } = createTestApp(llm);

    const first = await submit(app, 'Please add dark mode');
    await queue.onIdle();
    const second = await submit(app, '  please   ADD dark mode\n');
    await queue.onIdle();

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      id: first.json().id,
      duplicate: true,
      status: 'DONE',
      analysis: VALID_ANALYSIS,
    });
    expect(llm.requests).toHaveLength(1);
    const list = await app.inject({ url: '/feedback' });
    expect(list.json().total).toBe(1);
  });
});

describe('GET /feedback', () => {
  it('lists newest first with status and analysis, and supports filtering and paging', async () => {
    const llm = new FakeLlmClient(JSON.stringify(VALID_ANALYSIS), 'not json');
    const { app, queue } = createTestApp(llm);
    await submit(app, 'first');
    await queue.onIdle();
    await submit(app, 'second');
    await queue.onIdle();

    const all = (await app.inject({ url: '/feedback' })).json();
    expect(all.total).toBe(2);
    expect(all.items.map((item: { content: string }) => item.content)).toEqual(['second', 'first']);
    expect(all.items[0]).toMatchObject({ status: 'FAILED', analysis: null });
    expect(all.items[1]).toMatchObject({ status: 'DONE', analysis: VALID_ANALYSIS });

    const failed = (await app.inject({ url: '/feedback?status=FAILED' })).json();
    expect(failed.items).toHaveLength(1);
    expect(failed.total).toBe(1);

    const page = (await app.inject({ url: '/feedback?limit=1&offset=1' })).json();
    expect(page.items.map((item: { content: string }) => item.content)).toEqual(['first']);

    const search = (await app.inject({ url: '/feedback?q=FIR' })).json();
    expect(search.items.map((item: { content: string }) => item.content)).toEqual(['first']);
    expect(search.total).toBe(1);

    const sentiment = (await app.inject({ url: `/feedback?sentiment=${VALID_ANALYSIS.sentiment}` })).json();
    expect(sentiment.items.map((item: { content: string }) => item.content)).toEqual(['first']);
    const other = VALID_ANALYSIS.sentiment === 'negative' ? 'positive' : 'negative';
    expect((await app.inject({ url: `/feedback?sentiment=${other}` })).json().total).toBe(0);

    expect((await app.inject({ url: '/feedback?sentiment=happy' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/feedback?status=NOPE' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/feedback?limit=0' })).statusCode).toBe(400);
  });
});

describe('POST /feedback/:id/retry', () => {
  it('re-runs a FAILED analysis and keeps both attempts', async () => {
    const llm = new FakeLlmClient('not json', JSON.stringify(VALID_ANALYSIS));
    const { app, queue } = createTestApp(llm);
    const { id } = (await submit(app, 'Checkout is slow')).json();
    await queue.onIdle();

    const retry = await app.inject({ method: 'POST', url: `/feedback/${id}/retry` });
    expect(retry.statusCode).toBe(202);
    await queue.onIdle();

    const item = (await app.inject({ url: `/feedback/${id}` })).json();
    expect(item).toMatchObject({ status: 'DONE', attempts: 2, last_error: null, analysis: VALID_ANALYSIS });
    expect(item.attempt_history).toHaveLength(2);
    expect(item.attempt_history[0]).toMatchObject({ attempt: 1, raw_response: 'not json', result: null });
    expect(item.attempt_history[1]).toMatchObject({ attempt: 2, result: VALID_ANALYSIS, error: null });
  });

  it('returns 409 for feedback that is not FAILED and 404 for unknown ids', async () => {
    const llm = new FakeLlmClient();
    const { app, queue } = createTestApp(llm);
    const { id } = (await submit(app, 'All good')).json();
    await queue.onIdle();

    expect((await app.inject({ method: 'POST', url: `/feedback/${id}/retry` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/feedback/nope/retry' })).statusCode).toBe(404);
    await queue.onIdle();
    expect(llm.requests).toHaveLength(1);
  });
});

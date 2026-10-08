import type { LlmClient, LlmRequest } from '../src/analysis/llmClient.js';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

export const VALID_ANALYSIS = {
  sentiment: 'positive',
  feature_requests: [{ title: 'Add dark mode', confidence: 0.9 }],
  actionable_insight: 'Prioritise a dark theme.',
};

type Reply = string | Error | (() => Promise<string>);

/** Scripted LLM: each call consumes the next reply; the last one repeats. */
export class FakeLlmClient implements LlmClient {
  readonly model = 'fake-model';
  readonly requests: LlmRequest[] = [];
  private readonly replies: Reply[];

  constructor(...replies: Reply[]) {
    this.replies = replies.length > 0 ? replies : [JSON.stringify(VALID_ANALYSIS)];
  }

  async complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  }
}

export function createTestApp(llmClient: LlmClient = new FakeLlmClient()) {
  const db = openDb(':memory:');
  return { db, ...buildApp({ db, llmClient }) };
}

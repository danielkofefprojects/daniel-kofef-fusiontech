import type { AttemptOutcome, FeedbackRepository } from '../feedback/repository.js';
import type { LlmClient } from './llmClient.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { parseAnalysis } from './schema.js';

const MAX_ERROR_LENGTH = 1000;

export class Analyzer {
  private readonly repository: FeedbackRepository;
  private readonly llm: LlmClient;

  constructor(repository: FeedbackRepository, llm: LlmClient) {
    this.repository = repository;
    this.llm = llm;
  }

  /**
   * Runs one analysis attempt. Every outcome of the LLM call, including a
   * thrown error or malformed output, ends in a persisted DONE or FAILED.
   */
  async analyze(feedbackId: string): Promise<void> {
    const feedback = this.repository.claimForAnalysis(feedbackId);
    if (!feedback) return;

    let outcome: AttemptOutcome;
    try {
      const rawResponse = await this.llm.complete({
        system: SYSTEM_PROMPT,
        user: buildUserMessage(feedback.content),
      });
      const parsed = parseAnalysis(rawResponse);
      outcome = parsed.ok
        ? { ok: true, rawResponse, result: parsed.result }
        : { ok: false, rawResponse, error: parsed.error };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = { ok: false, rawResponse: null, error: `LLM request failed: ${message}` };
    }

    if (!outcome.ok) outcome.error = outcome.error.slice(0, MAX_ERROR_LENGTH);
    this.repository.completeAttempt(feedback, this.llm.model, outcome);
  }
}

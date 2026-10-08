import Groq from 'groq-sdk';

export interface LlmRequest {
  system: string;
  user: string;
}

/** Returns the model's raw text output, or throws if no output was obtained. */
export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<string>;
}

export interface GroqLlmClientOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /** Test seam; defaults to a real Groq SDK client. */
  client?: Pick<Groq, 'chat'>;
}

export class GroqLlmClient implements LlmClient {
  readonly model: string;
  private readonly client: Pick<Groq, 'chat'>;

  constructor({ apiKey, model, timeoutMs, maxRetries, client }: GroqLlmClientOptions) {
    this.model = model;
    // The SDK retries connection errors, 408, 409, 429 and 5xx with backoff.
    this.client = client ?? new Groq({ apiKey, timeout: timeoutMs, maxRetries });
  }

  async complete({ system, user }: LlmRequest): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      // Also has to cover reasoning tokens on reasoning models.
      max_completion_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const choice = completion.choices[0];
    // A cut-off reply would otherwise surface as a confusing "not valid JSON".
    if (choice?.finish_reason === 'length') {
      throw new Error('LLM output was truncated (hit the max_completion_tokens limit)');
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM response contained no message content');
    }
    return content;
  }
}

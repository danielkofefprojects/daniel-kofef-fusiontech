import { z } from 'zod';

/**
 * The contract the LLM output must satisfy. Objects are strict (unknown keys
 * are rejected) and nothing is coerced: output that does not match is a
 * failed analysis, not something to repair.
 */
export const analysisResultSchema = z.strictObject({
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  feature_requests: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(200),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(20),
  actionable_insight: z.string().min(1).max(2000),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export type ParsedAnalysis = { ok: true; result: AnalysisResult } | { ok: false; error: string };

export function parseAnalysis(raw: string): ParsedAnalysis {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `LLM output is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = analysisResultSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, error: `LLM output does not match the analysis schema: ${issues}` };
  }
  return { ok: true, result: parsed.data };
}

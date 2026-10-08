import { createHash } from 'node:crypto';

/** Feedback that differs only by case, surrounding or repeated whitespace is treated as identical. */
export function normalizeContent(content: string): string {
  return content.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashContent(content: string): string {
  return createHash('sha256').update(normalizeContent(content)).digest('hex');
}

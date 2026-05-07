/**
 * Heuristic question-mode classifier — decides whether a chat question
 * belongs in "ask" mode (single answer) or "investigate" mode (multi-step
 * causal exploration).
 *
 * Frontend-only, regex-based. No AI tokens. Fast enough to run on every
 * keystroke if needed. ~80% accurate on the common cases:
 *
 *   "What's our revenue this month?"        → ask
 *   "Why did revenue drop last month?"      → investigate
 *   "How many customers do we have?"        → ask
 *   "What caused the spike in returns?"     → investigate
 *
 * Edge cases the heuristic intentionally lets through as "ask":
 *   "How has revenue changed?"     ← could be either; ask is the safer
 *                                     default since it's faster + cheaper
 *   "Show me X over time"          ← descriptive, not causal
 *
 * Users can always override via the mode toggle next to the input.
 */

export type QuestionMode = 'ask' | 'investigate';

/**
 * Words/phrases that strongly signal causal investigation.
 * Anchored to the start when possible to reduce false positives in
 * descriptive questions that happen to mention 'why' mid-sentence.
 */
const INVESTIGATE_PATTERNS: RegExp[] = [
  /^why\b/i,                              // "Why did..."
  /^how come\b/i,                         // "How come..."
  /^what (caused|drove|led to)\b/i,       // "What caused..."
  /^what'?s (behind|driving|causing)\b/i, // "What's behind..."
  /^explain why\b/i,                      // "Explain why..."
  /^investigate\b/i,                      // "Investigate..."
  /^find out why\b/i,                     // "Find out why..."
  /^tell me why\b/i,                      // "Tell me why..."

  // Mid-sentence causal phrasings — slightly more permissive
  /\bwhy did .+ (drop|fall|rise|spike|jump|crash|change)/i,
  /\b(reason|cause|root cause) for\b/i,
  /\bwhat (made|made our) /i,
];

/**
 * Classify a user question.
 *
 * Returns 'investigate' only when at least one strong causal pattern matches.
 * Otherwise defaults to 'ask' — the fast, cheap, single-answer flow.
 */
export function classifyQuestion(question: string): QuestionMode {
  const trimmed = question.trim();
  if (!trimmed) return 'ask';
  for (const pattern of INVESTIGATE_PATTERNS) {
    if (pattern.test(trimmed)) return 'investigate';
  }
  return 'ask';
}

/**
 * Friendly label for the mode badge under the chat input.
 */
export function modeLabel(mode: QuestionMode): string {
  return mode === 'investigate' ? 'Investigate mode' : 'Ask mode';
}

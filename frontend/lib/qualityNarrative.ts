/**
 * Compaction for `quality_alerts.ai_context` — Claude's plain-English
 * explanation rendered under quality alert titles.
 *
 * Background: an earlier prompt produced multi-paragraph output with
 * `**Business Impact:**` / `**Action Required:**` markdown labels.
 * The frontend doesn't render markdown, so users saw literal asterisks
 * + 80-word paragraphs taking up half the screen.
 *
 * The prompt has since been tightened to demand one short sentence with
 * no markdown. This helper handles two cases:
 *   1. New alerts (good prompt) — passes through cleanly.
 *   2. Existing alerts in the DB (long markdown-laden context) —
 *      strips the labels and trims to the first sentence so they
 *      display as compactly as the new ones.
 *
 * Both render sites (Home AttentionSection + QualityAlertBanner) call
 * this so the two surfaces stay consistent.
 */

const MAX_CHARS = 180;

export function compactNarrative(text: string | null | undefined): string | null {
  if (!text) return null;
  let cleaned = String(text)
    // Drop markdown bold labels like **Business Impact:** or **Action Required:**
    // (non-greedy match between the asterisks; tolerates colons + whitespace
    // afterwards). Run twice in case there are multiple labels.
    .replace(/\*\*[^*]+?\*\*\s*:?\s*/g, '')
    .replace(/\*\*[^*]+?\*\*\s*:?\s*/g, '')
    // Collapse any remaining stray asterisks
    .replace(/\*+/g, '')
    // Normalise whitespace
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  // Take the first sentence. We split on a sentence-ending punctuation
  // followed by whitespace + capital letter (or markdown-style label,
  // already stripped). Falls back to the whole string if there's only
  // one sentence.
  const m = cleaned.match(/^[^.!?]+[.!?]/);
  if (m) cleaned = m[0].trim();

  // Hard cap as a last-resort safety net for edge cases (no punctuation,
  // run-on sentence, etc).
  if (cleaned.length > MAX_CHARS) {
    cleaned = cleaned.slice(0, MAX_CHARS - 1).trim() + '…';
  }
  return cleaned;
}

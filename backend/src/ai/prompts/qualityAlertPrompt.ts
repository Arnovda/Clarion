export const QUALITY_ALERT_SYSTEM = `You are a data quality advisor writing one short note for a busy executive.

OUTPUT RULES (strict):
- ONE sentence only. Max 25 words. Period.
- Plain prose only. NO markdown — no asterisks, no **Business Impact:**, no **Action Required:**, no labels of any kind.
- NO bullet points, NO numbered lists, NO multi-paragraph structure.
- Lead with the concrete business consequence, not the technical symptom.
- Never mention SQL, pass rates, thresholds, percentages, or technical column names.

Examples of GOOD output:
- "Roughly a third of customer records are missing emails, so password resets and order confirmations won't reach them."
- "Order amounts contain duplicate entries, which is inflating revenue figures across reports."
- "A supplier price drift is quietly eating margin on dry goods this month."

Examples of BAD output (DO NOT produce these):
- "**Business Impact:** Customer accounts are missing email addresses..." (markdown labels banned)
- "Customer accounts are missing emails. This means you cannot... Action Required: Audit..." (multiple sentences banned)`;

export interface QualityAlertInput {
  alertType: 'score_drop' | 'rule_fail';
  tableName: string;
  currentScore?: number;
  previousScore?: number;
  drop?: number;
  ruleName?: string;
  ruleType?: string;
}

export function buildQualityAlertUser(input: QualityAlertInput): string {
  if (input.alertType === 'rule_fail') {
    return `Table: "${input.tableName}". Rule "${input.ruleName}" (type: ${input.ruleType ?? 'unknown'}) is failing. Explain the business impact and what to do.`;
  }
  const dropText = input.drop != null ? `, a drop of ${Math.round(input.drop * 100)} percentage points` : '';
  const prev = input.previousScore != null ? ` (previously ${Math.round(input.previousScore * 100)}%)` : '';
  return `Table: "${input.tableName}". Overall data quality score is ${Math.round((input.currentScore ?? 0) * 100)}%${prev}${dropText}. Explain the business impact and what to do.`;
}

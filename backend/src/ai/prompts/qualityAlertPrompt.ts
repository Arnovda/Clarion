export const QUALITY_ALERT_SYSTEM = `You are a data quality advisor writing for a non-technical business audience.
Write exactly 2 sentences:
1. What the problem means for the business in plain language.
2. The single most important action to take.
Never mention SQL, pass rates, thresholds, or technical column names.`;

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

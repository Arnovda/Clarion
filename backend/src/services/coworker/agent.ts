/**
 * The Studio coworker's loop: one message in, a stream of what it is doing out.
 *
 * Shape (Genie's, deliberately): the model narrates in one short sentence
 * before each tool it uses — that is what the panel shows as "thinking" —
 * then the tool runs, the step settles, and the screen follows to whatever it
 * opened. A proposal is streamed the moment it is ready; the person decides
 * on it while the turn finishes.
 *
 * The cost rules are structural (owner, 2026-09-24: "no extra cost against
 * what we spend on AI today"):
 *   - the loop runs on the LIGHT model (category 'coworker'); the one
 *     expensive writing job it has, a SQL change, is delegated to the existing
 *     `transformation_propose` call — exactly the call, and the cost, the
 *     catalog assistant already makes;
 *   - reads cost no model call at all: they are routes;
 *   - no catalog is pasted into the prompt — the model looks up what it needs;
 *   - earlier turns come back as TEXT only (never their tool traffic), capped;
 *   - at most MAX_STEPS model steps per message, the last one forced to
 *     answer without tools, and a hard input-token ceiling per message;
 *   - tool results are clipped before they go back to the model.
 */
import type { Knex } from 'knex';
import {
  callClaudeWithTools, type ToolLoopMessage,
} from '../../ai/AIService';
import type { CoworkerEvent, CoworkerPageContext } from '../../shared/contract';
import { COWORKER_TOOLS, ToolError, type ToolContext } from './tools';
import { COWORKER_SYSTEM, describeWhereTheUserIs } from './prompt';
import type { InternalCaller } from './internalApi';
import { logger } from '../../utils/logger';
import { getTenantAiMode } from '../ai/tenantAiMode';

const log = logger.child({ mod: 'coworker' });

export const MAX_STEPS = Number(process.env.COWORKER_MAX_STEPS) || 8;
/** Input tokens one message may spend across its steps, cache reads included. */
export const MAX_TURN_INPUT_TOKENS = Number(process.env.COWORKER_MAX_TURN_INPUT_TOKENS) || 80_000;
const MAX_TOOL_RESULT_CHARS = 6000;
const HISTORY_TURNS = 10;
const HISTORY_CHARS = 1500;

export interface HistoryTurn { role: 'user' | 'assistant'; content: string }

interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Earlier turns, text only and capped — their tool traffic is never re-sent. */
export function compactHistory(history: HistoryTurn[]): ToolLoopMessage[] {
  const recent = history
    .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-HISTORY_TURNS)
    .map((h) => ({
      role: h.role,
      content: h.content.length > HISTORY_CHARS ? `${h.content.slice(0, HISTORY_CHARS - 1)}…` : h.content,
    }));
  // The API wants the conversation to open with the user and alternate.
  const out: ToolLoopMessage[] = [];
  for (const m of recent) {
    if (!out.length && m.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content as string}\n\n${m.content}`;
    else out.push({ ...m });
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

export async function runCoworkerTurn(opts: {
  caller: InternalCaller;
  tenantId: number;
  db: Knex | Knex.Transaction;
  message: string;
  history: HistoryTurn[];
  context: CoworkerPageContext;
  signal?: AbortSignal;
  emit: (event: CoworkerEvent) => void;
}): Promise<void> {
  const started = Date.now();
  const ctx: ToolContext = { caller: opts.caller, tenantId: opts.tenantId, db: opts.db };
  const messages: ToolLoopMessage[] = [
    ...compactHistory(opts.history),
    { role: 'user', content: `${describeWhereTheUserIs(opts.context)}\n\n${opts.message}` },
  ];
  // Row data only reaches Claude for a tenant that routes everything there.
  const rowsAllowed = (await getTenantAiMode(opts.tenantId)) === 'claude';
  const available = COWORKER_TOOLS.filter((t) => rowsAllowed || !t.sendsRows);
  const tools = available.map((t) => t.definition);

  let steps = 0;
  let inputSpent = 0;
  let stoppedAtLimit = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (opts.signal?.aborted) return;
    const lastStep = step === MAX_STEPS - 1 || inputSpent >= MAX_TURN_INPUT_TOKENS;
    const turn = await callClaudeWithTools({
      callLabel: 'coworker_turn',
      system: COWORKER_SYSTEM,
      tools,
      messages,
      maxTokens: 1500,
      signal: opts.signal,
      forceAnswer: lastStep,
      onText: (delta) => opts.emit({ type: 'text', delta }),
    });
    steps++;
    inputSpent += turn.inputTokens + turn.cacheReadTokens;

    const uses = turn.content.filter((b): b is ToolUseBlock => (b as { type?: string })?.type === 'tool_use');
    const said = textOf(turn.content);
    if (!uses.length) {
      opts.emit({ type: 'segment', kind: 'answer', text: said });
      break;
    }
    if (said) opts.emit({ type: 'segment', kind: 'thought', text: said });
    if (lastStep) { stoppedAtLimit = true; break; }

    messages.push({ role: 'assistant', content: turn.content });
    const results: unknown[] = [];
    for (const use of uses) {
      const tool = available.find((t) => t.definition.name === use.name);
      const stepId = use.id;
      const input = (use.input && typeof use.input === 'object') ? use.input : {};
      const label = tool ? safeLabel(() => tool.label(input), use.name) : use.name;
      opts.emit({ type: 'step', id: stepId, status: 'running', label, ...(tool ? { tool: tool.kind } : {}) });
      if (!tool) {
        opts.emit({ type: 'step', id: stepId, status: 'failed', label, detail: 'Unknown tool' });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `There is no tool called ${use.name}.` });
        continue;
      }
      try {
        const outcome = await tool.run(ctx, input);
        if (outcome.focus) opts.emit({ type: 'focus', target: outcome.focus });
        if (outcome.proposal) opts.emit({ type: 'proposal', proposal: outcome.proposal });
        opts.emit({ type: 'step', id: stepId, status: 'done', label, tool: tool.kind, ...(outcome.detail ? { detail: outcome.detail } : {}) });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: clipResult(outcome.result, tool.resultLimit) });
      } catch (err) {
        if (opts.signal?.aborted) return;
        const refusal = err instanceof ToolError;
        const msg = refusal ? err.message : 'That lookup failed on our side.';
        if (!refusal) log.warn({ tool: use.name, err: err instanceof Error ? err.message : String(err) }, 'coworker tool failed');
        opts.emit({ type: 'step', id: stepId, status: 'failed', label, tool: tool.kind, detail: msg });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: msg });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  opts.emit({ type: 'done', steps, durationMs: Date.now() - started, ...(stoppedAtLimit ? { stoppedAtLimit: true } : {}) });
  log.info({ tenantId: opts.tenantId, steps, inputSpent, ms: Date.now() - started, stoppedAtLimit }, 'coworker turn done');
}

function safeLabel(fn: () => string, fallback: string): string {
  try { return fn() || fallback; } catch { return fallback; }
}

export function clipResult(result: unknown, limit: number = MAX_TOOL_RESULT_CHARS): string {
  const s = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return s.length > limit ? `${s.slice(0, limit - 20)}… (truncated)` : s;
}

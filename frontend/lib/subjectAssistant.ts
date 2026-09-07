/**
 * The subject assistant — ONE assistant, two entry points.
 *
 * Until 2026-09-07 there were two chat boxes, in two places, that could not
 * see each other:
 *
 *   • /build's "Ask about your subjects" — whole-tenant coverage questions,
 *     and proposing a NEW subject.
 *   • a topic page's Refine chat — changes to the ONE subject you are on.
 *
 * The problem was not tidiness. Someone thinking "I want to see quotations"
 * does not know whether that is a new subject, a change to Sales, or already
 * there and they cannot find it — and working that out IS the question. Two
 * boxes made them answer it BEFORE they were allowed to ask.
 *
 * So the assistant is one thing now, and the ANCHOR (which subject you are
 * looking at, if any) is what varies:
 *
 *   • anchored   — a topic page. Can change this subject, and when the ask is
 *                  not a change to it, escalates here rather than dead-ending.
 *   • unanchored — /build. Coverage and additions; there is no subject to
 *                  change, which is the honest difference, not a missing
 *                  feature.
 *
 * This module is the shared half: asking, and turning an answer into a
 * build. It holds no React state so both callers keep their own thread UI.
 */
import api from './api';

/** A validated addition the backend proved against the real catalog. */
export interface SubjectProposal {
  connection_id: number;
  name: string;
  description: string;
  focus?: string | null;
  entities: string[];
}

export interface AssistantReply {
  reply: string;
  /** Non-null only when every part checked out server-side. */
  proposal: SubjectProposal | null;
}

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Ask the assistant. `anchorProductId` is the subject the user is looking at;
 * omit it on /build. The backend answers only from the real catalog — it does
 * not guess what exists.
 */
export async function askSubjectAssistant(
  messages: AssistantTurn[],
  anchorProductId?: number | null,
): Promise<AssistantReply> {
  const res = await api.post('/products/build-chat', {
    messages,
    ...(anchorProductId ? { anchorProductId } : {}),
  });
  const data = res.data?.data ?? {};
  return {
    reply: typeof data.reply === 'string' ? data.reply : '',
    proposal: (data.proposal ?? null) as SubjectProposal | null,
  };
}

export interface StartedBuild {
  jobId: string;
  connectionId: number;
}

/**
 * Turn an approved proposal into a build. ADDITIVE by construction — the
 * endpoint refuses a name that collides with an existing subject and entities
 * that never synced, so this can only ever add alongside what is there.
 * Nothing runs until the user presses the button that calls this.
 */
export async function startSubjectAddition(p: SubjectProposal): Promise<StartedBuild> {
  const res = await api.post('/products/bus-matrix/extend-start', {
    connectionId: p.connection_id,
    name: p.name,
    description: p.description,
    focus: p.focus ?? undefined,
    entities: p.entities,
  });
  const jobId = res.data?.data?.jobId;
  if (!jobId) throw new Error('The build did not start.');
  return { jobId: String(jobId), connectionId: p.connection_id };
}

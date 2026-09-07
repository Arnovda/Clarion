/**
 * The lead — the one sentence at the top of Home.
 *
 * Pure on purpose. This is the single most important piece of copy in the
 * product (it is the largest type on the landing page, and it decides
 * whether anyone opens Clarion tomorrow), so it is derived in a function
 * that can be unit-tested against every state rather than assembled inside
 * a component where only the happy path is ever exercised.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the lead is always a sentence about
 * the user's BUSINESS, never a score about the platform. The page it
 * replaced led with `73 / 100`. If a future change makes this function able
 * to return a number, that change is wrong.
 *
 * Four states, in the order they are checked:
 *
 *   cold     no source connected yet — there is nothing to say, so say what
 *            will happen tonight and make the ask box the only thing to do.
 *   waiting  data has arrived but no reading has been taken (the 06:00 job
 *            has not run, or has run once so there is no delta yet).
 *   quiet    a brief exists and nothing in it moved. This is a SUCCESS
 *            state, not an empty one — see the note on `quiet` below.
 *   moved    a brief exists with something worth saying.
 */

import type { Brief, BriefBullet, HomeAlert, PulseTile } from './types';

export type LeadTone = 'cold' | 'waiting' | 'quiet' | 'moved';

/**
 * A card on Home comes from one of two places: the brief's own bullets, or
 * an active quality alert. A union rather than coercing an alert into a
 * BriefBullet — that would throw away `aiContext`, which is the whole value
 * of an alert, and the id needed to dismiss it.
 */
export type HomeCard =
  | { source: 'brief'; bullet: BriefBullet }
  | { source: 'alert'; alert: HomeAlert };

/**
 * Which alerts earn a card. Only the loud ones: `quality_alerts` also holds
 * informational rows, and a card per row would rebuild the "worth your
 * attention" feed this redesign deleted.
 */
export function alertsWorthACard(alerts: HomeAlert[]): HomeAlert[] {
  return alerts.filter((a) => {
    const s = (a.severity ?? '').toLowerCase();
    return s === 'critical' || s === 'high' || s === 'error';
  });
}

export interface Lead {
  tone: LeadTone;
  /** The sentence. Plain text — the page decides the typography. */
  headline: string;
  /**
   * The fragment of `headline` to emphasise, when there is one. The page
   * underlines it rather than bolding, so a long headline still reads as
   * one sentence. Null when nothing should be picked out.
   */
  emphasis: string | null;
  /** Facts under the headline. The page joins them with separator dots. */
  sub: string[];
  /**
   * The cards to render under "what moved" — brief bullets first, in the
   * order the brief ranked them, then any loud quality alert.
   */
  cards: HomeCard[];
}

export interface LeadInput {
  brief: Brief | null;
  tiles: PulseTile[];
  /**
   * Undismissed quality alerts. LOAD-BEARING for the quiet state: a morning
   * with no metric movement but a live critical alert is NOT quiet, and
   * saying "nothing needs you" over the top of one would be a lie the user
   * could only discover by going and looking somewhere else.
   */
  alerts?: HomeAlert[];
  /** Sources the tenant has connected, from /home/summary. */
  sourceCount: number;
  /** Newest successful sync across every source, ISO. Null when none. */
  newestSyncAt: string | null;
}

/** A bullet earns a card when it says something happened. */
export function isWorthACard(b: BriefBullet): boolean {
  return b.kind === 'movement' || b.kind === 'warn';
}

/**
 * Trim a model-written sentence to something that reads as a headline.
 * The brief's `detail` is already specified as one sentence, but the model
 * occasionally runs two together; we take the first and leave the rest to
 * the card, which has room for it.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Split on sentence-ending punctuation followed by a space + capital.
  const m = trimmed.match(/^(.+?[.!?])\s+[A-Z(]/);
  return (m ? m[1] : trimmed).trim();
}

export function deriveLead(input: LeadInput): Lead {
  const { brief, tiles, sourceCount, newestSyncAt, alerts = [] } = input;
  const loudAlerts = alertsWorthACard(alerts);

  // ── cold ────────────────────────────────────────────────────────────────
  // No source at all. Nothing has ever arrived, so there is nothing honest
  // to lead with. Sell the mechanism instead and let the ask box carry it.
  if (sourceCount === 0 || !newestSyncAt) {
    return {
      tone: 'cold',
      headline: "Ask me something about your business — and by tomorrow morning I'll have noticed things for you.",
      emphasis: "I'll have noticed things for you",
      sub: sourceCount === 0
        ? ['No source connected yet']
        : ['Connected — waiting for the first data to land'],
      cards: [],
    };
  }

  const alertCards: HomeCard[] = loudAlerts.map((alert) => ({ source: 'alert', alert }));
  const bulletCards: HomeCard[] = brief
    ? brief.content.bullets.filter(isWorthACard).map((bullet) => ({ source: 'brief', bullet }))
    : [];
  const cards: HomeCard[] = [...bulletCards, ...alertCards];

  // ── waiting ─────────────────────────────────────────────────────────────
  // Data is here but no brief has been written for today. Two sub-cases,
  // and they must not be conflated: a user who has told us what to watch is
  // waiting for tonight's job; a user who has not is waiting for THEMSELVES.
  if (!brief && cards.length === 0) {
    const watching = tiles.length;
    const anyReading = tiles.some((t) => t.currentValue != null);
    return {
      tone: 'waiting',
      headline: watching === 0
        ? "Tell me what to keep an eye on, and I'll have something for you tomorrow morning."
        : anyReading
          ? "I've taken my first readings. Tomorrow I can tell you what changed."
          : "First readings go out tonight. Tomorrow I can tell you what changed.",
      emphasis: watching === 0 ? 'what to keep an eye on' : 'what changed',
      sub: watching === 0
        ? ['Nothing on your watchlist yet']
        : [`Watching ${watching} thing${watching === 1 ? '' : 's'}`, 'Next reading 06:00'],
      cards: [],
    };
  }

  // ── quiet ───────────────────────────────────────────────────────────────
  // A brief exists and nothing in it moved.
  //
  // This is the state the whole design depends on. A briefing that always
  // finds three things is a briefing nobody believes; rendering "all quiet"
  // as the SUCCESS state is what makes the loud mornings credible. Do not
  // "improve" this by surfacing the steady bullets as cards — the absence
  // of cards IS the message.
  if (cards.length === 0) {
    const watched = tiles.length || brief!.content.bullets.length;
    return {
      tone: 'quiet',
      headline: 'Nothing needs you this morning. Everything you watch is where it should be.',
      emphasis: 'Nothing needs you this morning.',
      sub: [
        watched > 0
          ? `Checked ${watched} thing${watched === 1 ? '' : 's'} at 06:00`
          : 'Checked at 06:00',
        'Nothing outside its normal range',
      ],
      cards: [],
    };
  }

  // ── moved ───────────────────────────────────────────────────────────────
  // Something happened. The headline is the best sentence we have about it,
  // in this order of preference:
  //
  //   1. The overnight investigation's conclusion (R2) — this is the one
  //      that names a DRIVER, which is what makes the page worth opening.
  //   2. The top bullet's detail — a real sentence about the business.
  //
  // The brief's own `summary` is deliberately NOT used: the prompt asks for
  // 2-3 sentences of scene-setting, which is a paragraph, not a headline.
  const top = cards[0];
  const topBullet = top.source === 'brief' ? top.bullet : null;
  const investigated = brief?.investigation;
  const useConclusion =
    investigated?.status === 'concluded' &&
    !!investigated.conclusion &&
    investigated.conclusion.trim().length > 0;

  const headline = useConclusion
    ? firstSentence(investigated!.conclusion!)
    : topBullet
      ? firstSentence(topBullet.detail)
      // No brief movement, so an alert is leading. Its aiContext is the
      // sentence a person can act on; the raw message is the fallback.
      : firstSentence(top.source === 'alert' ? (top.alert.aiContext ?? top.alert.message) : '');

  return {
    tone: 'moved',
    headline,
    // Emphasise the movement itself ("−€19k", "+29%") when the brief gave
    // us one — never a whole clause, which would underline half the line.
    emphasis: topBullet && topBullet.delta && topBullet.delta !== '—' ? topBullet.delta : null,
    sub: [
      `${cards.length} worth your time`,
      ...(useConclusion ? ['Already looked into'] : []),
    ],
    cards,
  };
}

/**
 * The operational line: what the numbers above actually include.
 *
 * Deliberately phrased as what staleness costs the READER ("the last three
 * days are missing"), never as a score about us ("Freshness 0/100"). The
 * page it replaced showed the latter, which reads as catastrophic during
 * the entirely normal state of a monthly-close dataset.
 *
 * Returns null when there is nothing true to say.
 */
export function deriveOpsLine(input: {
  newestSyncAt: string | null;
  staleSources: Array<{ id: number; name: string }>;
  staleProductCount: number;
  sourceCount: number;
}): { asOf: string | null; problem: string | null } | null {
  const { newestSyncAt, staleSources, staleProductCount, sourceCount } = input;
  if (sourceCount === 0) return null;

  const names = staleSources.map((s) => s.name);
  let problem: string | null = null;
  if (names.length === 1) {
    problem = `${names[0]} hasn't sent anything in over a day.`;
  } else if (names.length > 1) {
    problem = `${names.length} sources haven't sent anything in over a day.`;
  } else if (staleProductCount > 0) {
    problem = `${staleProductCount} subject${staleProductCount === 1 ? '' : 's'} ${staleProductCount === 1 ? 'is' : 'are'} waiting on a refresh.`;
  }

  if (!newestSyncAt && !problem) return null;
  return { asOf: newestSyncAt, problem };
}

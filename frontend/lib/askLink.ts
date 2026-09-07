/**
 * The one way to build an "ask about this subject" link into Ask AI.
 *
 * WHY THIS EXISTS. Ask AI resolves which connection a question runs against
 * in this order (app/query/page.tsx): the `connectionId` URL param, then
 * localStorage, then the first connection in the list. It renders no picker,
 * so with two or more sources that fallback is invisible AND arbitrary.
 *
 * A link carrying `productId` but no `connectionId` therefore aims the
 * question at whichever source the user happened to use last. When that
 * connection does not own the product, `buildProductSemanticContext`
 * filters `connection_id = X AND id IN (N)`, matches nothing, returns null
 * — and the question silently answers from the SOURCE layer of an unrelated
 * connection. The topic page's whole promise ("clicking a question answers
 * it") fails, quietly, and gets more likely the more sources a tenant has.
 *
 * Four surfaces built this URL four different ways and three of them were
 * wrong (2026-09-07 coherence review, D3). Hence one helper: a subject link
 * always carries BOTH ids, or the scoping is a coin flip.
 *
 * Pass `connectionId: null` only when it genuinely is not known — the link
 * then degrades to today's behaviour rather than sending a bad id.
 */
export interface SubjectAskLink {
  /** The subject (data product) the question is about. */
  productId: number;
  /** Its display name — shown as context in Ask AI. */
  productName: string;
  /** The connection that owns the subject. Without it, scoping is a guess. */
  connectionId: number | null | undefined;
  /** When set, Ask AI submits it on arrival instead of pre-filling the box. */
  question?: string;
}

export function askAboutSubject({
  productId, productName, connectionId, question,
}: SubjectAskLink): string {
  const params = new URLSearchParams({
    productId: String(productId),
    productName,
  });
  if (connectionId != null) params.set('connectionId', String(connectionId));
  if (question) {
    params.set('q', question);
    params.set('autoSubmit', '1');
  }
  return `/query?${params.toString()}`;
}

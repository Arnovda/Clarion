'use client';

/**
 * The catalog assistant's one piece of shared state: a SQL change it has
 * proposed for a table, waiting for a person to Keep or Discard it.
 *
 * The panel floats over the page; the diff renders ON THE DECLARATION — in
 * the table's SQL editor, where the question "is this right?" is easiest to
 * answer (the notebook's reasoning, applied here). The two never see each
 * other, so the page holds the proposal in this context: the panel puts it
 * in, the editor shows it and reports the decision back.
 *
 * Nothing is stored until Keep, and Keep IS Save — the editor's own save.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface DeclaredColumn { name: string; type: string }

export interface SqlProposal {
  id: string;
  /** Postgres product_tables id. */
  tableId: number;
  sql: string;
  summary: string;
  compiled: boolean;
  error?: string | null;
  columns?: DeclaredColumn[];
}

export type ProposalDecision = 'kept' | 'discarded';

interface CatalogAssistantContextValue {
  proposal: SqlProposal | null;
  /** The editor's unsaved draft, so a proposal is based on what is on screen. */
  reportDraft: (tableId: number, sql: string) => void;
  /** Called by the editor once the person decided. */
  decide: (proposalId: string, decision: ProposalDecision) => void;
}

const noop = () => {};
const CatalogAssistantContext = createContext<CatalogAssistantContextValue>({
  proposal: null,
  reportDraft: noop,
  decide: noop,
});

export function CatalogAssistantProvider({ value, children }: { value: CatalogAssistantContextValue; children: ReactNode }) {
  return <CatalogAssistantContext.Provider value={value}>{children}</CatalogAssistantContext.Provider>;
}

/** The proposal aimed at THIS table, if any. */
export function useSqlProposal(tableId: number | null) {
  const ctx = useContext(CatalogAssistantContext);
  const proposal = ctx.proposal && tableId != null && ctx.proposal.tableId === tableId ? ctx.proposal : null;
  return { proposal, reportDraft: ctx.reportDraft, decide: ctx.decide };
}

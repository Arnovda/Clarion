'use client';

import { useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb, Search, X, HelpCircle, Wand2 } from 'lucide-react';
import { widgetVariants } from '../utils/motion';
import type { WidgetSpec, WidgetData } from '../types';
import api from '../../../lib/api';
import WidgetProvenance from './WidgetProvenance';

interface WidgetCardProps {
  spec: WidgetSpec;
  data?: WidgetData;
  colSpan: number;
  children: ReactNode;
  isFiltered?: boolean;
  isCrossFilterSource?: boolean;
  revalidating?: boolean;
  onExportCsv?: () => void;
  onExportXlsx?: () => void;
  onInvestigate?: () => void;
  isInvestigating?: boolean;
  /** Which data layer the dashboard's SQL was generated against — passed
   * through to the provenance modal so it knows whether to look up
   * tables in source_tables vs product_tables. */
  dataLayer?: 'product' | 'source';
  /** Whether the current user is admin/analyst — gates the raw SQL view
   * inside the provenance modal. */
  isAdminOrAnalyst?: boolean;
  /** Render-time self-heal: shown when the widget errored. Calls
   * POST /dashboards/fix-widget and patches the spec in place. */
  onFixWidget?: () => void;
  fixing?: boolean;
  /** Aim the assistant at THIS card — "sort it descending", "show margin %
   *  instead". Scoping the edit is what keeps it fast and safe: the planner
   *  sees one widget, so it cannot rearrange the dashboard around it, and the
   *  request costs one small model call instead of a whole-spec rewrite. */
  onEditWidget?: () => void;
  /** Explicit CSS-grid placement (user-arranged layout). Wins over colSpan. */
  gridPlacement?: { x: number; y: number; w: number; h: number };
  /** Fill the parent's height (arrange-mode grid cells are fixed-size). */
  fillHeight?: boolean;
}

export function WidgetCard({
  spec,
  data,
  colSpan,
  children,
  isFiltered,
  isCrossFilterSource,
  revalidating,
  onExportCsv,
  onExportXlsx,
  onInvestigate,
  isInvestigating,
  dataLayer,
  isAdminOrAnalyst,
  onFixWidget,
  fixing,
  onEditWidget,
  gridPlacement,
  fillHeight,
}: WidgetCardProps) {
  const isKpi = spec.type === 'kpi_card';
  const featured = spec.featured;
  const cardRef = useRef<HTMLDivElement>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  // Provenance modal — separate from the AI chart explainer; this one
  // shows where the number comes from (SQL → plain English + tables +
  // refresh times) so finance teams can audit before trusting.
  const [showProvenance, setShowProvenance] = useState(false);

  async function fetchExplanation() {
    if (explaining || !data?.rows?.length) return;
    if (explanation) { setExplanation(null); return; } // toggle off
    setExplaining(true);
    try {
      const res = await api.post('/dashboards/explain-widget', {
        title: spec.title,
        type: spec.type,
        rows: data.rows,
      });
      setExplanation(res.data?.data?.explanation ?? null);
    } catch { /* silent — Explain is best-effort */ }
    finally { setExplaining(false); }
  }

  async function exportWidgetPdf() {
    if (!cardRef.current || exportingPdf) return;
    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
      });
      const imgData = canvas.toDataURL('image/png');
      const w = canvas.width / 2;
      const h = canvas.height / 2;
      const pdf = new jsPDF({
        orientation: w > h ? 'landscape' : 'portrait',
        unit: 'px',
        format: [w, h],
      });
      pdf.addImage(imgData, 'PNG', 0, 0, w, h);
      pdf.save(`${spec.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <motion.div
      ref={cardRef}
      variants={widgetVariants}
      style={
        fillHeight
          ? { height: '100%' }
          : gridPlacement
            ? {
                gridColumn: `${gridPlacement.x + 1} / span ${gridPlacement.w}`,
                gridRow: `${gridPlacement.y + 1} / span ${gridPlacement.h}`,
              }
            : {
                gridColumn: `span ${colSpan}`,
                gridRow: featured ? 'span 2' : undefined,
              }
      }
      className={`group/widget rounded-lg overflow-hidden flex flex-col bg-raised border transition-colors duration-200 ${
        isCrossFilterSource
          ? 'border-ocean/40 ring-1 ring-ocean/20'
          : isFiltered
            ? 'border-line opacity-50'
            : 'border-line hover:border-line-strong'
      }`}
    >
      {/* Self-heal banner — shown when the widget's SQL failed at render
          time (schema drift, renamed column). One click re-runs the
          execute → contract-check → AI-repair loop for just this widget. */}
      {data?.error && onFixWidget && (
        <div className="px-5 py-2 flex items-center justify-between gap-3 border-b border-line bg-err/5 shrink-0">
          <span className="text-[11px] text-err truncate">This widget is broken</span>
          <button
            onClick={onFixWidget}
            disabled={fixing}
            className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover disabled:opacity-50 transition-colors shrink-0"
          >
            {fixing ? 'Fixing…' : 'Fix with AI'}
          </button>
        </div>
      )}

      {/* Card header (non-KPI only) */}
      {!isKpi && (
        <div className="px-5 pt-4 pb-3 flex items-center justify-between gap-3 shrink-0 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-[13px] font-medium text-ink tracking-[-0.01em] truncate">
              {spec.title}
            </h3>
            {revalidating && (
              <span className="w-1.5 h-1.5 rounded-full bg-ocean/50 animate-pulse shrink-0" title="Updating…" />
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="flex items-center gap-0.5 overflow-hidden max-w-0 opacity-0 group-hover/widget:max-w-[200px] group-hover/widget:opacity-100 transition-all duration-200">
              {onEditWidget && (
                <button
                  onClick={onEditWidget}
                  className="p-1.5 rounded text-muted-2 hover:text-ocean hover:bg-ocean-softer transition-colors"
                  title="Change this card"
                  aria-label="Change this card"
                >
                  <Wand2 className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              )}
              {onExportCsv && (
                <button
                  onClick={onExportCsv}
                  className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
                  title="Export CSV"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  </svg>
                </button>
              )}
              {onExportXlsx && (
                <button
                  onClick={onExportXlsx}
                  className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
                  title="Export Excel"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
              )}
              {/* Provenance — "How was this computed?" */}
              <button
                onClick={() => setShowProvenance(true)}
                className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
                title="How was this computed?"
                aria-label="How was this computed?"
              >
                <HelpCircle className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
              {data && !data.loading && !data.error && data.rows.length > 0 && (
                <button
                  onClick={fetchExplanation}
                  disabled={explaining}
                  className={`p-1.5 rounded transition-colors disabled:opacity-40 ${explanation ? 'text-ocean bg-ocean-softer' : 'text-muted-2 hover:text-ink-2 hover:bg-softer'}`}
                  title={explanation ? 'Hide explanation' : 'Explain this chart'}
                >
                  {explaining ? (
                    <Lightbulb className="w-3.5 h-3.5 animate-pulse" strokeWidth={2} />
                  ) : (
                    <Lightbulb className="w-3.5 h-3.5" strokeWidth={2} />
                  )}
                </button>
              )}
              {onInvestigate && data && !data.loading && !data.error && (
                <button
                  onClick={onInvestigate}
                  className={`p-1.5 rounded transition-colors ${isInvestigating ? 'text-ocean bg-ocean-softer' : 'text-muted-2 hover:text-ink-2 hover:bg-softer'}`}
                  title="Investigate — ask why"
                >
                  <Search className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              )}
              <button
                onClick={exportWidgetPdf}
                disabled={exportingPdf}
                className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors disabled:opacity-40"
                title="Export widget as PDF"
              >
                {exportingPdf ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 018-8v4m0 0l-2-2m2 2l2-2" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                )}
              </button>
            </span>
            {isCrossFilterSource && (
              <span className="text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line bg-ocean-softer text-ocean">
                Filtering
              </span>
            )}
          </div>
        </div>
      )}

      <div className={`flex-1 relative ${isKpi ? 'p-5' : 'px-5 py-4'}`}>
        {/* KPI cards skip the header toolbar entirely, so we surface the
           provenance button as a floating top-right button that only
           appears on hover. KPIs are the most trust-sensitive thing on
           the dashboard — this is the headline number a CFO will quote. */}
        {isKpi && (
          <span className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover/widget:opacity-100 transition-opacity">
            {onEditWidget && (
              <button
                onClick={onEditWidget}
                className="p-1.5 rounded text-muted-2 hover:text-ocean hover:bg-ocean-softer transition-colors"
                title="Change this card"
                aria-label="Change this card"
              >
                <Wand2 className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            )}
            <button
              onClick={() => setShowProvenance(true)}
              className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors"
              title="How was this computed?"
              aria-label="How was this computed?"
            >
              <HelpCircle className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          </span>
        )}
        {children}
      </div>

      {explanation && (
        <div className="px-5 pb-4 pt-0 border-t border-line mt-0">
          <div className="mt-3 bg-ocean-softer rounded-md px-4 py-3 flex items-start gap-3">
            <Lightbulb className="w-3.5 h-3.5 text-ocean mt-0.5 shrink-0" strokeWidth={2} />
            <p className="text-[12px] text-ink-2 leading-relaxed flex-1">{explanation}</p>
            <button
              onClick={() => setExplanation(null)}
              className="text-muted-2 hover:text-ink-2 transition-colors shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {showProvenance && (
        <WidgetProvenance
          widget={spec}
          dataLayer={dataLayer ?? 'product'}
          isAdminOrAnalyst={!!isAdminOrAnalyst}
          onClose={() => setShowProvenance(false)}
        />
      )}
    </motion.div>
  );
}

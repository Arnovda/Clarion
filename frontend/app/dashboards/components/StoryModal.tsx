'use client';

import { useEffect, useRef, useState } from 'react';
import { X, BookOpen, Download } from 'lucide-react';
import api from '../../../lib/api';
import type { WidgetData, WidgetSpec } from '../types';

interface NarrativeOutput {
  headline: string;
  period: string;
  summary: string;
  sections: { widgetTitle: string; narrative: string }[];
  recommendation: string;
}

interface StoryModalProps {
  dashboardTitle: string;
  widgets: WidgetSpec[];
  widgetData: Record<string, WidgetData>;
  dashboardGridRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

export function StoryModal({
  dashboardTitle,
  widgets,
  widgetData,
  dashboardGridRef,
  onClose,
}: StoryModalProps) {
  const [narrative, setNarrative] = useState<NarrativeOutput | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;

    const payload = widgets
      .map((w) => ({
        title: w.title,
        type: w.type,
        rows: widgetData[w.id]?.rows ?? [],
      }))
      .filter((w) => w.rows.length > 0);

    api
      .post('/dashboards/narrate', { dashboardTitle, widgets: payload })
      .then((res) => {
        if (res.data.ok) setNarrative(res.data.data.narrative);
        else setError('Failed to generate narrative.');
      })
      .catch(() => setError('Failed to generate narrative.'))
      .finally(() => setLoading(false));
  }, []);

  async function downloadPdf() {
    if (!narrative || exportingPdf) return;
    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);

      // Capture dashboard grid screenshot
      let dashboardImgData: string | null = null;
      if (dashboardGridRef.current) {
        const canvas = await html2canvas(dashboardGridRef.current, {
          scale: 1.5,
          useCORS: true,
          backgroundColor: '#ffffff',
        });
        dashboardImgData = canvas.toDataURL('image/png');
      }

      // Build print HTML
      const today = new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      const sectionsHtml = narrative.sections
        .map(
          (s) => `
          <div class="section">
            <h3>${s.widgetTitle}</h3>
            <p>${s.narrative}</p>
          </div>`,
        )
        .join('');

      const imgHtml = dashboardImgData
        ? `<div class="dashboard-img"><img src="${dashboardImgData}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb;" /></div>`
        : '';

      const recHtml = narrative.recommendation
        ? `<div class="recommendation"><strong>Recommended action:</strong> ${narrative.recommendation}</div>`
        : '';

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${dashboardTitle} — Story Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&family=Inter:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; color: #1a1a1a; background: #fff; padding: 48px 56px; max-width: 860px; margin: 0 auto; }
  h1 { font-family: 'Source Serif 4', Georgia, serif; font-size: 28px; font-weight: 700; color: #0f172a; line-height: 1.2; margin-bottom: 6px; }
  .meta { font-size: 12px; color: #64748b; font-family: 'Inter', sans-serif; margin-bottom: 32px; letter-spacing: 0.04em; text-transform: uppercase; }
  .headline { font-family: 'Source Serif 4', Georgia, serif; font-size: 18px; font-weight: 600; color: #0369a1; line-height: 1.4; padding: 16px 20px; border-left: 3px solid #0369a1; background: #f0f9ff; margin-bottom: 28px; border-radius: 0 6px 6px 0; }
  .summary { font-size: 14px; line-height: 1.75; color: #374151; margin-bottom: 32px; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 28px 0; }
  .section { margin-bottom: 24px; }
  .section h3 { font-family: 'Source Serif 4', Georgia, serif; font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 6px; }
  .section p { font-size: 13px; line-height: 1.7; color: #374151; }
  .recommendation { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 18px; font-size: 13px; line-height: 1.6; color: #374151; margin-top: 28px; }
  .dashboard-img { margin-top: 36px; page-break-before: always; }
  .footer { margin-top: 48px; font-size: 11px; color: #94a3b8; text-align: center; border-top: 1px solid #e5e7eb; padding-top: 16px; }
  @media print {
    body { padding: 0; }
    .dashboard-img { page-break-before: always; padding-top: 20px; }
  }
</style>
</head>
<body>
  <h1>${dashboardTitle}</h1>
  <p class="meta">${narrative.period} &nbsp;·&nbsp; Generated ${today} &nbsp;·&nbsp; DataBridge</p>
  <div class="headline">${narrative.headline}</div>
  <p class="summary">${narrative.summary}</p>
  <hr class="divider" />
  ${sectionsHtml}
  ${recHtml}
  ${imgHtml}
  <div class="footer">Generated by DataBridge &nbsp;·&nbsp; ${today}</div>
  <script>window.onload = () => window.print();<\/script>
</body>
</html>`;

      const printWin = window.open('', '_blank');
      if (printWin) {
        printWin.document.write(html);
        printWin.document.close();
      } else {
        // Fallback: generate PDF with jsPDF directly
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        doc.setFontSize(11);
        doc.text(narrative.summary, 20, 40, { maxWidth: 170 });
        doc.save(`${dashboardTitle.replace(/[^a-zA-Z0-9]/g, '_')}_story.pdf`);
      }
    } finally {
      setExportingPdf(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface rounded-xl border border-line shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <BookOpen className="w-4 h-4 text-ocean" strokeWidth={2} />
            <span className="text-[13px] font-medium text-ink">Story Report</span>
          </div>
          <div className="flex items-center gap-2">
            {narrative && (
              <button
                onClick={downloadPdf}
                disabled={exportingPdf}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ocean text-white text-[11px] font-mono tracking-[0.06em] uppercase hover:bg-ocean-hover transition-colors disabled:opacity-40"
              >
                <Download className="w-3 h-3" />
                {exportingPdf ? 'Preparing…' : 'Download PDF'}
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading && (
            <div className="flex flex-col gap-4 animate-pulse">
              <div className="h-5 bg-softer rounded w-3/4" />
              <div className="h-3 bg-softer rounded w-1/3" />
              <div className="mt-3 space-y-2">
                <div className="h-3 bg-softer rounded" />
                <div className="h-3 bg-softer rounded" />
                <div className="h-3 bg-softer rounded w-5/6" />
              </div>
              <div className="mt-4 space-y-2">
                <div className="h-3 bg-softer rounded" />
                <div className="h-3 bg-softer rounded w-4/5" />
              </div>
            </div>
          )}

          {error && (
            <p className="text-[13px] text-err">{error}</p>
          )}

          {narrative && (
            <div className="flex flex-col gap-5">
              {/* Headline */}
              <div className="border-l-2 border-ocean pl-4 py-1 bg-ocean-softer rounded-r-md pr-4">
                <p className="font-display text-[15px] font-semibold text-ocean leading-snug">
                  {narrative.headline}
                </p>
              </div>

              {/* Meta */}
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">
                {narrative.period} &nbsp;·&nbsp; {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>

              {/* Summary */}
              <p className="text-[13px] text-ink-2 leading-relaxed">{narrative.summary}</p>

              {/* Divider */}
              <hr className="border-line" />

              {/* Per-widget sections */}
              {narrative.sections.map((s, i) => (
                <div key={i}>
                  <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1.5">
                    {s.widgetTitle}
                  </p>
                  <p className="text-[13px] text-ink-2 leading-relaxed">{s.narrative}</p>
                </div>
              ))}

              {/* Recommendation */}
              {narrative.recommendation && (
                <div className="rounded-lg border border-line bg-softer px-4 py-3 mt-1">
                  <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1.5">
                    Recommended action
                  </p>
                  <p className="text-[13px] text-ink leading-relaxed">{narrative.recommendation}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

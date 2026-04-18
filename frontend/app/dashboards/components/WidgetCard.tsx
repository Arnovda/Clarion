'use client';

import { type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { widgetVariants } from '../utils/motion';
import { getTypeAccent } from '../utils/chart-theme';
import type { WidgetSpec } from '../types';

interface WidgetCardProps {
  spec: WidgetSpec;
  colSpan: number;
  children: ReactNode;
  isFiltered?: boolean;
  isCrossFilterSource?: boolean;
  onExportCsv?: () => void;
  onExportXlsx?: () => void;
}

export function WidgetCard({
  spec,
  colSpan,
  children,
  isFiltered,
  isCrossFilterSource,
  onExportCsv,
  onExportXlsx,
}: WidgetCardProps) {
  const isKpi = spec.type === 'kpi_card';
  const accent = getTypeAccent(spec.type);
  const featured = spec.featured;

  return (
    <motion.div
      variants={widgetVariants}
      style={{
        gridColumn: `span ${colSpan}`,
        gridRow: featured ? 'span 2' : undefined,
      }}
      className={`group/widget rounded-[20px] overflow-hidden flex flex-col transition-all duration-300
        ${isCrossFilterSource
          ? 'widget-card-active bg-white/95'
          : isFiltered
            ? 'widget-card opacity-40 scale-[0.98]'
            : 'widget-card'
        }`}
    >
      {/* Animated gradient accent bar */}
      <div
        className="h-1.5 w-full shrink-0 accent-bar"
        style={{
          background: isCrossFilterSource
            ? 'linear-gradient(90deg, #6366f1, #8b5cf6, #06b6d4, #6366f1)'
            : `linear-gradient(90deg, ${accent}, ${accent}bb, ${accent})`,
          backgroundSize: '200% 100%',
        }}
      />

      {/* Card header (non-KPI only) */}
      {!isKpi && (
        <div className="px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{
                background: accent,
                boxShadow: `0 0 12px ${accent}40, 0 0 0 4px ${accent}15`,
              }}
            />
            <h3 className="text-sm font-bold text-slate-800 tracking-tight truncate">
              {spec.title}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {(onExportCsv || onExportXlsx) && (
              <span className="flex items-center gap-1 opacity-0 group-hover/widget:opacity-100 transition-opacity duration-300">
                {onExportCsv && (
                  <button
                    onClick={onExportCsv}
                    className="p-2 rounded-xl hover:bg-slate-100/80 text-slate-400 hover:text-slate-600 transition-all hover:scale-110"
                    title="Export CSV"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                  </button>
                )}
                {onExportXlsx && (
                  <button
                    onClick={onExportXlsx}
                    className="p-2 rounded-xl hover:bg-slate-100/80 text-slate-400 hover:text-slate-600 transition-all hover:scale-110"
                    title="Export Excel"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </button>
                )}
              </span>
            )}
            {isCrossFilterSource && (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-indigo-500/10 text-indigo-600 border border-indigo-500/15 backdrop-blur-sm">
                Filtering
              </span>
            )}
          </div>
        </div>
      )}

      <div className={`flex-1 ${isKpi ? 'p-6' : 'px-6 pb-5 pt-0'}`}>{children}</div>
    </motion.div>
  );
}

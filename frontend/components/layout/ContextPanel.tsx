'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

interface ContextPanelProps {
  children: React.ReactNode;
  /** Minimum width in px when not collapsed (default: 180) */
  minWidth?: number;
  /** Maximum width in px (default: 400) */
  maxWidth?: number;
  /** Default width in px (default: 240) */
  defaultWidth?: number;
}

export default function ContextPanel({
  children,
  minWidth = 180,
  maxWidth = 400,
  defaultWidth = 240,
}: ContextPanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging, minWidth, maxWidth]);

  return (
    <div
      ref={panelRef}
      className="relative h-full flex-shrink-0 bg-soft border-r border-line overflow-hidden transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? 0 : width }}
    >
      {/* Content */}
      {!collapsed && (
        <div className="h-full overflow-y-auto overflow-x-hidden scrollbar-thin" style={{ width }}>
          {children}
        </div>
      )}

      {/* Resize handle */}
      {!collapsed && (
        <div
          className={`
            absolute top-0 right-0 w-1 h-full cursor-col-resize z-10
            hover:bg-ocean/20 transition-colors
            ${isDragging ? 'bg-ocean/30' : ''}
          `}
          onMouseDown={onMouseDown}
        />
      )}

      {/* Collapse/expand toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={`
          absolute top-3 z-20 w-5 h-5 rounded-full
          bg-raised border border-line text-ink-3
          flex items-center justify-center
          text-[10px] font-mono
          hover:border-line-strong hover:text-ink-2 transition-colors
          ${collapsed ? '-right-2.5 translate-x-full' : 'right-1'}
        `}
        title={collapsed ? 'Expand panel' : 'Collapse panel'}
      >
        {collapsed ? '>' : '<'}
      </button>
    </div>
  );
}

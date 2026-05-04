'use client';

import { useRef, useEffect, useCallback } from 'react';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { sql } from '@codemirror/lang-sql';
import { python } from '@codemirror/lang-python';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

interface CellEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'sql' | 'python' | 'markdown';
  onRun?: () => void;
  onFocus?: () => void;
  /** Called once with insert function — use to register for external text insertion */
  onReady?: (insert: (text: string) => void) => void;
  placeholder?: string;
  readOnly?: boolean;
}

// Minimal light theme that matches the Clarion design
const lightTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: '#0d9488',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: 'none',
    color: '#94a3b8',
    fontSize: '11px',
    minWidth: '36px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: '#475569',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(99, 102, 241, 0.04)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#0d9488',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(99, 102, 241, 0.12) !important',
  },
  '.cm-placeholder': {
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  '.cm-scroller': {
    overflow: 'visible',
  },
});

export default function CellEditor({
  value,
  onChange,
  language,
  onRun,
  onFocus,
  onReady,
  placeholder = '',
  readOnly = false,
}: CellEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  const onReadyRef = useRef(onReady);

  // Keep refs fresh
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  onReadyRef.current = onReady;

  const getLangExtension = useCallback(() => {
    switch (language) {
      case 'sql': return sql();
      case 'python': return python();
      default: return [];
    }
  }, [language]);

  useEffect(() => {
    if (!containerRef.current) return;

    const runKeymap = keymap.of([
      {
        key: 'Shift-Enter',
        run: () => {
          onRunRef.current?.();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        lightTheme,
        keymap.of([...defaultKeymap, indentWithTab]),
        runKeymap,
        getLangExtension(),
        syntaxHighlighting(defaultHighlightStyle),
        placeholderExt(placeholder),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.focusChanged && update.view.hasFocus) {
            onFocus?.();
          }
        }),
        EditorView.editable.of(!readOnly),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    // Register insert callback for external text insertion (e.g., schema sidebar)
    onReadyRef.current?.((text: string) => {
      const v = viewRef.current;
      if (!v) return;
      const pos = v.state.selection.main.head;
      v.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
      });
      v.focus();
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only recreate on language change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // Sync external value changes (e.g., from server) without recreating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="w-full" />;
}

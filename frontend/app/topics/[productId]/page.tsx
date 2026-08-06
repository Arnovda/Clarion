'use client';

/**
 * /topics/[productId] — the topic-first front door.
 *
 * Two layers on one URL, not two pages:
 *   • the TOPIC layer (default) — the business user's home for a subject
 *     area. No SQL, no counts of tables, no warehouse vocabulary.
 *   • the MANAGE layer (`?manage=1`) — everything technical, analyst+ only.
 *
 * `?manage=1` rather than a route so the back button and a pasted link both
 * work, and so entering the mode is a cross-fade in place rather than a
 * navigation: the user keeps their place, which is the whole reason the
 * technical surface is a mode and not a destination.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { canCurate, isAdminRole, useRole } from '@/lib/role';
import { Skeleton } from '@/components/ui/Skeleton';
import TopicLayer from '@/components/topics/TopicLayer';
import ManageLayer from '@/components/topics/ManageLayer';
import type { FullDataProduct, ProductKpi } from '@/app/products/types';
import type { ManageTab, TableSubTab, Topic } from '@/app/topics/types';

/** Matches the `--dur-*` tokens; the transform runs slightly longer than the fade. */
const FADE_MS = 260;
const MOVE_MS = 320;

export default function TopicPage({ params }: { params: { productId: string } }) {
  const productId = Number(params.productId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = useRole();
  const curator = canCurate(role);
  const admin = isAdminRole(role);

  const [topic, setTopic] = useState<Topic | null>(null);
  const [detail, setDetail] = useState<FullDataProduct | null>(null);
  const [kpis, setKpis] = useState<ProductKpi[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Manage-mode UI state. `sqlOpen` deliberately resets on exit — leaving
  // SQL expanded across a mode switch means the next person to open Manage
  // mode is looking at SQL they didn't ask for.
  const [tab, setTab] = useState<ManageTab>('tables');
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [subTab, setSubTab] = useState<TableSubTab>('built');
  const [sqlOpen, setSqlOpen] = useState(false);

  const wantManage = searchParams.get('manage') === '1';
  // A viewer who lands on ?manage=1 (bookmark, shared link) gets the topic
  // page, not an error — the mode simply does not exist for them.
  const manage = wantManage && curator;

  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // ── Cross-fade bookkeeping ───────────────────────────────────────────
  // The manage layer must be IN THE DOM before it can animate in, and must
  // stay there while it animates out — so mounting is tracked separately
  // from the mode itself. `entered` flips one frame after mount, which is
  // what gives the browser a start value to transition from.
  const [manageMounted, setManageMounted] = useState(manage);
  const [entered, setEntered] = useState(manage);
  useEffect(() => {
    if (manage) {
      setManageMounted(true);
      if (reduceMotion) { setEntered(true); return; }
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    if (reduceMotion) { setManageMounted(false); return; }
    const t = setTimeout(() => setManageMounted(false), MOVE_MS);
    return () => clearTimeout(t);
  }, [manage, reduceMotion]);

  const loadTopic = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}/topic`);
      setTopic(res.data.data as Topic);
    } catch (err) {
      const ax = err as { response?: { status?: number } };
      setLoadError(ax?.response?.status === 404 ? 'not-found' : 'error');
    }
  }, [productId]);

  const loadManageData = useCallback(async () => {
    try {
      const [d, k] = await Promise.all([
        api.get(`/products/${productId}`),
        api.get(`/products/${productId}/kpis`),
      ]);
      setDetail(d.data.data as FullDataProduct);
      setKpis((k.data.data ?? []) as ProductKpi[]);
    } catch { /* the manage layer renders its own loading state */ }
  }, [productId]);

  useEffect(() => {
    if (!Number.isFinite(productId) || productId <= 0) { setLoadError('not-found'); return; }
    void loadTopic();
  }, [productId, loadTopic]);

  // The heavy payload is only fetched when the user actually opens Manage
  // mode — a viewer never pays for it, and neither does a curator who came
  // to read the topic page.
  const manageLoaded = useRef(false);
  useEffect(() => {
    if (!manage || manageLoaded.current) return;
    manageLoaded.current = true;
    void loadManageData();
  }, [manage, loadManageData]);

  const enterManage = useCallback((target?: 'quality') => {
    if (!curator) return;
    if (target) setTab(target);
    const next = new URLSearchParams(searchParams.toString());
    next.set('manage', '1');
    router.replace(`/topics/${productId}?${next.toString()}`, { scroll: false });
  }, [curator, productId, router, searchParams]);

  const exitManage = useCallback(() => {
    setSqlOpen(false);
    const next = new URLSearchParams(searchParams.toString());
    next.delete('manage');
    const qs = next.toString();
    router.replace(qs ? `/topics/${productId}?${qs}` : `/topics/${productId}`, { scroll: false });
  }, [productId, router, searchParams]);

  // Esc leaves Manage mode. Ignored while a text field has focus so it can't
  // steal the key from an inline editor mid-edit.
  useEffect(() => {
    if (!manage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (el as HTMLElement | null)?.isContentEditable) return;
      exitManage();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manage, exitManage]);

  const refreshAll = useCallback(() => {
    void loadTopic();
    void loadManageData();
  }, [loadTopic, loadManageData]);

  const transition = useMemo(() => (
    reduceMotion
      ? undefined
      : { transition: `opacity ${FADE_MS}ms var(--ease), transform ${MOVE_MS}ms var(--ease)` }
  ), [reduceMotion]);

  if (loadError === 'not-found') {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-sm text-center">
          <h1 className="font-display text-[22px] text-ink">This topic doesn&apos;t exist</h1>
          <p className="mt-2 text-[13.5px] text-muted">
            It may have been deleted, or the link may be wrong.
          </p>
          <button
            type="button"
            onClick={() => router.push('/home')}
            className="mt-4 rounded-sm bg-ocean px-3.5 py-2 text-[13px] font-medium text-white hover:bg-ocean-hover"
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (!topic) return <TopicSkeleton />;

  return (
    <div className="relative flex-1 overflow-hidden bg-bg">
      {/* Topic layer */}
      <div
        aria-hidden={manage}
        style={{
          ...transition,
          opacity: manage ? 0 : 1,
          transform: manage && !reduceMotion ? 'scale(0.985) translateY(-10px)' : 'none',
        }}
        className={cn('absolute inset-0', manage && 'pointer-events-none')}
      >
        <TopicLayer topic={topic} canManage={curator} onManage={enterManage} />
      </div>

      {/* Manage layer */}
      {manageMounted && (
        <div
          aria-hidden={!manage}
          style={{
            ...transition,
            opacity: entered ? 1 : 0,
            transform: entered || reduceMotion ? 'none' : 'scale(1.015) translateY(12px)',
          }}
          className={cn('absolute inset-0', !manage && 'pointer-events-none')}
        >
          <ManageLayer
            topic={topic}
            detail={detail}
            kpis={kpis}
            isAdmin={admin}
            tab={tab}
            onTab={setTab}
            selectedTableId={selectedTableId}
            onSelectTable={setSelectedTableId}
            subTab={subTab}
            onSubTab={setSubTab}
            sqlOpen={sqlOpen}
            onSqlOpen={setSqlOpen}
            onExit={exitManage}
            onChanged={refreshAll}
            onDeleted={() => router.push('/home')}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Skeletons in the shape of the final rows — never a spinner in the middle
 * of an empty topic page. The page's promise is "here is your subject
 * area"; a spinner promises nothing.
 */
function TopicSkeleton() {
  return (
    <div className="flex-1 overflow-hidden px-10 pt-[60px]">
      <div className="mx-auto flex max-w-[720px] flex-col items-center gap-[30px]">
        <div className="flex flex-col items-center gap-2.5">
          <Skeleton width={44} height={44} rounded="md" />
          <Skeleton width={180} height={38} rounded="sm" />
          <Skeleton width={420} height={16} rounded="sm" />
        </div>
        <Skeleton width="100%" height={52} rounded="md" />
        <div className="flex w-full flex-col gap-2">
          <Skeleton width={80} height={10} rounded="xs" />
          <Skeleton width="100%" height={52} rounded="sm" />
          <Skeleton width="100%" height={52} rounded="sm" />
          <Skeleton width="100%" height={52} rounded="sm" />
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * /topics/[productId] — the topic-first front door.
 *
 * The business user's home for a subject area: what can I ask, what can I
 * find out, is it current, can I trust it. No SQL, no counts of tables, no
 * warehouse vocabulary. Everything technical is the catalog's subject page
 * (`/catalog?productId=`), one door away for curators.
 *
 * Manage mode (`?manage=1`, a second layer on this URL) was retired on
 * 2026-09-23 — it overlapped with the catalog and sat behind a door nobody
 * found. An old link with `?manage=1` still lands: a curator is sent to the
 * subject in the catalog, a viewer gets the topic page as before.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import { canCurate, useRole } from '@/lib/role';
import { Skeleton } from '@/components/ui/Skeleton';
import TopicLayer from '@/components/topics/TopicLayer';
import type { Topic } from '@/app/topics/types';

export default function TopicPage({ params }: { params: { productId: string } }) {
  const productId = Number(params.productId);
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = useRole();
  const curator = canCurate(role);

  const [topic, setTopic] = useState<Topic | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The retired mode's links keep working: the subject in the catalog is
  // where its tables, metrics, quality and history live now.
  const wantManage = searchParams.get('manage') === '1';
  useEffect(() => {
    if (wantManage && curator && Number.isFinite(productId) && productId > 0) {
      router.replace(`/catalog?productId=${productId}`);
    }
  }, [wantManage, curator, productId, router]);

  const loadTopic = useCallback(async () => {
    try {
      const res = await api.get(`/products/${productId}/topic`);
      setTopic(res.data.data as Topic);
    } catch (err) {
      const ax = err as { response?: { status?: number } };
      setLoadError(ax?.response?.status === 404 ? 'not-found' : 'error');
    }
  }, [productId]);

  useEffect(() => {
    if (!Number.isFinite(productId) || productId <= 0) { setLoadError('not-found'); return; }
    void loadTopic();
  }, [productId, loadTopic]);

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
      <TopicLayer topic={topic} canManage={curator} />
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

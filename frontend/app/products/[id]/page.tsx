'use client';

/**
 * /products/[id] — Build's operator surface for one product.
 *
 * Mounts <ProductRootPanel> — Overview + Tables tabs, the per-table
 * notebook, and the Deploy all / Refresh / Refine / Delete actions.
 * Admin/analyst only — same role gate as /products. (An earlier version
 * of this comment claimed 6 tabs; the 2026-08-18 slimming moved Schema
 * diagram / Data flow / KPIs / Quality to the topic's Manage mode.)
 *
 * Navigation flow:
 *   - From BuildDashboard at /products: click a row → land here.
 *   - From /catalog ProductFullView "Open in Build →" button: also lands
 *     here (admin/analyst only).
 *   - "Back" returns the user to /products (the workshop dashboard).
 *
 * Previously this route was a 5-line redirect to /catalog — that was the
 * old behaviour where every product detail surface lived inside /catalog.
 * After Phase 5/6/7 the operator surface lives here and Catalog is
 * consumer-only.
 */

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import RequireRole from '@/components/RequireRole';
import ProductRootPanel from '@/components/products/ProductRootPanel';

export default function ProductDetailPage({ params }: { params: { id: string } }) {
  const productId = Number(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTable = searchParams.get('table');
  const [valid] = useState(() => Number.isFinite(productId) && productId > 0);
  const handleDeleted = useCallback(() => {
    router.push('/products');
  }, [router]);

  // Sanity-check the route param. Bad ids (NaN, negative) bounce back to
  // the dashboard so a stray bookmark or URL-typo doesn't render a
  // half-broken panel.
  useEffect(() => {
    if (!valid) router.replace('/products');
  }, [valid, router]);
  if (!valid) return null;

  return (
    <RequireRole roles={['admin', 'analyst']}>
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Sticky breadcrumb / back to workshop */}
        <div className="bg-softer border-b border-line px-6 py-2 flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => router.push('/products')}
            className="inline-flex items-center gap-1 px-2 py-1 -ml-2 text-[12px] font-medium text-muted hover:text-ink rounded hover:bg-soft transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2} />
            Back to Build
          </button>
          <span className="text-[10.5px] font-mono text-muted-2 tracking-[0.12em] uppercase ml-auto">
            Operator surface
          </span>
        </div>
        <ProductRootPanel
          productId={productId}
          onDeleted={handleDeleted}
          showBackButton={false}
          embedAskAI={false}
          initialTableName={initialTable ?? undefined}
        />
      </div>
    </RequireRole>
  );
}

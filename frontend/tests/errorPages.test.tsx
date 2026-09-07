/**
 * 9-1 — the error and not-found boundaries exist and offer a way back.
 * 9-3 — a viewer's home carries no operator door.
 *
 * The 9-3 half used to render `ViewerHome`, the second shape /home kept for
 * viewers. That shape is gone: /home is now ONE page for every role (the
 * standing brief), so the invariant is asserted against the real page with
 * a viewer's token. It matters more now, not less — with one page there is
 * no separate viewer surface to protect the rule for us.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NotFound from '../app/not-found';
import ErrorPage from '../app/error';
import HomePage from '../app/home/page';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (p: string) => push(p) }) }));
// next/dynamic is used for the pulse editor and the investigation panel —
// neither is on screen at rest, so a null component is the right stub.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../lib/auth', () => ({ getTokenPayload: () => ({ role: 'viewer', sub: 1 }) }));

const summary = {
  health: { overall: 12, freshness: 0, definitions: 0, quality: 0, pipelines: 0 },
  quality: { profiledTables: { passing: 0, total: 0 }, activeRules: { passing: 0, total: 0 } },
  freshness: {
    sources: { fresh: 1, total: 1 }, products: { fresh: 0, total: 1 },
    stale: [], staleProducts: [{ id: 1, name: 'Sales', status: 'success', lastRefreshedAt: null, isStale: true }],
    allSources: [{ id: 1, name: 'Exact', connectorType: 'exactonline', lastSyncedAt: '2026-09-05T10:00:00Z', lastSyncStatus: 'succeeded', isStale: false }],
    allProducts: [],
  },
  definitions: { tables: { defined: 12, total: 40 }, columns: { defined: 0, total: 0 }, relationships: { approved: 0, total: 0 }, pendingReview: { tables: 3, columns: 0, relationships: 0, total: 3 } },
  pipelines: { runsThisWeek: 4, successCount: 2, failureCount: 2, activeNow: 0, successRate: 0.5 },
  dashboards: [{ id: 7, title: 'Cash', starred: true, updatedAt: null }],
  recentQuestions: [],
  alerts: [],
};

const brief = {
  id: 1, brief_date: '2026-09-07',
  content: {
    summary: 'A quiet start to the week.',
    bullets: [{ kind: 'movement', label: 'Open receivables', delta: '+29%', detail: 'Overdue receivables rose €19k in nine days.' }],
    suggested_focus: 'Check receivables.', confidence: 'high',
  },
  opened_at: null, emailed_at: null, created_at: '2026-09-07T06:00:00Z',
};

vi.mock('../lib/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.startsWith('/home/summary')) return Promise.resolve({ data: { data: summary } });
      if (url.startsWith('/briefs/today')) return Promise.resolve({ data: { data: brief } });
      if (url.startsWith('/pulse/state')) return Promise.resolve({ data: { data: [] } });
      if (url.startsWith('/query/starters')) return Promise.resolve({ data: { data: { starters: [] } } });
      if (url.startsWith('/users/profile')) return Promise.resolve({ data: { data: { display_name: 'Ann Peeters' } } });
      return Promise.resolve({ data: { data: null } });
    }),
    post: vi.fn(() => Promise.resolve({ data: { data: {} } })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

describe('not-found and error boundaries (9-1)', () => {
  it('404 offers home and Ask AI', () => {
    render(<NotFound />);
    expect(screen.getByRole('link', { name: 'Go to home' }).getAttribute('href')).toBe('/home');
    expect(screen.getByRole('link', { name: 'Ask a question' }).getAttribute('href')).toBe('/query');
  });

  it('the error page shows the digest, never the message, and Try again calls reset', () => {
    const reset = vi.fn();
    const err = Object.assign(new Error('SELECT secret FROM customers'), { digest: 'abc123' });
    render(<ErrorPage error={err} reset={reset} />);
    expect(screen.getByText(/reference abc123/)).toBeTruthy();
    expect(screen.queryByText(/SELECT secret/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('the home page as a viewer (9-3)', () => {
  beforeEach(() => { push.mockClear(); });

  it('leads with the business, carries no operator vocabulary, and asks', async () => {
    render(<HomePage />);

    // The lead is a sentence about the company, not a score about us.
    const lead = await screen.findByRole('heading', { level: 1 });
    expect(lead.textContent).toContain('Overdue receivables rose €19k in nine days.');
    expect(lead.textContent).not.toMatch(/\d+\s*\/\s*100/);

    // The operator vocabulary and its doors are absent — the whole point of
    // replacing the health ring and the attention feed.
    expect(screen.queryByText(/Definitions/)).toBeNull();
    expect(screen.queryByText(/pipeline/i)).toBeNull();
    expect(screen.queryByText(/AI suggestion/)).toBeNull();
    expect(screen.queryByText(/Data health/i)).toBeNull();
    expect(screen.queryByText(/sub-score/i)).toBeNull();
    // A viewer cannot trigger a refresh, so they are not offered one.
    expect(screen.queryByText('Refresh now')).toBeNull();

    // Their own things are here.
    expect(screen.getByText('Cash')).toBeTruthy();

    // The question box asks, with the question carried along.
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'who owes me money' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(push).toHaveBeenCalledWith('/query?q=who%20owes%20me%20money&autoSubmit=1');
  });

  it('states how current the data is without scoring it', async () => {
    render(<HomePage />);
    await waitFor(() => expect(screen.getByText(/includes data through/)).toBeTruthy());
    expect(screen.getByText(/waiting on a refresh/)).toBeTruthy();
  });
});

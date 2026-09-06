/**
 * 9-1 — the error and not-found boundaries exist and offer a way back.
 * 9-3 — the viewer's home carries no operator door.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import NotFound from '../app/not-found';
import ErrorPage from '../app/error';
import { ViewerHome } from '../app/home/ViewerHome';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('../lib/api', () => ({ default: { get: vi.fn(() => Promise.resolve({ data: { data: null } })) } }));

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

describe('the viewer home (9-3)', () => {
  const summary = {
    health: { overall: 12, freshness: 0, definitions: 0, quality: 0, pipelines: 0 },
    quality: { profiledTables: { passing: 0, total: 0 }, activeRules: { passing: 0, total: 0 } },
    freshness: {
      sources: { fresh: 1, total: 1 }, products: { fresh: 0, total: 1 },
      stale: [], staleProducts: [{ id: 1, name: 'Sales', status: 'success', lastRefreshedAt: null, isStale: true }],
      allSources: [{ id: 1, name: 'Exact', connectorType: 'exactonline', lastSyncedAt: new Date().toISOString(), lastSyncStatus: 'succeeded', isStale: false }],
      allProducts: [],
    },
    definitions: { tables: { defined: 12, total: 40 }, columns: { defined: 0, total: 0 }, relationships: { approved: 0, total: 0 }, pendingReview: { tables: 3, columns: 0, relationships: 0, total: 3 } },
    pipelines: { runsThisWeek: 4, successCount: 2, failureCount: 2, activeNow: 0, successRate: 0.5 },
    dashboards: [{ id: 7, title: 'Cash', starred: true, updatedAt: null }],
    recentQuestions: [],
    alerts: [],
  };

  it('shows the brief, the question box, dashboards and subjects — and no operator door', () => {
    const onJump = vi.fn();
    render(<ViewerHome summary={summary} userName="Ann" today="Sunday" onJump={onJump} />);
    expect(screen.getByText('Welcome back, Ann')).toBeTruthy();
    expect(screen.getByText(/Data as of/)).toBeTruthy();
    expect(screen.getByText(/1 item waiting on a refresh/)).toBeTruthy();
    expect(screen.getByText('Cash')).toBeTruthy();
    // The operator vocabulary and its doors are absent.
    expect(screen.queryByText(/Definitions/)).toBeNull();
    expect(screen.queryByText(/pipeline/i)).toBeNull();
    expect(screen.queryByText(/AI suggestion/)).toBeNull();
    expect(screen.queryByText(/Data health/)).toBeNull();
    // The question box asks, with the question carried along.
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'who owes me money' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onJump).toHaveBeenCalledWith('/query?q=who%20owes%20me%20money&autoSubmit=1');
    fireEvent.click(screen.getByRole('button', { name: /Subjects/ }));
    expect(onJump).toHaveBeenCalledWith('/subjects');
  });
});

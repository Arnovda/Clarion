/**
 * P1-7 — the first COMPONENT test this frontend has had. EmptyState is
 * chosen deliberately: it is small, widely used, and exercises the whole
 * harness (JSX transform, jsdom, Testing Library, the `@/` alias via
 * next/link's import chain) without dragging in app state.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmptyState from '../components/EmptyState';

describe('EmptyState', () => {
  it('renders eyebrow, title, description and a primary action link', () => {
    render(
      <EmptyState
        eyebrow="DASHBOARDS"
        title="Nothing here yet"
        description="Create your first dashboard to get going."
        action={{ label: 'Create dashboard', href: '/dashboards' }}
      />,
    );
    expect(screen.getByText('DASHBOARDS')).toBeTruthy();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Create dashboard' });
    expect(link.getAttribute('href')).toBe('/dashboards');
  });

  it('renders an onClick action as a button, not a link', () => {
    render(<EmptyState title="T" action={{ label: 'Do it', onClick: () => undefined }} />);
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('children replace the action buttons', () => {
    render(
      <EmptyState title="T" action={{ label: 'Hidden', href: '/x' }}>
        <div>custom body</div>
      </EmptyState>,
    );
    expect(screen.getByText('custom body')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Hidden' })).toBeNull();
  });
});

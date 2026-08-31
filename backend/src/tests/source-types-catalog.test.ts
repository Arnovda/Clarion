/**
 * Every connector is offered to every tenant.
 *
 * Excel and SharePoint shipped behind the August release train, so the catalog
 * filtered them out for a tenant the operator had not switched on. That gate is
 * gone: with no customers there is no audience to protect, and a switch
 * guarding nobody is a code path that can only ever be wrong. This file is what
 * is left of that one — it pins the DECISION, so re-introducing a gate is a
 * visible act rather than something that creeps back in.
 *
 * If a future connector does need gating, this test is the thing that should go
 * red first. Change it deliberately; do not delete it quietly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { request, registerUser } from './helpers';

describe('source-types catalog', () => {
  let agent: Awaited<ReturnType<typeof request>>;
  let user: Awaited<ReturnType<typeof registerUser>>;

  beforeEach(async () => {
    agent = await request();
    user = await registerUser({ companyName: `CatalogCo-${Date.now()}` });
  });

  async function types(): Promise<string[]> {
    const res = await agent.get('/api/source-types').set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    return (res.body.data as { type: string }[]).map((t) => t.type);
  }

  it('offers the spreadsheet connectors to a brand-new tenant', async () => {
    // A tenant that has just registered, with nothing switched on for it.
    const listed = await types();
    expect(listed).toContain('excel');
    expect(listed).toContain('sharepoint');
  });

  it('still offers the established connectors', async () => {
    const listed = await types();
    expect(listed).toContain('exactonline');
    expect(listed).toContain('odoo');
  });

  it('ships the config schema each connector needs to render its form', async () => {
    // The wizard AND the edit dialog both read a connection's config schema
    // from this catalog, which is why removing a type from it was never safe
    // while a tenant might already be using it.
    const res = await agent.get('/api/source-types').set('Authorization', `Bearer ${user.token}`);
    const excel = (res.body.data as Array<{ type: string; configSchema?: unknown }>)
      .find((t) => t.type === 'excel');
    expect(excel?.configSchema).toBeTruthy();
  });
});

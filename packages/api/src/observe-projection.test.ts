/**
 * Compact observation projection, end to end through the service (FakeEngine).
 *
 * Projection is service-layer response shaping: the engine still observes the
 * whole page, refs stay minted over the full list (a filtered-out ref must
 * remain actionable), and the response carries the projection echo with
 * matched/total so a subset can never read as the whole page.
 */
import { FakeEngine } from '@agentbrowser/testkit';
import { describe, expect, it } from 'vitest';
import { AgentBrowserService } from './service';

/** A dialog+table page shaped like the OVH Manager fixture from the handoff. */
function seedOvhLike(fakePage: ReturnType<FakeEngine['getFakePage']>, navLinks = 12) {
  fakePage?.seedElements([
    ...Array.from({ length: navLinks }, (_, i) => ({
      ref: `e1_${i}`,
      role: 'link',
      name: `Nav ${i}`,
    })),
    {
      ref: `e1_${navLinks}`,
      role: 'dialog',
      name: 'Manage user policy',
      depth: 0,
    },
    {
      ref: `e1_${navLinks + 1}`,
      role: 'checkbox',
      name: 'Object Storage read',
      depth: 1,
      checked: true,
    },
    { ref: `e1_${navLinks + 2}`, role: 'checkbox', name: 'Object Storage write', depth: 1 },
    { ref: `e1_${navLinks + 3}`, role: 'button', name: 'Confirm', depth: 1 },
    { ref: `e1_${navLinks + 4}`, role: 'button', name: 'Cancel', depth: 1 },
    { ref: `e1_${navLinks + 5}`, role: 'row', name: 'user-1-prod' },
    { ref: `e1_${navLinks + 6}`, role: 'button', name: 'user-1-prod kebab' },
  ]);
}

async function setup(navLinks = 12) {
  const engine = new FakeEngine();
  const service = new AgentBrowserService({ engine });
  const session = await service.createSession({ tenantId: 't1' });
  const pageId = (await service.createPage(session.sessionId)).pageId;
  const engineSessionId = engine.getSessionIds()[0];
  if (engineSessionId === undefined) throw new Error('no engine session');
  const fakePage = engine.getFakePage(engineSessionId, pageId);
  if (!fakePage) throw new Error('no fake page');
  seedOvhLike(fakePage, navLinks);
  return { service, session, pageId, fakePage };
}

describe('observe compact projection', () => {
  it('projects by roles end to end and echoes matched/total', async () => {
    const { service, session, pageId } = await setup();

    const result = await service.observe(session.sessionId, pageId, {
      roles: ['checkbox'],
    });

    expect(result.elements.map((e) => e.name)).toEqual([
      'Object Storage read',
      'Object Storage write',
    ]);
    expect(result.projection).toMatchObject({ roles: ['checkbox'], matched: 2, total: 19 });
    // Checked state rides along in the compact core.
    expect(result.elements[0]).toMatchObject({ checked: true });
  });

  it('scopes to a dialog subtree and cuts the nav noise entirely', async () => {
    const { service, session, pageId } = await setup();

    const full = await service.observe(session.sessionId, pageId, {});
    const dialogRef = full.elements.find((e) => e.role === 'dialog')?.ref;
    expect(dialogRef).toBeDefined();

    const scoped = await service.observe(session.sessionId, pageId, {
      scopeRef: dialogRef,
    });

    expect(scoped.elements.map((e) => e.name)).toEqual([
      'Manage user policy',
      'Object Storage read',
      'Object Storage write',
      'Confirm',
      'Cancel',
    ]);
    expect(scoped.projection).toMatchObject({ scopeRef: dialogRef, matched: 5, total: 19 });
    expect(scoped.truncated).toBe(false);
  });

  it('rejects a projection from a malformed scope ref as INVALID_REQUEST', async () => {
    const { service, session, pageId } = await setup();

    const error = await service
      .observe(session.sessionId, pageId, { scopeRef: 'button.submit' })
      .catch((e: unknown) => e as { code: string });

    expect(error.code).toBe('INVALID_REQUEST');
  });

  it('rejects unknown projection options rather than dropping them', async () => {
    const { service, session, pageId } = await setup();

    const error = await service
      .observe(session.sessionId, pageId, { includeFields: ['bounds'] })
      .catch((e: unknown) => e as { code: string; message: string });

    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('includeFields');
  });

  it('finds and scopes a dialog past a 300-element priority-sorted window', async () => {
    // >300 elements: the normalizer priority-sorts the retained list, so the
    // dialog children must still be reachable by scope regardless of sort
    // position. Seed 300 nav links plus the dialog subtree at the tail.
    const { service, session, pageId } = await setup(301);

    const scoped = await service.observe(session.sessionId, pageId, {
      roles: ['checkbox', 'dialog'],
    });

    expect(scoped.elements.map((e) => e.name)).toEqual([
      'Manage user policy',
      'Object Storage read',
      'Object Storage write',
    ]);
    expect(scoped.projection).toMatchObject({ matched: 3 });
  });

  it('a ref filtered out of the response remains actionable', async () => {
    const { service, session, pageId } = await setup();

    const scoped = await service.observe(session.sessionId, pageId, { roles: ['checkbox'] });
    expect(scoped.elements.some((e) => e.name === 'Confirm')).toBe(false);

    // Confirm was never in the projected response; acting on its ref (from
    // the full observation semantics) must still resolve and click.
    const full = await service.observe(session.sessionId, pageId, {});
    const confirmRef = full.elements.find((e) => e.name === 'Confirm')?.ref;
    expect(confirmRef).toBeDefined();

    const acted = (await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: confirmRef },
    })) as { status: string; newRevision: number };
    expect(acted.status).toBe('success');
  });

  it('repeated compact observes without mutation yield identical refs; a mutation renumbers them by revision', async () => {
    const { service, session, pageId } = await setup();

    const first = await service.observe(session.sessionId, pageId, { roles: ['checkbox'] });
    const second = await service.observe(session.sessionId, pageId, { roles: ['checkbox'] });
    expect(second.elements.map((e) => e.ref)).toEqual(first.elements.map((e) => e.ref));
    expect(second.projection).toEqual(first.projection);

    // A mutating act bumps the revision: refs renumber (e1 -> e2) by ADR-004,
    // but the projected match set stays stable by identity.
    await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: first.elements[0]?.ref },
    });
    const third = await service.observe(session.sessionId, pageId, { roles: ['checkbox'] });
    expect(third.revision).toBeGreaterThan(second.revision);
    expect(third.elements.map((e) => e.name)).toEqual(first.elements.map((e) => e.name));
    expect(third.elements.some((e) => e.ref.startsWith('e1_'))).toBe(false);
  });

  it('keeps degraded disclosure under a filter', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const engineSessionId = engine.getSessionIds()[0];
    const fakePage = engine.getFakePage(engineSessionId ?? '', pageId);
    fakePage?.seedElements([{ ref: 'e1_0', role: 'checkbox', name: 'A' }]);

    const result = await service.observe(session.sessionId, pageId, { roles: ['checkbox'] });
    // FakeEngine is not degraded; assert the flags pass through untouched
    // alongside the projection echo (they ride the page-level spread).
    expect(result.projection).toMatchObject({ matched: 1 });
    expect(result.degraded).toBeUndefined();
  });

  it('limit windows matches with a page-ordinal continuation cursor', async () => {
    const { service, session, pageId } = await setup(4);

    const result = await service.observe(session.sessionId, pageId, {
      roles: ['link'],
      limit: 2,
    });

    expect(result.elements).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.continuation).toEqual({ nextOrdinal: 2, remaining: 2 });

    const resumed = await service.observe(session.sessionId, pageId, {
      roles: ['link'],
      limit: 2,
      continueFrom: result.continuation?.nextOrdinal,
    });
    expect(resumed.elements.map((e) => e.name)).toEqual(['Nav 2', 'Nav 3']);
    expect(resumed.continuation).toBeUndefined();
    expect(resumed.truncated).toBe(false);
  });

  it('sinceRevision diffs compose with the projection predicate', async () => {
    const { service, session, pageId, fakePage } = await setup();

    const baseline = await service.observe(session.sessionId, pageId, {});
    // Mutate: flip a checkbox and add a new link.
    fakePage?.setElements([
      ...Array.from({ length: 12 }, (_, i) => ({ ref: `e1_${i}`, role: 'link', name: `Nav ${i}` })),
      { ref: 'e1_12', role: 'dialog', name: 'Manage user policy', depth: 0 },
      { ref: 'e1_13', role: 'checkbox', name: 'Object Storage read', depth: 1 },
      { ref: 'e1_14', role: 'checkbox', name: 'NEW write', depth: 1 },
      { ref: 'e1_15', role: 'button', name: 'Confirm', depth: 1 },
      { ref: 'e1_16', role: 'button', name: 'Cancel', depth: 1 },
      { ref: 'e1_17', role: 'row', name: 'user-1-prod' },
      { ref: 'e1_18', role: 'button', name: 'user-1-prod kebab' },
      { ref: 'e1_19', role: 'link', name: 'NEW link' },
    ]);
    await service.act(session.sessionId, pageId, {
      action: 'click',
      target: { ref: 'e1_1' },
    });
    const changed = await service.observe(session.sessionId, pageId, {});

    const diff = await service.observe(session.sessionId, pageId, {
      sinceRevision: baseline.revision,
      roles: ['checkbox'],
    });

    // The NEW checkbox appears in the diff and survives the filter; under
    // sinceRevision the echo's total counts the changed set.
    expect(diff.elements.some((e) => e.name === 'NEW write')).toBe(true);
    expect(diff.projection).toBeDefined();
    expect(diff.projection?.matched).toBeLessThanOrEqual(diff.projection?.total ?? 0);
    expect(changed.revision).toBeGreaterThan(baseline.revision);
  });

  it('a removed element matching the filter appears in the projected diff', async () => {
    const { service, session, pageId, fakePage } = await setup();

    const baseline = await service.observe(session.sessionId, pageId, {});
    // Replace the page keeping the nav/dialog (same engine refs) but with
    // FRESH engine refs for the new buttons — the checkboxes' engine refs
    // genuinely vanish, so the diff reports them as removed.
    fakePage?.setElements([
      ...Array.from({ length: 12 }, (_, i) => ({ ref: `e1_${i}`, role: 'link', name: `Nav ${i}` })),
      { ref: 'e1_12', role: 'dialog', name: 'Manage user policy', depth: 0 },
      { ref: 'x1_13', role: 'button', name: 'Confirm', depth: 1 },
      { ref: 'x1_14', role: 'button', name: 'Cancel', depth: 1 },
    ]);
    await service.act(session.sessionId, pageId, { action: 'press', key: 'Enter' });

    const diff = await service.observe(session.sessionId, pageId, {
      sinceRevision: baseline.revision,
      roles: ['checkbox'],
    });

    // The removals are the decision-relevant signal: they must surface even
    // though their old-revision refs can never be in the surviving window.
    const removedCheckboxes = (diff.changes ?? []).filter(
      (change) =>
        change.change === 'removed' &&
        (change.properties.element as { old?: { role?: string } }).old?.role === 'checkbox'
    );
    expect(removedCheckboxes.length).toBe(2);
  });

  it('resuming a projection cursor after every match vanished returns empty, not INVALID_REQUEST', async () => {
    const { service, session, pageId, fakePage } = await setup(4);

    const first = await service.observe(session.sessionId, pageId, {
      roles: ['checkbox'],
      limit: 1,
    });
    expect(first.continuation).toBeDefined();

    // All checkboxes disappear; the page moves to a new revision.
    fakePage?.setElements([{ ref: 'e9_0', role: 'button', name: 'Only a button' }]);
    await service.act(session.sessionId, pageId, { action: 'press', key: 'Enter' });

    const resumed = await service.observe(session.sessionId, pageId, {
      roles: ['checkbox'],
      limit: 1,
      continueFrom: first.continuation?.nextOrdinal,
    });

    // The CLI prints this exact resume command on every truncated result:
    // an exhausted cursor is an empty projected view with an honest echo,
    // never a 400 misread as "continueFrom exceeds the element count".
    expect(resumed.elements).toEqual([]);
    expect(resumed.projection).toMatchObject({ matched: 0 });
    expect(resumed.continuation).toBeUndefined();
  });

  it('FakeEngine parity: seeded context reaches observations and survives projection (G1/F8)', async () => {
    const engine = new FakeEngine();
    const service = new AgentBrowserService({ engine });
    const session = await service.createSession({ tenantId: 't1' });
    const pageId = (await service.createPage(session.sessionId)).pageId;
    const engineSessionId = engine.getSessionIds()[0];
    const fakePage = engine.getFakePage(engineSessionId ?? '', pageId);
    fakePage?.seedElements([
      {
        ref: 'e1_0',
        role: 'control',
        name: 'Access: No access',
        context: 'Contents — Repository permissions',
      },
      {
        ref: 'e1_1',
        role: 'control',
        name: 'Access: No access',
        context: 'Pull requests — Repository permissions',
      },
      { ref: 'e1_2', role: 'button', name: 'Submit' },
    ]);

    const full = await service.observe(session.sessionId, pageId, {
      include: ['formControls'],
    });
    expect(full.elements[0]).toMatchObject({
      context: 'Contents — Repository permissions',
    });

    // Context is protected core: a compact projection must not strip the
    // disambiguator from generic-named controls (review G1/F1).
    const projected = await service.observe(session.sessionId, pageId, {
      include: ['formControls'],
      roles: ['control'],
    });
    expect(projected.elements).toHaveLength(2);
    expect(projected.elements.map((e) => e.context)).toEqual([
      'Contents — Repository permissions',
      'Pull requests — Repository permissions',
    ]);
  });
});

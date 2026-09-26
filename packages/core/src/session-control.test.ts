import { describe, expect, it } from 'vitest';
import { SessionControl } from './session-control.js';

function delegated(control = new SessionControl()) {
  const review = control.prepareResume();
  const state = control.delegate(review.epoch);
  return { control, epoch: state.epoch };
}

describe('session control', () => {
  it('finalizes execution while retaining exclusion and replay identity until release', () => {
    const control = new SessionControl();
    const request = { actor: 'operator' as const, operationId: 'publish', fingerprint: 'a' };
    const ticket = control.begin(request);
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.dispatched(ticket);
    control.finalize(ticket, 'completed');
    expect(control.view()).toMatchObject({
      busy: true,
      operation: { status: 'completed', dispatched: true },
    });
    expect(() => control.begin({ actor: 'operator' })).toThrow(/busy/i);
    expect(() => control.prepareResume()).toThrow(/busy/i);
    expect(control.begin(request)).toMatchObject({ replay: { status: 'completed' } });
    expect(() => control.begin({ ...request, fingerprint: 'other' })).toThrow(/different/i);
    // Ownership checks remain available for publication; effects do not.
    expect(() => control.check(ticket)).not.toThrow();
    expect(() => control.dispatched(ticket)).toThrow(/finalized/i);
    control.finish(ticket, 'outcome_unknown');
    expect(control.view().busy).toBe(false);
    expect(control.operation('publish')).toMatchObject({ status: 'completed', dispatched: true });
  });

  it.each(['completed', 'failed', 'outcome_unknown'] as const)(
    'retains finalized %s through repeated finalization, takeover and release',
    (status) => {
      const { control, epoch } = delegated();
      const ticket = control.begin({
        actor: 'agent',
        epoch,
        operationId: 'terminal',
        fingerprint: 'a',
      });
      if ('replay' in ticket) throw new Error('unexpected replay');
      control.dispatched(ticket);
      control.finalize(ticket, status);
      control.finalize(ticket, status);
      control.finalize(ticket, status === 'completed' ? 'failed' : 'completed');
      expect(control.takeover().state).toBe('PAUSE_REQUESTED');
      expect(() => control.check(ticket)).toThrow(/revoked/i);
      control.finish(ticket, 'failed');
      expect(control.operation('terminal')).toMatchObject({ status, dispatched: true });
      expect(control.view()).toMatchObject({ busy: false, state: 'HUMAN_ACTIVE' });
    }
  );

  it('does not finalize or release a current ticket through stale, foreign or copied tickets', () => {
    const control = new SessionControl();
    const old = control.begin({ actor: 'operator', operationId: 'old', fingerprint: 'a' });
    if ('replay' in old) throw new Error('unexpected replay');
    control.finish(old, 'completed');
    const next = control.begin({ actor: 'operator', operationId: 'next', fingerprint: 'b' });
    const foreign = new SessionControl().begin({ actor: 'operator' });
    if ('replay' in next || 'replay' in foreign) throw new Error('unexpected replay');
    for (const invalid of [old, foreign, { ...next }]) {
      control.finalize(invalid, 'failed');
      control.finish(invalid, 'failed');
    }
    expect(control.view()).toMatchObject({ busy: true, operation: { status: 'in_flight' } });
    control.dispatched(next);
    control.finish(next, 'outcome_unknown');
    control.finalize(old, 'failed');
    expect(control.operation('old')?.status).toBe('completed');
    expect(control.operation('next')?.status).toBe('outcome_unknown');
  });

  it('seals anonymous tickets and resets finalization only for a newly admitted ticket', () => {
    const control = new SessionControl();
    const first = control.begin({ actor: 'operator' });
    if ('replay' in first) throw new Error('unexpected replay');
    control.finalize(first, 'completed');
    expect(() => control.dispatched(first)).toThrow(/finalized/i);
    expect(first.didDispatch).toBe(false);
    expect(control.view().busy).toBe(true);
    control.finish(first, 'failed');
    const next = control.begin({ actor: 'operator', operationId: 'next', fingerprint: 'a' });
    if ('replay' in next) throw new Error('unexpected replay');
    control.dispatched(next);
    control.finish(next, 'completed');
    expect(control.operation('next')).toMatchObject({ status: 'completed', dispatched: true });
  });

  it('can finalize a revoked draining ticket without granting permission or reviving a stopped owner', () => {
    const { control, epoch } = delegated();
    const ticket = control.begin({
      actor: 'agent',
      epoch,
      operationId: 'revoked',
      fingerprint: 'a',
    });
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.dispatched(ticket);
    control.stop();
    control.finalize(ticket, 'outcome_unknown');
    expect(control.view()).toMatchObject({ state: 'STOPPED', busy: true });
    expect(() => control.check(ticket)).toThrow(/revoked/i);
    control.finish(ticket, 'completed');
    expect(control.operation('revoked')?.status).toBe('outcome_unknown');
    expect(control.view()).toMatchObject({ state: 'STOPPED', busy: false });
    expect(() => control.begin({ actor: 'operator' })).toThrow(/stopped/i);
  });

  it('starts with human authority and requires a current review to delegate', () => {
    const control = new SessionControl();
    expect(control.view().state).toBe('HUMAN_ACTIVE');
    expect(() => control.delegate(0)).toThrow(/review/i);
    const review = control.prepareResume();
    control.takeover();
    expect(() => control.delegate(review.epoch)).toThrow(/review/i);
  });

  it('revokes immediately but keeps the session draining until the actual operation settles', () => {
    const { control, epoch } = delegated();
    const ticket = control.begin({ actor: 'agent', epoch });
    expect('replay' in ticket).toBe(false);
    if ('replay' in ticket) throw new Error('unexpected replay');
    expect(control.takeover().state).toBe('PAUSE_REQUESTED');
    expect(() => control.check(ticket)).toThrow(/revoked/i);
    expect(() => control.begin({ actor: 'operator' })).toThrow(/busy/i);
    expect(() => control.prepareResume()).toThrow(/busy/i);
    control.finish(ticket, 'completed');
    expect(control.view().state).toBe('HUMAN_ACTIVE');
    expect(() => control.begin({ actor: 'agent', epoch })).toThrow(/revoked/i);
  });

  it('serializes observations and actions, and rejects the operator while an agent owns control', () => {
    const { control, epoch } = delegated();
    expect(() => control.begin({ actor: 'operator' })).toThrow(/takeover/i);
    const observation = control.begin({ actor: 'agent', epoch });
    expect(() => control.begin({ actor: 'agent', epoch })).toThrow(/busy/i);
    if ('replay' in observation) throw new Error('unexpected replay');
    control.finish(observation, 'completed');
    expect(control.begin({ actor: 'agent', epoch })).not.toHaveProperty('replay');
  });

  it('deduplicates writes while pending and after completion without retaining payloads', () => {
    const { control, epoch } = delegated();
    const request = {
      actor: 'agent' as const,
      epoch,
      operationId: 'save-1',
      fingerprint: 'digest',
    };
    const ticket = control.begin(request);
    if ('replay' in ticket) throw new Error('unexpected replay');
    expect(control.begin(request)).toMatchObject({ replay: { status: 'in_flight' } });
    control.dispatched(ticket);
    control.finish(ticket, 'outcome_unknown');
    expect(control.begin(request)).toMatchObject({ replay: { status: 'outcome_unknown' } });
    expect(() => control.begin({ ...request, fingerprint: 'different' })).toThrow(/different/i);
    expect(control.operation('save-1')).not.toHaveProperty('fingerprint');
  });

  it('withholds acknowledgment-required replay and publication until intent is acknowledged', () => {
    const control = new SessionControl();
    const request = {
      actor: 'operator' as const,
      operationId: 'durable-save',
      fingerprint: 'digest',
      acknowledgmentRequired: true,
    };
    const ticket = control.begin(request);
    if ('replay' in ticket) throw new Error('unexpected replay');

    expect(control.operation('durable-save')).toMatchObject({
      status: 'in_flight',
      dispatched: false,
    });
    expect(() => control.publicationOperation('durable-save')).toThrow(/acknowledgment/i);
    expect(() => control.begin(request)).toThrow(/acknowledgment/i);

    control.acknowledge(ticket, { status: 'in_flight', dispatched: false });
    const published = control.publicationOperation('durable-save');
    expect(published).toEqual({
      operationId: 'durable-save',
      epoch: 0,
      status: 'in_flight',
      dispatched: false,
    });
    expect(control.begin(request)).toEqual({ replay: published });
    if (published) published.status = 'completed';
    expect(control.publicationOperation('durable-save')?.status).toBe('in_flight');
  });

  it('omits unacknowledged intent from views without blocking lifecycle control', () => {
    const control = new SessionControl();
    const ticket = control.begin({
      actor: 'operator',
      operationId: 'pending-intent',
      fingerprint: 'digest',
      acknowledgmentRequired: true,
    });
    if ('replay' in ticket) throw new Error('unexpected replay');
    expect(control.view()).toEqual({ state: 'HUMAN_ACTIVE', epoch: 0, busy: true });
    expect(control.takeover()).toEqual({ state: 'PAUSE_REQUESTED', epoch: 0, busy: true });
    expect(() => control.publicationOperation('pending-intent')).toThrow(/acknowledgment/i);
    control.stop();
    expect(control.view()).toMatchObject({ state: 'STOPPED', busy: true });
    expect(control.view()).not.toHaveProperty('operation');
    expect(control.operation('pending-intent')).toMatchObject({ status: 'in_flight' });
  });

  it.each(['completed', 'failed', 'outcome_unknown'] as const)(
    'bounds active views by ACK rather than live %s execution and returns isolated snapshots',
    (status) => {
      const control = new SessionControl();
      const ticket = control.begin({
        actor: 'operator',
        operationId: 'pending-terminal',
        fingerprint: 'digest',
        acknowledgmentRequired: true,
      });
      if ('replay' in ticket) throw new Error('unexpected replay');
      control.acknowledge(ticket, { status: 'in_flight', dispatched: false });
      const intentView = control.view();
      expect(intentView.operation).toMatchObject({ status: 'in_flight', dispatched: false });
      control.acknowledge(ticket, { status: 'in_flight', dispatched: true });
      // A committed marker is conservatively visible even before physical dispatch.
      expect(control.operation('pending-terminal')?.dispatched).toBe(false);
      expect(control.view().operation).toMatchObject({ status: 'in_flight', dispatched: true });
      control.dispatched(ticket);
      control.finalize(ticket, status);
      expect(control.operation('pending-terminal')?.status).toBe(status);
      const markerView = control.takeover();
      expect(markerView.operation).toMatchObject({ status: 'in_flight', dispatched: true });
      if (markerView.operation) markerView.operation.status = 'failed';
      expect(control.view().operation?.status).toBe('in_flight');
      expect(intentView.operation?.dispatched).toBe(false);
      control.acknowledge(ticket, { status, dispatched: true });
      expect(control.view().operation).toEqual(control.publicationOperation('pending-terminal'));
      expect(control.view().operation?.status).toBe(status);
      control.finish(ticket, status);
      expect(control.view()).toMatchObject({ busy: false });
      expect(control.view()).not.toHaveProperty('operation');
    }
  );

  it('binds acknowledgment selection into the existing duplicate identity in both directions', () => {
    const control = new SessionControl();
    const durable = {
      actor: 'operator' as const,
      operationId: 'durable',
      fingerprint: 'same',
      acknowledgmentRequired: true,
    };
    const durableTicket = control.begin(durable);
    if ('replay' in durableTicket) throw new Error('unexpected replay');
    expect(() =>
      control.begin({ actor: 'operator', operationId: 'durable', fingerprint: 'same' })
    ).toThrow(/different/i);
    control.finish(durableTicket, 'failed');

    const ephemeral = {
      actor: 'operator' as const,
      operationId: 'ephemeral-selection',
      fingerprint: 'same',
    };
    const ephemeralTicket = control.begin(ephemeral);
    if ('replay' in ephemeralTicket) throw new Error('unexpected replay');
    expect(() => control.begin({ ...ephemeral, acknowledgmentRequired: true })).toThrow(
      /different/i
    );
    expect(control.publicationOperation('ephemeral-selection')).toMatchObject({
      status: 'in_flight',
      dispatched: false,
    });
  });

  it.each(['completed', 'failed', 'outcome_unknown'] as const)(
    'advances an acknowledged marker to immutable %s terminal facts after revocation',
    (status) => {
      const control = new SessionControl();
      const request = {
        actor: 'operator' as const,
        operationId: `durable-${status}`,
        fingerprint: 'digest',
        acknowledgmentRequired: true,
      };
      const ticket = control.begin(request);
      if ('replay' in ticket) throw new Error('unexpected replay');
      control.acknowledge(ticket, { status: 'in_flight', dispatched: false });
      control.acknowledge(ticket, { status: 'in_flight', dispatched: true });
      control.dispatched(ticket);
      control.finalize(ticket, status);
      expect(control.takeover().state).toBe('PAUSE_REQUESTED');

      control.acknowledge(ticket, { status, dispatched: true });
      expect(control.publicationOperation(request.operationId)).toMatchObject({
        status,
        dispatched: true,
      });
      expect(() =>
        control.acknowledge(ticket, {
          status: status === 'completed' ? 'failed' : 'completed',
          dispatched: true,
        })
      ).toThrow(/acknowledgment/i);
      control.finish(ticket, 'failed');
      expect(control.publicationOperation(request.operationId)).toMatchObject({
        status,
        dispatched: true,
      });
    }
  );

  it('allows only failed terminal facts before a dispatch marker', () => {
    const control = new SessionControl();
    const request = {
      actor: 'operator' as const,
      operationId: 'predispatch-failure',
      fingerprint: 'digest',
      acknowledgmentRequired: true,
    };
    const ticket = control.begin(request);
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.acknowledge(ticket, { status: 'in_flight', dispatched: false });
    expect(() => control.acknowledge(ticket, { status: 'completed', dispatched: false })).toThrow(
      /acknowledgment/i
    );
    expect(() =>
      control.acknowledge(ticket, { status: 'outcome_unknown', dispatched: false })
    ).toThrow(/acknowledgment/i);
    expect(() => control.acknowledge(ticket, { status: 'failed', dispatched: true })).toThrow(
      /acknowledgment/i
    );

    control.acknowledge(ticket, { status: 'failed', dispatched: false });
    control.finalize(ticket, 'completed');
    control.finish(ticket, 'completed');
    expect(control.operation('predispatch-failure')).toMatchObject({ status: 'completed' });
    expect(control.publicationOperation('predispatch-failure')).toMatchObject({
      status: 'failed',
      dispatched: false,
    });
  });

  it('refuses skipped, regressed, copied, foreign and released acknowledgment owners', () => {
    const control = new SessionControl();
    const request = {
      actor: 'operator' as const,
      operationId: 'ack-owner',
      fingerprint: 'digest',
      acknowledgmentRequired: true,
    };
    const ticket = control.begin(request);
    const foreign = new SessionControl().begin({
      actor: 'operator',
      operationId: 'foreign',
      fingerprint: 'digest',
      acknowledgmentRequired: true,
    });
    if ('replay' in ticket || 'replay' in foreign) throw new Error('unexpected replay');

    for (const invalid of [
      { owner: ticket, projection: { status: 'in_flight' as const, dispatched: true } },
      { owner: { ...ticket }, projection: { status: 'in_flight' as const, dispatched: false } },
      { owner: foreign, projection: { status: 'in_flight' as const, dispatched: false } },
    ])
      expect(() => control.acknowledge(invalid.owner, invalid.projection)).toThrow(
        /acknowledgment/i
      );
    expect(() => control.publicationOperation('ack-owner')).toThrow(/acknowledgment/i);

    control.acknowledge(ticket, { status: 'in_flight', dispatched: false });
    control.acknowledge(ticket, { status: 'in_flight', dispatched: true });
    expect(() => control.acknowledge(ticket, { status: 'in_flight', dispatched: false })).toThrow(
      /acknowledgment/i
    );
    control.finish(ticket, 'outcome_unknown');
    expect(() =>
      control.acknowledge(ticket, { status: 'outcome_unknown', dispatched: true })
    ).toThrow(/acknowledgment/i);
  });

  it('never evicts deduplication records to admit a new write', () => {
    const { control, epoch } = delegated(new SessionControl({ maxOperations: 1 }));
    const ticket = control.begin({ actor: 'agent', epoch, operationId: 'one', fingerprint: 'a' });
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.finish(ticket, 'completed');
    expect(() =>
      control.begin({ actor: 'agent', epoch, operationId: 'two', fingerprint: 'b' })
    ).toThrow(/budget/i);
    expect(
      control.begin({ actor: 'agent', epoch, operationId: 'one', fingerprint: 'a' })
    ).toHaveProperty('replay');
  });

  it('makes old tickets unusable after drain and after stop', () => {
    const control = new SessionControl();
    const ticket = control.begin({ actor: 'operator' });
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.finish(ticket, 'completed');
    expect(() => control.check(ticket)).toThrow();
    control.stop();
    expect(() => control.begin({ actor: 'operator' })).toThrow(/stopped/i);
  });
  it('invalidates a review when the operator admits another write', () => {
    const control = new SessionControl();
    const review = control.prepareResume();
    const ticket = control.begin({ actor: 'operator', operationId: 'edit', fingerprint: 'edit' });
    if ('replay' in ticket) throw new Error('unexpected replay');
    control.dispatched(ticket);
    control.finish(ticket, 'completed');
    expect(() => control.delegate(review.epoch)).toThrow(/review/i);
    expect(control.view().state).toBe('HUMAN_ACTIVE');
  });

  it('surfaces the in-flight operation in the view while one is active', () => {
    const control = new SessionControl();
    // No active operation: the view carries no operation record.
    expect(control.view()).toMatchObject({ state: 'HUMAN_ACTIVE', epoch: 0, busy: false });
    expect(control.view().operation).toBeUndefined();

    const ticket = control.begin({
      actor: 'operator',
      operationId: 'op-1',
      fingerprint: 'digest',
    });
    if ('replay' in ticket) throw new Error('unexpected replay');

    const view = control.view();
    expect(view.busy).toBe(true);
    expect(view.operation).toEqual({
      operationId: 'op-1',
      epoch: 0,
      status: 'in_flight',
      dispatched: false,
    });

    control.dispatched(ticket);
    expect(control.view().operation).toMatchObject({ dispatched: true });
    expect(view.operation?.dispatched).toBe(false);
    if (view.operation) view.operation.status = 'failed';
    expect(control.view().operation?.status).toBe('in_flight');

    control.finish(ticket, 'completed');
    expect(control.view().operation).toBeUndefined();
    expect(control.view().busy).toBe(false);
  });

  it('rejects an operation ID without a matching shape or fingerprint', () => {
    const control = new SessionControl();

    // Not matching CONTROL_OPERATION_ID's [A-Za-z0-9_-] charset.
    expect(() => control.begin({ actor: 'operator', operationId: 'bad id!' })).toThrow(
      'A valid operation ID and fingerprint are required'
    );
    // A well-formed ID without a fingerprint is equally unusable: replay
    // detection cannot bind it to a specific write.
    expect(() => control.begin({ actor: 'operator', operationId: 'op-1' })).toThrow(
      'A valid operation ID and fingerprint are required'
    );
    // Neither attempt may have started an operation.
    expect(control.view().busy).toBe(false);
  });
});

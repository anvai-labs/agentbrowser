import { describe, expect, it } from 'vitest';
import { SessionControl } from './session-control.js';

function delegated(control = new SessionControl()) {
  const review = control.prepareResume();
  const state = control.delegate(review.epoch);
  return { control, epoch: state.epoch };
}

describe('session control', () => {
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

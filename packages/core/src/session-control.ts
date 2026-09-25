import { randomUUID } from 'node:crypto';
import {
  CONTROL_OPERATION_ID,
  type ControlState,
  type ControlView,
  type OperationRecord,
} from '@agentbrowser/protocol';

export class ControlError extends Error {
  constructor(
    public readonly code:
      | 'SESSION_BUSY'
      | 'CONTROL_REVOKED'
      | 'CONTROL_REQUIRED'
      | 'OPERATION_CONFLICT'
      | 'QUOTA_EXCEEDED'
      | 'INVALID_REQUEST',
    message: string
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export interface ControlTicket {
  readonly epoch: number;
  readonly actor: 'agent' | 'operator';
  readonly operationId?: string;
  didDispatch: boolean;
}

type StoredOperation = {
  fingerprint: string;
  actor: string;
  acknowledgmentRequired: boolean;
  ticket: ControlTicket;
  record: OperationRecord;
  acknowledgment?: OperationRecord;
};

const acknowledgmentUnavailable = () =>
  new ControlError('CONTROL_REQUIRED', 'Operation acknowledgment is unavailable');

/** One ephemeral session owner. No queued work and no eviction of write identities. */
export class SessionControl {
  private state: ControlState = 'HUMAN_ACTIVE';
  private epoch = 0;
  private review = randomUUID();
  private active: ControlTicket | undefined;
  private finalized = false;
  private readonly records = new Map<string, StoredOperation>();
  private readonly maxOperations: number;

  constructor(options: { maxOperations?: number } = {}) {
    this.maxOperations = options.maxOperations ?? 1000;
    if (
      !Number.isInteger(this.maxOperations) ||
      this.maxOperations < 1 ||
      this.maxOperations > 10000
    )
      throw new Error('Invalid operation budget');
  }

  view(): ControlView {
    const operation = this.active?.operationId
      ? this.operation(this.active.operationId)
      : undefined;
    return {
      state: this.state,
      epoch: this.epoch,
      busy: this.active !== undefined,
      ...(operation ? { operation } : {}),
    };
  }

  operation(id: string): OperationRecord | undefined {
    const record = this.records.get(id)?.record;
    return record ? { ...record } : undefined;
  }

  /** Publication sees only acknowledged facts for selected operations. */
  publicationOperation(id: string): OperationRecord | undefined {
    const entry = this.records.get(id);
    if (!entry) return undefined;
    if (!entry.acknowledgmentRequired) return { ...entry.record };
    if (!entry.acknowledgment) throw acknowledgmentUnavailable();
    return { ...entry.acknowledgment };
  }

  /** Opaque control-review version, not permission or page/payload evidence. */
  reviewVersion(): string {
    return this.review;
  }

  /** Trusted owners invalidate review around configuration callbacks too. */
  invalidateReview(): void {
    this.review = randomUUID();
  }

  takeover(): ControlView {
    if (this.state === 'STOPPED') return this.view();
    this.invalidateReview();
    if (this.state !== 'PAUSE_REQUESTED' && this.state !== 'HUMAN_ACTIVE') this.epoch++;
    this.state = this.active ? 'PAUSE_REQUESTED' : 'HUMAN_ACTIVE';
    return this.view();
  }

  prepareResume(): ControlView {
    if (this.active)
      throw new ControlError('SESSION_BUSY', 'Session is busy draining an operation');
    if (this.state !== 'HUMAN_ACTIVE' && this.state !== 'RESUME_REVIEW')
      throw new ControlError('CONTROL_REQUIRED', 'Human takeover is required before review');
    this.invalidateReview();
    this.epoch++;
    this.state = 'RESUME_REVIEW';
    return this.view();
  }

  delegate(reviewEpoch: number): ControlView {
    if (this.active) throw new ControlError('SESSION_BUSY', 'Session is busy');
    if (this.state !== 'RESUME_REVIEW' || reviewEpoch !== this.epoch)
      throw new ControlError('CONTROL_REVOKED', 'A current human review is required');
    this.invalidateReview();
    this.epoch++;
    this.state = 'AGENT_ACTIVE';
    return this.view();
  }

  authorizeAgent(epoch: number): void {
    if (this.state !== 'AGENT_ACTIVE' || epoch !== this.epoch)
      throw new ControlError('CONTROL_REVOKED', 'Delegated control was revoked');
  }

  begin(request: {
    actor: 'agent' | 'operator';
    epoch?: number;
    operationId?: string;
    fingerprint?: string;
    acknowledgmentRequired?: boolean;
  }): ControlTicket | { replay: OperationRecord } {
    if (this.state === 'STOPPED')
      throw new ControlError('CONTROL_REVOKED', 'Session control is stopped');
    if (request.actor === 'agent') this.authorizeAgent(request.epoch ?? -1);
    else if (this.state === 'AGENT_ACTIVE')
      throw new ControlError('CONTROL_REQUIRED', 'Human takeover is required');
    if (
      request.acknowledgmentRequired !== undefined &&
      typeof request.acknowledgmentRequired !== 'boolean'
    )
      throw new ControlError('INVALID_REQUEST', 'Invalid acknowledgment selection');
    const acknowledgmentRequired = request.acknowledgmentRequired === true;
    if (acknowledgmentRequired && request.operationId === undefined)
      throw new ControlError('INVALID_REQUEST', 'Acknowledgment requires an operation identity');
    if (request.operationId !== undefined) {
      if (!CONTROL_OPERATION_ID.test(request.operationId) || !request.fingerprint)
        throw new ControlError(
          'INVALID_REQUEST',
          'A valid operation ID and fingerprint are required'
        );
      const previous = this.records.get(request.operationId);
      if (previous) {
        if (
          previous.fingerprint !== request.fingerprint ||
          previous.actor !== request.actor ||
          previous.record.epoch !== this.epoch ||
          previous.acknowledgmentRequired !== acknowledgmentRequired
        )
          throw new ControlError(
            'OPERATION_CONFLICT',
            'Operation ID belongs to different arguments or control generation'
          );
        const replay = this.publicationOperation(request.operationId);
        if (!replay) throw acknowledgmentUnavailable();
        return { replay };
      }
    }
    if (this.active) throw new ControlError('SESSION_BUSY', 'Session is busy');
    if (request.operationId !== undefined && this.records.size >= this.maxOperations)
      throw new ControlError('QUOTA_EXCEEDED', 'Session operation budget exhausted');
    // A review describes the state before this write, even if dispatch fails.
    if (request.actor === 'operator' && request.operationId && this.state === 'RESUME_REVIEW') {
      this.invalidateReview();
      this.epoch++;
      this.state = 'HUMAN_ACTIVE';
    }
    const ticket: ControlTicket = {
      epoch: this.epoch,
      actor: request.actor,
      didDispatch: false,
      ...(request.operationId ? { operationId: request.operationId } : {}),
    };
    if (request.operationId)
      this.records.set(request.operationId, {
        fingerprint: request.fingerprint ?? '',
        actor: request.actor,
        acknowledgmentRequired,
        ticket,
        record: {
          operationId: request.operationId,
          epoch: this.epoch,
          status: 'in_flight',
          dispatched: false,
        },
      });
    this.active = ticket;
    this.finalized = false;
    return ticket;
  }

  /** Advance one exact operation's publication facts without reopening live authority. */
  acknowledge(
    ticket: ControlTicket,
    projection: Pick<OperationRecord, 'status' | 'dispatched'>
  ): void {
    const operationId = ticket.operationId;
    const entry = operationId === undefined ? undefined : this.records.get(operationId);
    if (
      this.active !== ticket ||
      !entry ||
      entry.ticket !== ticket ||
      !entry.acknowledgmentRequired
    )
      throw acknowledgmentUnavailable();
    const status = projection?.status;
    const dispatched = projection?.dispatched;
    if (
      !['in_flight', 'completed', 'failed', 'outcome_unknown'].includes(status as string) ||
      typeof dispatched !== 'boolean'
    )
      throw acknowledgmentUnavailable();
    const previous = entry.acknowledgment;
    if (previous?.status === status && previous.dispatched === dispatched) return;
    const fromIntent = previous?.status === 'in_flight' && !previous.dispatched;
    const fromMarker = previous?.status === 'in_flight' && previous.dispatched;
    const valid =
      previous === undefined
        ? status === 'in_flight' && !dispatched
        : fromIntent
          ? (status === 'in_flight' && dispatched) || (status === 'failed' && !dispatched)
          : fromMarker
            ? status !== 'in_flight' && dispatched
            : false;
    if (!valid) throw acknowledgmentUnavailable();
    entry.acknowledgment = {
      operationId: entry.record.operationId,
      epoch: entry.record.epoch,
      status,
      dispatched,
    };
  }

  check(ticket: ControlTicket): void {
    if (
      this.active !== ticket ||
      ticket.epoch !== this.epoch ||
      this.state === 'STOPPED' ||
      this.state === 'PAUSE_REQUESTED'
    )
      throw new ControlError('CONTROL_REVOKED', 'Operation authority was revoked');
  }

  dispatched(ticket: ControlTicket): void {
    this.check(ticket);
    if (this.finalized)
      throw new ControlError('CONTROL_REVOKED', 'Operation execution is finalized');
    ticket.didDispatch = true;
    if (ticket.operationId) {
      const entry = this.records.get(ticket.operationId);
      if (entry) entry.record.dispatched = true;
    }
  }

  /** Freeze execution facts without releasing the captured ticket's exclusion. */
  finalize(ticket: ControlTicket, status: Exclude<OperationRecord['status'], 'in_flight'>): void {
    // Completion bookkeeping must also work after revocation while the old owner drains.
    if (this.active !== ticket || this.finalized) return;
    if (ticket.operationId) {
      const entry = this.records.get(ticket.operationId);
      if (entry) entry.record.status = status;
    }
    this.finalized = true;
  }

  /** Compatibility composition: finalize once, then release only the captured ticket. */
  finish(ticket: ControlTicket, status: Exclude<OperationRecord['status'], 'in_flight'>): void {
    if (this.active !== ticket) return;
    this.finalize(ticket, status);
    this.active = undefined;
    if (this.state === 'PAUSE_REQUESTED') this.state = 'HUMAN_ACTIVE';
  }

  stop(): void {
    this.invalidateReview();
    this.epoch++;
    this.state = 'STOPPED';
  }
}

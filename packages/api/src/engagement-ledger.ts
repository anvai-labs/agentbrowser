import { createHash, randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ENGAGEMENT_GENESIS as GENESIS, engagementChainHash as hashOf } from '@agentbrowser/core';

/**
 * T10 M2: the engagement ledger — an append-only, hash-chained JSONL record
 * of a scoped session's traffic decisions, metadata only.
 *
 * ```
 * {seq, at, type, data, prev, hash}    hash = sha256(prev + "\n" + JSON{seq,at,type,data})
 * seq 0  engagement.opened   scope snapshot (no identity values), session, product
 * seq n  request             method, origin+path, status, bytes, blocked, reason, scope
 * seq n  preflight.denied    a navigation the scope refused before the wire
 * last   engagement.closed   scope snapshot, counts
 * ```
 *
 * Without rewriting the chain from that point on, an edited, removed, reordered or reformatted
 * line fails `verifyEngagementLedger`. There is no key or external anchor: whoever can write the
 * file can rewrite and re-hash it, and a missing `engagement.closed` means truncated or crashed.
 * Request and response bodies, query strings and identity marker values are never
 * written: request events carry origin+path only, already redacted by the service.
 *
 * Bounded: past `maxBytes - RESERVE_BYTES` the ledger reports itself full, and the
 * caller stops the scope (fail closed). Records still in flight are appended up to
 * `maxBytes`; any beyond that are counted, never silently lost, in the closing record.
 */

export const ENGAGEMENT_ID = /^eng_[0-9a-f]{24}$/;
/** Room kept for the requests already in flight when the ledger fills. */
export const RESERVE_BYTES = 64 * 1024;

export interface EngagementLedgerOptions {
  directory: string;
  tenantId: string;
  maxBytes: number;
  /** Called once when the ledger can no longer take new traffic (full or failed). */
  onUnavailable: (reason: 'full' | 'write_failed') => void;
  /** Test seam: how the ledger file is created (default: exclusive, mode 0600). */
  openFile?: (path: string) => Promise<Pick<FileHandle, 'write' | 'sync' | 'close'>>;
}

function newEngagementId(): string {
  return `eng_${randomBytes(12).toString('hex')}`;
}

/** Tenant-scoped location: a hashed tenant segment, so ids never cross tenants. */
export function engagementPath(directory: string, tenantId: string, engagementId: string): string {
  if (!ENGAGEMENT_ID.test(engagementId)) throw new Error('invalid engagement id');
  const tenant = createHash('sha256').update(tenantId).digest('hex').slice(0, 32);
  return join(directory, tenant, `${engagementId}.jsonl`);
}

export class EngagementLedger {
  private seq = 0;
  private prev = GENESIS;
  private bytes = 0;
  private dropped = 0;
  private unavailable: 'full' | 'write_failed' | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly engagementId: string,
    readonly path: string,
    private readonly handle: Pick<FileHandle, 'write' | 'sync' | 'close'>,
    private readonly options: EngagementLedgerOptions
  ) {}

  /** Creates the ledger file exclusively (never reuses one) and writes the opening record. */
  static async open(
    options: EngagementLedgerOptions,
    opened: Record<string, unknown>
  ): Promise<EngagementLedger> {
    const engagementId = newEngagementId();
    const path = engagementPath(options.directory, options.tenantId, engagementId);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const handle = await (options.openFile ?? ((target: string) => open(target, 'wx', 0o600)))(
      path
    );
    const ledger = new EngagementLedger(engagementId, path, handle, options);
    ledger.append('engagement.opened', { engagementId, ...opened });
    await ledger.writes;
    if (ledger.unavailable === 'write_failed') {
      await handle.close().catch(() => {});
      // Never leave a partial ledger behind for an engagement that never ran.
      await unlink(path).catch(() => {});
      throw new Error('engagement ledger could not be written');
    }
    return ledger;
  }

  get state(): 'open' | 'full' | 'write_failed' {
    return this.unavailable ?? 'open';
  }

  /** Authority changes need an acknowledged, synced record, not a queued intent. */
  async appendCritical(type: string, data: Record<string, unknown>): Promise<void> {
    if (this.closed || this.unavailable !== undefined)
      throw new Error('Engagement ledger unavailable');
    const before = this.seq;
    this.append(type, data);
    await this.writes;
    if (this.closed || this.unavailable !== undefined || this.seq <= before)
      throw new Error('Engagement ledger unavailable');
    try {
      await this.handle.sync();
    } catch {
      this.markUnavailable('write_failed');
      throw new Error('Engagement ledger unavailable');
    }
    if (this.closed || this.unavailable !== undefined)
      throw new Error('Engagement ledger unavailable');
  }

  /** Appends one record, in call order. Never throws; failures fail the scope closed. */
  append(type: string, data: Record<string, unknown>): void {
    if (this.closed) return;
    if (this.unavailable === 'write_failed') {
      // The file can no longer be written: count what it could not take.
      this.dropped += 1;
      return;
    }
    const at = new Date().toISOString();
    const body = JSON.stringify({ seq: this.seq, at, type, data });
    const line = `${JSON.stringify({ seq: this.seq, at, type, data, prev: this.prev, hash: hashOf(this.prev, body) })}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.options.maxBytes) {
      this.dropped += 1;
      this.markUnavailable('full');
      return;
    }
    this.prev = hashOf(this.prev, body);
    this.seq += 1;
    this.bytes += size;
    if (this.bytes >= this.options.maxBytes - RESERVE_BYTES) this.markUnavailable('full');
    this.writes = this.writes.then(async () => {
      if (this.unavailable === 'write_failed') return;
      try {
        const { bytesWritten } = await this.handle.write(line);
        // A short write (a full disk) corrupts the tail: treat it as a failure.
        if (bytesWritten !== size) this.markUnavailable('write_failed');
      } catch {
        this.markUnavailable('write_failed');
      }
    });
  }

  /** Writes the closing record (always, even when full) and syncs the file. */
  async close(closed: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const at = new Date().toISOString();
    const data = { ...closed, records: this.seq, dropped: this.dropped, state: this.state };
    const body = JSON.stringify({ seq: this.seq, at, type: 'engagement.closed', data });
    const line = `${JSON.stringify({ seq: this.seq, at, type: 'engagement.closed', data, prev: this.prev, hash: hashOf(this.prev, body) })}\n`;
    this.closed = true;
    this.writes = this.writes.then(async () => {
      if (this.unavailable === 'write_failed') return;
      try {
        const { bytesWritten } = await this.handle.write(line);
        if (bytesWritten !== Buffer.byteLength(line)) throw new Error('short write');
        await this.handle.sync();
      } catch {
        this.unavailable = 'write_failed';
      }
    });
    await this.writes;
    await this.handle.close().catch(() => {});
  }

  private markUnavailable(reason: 'full' | 'write_failed'): void {
    if (this.unavailable === 'write_failed') return;
    if (this.unavailable === reason) return;
    const first = this.unavailable === undefined;
    this.unavailable = reason;
    if (first || reason === 'write_failed') this.options.onUnavailable(reason);
  }
}

export { verifyEngagementLedger } from '@agentbrowser/core';

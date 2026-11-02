import { createHash, randomBytes } from 'node:crypto';

/**
 * ADR-030 trusted transport integration: the claim registry that ties exactly
 * one isolated-world browser fetch to the request the choke point sees.
 *
 * Attribution is a per-dispatch random nonce header (`x-agentbrowser-probe`):
 * it exists only inside the isolated world's fetch call, so concurrent page
 * traffic — including identical method+URL requests from page timers — can
 * never be mistaken for the probe (the rejected alternative). The nonce is
 * stripped before the request reaches the wire on both lanes: the CDP guard
 * rebuilds request-stage headers for the native (POST/PUT/PATCH) lane, and the
 * route handler's Node-side re-issue drops it for the inspected lane.
 *
 * Claims settle exactly once, from whichever authority sees the outcome first:
 * the route handler (policy denial, or the inspected lane's terminal
 * response), or the CDP guard (native-lane admission or network failure).
 */

export const PROBE_NONCE_HEADER = 'x-agentbrowser-probe';

/** Live claims per context: a probe holds the page exclusively while in flight. */
const MAX_LIVE_CLAIMS = 8;

export type ProbeClaimOutcome =
  | {
      kind: 'admitted';
      status: number;
      headers: Array<{ name: string; value: string }>;
      body: Buffer | undefined;
      outcome: 'terminal' | 'bodyless';
    }
  | { kind: 'denied'; reason: string; scope?: string }
  | { kind: 'failed'; detail: string };

export interface ProbeClaim {
  readonly nonce: string;
  readonly method: string;
  readonly url: string;
  /** The pinned document origin at prepare time; redirect hops must stay on it. */
  readonly origin: string;
  /** Chromium network id, bound when a guard/route request is attributed. */
  networkId: string | undefined;
  /** Redirect hops followed on the native lane, for the shared hop cap. */
  hops: number;
  /** Distinct hop URLs seen, for loop detection. */
  readonly seen: Set<string>;
  readonly startedAt: number;
  settled: boolean;
  readonly done: Promise<ProbeClaimOutcome>;
  readonly resolve: (outcome: ProbeClaimOutcome) => void;
}

export class PageFetchLane {
  private readonly claims = new Map<string, ProbeClaim>();
  private readonly byNetworkId = new Map<string, ProbeClaim>();
  /**
   * The choke point's denial bookkeeping for native-lane probes: the guard
   * strips the nonce before the route handler can attribute the request, so a
   * denial is recorded by method+origin+path and the guard's synthetic-denial
   * detection picks it up. Failure bookkeeping only, never wire authority:
   * a denial note cannot admit, skip or expand anything.
   */
  private readonly denialNotes = new Map<string, { reason: string; scope?: string }>();

  get liveCount(): number {
    return this.claims.size;
  }

  hasLiveClaims(): boolean {
    return this.claims.size > 0;
  }

  noteDenied(method: string, url: string, reason: string, scope?: string): void {
    try {
      const at = new URL(url);
      if (this.denialNotes.size >= 32) {
        const oldest = this.denialNotes.keys().next().value;
        if (oldest !== undefined) this.denialNotes.delete(oldest);
      }
      this.denialNotes.set(`${method.toUpperCase()} ${at.origin}${at.pathname}`, {
        reason,
        ...(scope !== undefined ? { scope } : {}),
      });
    } catch {
      /* an unparseable URL notes nothing; the claim settles fail-closed */
    }
  }

  /** Consume the denial recorded for this request shape, if any. */
  takeDenial(method: string, url: string): { reason: string; scope?: string } | undefined {
    try {
      const at = new URL(url);
      const key = `${method.toUpperCase()} ${at.origin}${at.pathname}`;
      const note = this.denialNotes.get(key);
      if (note !== undefined) this.denialNotes.delete(key);
      return note;
    } catch {
      return undefined;
    }
  }

  register(request: { method: string; url: string; origin: string }): ProbeClaim {
    if (this.claims.size >= MAX_LIVE_CLAIMS) throw new Error('PROBE_LANE_FULL');
    let resolve!: (outcome: ProbeClaimOutcome) => void;
    const done = new Promise<ProbeClaimOutcome>((settle) => {
      resolve = settle;
    });
    const claim: ProbeClaim = {
      nonce: createHash('sha256').update(randomBytes(32)).digest('hex'),
      method: request.method,
      url: request.url,
      origin: request.origin,
      networkId: undefined,
      hops: 0,
      seen: new Set([request.url]),
      startedAt: Date.now(),
      settled: false,
      done,
      resolve,
    };
    this.claims.set(claim.nonce, claim);
    return claim;
  }

  /** Attribute a seen request to its claim by the secret nonce header value. */
  claimForHeaders(headers: Record<string, string>): ProbeClaim | undefined {
    const nonce = headers[PROBE_NONCE_HEADER];
    if (nonce === undefined) return undefined;
    return this.claims.get(nonce);
  }

  claimForNetworkId(networkId: string): ProbeClaim | undefined {
    return this.byNetworkId.get(networkId);
  }

  bindNetworkId(claim: ProbeClaim, networkId: string): void {
    // One network id is one browser request: never rebound, never shared. An
    // id that is already taken leaves the second claim unattributed — it
    // settles fail-closed rather than borrowing another probe's authority.
    if (claim.networkId !== undefined) return;
    if (this.byNetworkId.has(networkId)) return;
    claim.networkId = networkId;
    this.byNetworkId.set(networkId, claim);
  }

  /**
   * ADR-030 redirect rule: every method refuses a cross-origin redirect, even
   * a scope-allowed CORS destination — an explicitly supplied CSRF header must
   * never leak to a second origin through a 307/308.
   */
  allowsRedirect(claim: ProbeClaim, nextUrl: string): boolean {
    try {
      return new URL(nextUrl).origin === claim.origin;
    } catch {
      return false;
    }
  }

  /** Exactly-once settlement; later observers are no-ops. */
  settle(claim: ProbeClaim, outcome: ProbeClaimOutcome): void {
    if (claim.settled) return;
    claim.settled = true;
    this.forget(claim);
    this.takeDenial(claim.method, claim.url);
    claim.resolve(outcome);
  }

  forget(claim: ProbeClaim): void {
    this.claims.delete(claim.nonce);
    if (claim.networkId !== undefined && this.byNetworkId.get(claim.networkId) === claim)
      this.byNetworkId.delete(claim.networkId);
  }
}

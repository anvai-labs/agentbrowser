/**
 * TD-BROWSER-15 phase 4b: the policy performance gate. A 300-subresource page
 * where EVERY subresource needs a policy decision (the worst case: private
 * addresses, so each request asks `request.private` per source) must spend a
 * bounded share of its load time in policy evaluation.
 *
 * Three modes, per the TD: uncached (every decision reaches Cedar), memoized
 * (the per-session LRU; the page loads 30 hosts ten times each, so nine of
 * ten requests are hits), and shadow (legacy decides while Cedar evaluates
 * alongside, which doubles evaluation). The reference page-load time is
 * 1.0 s: the MVP latency targets put a 300-subresource interaction well above
 * that, so the share reported here is an upper bound on the real one.
 *
 * The gate ceiling is set from the first measured run and recorded in the TD.
 */

import { NetworkPolicy } from '@agentbrowser/policy';
import {
  type Authorizer,
  CedarAuthorizer,
  egressExceptionsOf,
  LegacyAuthorizer,
  MemoizedAuthorizer,
  policyDocumentFromLegacyConfig,
  ShadowAuthorizer,
  TenantBindingAuthorizer,
} from '@agentbrowser/policy-engine';
import { percentile } from './harness.js';

export const SUBRESOURCES = 300;
/** The reference page load the policy share is measured against (ms). */
export const REFERENCE_PAGE_LOAD_MS = 1000;
/**
 * The gate: the maximum share of load time spent in policy evaluation, for
 * the modes production runs — memoized (always) and shadow (opt-in). The
 * uncached mode is the measurement floor and is reported, not gated: the
 * service never runs it. First measured run (2026-10-13, this machine):
 * uncached 68.7 ms / p50 193 µs (6.9%), memoized 9.6 ms / p50 2.9 µs
 * (0.96%), shadow 49.9 ms / p50 153 µs (5.0%). The first CI run measured
 * shared runners at roughly 2-3x that, so the gate is 25%: its job is to
 * catch order-of-magnitude regressions (a broken memo, a quadrupled
 * decision cost), not to police small constant factors.
 */
export const POLICY_SHARE_GATE_PERCENT = 25;
export const GATED_MODES: readonly PolicyGateResult['mode'][] = ['memoized', 'shadow'];

export interface PolicyGateResult {
  mode: 'uncached' | 'memoized' | 'shadow';
  totalMs: number;
  p50Us: number;
  p95Us: number;
  /** Policy time as a share of the reference page load, percent. */
  sharePercent: number;
  gatePercent: number;
  /** False for the uncached measurement floor: reported, never gated. */
  gated: boolean;
  pass: boolean;
}

/** Thirty private hosts, ten requests each: a realistic subresource mix. */
const HOSTS = Array.from({ length: 30 }, (_, i) => `10.1.${Math.floor(i / 250)}.${i + 1}`);

const documentFor = () =>
  policyDocumentFromLegacyConfig({
    allowedPrivateCIDRs: ['10.0.0.0/8', '192.168.0.0/16', 'fd12::/32', '::ffff:172.16.0.0/104'],
    unknownRisk: 'required',
    rules: [
      { id: 'pay', effect: 'transaction', decision: 'required' },
      { id: 'mail', effect: 'external-message', decision: 'allow' },
      { hostname: 'shop.example', effect: 'write-local', decision: 'required' },
    ],
  });

function chainFor(authorizer: Authorizer): NetworkPolicy {
  return new NetworkPolicy({
    blockLoopback: true,
    blockPrivateIPs: true,
    blockMetadata: true,
    exceptions: egressExceptionsOf(new TenantBindingAuthorizer(authorizer, 't1')),
  });
}

/** Measures one mode over the worst-case page. */
export async function measurePolicyGate(mode: PolicyGateResult['mode']): Promise<PolicyGateResult> {
  const cedar = new CedarAuthorizer({ document: documentFor(), defaultTenant: 't1' });
  let deciding: Authorizer = cedar;
  if (mode === 'shadow') {
    // The shadow's legacy side mirrors the same configuration, as the
    // service's does: legacy decides, Cedar evaluates alongside.
    deciding = new ShadowAuthorizer(
      new LegacyAuthorizer({
        allowedPrivateCIDRs: ['10.0.0.0/8', '192.168.0.0/16', 'fd12::/32'],
        unknownRisk: 'required',
      }),
      cedar
    );
  }
  const policy = chainFor(mode === 'memoized' ? new MemoizedAuthorizer(deciding) : deciding);

  const samples: number[] = [];
  for (let i = 0; i < SUBRESOURCES; i += 1) {
    const hostname = HOSTS[i % HOSTS.length] as string;
    const start = process.hrtime.bigint();
    await policy.checkRequest({ hostname });
    samples.push(Number(process.hrtime.bigint() - start) / 1000);
  }
  const totalMs = samples.reduce((acc, us) => acc + us, 0) / 1000;
  const sharePercent = (totalMs / REFERENCE_PAGE_LOAD_MS) * 100;
  return {
    mode,
    totalMs,
    p50Us: percentile(samples, 0.5),
    p95Us: percentile(samples, 0.95),
    sharePercent,
    gatePercent: POLICY_SHARE_GATE_PERCENT,
    pass: sharePercent <= POLICY_SHARE_GATE_PERCENT,
    gated: GATED_MODES.includes(mode),
  };
}

/**
 * All three modes, measured. The gate assertion itself lives in the test and
 * binds only the gated modes (see GATED_MODES); `pass` is computed for every
 * mode for reporting, so an ungated row must not be read as gated.
 */
export async function policyGateReport(): Promise<PolicyGateResult[]> {
  const modes: PolicyGateResult['mode'][] = ['uncached', 'memoized', 'shadow'];
  const results: PolicyGateResult[] = [];
  for (const mode of modes) results.push(await measurePolicyGate(mode));
  return results;
}

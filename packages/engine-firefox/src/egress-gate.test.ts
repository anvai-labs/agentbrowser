import { expect, it } from 'vitest';
import { EXPECTED_CANDIDATE, probeFirefoxEgress } from '../scripts/probe-egress.mjs';

it.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)(
  'keeps public interception unqualified when independent worker destinations bypass denial',
  async () => {
    const report = await probeFirefoxEgress(process.env.AGENTBROWSER_FIREFOX_EXECUTABLE);
    expect(report).toMatchObject(EXPECTED_CANDIDATE);
    // A newly opened popup can dispatch before page-scoped interception attaches.
    // Preserve that observed race as disqualifying evidence; other probe errors fail.
    for (const error of report.errors) {
      expect(error).toEqual({
        phase: 'interception',
        message: 'Denied request was not paused: /target/popup',
      });
      expect(report.gate.reasons).toContain('probe-errors');
    }
    const popup = report.channels.find((row) => row.channel === 'popup');
    if (popup.deniedHits > 0) {
      expect(report.gate.reasons).toContain('popup:destination-reached');
    }
    for (const row of report.channels) {
      expect(row.allowedHits, `${row.channel}: positive control`).toBeGreaterThan(0);
      expect(row.allowedCompleted, `${row.channel}: completed control`).toBe(true);
    }
    for (const channel of ['navigation', 'redirect', 'fetch', 'dedicated-worker', 'websocket']) {
      expect(report.channels.find((row) => row.channel === channel)).toMatchObject({
        deniedHits: 0,
        deniedCompleted: true,
      });
    }
    // Truth guards: an upstream fix changes the evidence and requires requalification.
    for (const channel of ['shared-worker', 'service-worker']) {
      expect(report.channels.find((row) => row.channel === channel)).toMatchObject({
        deniedHits: 1,
        denialCallbacks: 0,
        deniedOutcome: 'reached',
      });
      expect(report.gate.reasons).toContain(`${channel}:destination-reached`);
    }
    expect(report.responseInspection).toMatchObject({
      contentAvailable: true,
      deliveredBodyCharacters: 65536,
    });
    expect(report.gate.ready).toBe(false);
    expect(report.gate.reasons).toContain('responseBytesBeforeDelivery:unverified');
  },
  60_000
);

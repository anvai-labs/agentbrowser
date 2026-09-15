import { expect, it } from 'vitest';
import { probeFirefoxEgress } from '../scripts/probe-egress.mjs';
import {
  SESSION_CANDIDATE,
  launchSessionEgressBrowser,
} from '../scripts/session-egress-browser.mjs';

it.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)(
  'preserves session-wide worker bypass evidence without promoting guarded Firefox',
  async () => {
    const report = await probeFirefoxEgress(process.env.AGENTBROWSER_FIREFOX_EXECUTABLE, {
      expected: SESSION_CANDIDATE,
      createBrowser: launchSessionEgressBrowser,
    });
    expect(report).toMatchObject(SESSION_CANDIDATE);
    expect(report.errors).toEqual([]);
    expect(report.versions).toEqual([SESSION_CANDIDATE.browser, SESSION_CANDIDATE.browser]);
    expect(report.sessionDetails).toHaveLength(2);
    for (const phase of report.sessionDetails) {
      expect(phase).toMatchObject({
        scope: 'session',
        subscribeAcknowledged: true,
        interceptAcknowledged: true,
      });
      expect(phase.blockedEvents).toBeGreaterThan(0);
    }
    for (const row of report.channels) {
      expect(row.allowedHits, row.channel).toBe(1);
      expect(row.allowedCompleted, row.channel).toBe(true);
    }
    for (const channel of ['navigation', 'redirect', 'fetch', 'dedicated-worker', 'websocket']) {
      expect(report.channels.find((row) => row.channel === channel)).toMatchObject({
        deniedHits: 0,
        denialCallbacks: 1,
        deniedCompleted: true,
      });
    }
    // A changed result must trigger review of the evidence, not automatic promotion.
    for (const channel of ['shared-worker', 'service-worker']) {
      expect(report.channels.find((row) => row.channel === channel)).toMatchObject({
        deniedHits: 1,
        denialCallbacks: 0,
        deniedOutcome: 'reached',
      });
      expect(report.gate.reasons).toContain(`${channel}:destination-reached`);
    }
    expect(report.responseInspection).toEqual({
      contentAvailable: null,
      deliveredBodyCharacters: 65536,
    });
    expect(report.gate.ready).toBe(false);
    expect(report.gate.reasons).toContain('responseBytesBeforeDelivery:unverified');
  },
  60_000
);

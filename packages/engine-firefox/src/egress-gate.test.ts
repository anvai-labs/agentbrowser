import { launch } from 'puppeteer-core';
import { expect, it } from 'vitest';
import { EXPECTED_CANDIDATE, probeFirefoxEgress } from '../scripts/probe-egress.mjs';
import { installPublicEgressPage } from '../scripts/public-egress-request.mjs';

it.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)(
  'records native target closure during interception setup without claiming installation',
  async () => {
    const executablePath = process.env.AGENTBROWSER_FIREFOX_EXECUTABLE;
    if (!executablePath) throw new Error('Configured Firefox binary required');
    const browser = await launch({
      browser: 'firefox',
      protocol: 'webDriverBiDi',
      executablePath,
      headless: true,
      args: ['--no-remote'],
    });
    try {
      const page = await browser.newPage();
      const errors: unknown[] = [];
      const intercepted = new Map();
      await installPublicEgressPage(
        {
          isClosed: () => page.isClosed(),
          on: () => {},
          async setRequestInterception(enabled: boolean) {
            // Force the actual native closed-context error after admission.
            await page.close();
            await page.setRequestInterception(enabled);
          },
        },
        { target: 'http://fixture.invalid', deny: true, errors, intercepted }
      );
      expect(page.isClosed()).toBe(true);
      expect(errors).toEqual([
        {
          phase: 'popup-install',
          reason: 'target-closed',
          message: 'Target closed before interception setup completed',
        },
      ]);
      expect(intercepted.size).toBe(0);
    } finally {
      await browser.close();
    }
  },
  30_000
);

it.skipIf(!process.env.AGENTBROWSER_FIREFOX_EXECUTABLE)(
  'keeps public interception unqualified when independent worker destinations bypass denial',
  async () => {
    const report = await probeFirefoxEgress(process.env.AGENTBROWSER_FIREFOX_EXECUTABLE);
    expect(report).toMatchObject(EXPECTED_CANDIDATE);
    // A newly opened popup can dispatch before page-scoped interception attaches.
    // A popup can also close during setup. Both remain disqualifying evidence;
    // unexpected probe errors still fail this regression.
    for (const error of report.errors) {
      if (error.reason === 'target-closed') {
        expect(error).toEqual({
          phase: 'popup-install',
          reason: 'target-closed',
          message: 'Target closed before interception setup completed',
        });
      } else {
        expect(error).toEqual({
          phase: 'interception',
          message: 'Denied request was not paused: /target/popup',
        });
      }
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

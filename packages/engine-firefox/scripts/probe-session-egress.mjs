import { firefoxExecutable } from './browser-config.mjs';
import { probeFirefoxEgress } from './probe-egress.mjs';
import { launchSessionEgressBrowser, SESSION_CANDIDATE } from './session-egress-browser.mjs';

const report = await probeFirefoxEgress(firefoxExecutable(), { expected: SESSION_CANDIDATE, createBrowser: launchSessionEgressBrowser });
console.log(JSON.stringify(report, null, 2));
if (!report.gate.ready) process.exitCode = 1;

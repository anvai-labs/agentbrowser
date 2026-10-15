/**
 * Server startup, loaded by bin.ts only after argument handling so that
 * --help/--version never pull in the engine graph (Playwright).
 * Port and host come from the PORT/HOST environment variables or the
 * ServerOptions defaults (5709 on 127.0.0.1; set HOST=0.0.0.0 for
 * network/container exposure).
 */

import { MetricsRegistry, StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import {
  CedarAuthorizer,
  loadPolicyFile,
  policyDocumentFromEnvironment,
  ShadowAuthorizer,
} from '@agentbrowser/policy-engine';
import { deploymentModeFromEnvironment } from './cdp-config.js';
import { operatorCdpFromEnvironment } from './cdp-startup.js';
import { extractMaxBytesFromEnvironment } from './extraction-config.js';
import {
  legacyAuthorizerFromEnvironment,
  networkPolicyFromEnvironment,
  unknownRiskFromEnvironment,
} from './network-policy-config.js';
import { apiKeysFromEnv, startServer } from './server.js';
import { parseLogLevel } from './server-args.js';

// TD-BROWSER-15 phase 4: a policy file replaces the environment-derived
// operator decisions entirely; AGENTBROWSER_POLICY_SHADOW evaluates the
// document this environment would generate alongside the legacy decisions
// (legacy decides; divergences warn). Invalid policy aborts startup.
const policyFilePath = process.env.AGENTBROWSER_POLICY_FILE?.trim() || undefined;
const policyShadow = /^(1|true|yes)$/i.test(process.env.AGENTBROWSER_POLICY_SHADOW?.trim() ?? '');
// TD-BROWSER-16 phase 4: the login browser is enabled only with operator
// keys present; main wires the flag and the server enforces the rest
// (hosted and multi-tenant deployments refuse to open it).
const loginBrowserEnabled = /^1$/i.test(process.env.AGENTBROWSER_LOGIN_BROWSER?.trim() ?? '');
const policyBearing = [
  'AGENTBROWSER_ALLOW_LOOPBACK',
  'AGENTBROWSER_ALLOWED_CIDRS',
  'AGENTBROWSER_APPROVAL_POLICY',
  'AGENTBROWSER_MAX_RESPONSE_BYTES',
];
let policy:
  | ({ kind: 'file' } & Awaited<ReturnType<typeof loadPolicyFile>>)
  | {
      kind: 'shadow';
      authorizer: ShadowAuthorizer;
      version: string;
      limits: Record<string, never>;
    }
  | undefined;
if (policyFilePath !== undefined) {
  const keys = apiKeysFromEnv();
  policy = {
    kind: 'file',
    ...(await loadPolicyFile(policyFilePath, {
      apiKeysConfigured: keys !== undefined,
      ...(keys !== undefined ? { keyTenants: [...new Set(keys.values())] } : {}),
    })),
  };
  // Conservative by design: warn when any loaded permit can grant the
  // loopback or private exception actions at all.
  for (const action of ['request.loopback', 'request.private']) {
    if (
      policy.document.policies.some(
        (p) => p.cedar.includes('permit(') && p.cedar.includes(`"${action}"`)
      )
    ) {
      console.warn(
        `[agentbrowser] The policy file permits ${action} for at least some requests; the floor's other blocks remain.`
      );
    }
  }
  if (
    policy.document.baseline === 'none' &&
    !policy.document.policies.some(
      (p) => p.cedar.includes('permit(') && p.cedar.includes('"request"')
    )
  ) {
    console.warn(
      '[agentbrowser] The policy baseline is "none" and no loaded policy permits the public egress request action; sessions may not be able to browse at all.'
    );
  }
} else {
  for (const name of policyBearing) {
    if (process.env[name] !== undefined) {
      console.warn(
        `[agentbrowser] ${name} is deprecated: write a policy file (agentbrowser-server policy export migrates today's configuration) and set AGENTBROWSER_POLICY_FILE.`
      );
    }
  }
  if (policyShadow) {
    // Legacy decides — with exactly the decisions the environment would make
    // without a shadow, so shadow mode observes, never changes, behavior.
    const document = policyDocumentFromEnvironment(process.env);
    const legacy = legacyAuthorizerFromEnvironment(
      process.env,
      unknownRiskFromEnvironment(process.env.AGENTBROWSER_APPROVAL_POLICY)
    );
    policy = {
      kind: 'shadow',
      authorizer: new ShadowAuthorizer(
        legacy,
        new CedarAuthorizer({ document, defaultTenant: 'local' })
      ),
      version: 'shadow',
      limits: {},
    };
  }
}

// Validate before engine/server startup; invalid operator policy aborts startup.
const networkPolicy =
  policyFilePath === undefined
    ? networkPolicyFromEnvironment(
        process.env,
        console.warn,
        policy?.kind === 'shadow' ? policy.authorizer : undefined
      )
    : undefined;
const extractMaxBytes =
  policyFilePath === undefined ? extractMaxBytesFromEnvironment(process.env) : undefined;
const operatorCdp = operatorCdpFromEnvironment(process.env);
const deploymentMode = deploymentModeFromEnvironment(process.env);
const engine = new PlaywrightChromiumEngine({
  ...(operatorCdp ? { operatorCdp } : {}),
  // ADR-025 §3: while the login browser is enabled, the shared pool
  // launches with the WebRTC IP-handling policy pinned (phase 6).
  ...(loginBrowserEnabled ? { forceWebrtcIpHandlingPolicy: true } : {}),
});
if (operatorCdp)
  console.warn(
    '[agentbrowser] Operator CDP attachment configured (local authenticated admission required): dedicated profile required. Only initial explicit navigation URLs are checked; redirects, subresources, workers, clicks, forms, downloads and operator activity are outside network containment.'
  );

// TD-BROWSER-7 Phase 2: real Safari via safaridriver, registered for
// capability discovery. The guarded service always attaches an egress policy,
// so Safari creation returns ENGINE_UNSUPPORTED / EGRESS_UNSUPPORTED even
// after driver enablement; direct-engine local use is a separate deployment.
const engines: Record<string, BrowserEngine> = {};
if (process.platform === 'darwin') {
  const { SafaridriverEngine } = await import('@agentbrowser/engine-safari');
  engines.safari = new SafaridriverEngine();
}
const metrics = new MetricsRegistry();
const logLevel = parseLogLevel(process.env.AGENTBROWSER_LOG_LEVEL);
if (logLevel.warning !== undefined) console.warn(logLevel.warning);
const logger = new StructuredLogger({ level: logLevel.level });

/** Parse a positive-int env var; undefined when unset or garbage (loud default). */
const envMs = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[agentbrowser] Ignoring ${name}="${raw}" - must be a positive integer of milliseconds.`
    );
    return undefined;
  }
  return parsed;
};

// Operator-level session defaults (per-request values still win).
const defaultTtlMs = envMs('AGENTBROWSER_DEFAULT_TTL_MS');
const defaultIdleTimeoutMs = envMs('AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS');
const server = await startServer({
  ...(operatorCdp ? { operatorCdp } : {}),
  deploymentMode,
  ...(extractMaxBytes !== undefined ? { extractMaxBytes } : {}),
  ...(networkPolicy !== undefined ? { networkPolicy } : {}),
  ...(loginBrowserEnabled ? { loginBrowser: true } : {}),
  ...(policy !== undefined
    ? {
        policy: {
          kind: policy.kind,
          authorizer: policy.authorizer,
          version: policy.authorizer.version,
          limits: policy.limits,
        },
      }
    : {}),
  engine,
  engines,
  metrics,
  logger,
  ...(defaultTtlMs !== undefined ? { defaultTtlMs } : {}),
  ...(defaultIdleTimeoutMs !== undefined ? { defaultIdleTimeoutMs } : {}),
});

// Ensure the browser process goes down with the server. The close runs once:
// stdin EOF racing a signal must not close the server twice. A SECOND SIGNAL
// (not a signal after stdin EOF) while the close is still pending — e.g. a
// wedged browser — forces exit 1: the operator's way out of a hung shutdown.
let shuttingDown = false;
let signalled = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close(); // onClose shuts the service down, which closes the engine
    process.exit(0);
  } catch (error) {
    console.error('[agentbrowser] shutdown failed:', error);
    process.exit(1);
  }
};
const onSignal = () => {
  if (signalled) process.exit(1);
  signalled = true;
  void shutdown();
};
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Ctrl-Break / console close on Windows.
if (process.platform === 'win32') signals.push('SIGBREAK');
for (const signal of signals) process.on(signal, onSignal);

// Launcher lifeline (opt-in): a supervising launcher holds our stdin open and
// closes it to stop us — and if the launcher is killed outright (Windows
// TerminateProcess), the OS closes the pipe, so the server still shuts down
// cleanly and takes Chromium with it instead of leaking an orphan.
if (process.env.AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF === '1') {
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  process.stdin.resume();
}

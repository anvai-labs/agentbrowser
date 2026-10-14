import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkPolicy } from '@agentbrowser/policy';
import {
  approvalModeOf,
  CedarAuthorizer,
  egressExceptionsOf,
  loadPolicyFile,
  MemoizedAuthorizer,
  ShadowAuthorizer,
  TenantBindingAuthorizer,
} from '@agentbrowser/policy-engine';
import { FakeEngine } from '@agentbrowser/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyAuthorizerFromEnvironment,
  unknownRiskFromEnvironment,
} from './network-policy-config.js';
import { sessionPolicyFactoryFor } from './policy-session.js';
import { startServer } from './server.js';
import { AgentBrowserService } from './service.js';

/**
 * TD-BROWSER-15 phase 4: the policy file end to end — per-session tenant-bound
 * decisions under the loaded policy, session stamping, memo clearing, the
 * embedder-conflict refusal, and /health's authorizer boolean.
 */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'api-policy-file-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Grants only the implicit no-keys tenant; loadable without API keys. */
const localDocument = {
  version: 'agentbrowser-policy/v1' as const,
  unknownRisk: 'allow' as const,
  approvalRules: [],
  policies: [
    {
      key: 'operator.loopback#1',
      ruleId: 'operator.loopback',
      cedar:
        '@rule("operator.loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { principal in AgentBrowser::Tenant::"local" };',
    },
  ],
};

const perTenantDocument = {
  version: 'agentbrowser-policy/v1' as const,
  unknownRisk: 'allow' as const,
  approvalRules: [],
  policies: [
    {
      key: 'operator.loopback#1',
      ruleId: 'operator.loopback',
      cedar:
        '@rule("operator.loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { principal in AgentBrowser::Tenant::"a" || principal in AgentBrowser::Tenant::"local" };',
    },
  ],
};

/** The factory startServer builds when a policy file is loaded. */
const sessionFactory =
  (authorizer: CedarAuthorizer, keyed: boolean, memoSpy?: MemoizedAuthorizer[]) =>
  (tenantId: string | undefined) => {
    const memo = new MemoizedAuthorizer(
      new TenantBindingAuthorizer(authorizer, keyed ? tenantId : undefined)
    );
    memoSpy?.push(memo);
    return {
      networkPolicy: new NetworkPolicy({
        blockLoopback: true,
        blockPrivateIPs: true,
        blockMetadata: true,
        exceptions: egressExceptionsOf(memo),
      }),
      clear: () => memo.clear(),
    };
  };

const serviceWith = (deps: ConstructorParameters<typeof AgentBrowserService>[0]) =>
  new AgentBrowserService({ engine: new FakeEngine(), ...deps });

describe('policy file: per-session decisions', () => {
  it('tenant A reaches a loopback fixture; tenant B is denied', async () => {
    const loaded = await (async () => {
      const path = join(dir, 'per-tenant.json');
      await writeFile(path, JSON.stringify(perTenantDocument));
      return loadPolicyFile(path, { apiKeysConfigured: true });
    })();
    const service = serviceWith({
      authorizer: loaded.authorizer,
      policyVersion: loaded.authorizer.version,
      sessionPolicyFactory: sessionFactory(loaded.authorizer, true),
    });
    // A loopback request through the session's policy chain: the floor blocks
    // loopback, and only the policy's exception can let it through.
    const policyA = sessionFactory(loaded.authorizer, true)('a').networkPolicy;
    await expect(policyA.checkRequest({ hostname: 'localhost' })).resolves.toBeUndefined();
    const policyB = sessionFactory(loaded.authorizer, true)('b').networkPolicy;
    await expect(policyB.checkRequest({ hostname: 'localhost' })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await service.shutdown();
  });

  it('with no keys, a tenantId:"qa" request cannot obtain qa grants', async () => {
    // A qa-only document cannot even LOAD without keys (the loader refuses
    // foreign tenants), so construct the authorizer directly and prove the
    // binding grants nothing: nothing is bound, and the implicit
    // Tenant::"local" is not "qa".
    const qaOnly = {
      version: 'agentbrowser-policy/v1' as const,
      unknownRisk: 'allow' as const,
      approvalRules: [],
      policies: [
        {
          key: 'operator.loopback#1',
          ruleId: 'operator.loopback',
          cedar:
            '@rule("operator.loopback") permit(principal, action == AgentBrowser::Action::"request.loopback", resource) when { principal in AgentBrowser::Tenant::"qa" };',
        },
      ],
    };
    const authorizer = new CedarAuthorizer({ document: qaOnly, defaultTenant: 'local' });
    const factory = sessionFactory(authorizer, false);
    await expect(
      factory('qa').networkPolicy.checkRequest({ hostname: 'localhost' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('the session view carries the policy version', async () => {
    const path = join(dir, 'stamp.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const service = serviceWith({
      authorizer: loaded.authorizer,
      policyVersion: loaded.authorizer.version,
      sessionPolicyFactory: sessionFactory(loaded.authorizer, false),
    });
    const session = await service.createSession({});
    expect(session.policyVersion).toBe(loaded.authorizer.version);
    await service.closeSession(session.sessionId);
    await service.shutdown();
  });

  it('closing a session clears its memo', async () => {
    const path = join(dir, 'memo.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const memos: MemoizedAuthorizer[] = [];
    const service = serviceWith({
      authorizer: loaded.authorizer,
      policyVersion: loaded.authorizer.version,
      sessionPolicyFactory: sessionFactory(loaded.authorizer, false, memos),
    });
    const session = await service.createSession({});
    expect(memos.length).toBe(1);
    // A decision through the session's chain warms the memo.
    await memos[0]!.decide({ action: 'downloads', context: {} });
    expect(memos[0]?.size).toBeGreaterThan(0);
    await service.closeSession(session.sessionId);
    expect(memos[0]?.size).toBe(0);
    await service.shutdown();
  });
});

describe('startServer with a policy file', () => {
  it('refuses embedder options, naming every conflict', async () => {
    const path = join(dir, 'conflict.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const policy = {
      authorizer: loaded.authorizer,
      version: loaded.authorizer.version,
      limits: loaded.limits,
    };
    await expect(
      startServer({
        engine: new FakeEngine(),
        policy,
        networkPolicy: new NetworkPolicy({ blockLoopback: true }),
      })
    ).rejects.toThrow(/cannot be combined with networkPolicy/);
    await expect(
      startServer({ engine: new FakeEngine(), policy, extractMaxBytes: 2048, approvalPolicy: {} })
    ).rejects.toThrow(/approvalPolicy, extractMaxBytes/);
  });

  it('/health exposes the authorizer health as a boolean only', async () => {
    const path = join(dir, 'health.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const app = await startServer({
      engine: new FakeEngine(),
      policy: {
        authorizer: loaded.authorizer,
        version: loaded.authorizer.version,
        limits: loaded.limits,
      },
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      const body = response.json() as { authorizerHealthy?: boolean };
      expect(body.authorizerHealthy).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('review of phase 4: shadow startup and untrusted tenant claims', () => {
  it('shadow mode starts alongside the environment network policy (kind: shadow)', async () => {
    // The previously fatal combination: a policy wrapper plus the
    // environment-derived networkPolicy. Only a FILE refuses the combination.
    const path = join(dir, 'shadow-start.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const shadow = new ShadowAuthorizer(legacyAuthorizerFromEnvironment({}), loaded.authorizer);
    const app = await startServer({
      engine: new FakeEngine(),
      policy: { kind: 'shadow', authorizer: shadow, version: 'shadow', limits: {} },
      networkPolicy: new NetworkPolicy({ blockLoopback: true }),
      port: 0,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect((response.json() as { authorizerHealthy?: boolean }).authorizerHealthy).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('a claimed tenant gates no capability without keys', async () => {
    // A policy granting downloads only to a context claiming tenantId "qa"
    // loads without keys (no entity literal); the claim must not work.
    const document = {
      version: 'agentbrowser-policy/v1' as const,
      unknownRisk: 'allow' as const,
      approvalRules: [],
      policies: [
        {
          key: 'operator.downloads#1',
          ruleId: 'operator.downloads',
          cedar:
            '@rule("operator.downloads") permit(principal, action == AgentBrowser::Action::"downloads", resource) when { context has tenantId && context.tenantId == "qa" };',
        },
      ],
    };
    const authorizer = new CedarAuthorizer({ document, defaultTenant: 'local' });
    const service = serviceWith({
      authorizer,
      tenantsConfigured: false,
    });
    await expect(
      service.createSession({ allowDownloads: true, tenantId: 'qa' })
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // With keys configured, the (authenticated) tenant decides and the
    // capability is granted: creation succeeds.
    const keyed = serviceWith({ authorizer, tenantsConfigured: true });
    const session = await keyed.createSession({ allowDownloads: true, tenantId: 'qa' });
    await keyed.closeSession(session.sessionId);
    await keyed.shutdown();
    await service.shutdown();
  });

  it('the shadow legacy side mirrors the environment decisions', () => {
    const env = {
      AGENTBROWSER_ALLOWED_CIDRS: ' 10.0.0.0/8 , 192.168.0.0/16 ',
      AGENTBROWSER_ALLOW_LOOPBACK: 'YES',
    };
    const legacy = legacyAuthorizerFromEnvironment(env);
    const egress = {
      action: 'request.private' as const,
      context: {
        phase: 'resolved' as const,
        target: '10.1.2.3',
        addressClasses: ['private' as const],
        privateSources: [{ address: '10.1.2.3', type: 'ipv4' as const }],
      },
    };
    expect(legacy.decide(egress)).toMatchObject({ allowed: true });
    const loopback = {
      action: 'request.loopback' as const,
      context: {
        phase: 'hostname' as const,
        target: 'localhost',
        addressClasses: ['loopback' as const],
        privateSources: [],
      },
    };
    expect(legacy.decide(loopback)).toMatchObject({ allowed: true });
    expect(legacyAuthorizerFromEnvironment({}).decide(loopback)).toMatchObject({
      allowed: false,
    });
  });
});

describe('review of phase 4, round 2: shadow parity', () => {
  it('R1: shadow sessions keep the environment response-size cap', async () => {
    // The exact repro: AGENTBROWSER_MAX_RESPONSE_BYTES=1024 must reject a
    // 5000-byte body in shadow mode exactly as it does without one.
    const policy = sessionPolicyFactoryFor(
      { kind: 'shadow', authorizer: new CedarAuthorizer({ document: localDocument }), limits: {} },
      true,
      { AGENTBROWSER_MAX_RESPONSE_BYTES: '1024' }
    )('t1');
    await expect(policy.networkPolicy.checkBodySize(5000)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    await expect(policy.networkPolicy.checkBodySize(500)).resolves.toBeUndefined();
    // Without the env var the default applies (10 MB): 5000 passes.
    const unshackled = sessionPolicyFactoryFor(
      { kind: 'shadow', authorizer: new CedarAuthorizer({ document: localDocument }), limits: {} },
      true,
      {}
    )('t1');
    await expect(unshackled.networkPolicy.checkBodySize(5000)).resolves.toBeUndefined();
  });

  it('R1: file limits still set the cap, and only for files', async () => {
    const file = sessionPolicyFactoryFor(
      {
        kind: 'file',
        authorizer: new CedarAuthorizer({ document: localDocument }),
        limits: { maxResponseBytes: 2048 },
      },
      true
    )('t1');
    await expect(file.networkPolicy.checkBodySize(5000)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    // A file with no limit: the default applies.
    const unbounded = sessionPolicyFactoryFor(
      { kind: 'file', authorizer: new CedarAuthorizer({ document: localDocument }), limits: {} },
      true
    )('t1');
    await expect(unbounded.networkPolicy.checkBodySize(5000)).resolves.toBeUndefined();
  });

  it('R2: the shadow deciding side honors the approval policy unknownRisk', () => {
    // With AGENTBROWSER_APPROVAL_POLICY={"unknownRisk":"required"}, unknown
    // effects require approval — in shadow mode exactly as without it.
    const legacy = legacyAuthorizerFromEnvironment(
      {},
      unknownRiskFromEnvironment('{"unknownRisk":"required"}')
    );
    expect(approvalModeOf(legacy, { effect: 'unknown' })).toBe('required');
    // And the default env keeps 'allow'.
    expect(
      approvalModeOf(legacyAuthorizerFromEnvironment({}, unknownRiskFromEnvironment(undefined)), {
        effect: 'unknown',
      })
    ).toBe('allow');
  });

  it('the embedder gap: a file plus policy-bearing env vars refuses at startServer too', async () => {
    const path = join(dir, 'embedder-env.json');
    await writeFile(path, JSON.stringify(localDocument));
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    const previous = process.env.AGENTBROWSER_ALLOW_LOOPBACK;
    process.env.AGENTBROWSER_ALLOW_LOOPBACK = '1';
    try {
      await expect(
        startServer({
          engine: new FakeEngine(),
          policy: {
            authorizer: loaded.authorizer,
            version: loaded.authorizer.version,
            limits: loaded.limits,
          },
          port: 0,
        })
      ).rejects.toThrow(
        /AGENTBROWSER_POLICY_FILE cannot be combined with AGENTBROWSER_ALLOW_LOOPBACK/
      );
    } finally {
      if (previous === undefined) delete process.env.AGENTBROWSER_ALLOW_LOOPBACK;
      else process.env.AGENTBROWSER_ALLOW_LOOPBACK = previous;
    }
  });
});

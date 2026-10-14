import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { policyDocumentFromLegacyConfig } from './cedar-generator.js';
import { loadPolicyFile, PolicyFileError } from './policy-file.js';

/**
 * TD-BROWSER-15 phase 4: the policy file loader's startup refusals. Every
 * refusal is a startup error in the TD's words — never a silent ignore.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'policy-file-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (document: unknown, name = 'policy.json') => {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(document));
  return path;
};

const generated = () => policyDocumentFromLegacyConfig({ allowedPrivateCIDRs: ['10.0.0.0/8'] });

describe('loadPolicyFile refusals', () => {
  it('refuses a file combined with policy-bearing variables, naming every conflict', async () => {
    const path = await write(generated());
    await expect(
      loadPolicyFile(path, { apiKeysConfigured: false }, { AGENTBROWSER_ALLOW_LOOPBACK: '1' })
    ).rejects.toThrow(
      /cannot be combined with policy-bearing variables: AGENTBROWSER_ALLOW_LOOPBACK/
    );
    await expect(
      loadPolicyFile(
        path,
        { apiKeysConfigured: true },
        { AGENTBROWSER_ALLOW_LOOPBACK: '1', AGENTBROWSER_APPROVAL_POLICY: '{}' }
      )
    ).rejects.toThrow(/AGENTBROWSER_ALLOW_LOOPBACK, AGENTBROWSER_APPROVAL_POLICY/);
  });

  it('refuses an unreadable or unparsable file', async () => {
    await expect(
      loadPolicyFile(join(dir, 'missing.json'), { apiKeysConfigured: false })
    ).rejects.toThrow(/cannot read or parse the policy file/);
    const path = join(dir, 'broken.json');
    await writeFile(path, '{not json');
    await expect(loadPolicyFile(path, { apiKeysConfigured: false })).rejects.toThrow(
      /cannot read or parse the policy file/
    );
  });

  it('refuses an unknown limits key instead of ignoring it', async () => {
    const path = await write({ ...generated(), limits: { extractMaxBytes: 4096, nonsense: 1 } });
    await expect(loadPolicyFile(path, { apiKeysConfigured: true })).rejects.toThrow(
      /Invalid policy document/
    );
  });

  it('refuses a Tenant literal other than local while no API keys are configured', async () => {
    const document = generated();
    document.policies.push({
      key: 'operator.qa#1',
      ruleId: 'operator.qa',
      cedar:
        '@rule("operator.qa") permit(principal == AgentBrowser::Tenant::"qa", action, resource) when { context.t == AgentBrowser::Tenant::"deep" };',
    });
    const path = await write(document);
    // The literal is found in the scope AND inside the condition.
    await expect(loadPolicyFile(path, { apiKeysConfigured: false })).rejects.toThrow(
      /names tenants "deep", "qa" but no API keys are configured/
    );
    // With keys configured the same document loads.
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: true });
    expect(loaded.authorizer.healthy).toBe(true);
  });

  it('refuses a key tenant named local', async () => {
    const path = await write(generated());
    await expect(
      loadPolicyFile(path, { apiKeysConfigured: true, keyTenants: ['local', 'acme'] })
    ).rejects.toThrow(/tenant name "local" is reserved/);
  });

  it('refuses a document the authorizer refuses (strict validation)', async () => {
    const document = generated();
    document.policies.push({
      key: 'operator.bad#1',
      ruleId: 'operator.bad',
      cedar: 'permit(principal, action, resource) when { context.nope == "x" };',
    });
    const path = await write(document);
    await expect(loadPolicyFile(path, { apiKeysConfigured: true })).rejects.toThrow(
      /Cedar validation failed/
    );
  });

  it('refuses a mismatched @rule annotation', async () => {
    const document = generated();
    document.policies.push({
      key: 'operator.x#1',
      ruleId: 'operator.x',
      cedar: '@rule("operator.y") permit(principal, action, resource);',
    });
    const path = await write(document);
    await expect(loadPolicyFile(path, { apiKeysConfigured: true })).rejects.toThrow(
      /@rule annotation does not match/
    );
  });
});

describe('loadPolicyFile success', () => {
  it('loads a generated document and carries its limits', async () => {
    const document = { ...generated(), limits: { extractMaxBytes: 4096 } };
    const path = await write(document);
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    expect(loaded.limits).toEqual({ extractMaxBytes: 4096 });
    expect(loaded.authorizer.version).toBe(loaded.authorizer.version); // stable
    const again = await loadPolicyFile(path, { apiKeysConfigured: false });
    expect(again.authorizer.version).toBe(loaded.authorizer.version);
  });

  it('loads with empty limits by default', async () => {
    const path = await write(generated());
    const loaded = await loadPolicyFile(path, { apiKeysConfigured: false });
    expect(loaded.limits).toEqual({});
  });
});

describe('PolicyFileError', () => {
  it('is distinguishable from validation errors', () => {
    expect(new PolicyFileError('x').name).toBe('PolicyFileError');
  });
});

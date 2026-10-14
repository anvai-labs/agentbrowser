import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorKeysFromEnvironment, operatorKeysFromFile } from './operator-keys.js';

/** TD-BROWSER-16 phase 1: the operator credential file and its refusals. */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'operator-keys-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (text: string) => {
  const path = join(dir, 'keys');
  await writeFile(path, text);
  return path;
};
const sha = (key: string) => createHash('sha256').update(key).digest('hex');

describe('operator keys file', () => {
  it('parses key:tenant lines, skipping blanks and comments', async () => {
    const path = await write('# operators\nop-key-one-aaaaaaaa:acme\n\nop-key-two-aaaaaaaa:acme\n');
    const keys = await operatorKeysFromFile(path, {
      apiKeys: new Map([[sha('api-key-aaaaaaaaaaaa'), 'acme']]),
    });
    expect(keys.tenant).toBe('acme');
    expect([...keys.byHash.values()]).toEqual(['acme', 'acme']);
    expect(keys.byHash.has(sha('op-key-one-aaaaaaaa'))).toBe(true);
  });

  it('refuses malformed lines, bad key shapes, duplicates, empty files', async () => {
    await expect(operatorKeysFromFile(await write('no-colon'))).rejects.toThrow(/key:tenant/);
    await expect(operatorKeysFromFile(await write('short:acme'))).rejects.toThrow(
      /16-128 characters/
    );
    await expect(
      operatorKeysFromFile(await write('op-key-one-aaaaaaaa:acme\nop-key-one-aaaaaaaa:acme'))
    ).rejects.toThrow(/duplicates/);
    await expect(operatorKeysFromFile(await write('# only comments\n'))).rejects.toThrow(
      /no key:tenant entries/
    );
  });

  it('refuses mixed tenants: one file, one tenant', async () => {
    await expect(
      operatorKeysFromFile(await write('op-key-one-aaaaaaaa:acme\nop-key-two-aaaaaaaa:other'))
    ).rejects.toThrow(/single configured tenant/);
  });

  it('refuses a key present in both credential sets', async () => {
    const shared = 'shared-operator-key';
    const apiKeys = new Map([[sha(shared), 'acme']]);
    await expect(operatorKeysFromFile(await write(`${shared}:acme`), { apiKeys })).rejects.toThrow(
      /one credential, one identity/
    );
  });

  it('refuses a tenant that is not the API-key tenant', async () => {
    const apiKeys = new Map([[sha('some-api-key-aaaaaa'), 'acme']]);
    await expect(
      operatorKeysFromFile(await write('op-key-one-aaaaaaaa:other'), { apiKeys })
    ).rejects.toThrow(/not the API-key tenant/);
  });

  it('errors never contain key values', async () => {
    const secret = 'op-secret-value-aaaa';
    const attempt = operatorKeysFromFile(await write(`${secret}:acme\n${secret}:acme`));
    await expect(attempt).rejects.toThrow(/duplicates a key/);
    try {
      await attempt;
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('reads from the environment; unset means none', async () => {
    expect(await operatorKeysFromEnvironment({})).toBeUndefined();
    const path = await write('op-key-one-aaaaaaaa:acme');
    const keys = await operatorKeysFromEnvironment(
      { AGENTBROWSER_OPERATOR_KEYS_FILE: path },
      { apiKeys: new Map([[sha('api-key-aaaaaaaaaaaa'), 'acme']]) }
    );
    expect(keys?.tenant).toBe('acme');
  });
});

describe('operator keys review round 1 (F9, F10)', () => {
  it('refuses an operator file when no API keys are configured', async () => {
    const path = await write('op-key-one-aaaaaaaa:acme');
    await expect(operatorKeysFromFile(path)).rejects.toThrow(/requires AGENTBROWSER_API_KEYS/);
  });

  it('refuses a multi-tenant API-key deployment', async () => {
    const sha2 = (k: string) => createHash('sha256').update(k).digest('hex');
    const path = await write('op-key-one-aaaaaaaa:acme');
    await expect(
      operatorKeysFromFile(path, {
        apiKeys: new Map([
          [sha('api-key-aaaaaaaaaaaa'), 'acme'],
          [sha2('api-key-bbbbbbbbbbbb'), 'other'],
        ]),
      })
    ).rejects.toThrow(/exactly one API-key tenant/);
  });
});

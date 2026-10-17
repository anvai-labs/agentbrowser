import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENGAGEMENT_MAX_BYTES,
  engagementConfigFromEnvironment,
} from './engagement-config.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const privateDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-cfg-'));
  dirs.push(dir);
  await chmod(dir, 0o700);
  return dir;
};

describe('engagement configuration (T10 M2)', () => {
  it('is absent unless configured', async () => {
    expect(await engagementConfigFromEnvironment({})).toBeUndefined();
  });

  it('accepts a private directory with the default cap', async () => {
    const dir = await privateDir();
    expect(await engagementConfigFromEnvironment({ AGENTBROWSER_ENGAGEMENT_DIR: dir })).toEqual({
      directory: dir,
      maxBytes: DEFAULT_ENGAGEMENT_MAX_BYTES,
    });
  });

  it('refuses unsafe or malformed settings', async () => {
    const dir = await privateDir();
    const open = await privateDir();
    await chmod(open, 0o777);
    const link = join(dir, 'link');
    await symlink(dir, link);
    const readable = await privateDir();
    await chmod(readable, 0o750);
    const throughLink = join(link, 'inner');
    await (await import('node:fs/promises')).mkdir(join(dir, 'inner'), { mode: 0o700 });
    for (const env of [
      { AGENTBROWSER_ENGAGEMENT_DIR: 'relative/dir' },
      { AGENTBROWSER_ENGAGEMENT_DIR: join(dir, 'missing') },
      { AGENTBROWSER_ENGAGEMENT_DIR: open },
      { AGENTBROWSER_ENGAGEMENT_DIR: link },
      { AGENTBROWSER_ENGAGEMENT_DIR: readable },
      { AGENTBROWSER_ENGAGEMENT_DIR: throughLink },
      { AGENTBROWSER_ENGAGEMENT_DIR: dir, AGENTBROWSER_ENGAGEMENT_MAX_BYTES: '1' },
      { AGENTBROWSER_ENGAGEMENT_DIR: dir, AGENTBROWSER_ENGAGEMENT_MAX_BYTES: '64MiB' },
      { AGENTBROWSER_ENGAGEMENT_MAX_BYTES: '2097152' },
    ])
      await expect(engagementConfigFromEnvironment(env)).rejects.toThrow(/Invalid configuration/);
  });

  it('refuses Windows, where directory privacy cannot be verified', async () => {
    const dir = await privateDir();
    await expect(
      engagementConfigFromEnvironment({ AGENTBROWSER_ENGAGEMENT_DIR: dir }, 'win32')
    ).rejects.toThrow(/not supported on Windows/);
  });
});

import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * T10 M2: operator configuration for engagement ledgers.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `AGENTBROWSER_ENGAGEMENT_DIR` | existing private local directory: absolute, canonical (no symlinked component), owned by the server user, mode 0700 (no group/other access); unset = ledgers refused |
 * | `AGENTBROWSER_ENGAGEMENT_MAX_BYTES` | per-engagement byte cap, 1 MiB to 1 GiB (default 64 MiB) |
 */
export interface EngagementConfig {
  directory: string;
  maxBytes: number;
}

export const DEFAULT_ENGAGEMENT_MAX_BYTES = 64 * 1024 * 1024;
const MIN_BYTES = 1024 * 1024;
const MAX_BYTES = 1024 * 1024 * 1024;

export async function engagementConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<EngagementConfig | undefined> {
  const value = (name: string) => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const directory = value('AGENTBROWSER_ENGAGEMENT_DIR');
  const maxRaw = value('AGENTBROWSER_ENGAGEMENT_MAX_BYTES');
  if (directory === undefined) {
    if (maxRaw !== undefined)
      throw new Error(
        'Invalid configuration: AGENTBROWSER_ENGAGEMENT_MAX_BYTES requires AGENTBROWSER_ENGAGEMENT_DIR'
      );
    return undefined;
  }
  // The privacy checks below are POSIX mode and owner checks; Windows ACLs are not
  // checked, so refuse there rather than accept an unverified directory.
  if (platform === 'win32')
    throw new Error(
      'Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR is not supported on Windows yet (its directory privacy cannot be verified)'
    );
  if (!isAbsolute(directory))
    throw new Error('Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR must be an absolute path');
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory())
    throw new Error(
      'Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR must be an existing directory (not a symlink)'
    );
  if ((await realpath(directory).catch(() => undefined)) !== directory)
    throw new Error(
      'Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR must be a canonical path with no symlinked component'
    );
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new Error(
      'Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR must be owned by the server user'
    );
  if ((info.mode & 0o077) !== 0)
    throw new Error(
      'Invalid configuration: AGENTBROWSER_ENGAGEMENT_DIR must be private (no group or other access, e.g. mode 0700)'
    );
  const maxBytes = maxRaw === undefined ? DEFAULT_ENGAGEMENT_MAX_BYTES : Number(maxRaw);
  if (
    !/^\d+$/.test(maxRaw ?? '0') ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < MIN_BYTES ||
    maxBytes > MAX_BYTES
  )
    throw new Error(
      `Invalid configuration: AGENTBROWSER_ENGAGEMENT_MAX_BYTES must be an integer from ${MIN_BYTES} to ${MAX_BYTES}`
    );
  return { directory, maxBytes };
}

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import {
  adoptAssetCandidates,
  deniedHostsFromLedger,
  ENGAGEMENT_GENESIS,
  engagementChainHash,
  loadTldts,
  verifyEngagementLedger,
} from '@agentbrowser/core';
import { validateEngagementScope } from '@agentbrowser/protocol';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function bounded(path: string, maxBytes: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Scope/ledger input exceeds its bound or is not a regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Local operator file operation: preview by default, explicit named hosts to commit. */
export async function adoptScopeAssets(
  path: string,
  ledgerPath: string,
  approved?: string[],
  options: { replace?: typeof rename } = {}
) {
  await loadTldts();
  const original = await bounded(path, 1024 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    throw new Error('Invalid engagement scope JSON');
  }
  const checked = validateEngagementScope(parsed);
  if (!checked.ok) throw new Error('Invalid engagement scope');
  const ledger = await bounded(ledgerPath, 128 * 1024 * 1024);
  const candidates = deniedHostsFromLedger(ledger);
  if (candidates.truncated)
    throw new Error('Too many denied hosts; select a bounded engagement ledger');
  const preview = adoptAssetCandidates(checked.value, candidates.hosts);
  if (!approved) return { preview: true, candidates: candidates.hosts, scope: preview };
  const selected = [...new Set(approved.map((h) => h.toLowerCase().trim()))].sort();
  if (
    !selected.length ||
    selected.some((host) => !(preview.assetHosts ?? []).some((a) => a.host === host))
  )
    throw new Error('Approve only exact static-asset candidates from the ledger');
  const next = adoptAssetCandidates(
    checked.value,
    candidates.hosts.filter((h) => selected.includes(h.hostname))
  );
  const before = sha(JSON.stringify(checked.value));
  const after = sha(JSON.stringify(next));
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if ((await bounded(path, 1024 * 1024)) !== original)
      throw new Error('Scope changed during adoption');
    const logPath = `${path}.amendments.ndjson`;
    let prior = '';
    try {
      prior = await bounded(logPath, 2 * 1024 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const lines = prior.trim() ? prior.trim().split('\n') : [];
    if (lines.length && (!prior.endsWith('\n') || !verifyEngagementLedger(prior).ok))
      throw new Error('Invalid scope amendment chain');
    const last = lines.length
      ? (JSON.parse(lines[lines.length - 1] as string) as {
          hash: string;
          type: string;
          data: { toSha256?: string; fromSha256?: string };
        })
      : undefined;
    let prev = last?.hash ?? ENGAGEMENT_GENESIS;
    let seq = lines.length;
    const encode = (type: string, data: Record<string, unknown>) => {
      const body = { seq: seq++, at: new Date().toISOString(), type, data };
      const hash = engagementChainHash(prev, JSON.stringify(body));
      const line = `${JSON.stringify({ ...body, prev, hash })}\n`;
      prev = hash;
      return line;
    };
    let recovery = '';
    if (last?.type === 'scope.assets.authorized') {
      if (last.data.toSha256 === before)
        recovery = encode('scope.assets.recovered.committed', { toSha256: before });
      else if (last.data.fromSha256 === before)
        recovery = encode('scope.assets.recovered.aborted', { toSha256: before });
      else throw new Error('Pending scope amendment does not match this scope');
    } else if (last && last.data.toSha256 !== before)
      throw new Error('Scope amendment chain does not match this scope');
    if (before === after && !recovery) return { preview: false, scope: next, adopted: [] };
    const audit = await open(
      logPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    let logBytes = Buffer.byteLength(prior);
    const persist = async (text: string) => {
      if (logBytes + Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new Error('Scope amendment log is full');
      const written = await audit.write(text);
      if (written.bytesWritten !== Buffer.byteLength(text))
        throw new Error('Short amendment write');
      await audit.sync();
      logBytes += written.bytesWritten;
    };
    try {
      if (recovery) await persist(recovery);
      if (before === after) return { preview: false, scope: next, adopted: [] };
      let authorized = last
        ? ''
        : encode('engagement.opened', { kind: 'scope.amendments', toSha256: before });
      authorized += encode('scope.assets.authorized', {
        fromSha256: before,
        toSha256: after,
        hosts: selected,
        ledgerSha256: sha(ledger),
      });
      await persist(authorized);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        await (options.replace ?? rename)(temporary, path);
      } catch {
        await persist(encode('scope.assets.aborted', { toSha256: before }));
        throw new Error('Scope replacement failed; the authorization was aborted');
      }
      await persist(encode('scope.assets.committed', { toSha256: after }));
    } finally {
      await audit.close();
    }
    return { preview: false, scope: next, adopted: selected, amendmentLog: logPath };
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

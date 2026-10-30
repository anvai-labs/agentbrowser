// T10 M2: the engagement ledger's chain, tamper evidence and bounds.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_ID,
  EngagementLedger,
  engagementPath,
  RESERVE_BYTES,
  verifyEngagementLedger,
} from './engagement-ledger.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  dirs.push(dir);
  return dir;
};

async function ledgerWith(maxBytes = 1024 * 1024) {
  const directory = await scratch();
  const unavailable: string[] = [];
  const ledger = await EngagementLedger.open(
    { directory, tenantId: 'one', maxBytes, onUnavailable: (reason) => unavailable.push(reason) },
    { sessionId: 'ses_1' }
  );
  return { ledger, unavailable, directory };
}

describe('engagement ledger (T10 M2)', () => {
  it('acknowledges critical records only after persistence and refuses closed ledgers', async () => {
    const { ledger } = await ledgerWith();
    await ledger.appendCritical('scope.amended', { revision: 1 });
    expect(await readFile(ledger.path, 'utf8')).toContain('scope.amended');
    await ledger.close({});
    await expect(ledger.appendCritical('scope.amended', { revision: 2 })).rejects.toThrow();
  });
  it('refuses a critical authority change when fsync fails', async () => {
    const unavailable: string[] = [];
    const ledger = await EngagementLedger.open(
      {
        directory: await scratch(),
        tenantId: 'one',
        maxBytes: 1024 * 1024,
        onUnavailable: (reason) => unavailable.push(reason),
        openFile: async () => ({
          write: async (line) => ({
            bytesWritten: Buffer.byteLength(line as string),
            buffer: line,
          }),
          sync: async () => {
            throw new Error('disk failure');
          },
          close: async () => {},
        }),
      },
      {}
    );
    await expect(ledger.appendCritical('scope.amended', { revision: 1 })).rejects.toThrow();
    expect(unavailable).toEqual(['write_failed']);
    await ledger.close({});
  });
  it('writes a chain that verifies, opened to closed, in a private tenant-scoped file', async () => {
    const { ledger, directory } = await ledgerWith();
    expect(ledger.engagementId).toMatch(ENGAGEMENT_ID);
    expect(ledger.path).toBe(engagementPath(directory, 'one', ledger.engagementId));
    ledger.append('request', { method: 'GET', url: 'https://in.example/a', status: 200 });
    ledger.append('request', {
      method: 'POST',
      url: 'https://in.example/b',
      blocked: true,
      scope: 'SCOPE_HOST_DENIED',
    });
    await ledger.close({ reason: 'session closed' });
    const text = await readFile(ledger.path, 'utf8');
    expect(verifyEngagementLedger(text)).toEqual({ ok: true, records: 4, closed: true });
    const lines = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual([
      'engagement.opened',
      'request',
      'request',
      'engagement.closed',
    ]);
    expect(lines[3].data).toMatchObject({ records: 3, dropped: 0, state: 'open' });
    expect((await stat(ledger.path)).mode & 0o077).toBe(0);
  });

  it('detects an edited, removed, reordered or appended line', async () => {
    const { ledger } = await ledgerWith();
    for (const path of ['/a', '/b', '/c'])
      ledger.append('request', { url: `https://in.example${path}` });
    await ledger.close({});
    const lines = (await readFile(ledger.path, 'utf8')).trim().split('\n');
    const edited = [...lines];
    edited[2] = edited[2]!.replace('/b', '/x');
    expect(verifyEngagementLedger(edited.join('\n'))).toMatchObject({ ok: false, seq: 2 });
    expect(
      verifyEngagementLedger([lines[0], lines[1], lines[3], lines[4]].join('\n'))
    ).toMatchObject({ ok: false });
    expect(
      verifyEngagementLedger([lines[0], lines[2], lines[1], lines[3], lines[4]].join('\n'))
    ).toMatchObject({ ok: false });
    expect(verifyEngagementLedger([...lines, lines[1]].join('\n'))).toMatchObject({ ok: false });
    expect(verifyEngagementLedger('')).toMatchObject({ ok: false });
  });

  it('reports full before the hard cap, then counts what it could not write', async () => {
    const { ledger, unavailable } = await ledgerWith(RESERVE_BYTES + 4 * 1024);
    const filler = 'x'.repeat(900);
    for (let index = 0; index < 200; index += 1) ledger.append('request', { url: filler, index });
    expect(ledger.state).toBe('full');
    expect(unavailable).toEqual(['full']);
    await ledger.close({});
    const text = await readFile(ledger.path, 'utf8');
    const verdict = verifyEngagementLedger(text);
    expect(verdict).toMatchObject({ ok: true, closed: true });
    const closing = JSON.parse(text.trim().split('\n').at(-1)!);
    expect(closing.data.dropped).toBeGreaterThan(0);
    expect(closing.data.state).toBe('full');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(RESERVE_BYTES + 4 * 1024 + 1024);
  });

  it('never reuses an engagement file and refuses a malformed id', async () => {
    const directory = await scratch();
    expect(() => engagementPath(directory, 'one', '../../etc/passwd')).toThrow();
    const options = { directory, tenantId: 'one', maxBytes: 1024 * 1024, onUnavailable: () => {} };
    const a = await EngagementLedger.open(options, {});
    const b = await EngagementLedger.open(options, {});
    expect(a.engagementId).not.toBe(b.engagementId);
    await a.close({});
    await b.close({});
  });

  it('the chain link is checked: a re-hashed record still breaks its successor', async () => {
    const { ledger } = await ledgerWith();
    ledger.append('request', { url: 'https://in.example/a' });
    ledger.append('request', { url: 'https://in.example/b' });
    await ledger.close({});
    const lines = (await readFile(ledger.path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const { createHash } = await import('node:crypto');
    // Forge record 1 and recompute its own hash from its stated prev.
    lines[1].data.url = 'https://in.example/forged';
    const body = JSON.stringify({
      seq: lines[1].seq,
      at: lines[1].at,
      type: lines[1].type,
      data: lines[1].data,
    });
    lines[1].hash = createHash('sha256').update(`${lines[1].prev}\n${body}`).digest('hex');
    const forged = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(verifyEngagementLedger(forged)).toMatchObject({
      ok: false,
      seq: 2,
      reason: 'chain break',
    });
  });

  it('only the canonical line form verifies: extra fields, duplicate keys, reformatting fail', async () => {
    const { ledger } = await ledgerWith();
    ledger.append('request', { url: 'https://in.example/a' });
    await ledger.close({});
    const lines = (await readFile(ledger.path, 'utf8')).trim().split('\n');
    const variants = [
      lines[1]!.replace('{"seq"', '{"note":"approved","seq"'),
      lines[1]!.replace(
        '"url":"https://in.example/a"',
        '"url":"https://evil.example/","url":"https://in.example/a"'
      ),
      lines[1]!.replace('"seq":1,', '"seq": 1,'),
    ];
    for (const variant of variants) {
      const text = [lines[0], variant, lines[2]].join('\n');
      expect(verifyEngagementLedger(text)).toMatchObject({ ok: false, seq: 1 });
    }
  });

  it('a write failure stops the scope and later records are counted, not lost silently', async () => {
    const { ledger, unavailable } = await ledgerWith();
    // Close the underlying file so the next write fails (EBADF).
    await (ledger as unknown as { handle: { close(): Promise<void> } }).handle.close();
    ledger.append('request', { url: 'https://in.example/a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ledger.state).toBe('write_failed');
    expect(unavailable).toEqual(['write_failed']);
    ledger.append('request', { url: 'https://in.example/b' });
    expect((ledger as unknown as { dropped: number }).dropped).toBe(1);
  });

  it('a short write is a write failure', async () => {
    const directory = await scratch();
    const unavailable: string[] = [];
    let writes = 0;
    const ledger = await EngagementLedger.open(
      {
        directory,
        tenantId: 'one',
        maxBytes: 1024 * 1024,
        onUnavailable: (reason) => unavailable.push(reason),
        openFile: async () =>
          ({
            write: async (line: string) => {
              writes += 1;
              // The opening record is written whole; the next is cut short.
              return { bytesWritten: writes === 1 ? Buffer.byteLength(line) : 3, buffer: line };
            },
            sync: async () => {},
            close: async () => {},
          }) as never,
      },
      {}
    );
    ledger.append('request', { url: 'https://in.example/a' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ledger.state).toBe('write_failed');
    expect(unavailable).toEqual(['write_failed']);
  });

  it('an opening that cannot be written leaves no partial file behind', async () => {
    const directory = await scratch();
    const { open: openFile } = await import('node:fs/promises');
    let created = '';
    await expect(
      EngagementLedger.open(
        {
          directory,
          tenantId: 'one',
          maxBytes: 1024 * 1024,
          onUnavailable: () => {},
          openFile: async (path: string) => {
            created = path;
            const real = await openFile(path, 'wx', 0o600);
            return {
              write: async () => {
                throw new Error('ENOSPC');
              },
              sync: async () => {},
              close: () => real.close(),
            } as never;
          },
        },
        {}
      )
    ).rejects.toThrow(/could not be written/);
    await expect(stat(created)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

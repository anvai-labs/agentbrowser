// Shared by the reseed suites: read every ledger line under an engagement
// directory. Tenant segments are hashed (engagementPath), so the reader walks
// every tenant directory; lines are parsed in write order.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readEngagementLedgerLines(
  directory: string
): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const tenant of await readdir(directory)) {
    const names = await readdir(join(directory, tenant)).catch(() => []);
    for (const name of names.filter((n) => n.endsWith('.jsonl')))
      for (const line of (await readFile(join(directory, tenant, name), 'utf8')).split('\n'))
        if (line.trim() !== '') lines.push(JSON.parse(line));
  }
  return lines;
}

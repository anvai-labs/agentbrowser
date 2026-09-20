import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { isIP } from 'node:net';
import {
  type SessionRequest,
  UsageError,
  validateSessionRequest,
} from '@agentbrowser/sdk-typescript';
import { MAX_JSON_INPUT_BYTES, createTextArgumentReader } from './json-input.js';

type Cookie = NonNullable<SessionRequest['cookies']>[number];
export const MAX_COOKIE_COUNT = 1000;
const keys = new Set([
  'name',
  'value',
  'domain',
  'path',
  'expires',
  'httpOnly',
  'secure',
  'sameSite',
]);
const partitionKeys = new Set(['partitionKey', 'partitionKeyOpaque', 'hasCrossSiteAncestor']);
const fail = (row: number, reason: string): never => {
  throw new UsageError(`Cookie row ${row}: ${reason}.`);
};

export function assertCookieRequestSize(request: unknown): void {
  let json: string;
  try {
    json = JSON.stringify(request);
  } catch {
    throw new UsageError('Cookie request is not serializable.');
  }
  if (!json || Buffer.byteLength(json, 'utf8') > MAX_JSON_INPUT_BYTES)
    throw new UsageError('Cookie request exceeds 1048576 bytes.');
}

/** Strict file normalization. Canonical wire shape stays owned by the protocol validator. */
function validateCookies(
  value: unknown,
  skipUnsupported: boolean,
  now: number
): { cookies: Cookie[]; skipped: number } {
  if (!Array.isArray(value) || value.length > MAX_COOKIE_COUNT)
    throw new UsageError('Cookie input must be an array of at most 1000 cookies.');
  assertCookieRequestSize({ cookies: value });
  const retained: unknown[] = [];
  const omitted = new Set<number>();
  for (const [i, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      fail(i + 1, 'expected a cookie object');
    const names = Object.keys(item);
    if (names.some((key) => !keys.has(key) && !partitionKeys.has(key)))
      fail(i + 1, 'unsupported attribute');
    if (names.some((key) => partitionKeys.has(key))) {
      if (!skipUnsupported) fail(i + 1, 'partition attributes are unsupported');
      // Omit the whole record, never strip its partition and widen its scope.
      omitted.add(i);
    }
    retained.push(Object.fromEntries(Object.entries(item).filter(([key]) => keys.has(key))));
  }
  const result = validateSessionRequest({ cookies: retained });
  if (!result.ok) throw new UsageError('Cookie input does not satisfy the session cookie schema.');
  const cookies = result.value.cookies ?? [];
  const seen = new Set<string>();
  for (const [i, c] of cookies.entries()) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name)) fail(i + 1, 'invalid name');
    // Preserve an explicit leading dot: it controls host-only versus domain scope.
    const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
    if (
      domain.length > 253 ||
      (!(
        isIP(domain) === 4 ||
        (domain.startsWith('[') && domain.endsWith(']') && isIP(domain.slice(1, -1)) === 6)
      ) &&
        !domain
          .split('.')
          .every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part)))
    )
      fail(i + 1, 'invalid domain');
    if (
      !c.path.startsWith('/') ||
      c.path.includes(';') ||
      [...c.path, ...c.value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      fail(i + 1, 'invalid path or value encoding');
    if (
      c.expires !== undefined &&
      (!Number.isFinite(c.expires) || (c.expires !== -1 && c.expires <= now))
    )
      fail(i + 1, 'expiry must be a future Unix timestamp or -1');
    if (c.sameSite === 'None' && c.secure !== true) fail(i + 1, 'SameSite None requires Secure');
    if (c.name.startsWith('__Secure-') && c.secure !== true)
      fail(i + 1, 'Secure prefix requires Secure');
    if (
      c.name.startsWith('__Host-') &&
      (c.secure !== true || c.domain.startsWith('.') || c.path !== '/')
    )
      fail(i + 1, 'Host prefix requires Secure, host-only domain and root path');
    const identity = JSON.stringify([c.name, domain.toLowerCase(), c.path]);
    if (seen.has(identity)) fail(i + 1, 'duplicate name/domain/path');
    seen.add(identity);
  }
  assertCookieRequestSize({ cookies });
  return { cookies: cookies.filter((_, index) => !omitted.has(index)), skipped: omitted.size };
}

function flag(value: string, row: number, format: 'netscape' | 'devtools'): boolean {
  if (format === 'netscape') {
    if (value === 'TRUE') return true;
    if (value === 'FALSE') return false;
  } else {
    if (value === '✓') return true;
    if (value === '') return false;
  }
  return fail(row, 'invalid boolean flag');
}
function expiry(value: string, row: number, format: 'netscape' | 'devtools'): number {
  if (
    (format === 'netscape' && value === '0') ||
    (format === 'devtools' && value === 'Session') ||
    value === '-1'
  )
    return -1;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (format === 'devtools' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    const n = Date.parse(value);
    if (
      Number.isFinite(n) &&
      new Date(n).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
    )
      return n / 1000;
  }
  return fail(row, 'invalid expiry');
}
export function parseCookieText(
  text: string,
  format = 'json',
  skipUnsupported = false,
  now = Date.now() / 1000
) {
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_INPUT_BYTES)
    throw new UsageError('Cookie input exceeds 1048576 bytes.');
  let value: unknown;
  if (format === 'json') {
    try {
      value = JSON.parse(text);
    } catch {
      throw new UsageError('Cookie input must be valid JSON.');
    }
  } else if (format === 'netscape' || format === 'chrome-devtools-tsv') {
    const rows: unknown[] = [];
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      if (raw === '') continue;
      const row = index + 1;
      if (format === 'netscape' && raw.startsWith('#') && !raw.startsWith('#HttpOnly_')) continue;
      const columns = raw.split('\t');
      if (format === 'netscape') {
        if (columns.length !== 7) fail(row, 'Netscape format requires exactly 7 columns');
        const [rawDomain, subdomain, path, secure, expires, name, cookieValue] = columns as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        const httpOnly = rawDomain.startsWith('#HttpOnly_');
        const domain = httpOnly ? rawDomain.slice(10) : rawDomain;
        if (flag(subdomain, row, 'netscape') !== domain.startsWith('.'))
          fail(row, 'domain and include-subdomains flag disagree');
        rows.push({
          name,
          value: cookieValue,
          domain,
          path,
          secure: flag(secure, row, 'netscape'),
          httpOnly,
          expires: expiry(expires, row, 'netscape'),
        });
      } else {
        if (columns.length !== 12) fail(row, 'DevTools format requires exactly 12 columns');
        const [
          name,
          cookieValue,
          domain,
          path,
          expires,
          size,
          httpOnly,
          secure,
          sameSite,
          partitionKey,
          ancestor,
          priority,
        ] = columns as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        if (!/^\d+$/.test(size) || !['Low', 'Medium', 'High', ''].includes(priority))
          fail(row, 'invalid size or priority');
        if (ancestor !== '' && ancestor !== '✓' && ancestor !== 'true' && ancestor !== 'false')
          fail(row, 'invalid cross-site-ancestor flag');
        if (sameSite !== '' && !['Strict', 'Lax', 'None'].includes(sameSite))
          fail(row, 'invalid SameSite');
        rows.push({
          name,
          value: cookieValue,
          domain,
          path,
          expires: expiry(expires, row, 'devtools'),
          httpOnly: flag(httpOnly, row, 'devtools'),
          secure: flag(secure, row, 'devtools'),
          ...(sameSite ? { sameSite } : {}),
          ...(partitionKey !== '' || ancestor !== ''
            ? { partitionKey, hasCrossSiteAncestor: ancestor }
            : {}),
        });
      }
      if (rows.length > MAX_COOKIE_COUNT)
        throw new UsageError('Cookie input exceeds 1000 cookies.');
    }
    value = rows;
  } else throw new UsageError('Cookie format must be json, netscape or chrome-devtools-tsv.');
  return validateCookies(value, skipUnsupported, now);
}

export async function readCookieFile(path: string, format?: string, skipUnsupported = false) {
  const text = await createTextArgumentReader({ noFollow: true })(`@${path}`, 'cookie input');
  return parseCookieText(text, format, skipUnsupported);
}

/** Validate before opening; exclusive creation prevents overwriting a credential file or symlink. */
export async function writeCookieFile(path: string, value: unknown) {
  const { cookies } = validateCookies(value, false, Date.now() / 1000);
  const text = `${JSON.stringify(cookies, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_INPUT_BYTES)
    throw new UsageError('Cookie export exceeds 1048576 bytes.');
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new UsageError('Could not exclusively create cookie output file.');
  }
  try {
    await file.writeFile(text, 'utf8');
    await file.close();
  } catch {
    await file.close().catch(() => {});
    // Retain incomplete private output: this pathname may now identify another file.
    // Removing it after a failed write could delete a concurrent replacement.
    throw new UsageError('Could not write cookie output file.');
  }
  return { count: cookies.length, path };
}

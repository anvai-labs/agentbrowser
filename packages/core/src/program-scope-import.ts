import {
  type EngagementScope,
  SCOPE_HOST_PATTERN,
  type ScopePathRule,
  validateEngagementScope,
} from '@agentbrowser/protocol';
import { tldts } from './tldts-lazy.js';

/**
 * T10 M3: convert a published program scope into an EngagementScope. Pure and
 * deterministic; nothing is guessed.
 *
 * | Program entry | Becomes |
 * | --- | --- |
 * | `*.example.com` | `.example.com` (subdomains only; the apex only when listed) |
 * | exact host or IP | exact host |
 * | URL with a path | host plus a host-bound path rule (dropped when the host is fully in scope) |
 * | out-of-scope host / URL | `excludeHosts` / `excludePaths` (dropped when already outside) |
 * | ambiguous wildcard, CIDR, per-host port, non-web asset, Unicode host | refused |
 *
 * A refused in-scope entry only narrows the result. A refused out-of-scope entry
 * would leave the scope wider than the program, so the whole import fails.
 * Authorization (`authorizedBy`, `authorizedAt`) is never inferred: it comes from
 * the caller or the scope carries no program.
 */

export type ProgramScopeFormat = 'h1' | 'bugcrowd' | 'text';

export interface ProgramScopeEntry {
  entry: string;
  inScope: boolean;
  decision: 'in' | 'out' | 'refused' | 'ignored';
  mapped?: string;
  reason?: string;
  note?: string;
}

export type ProgramScopeImport =
  | { ok: true; scope: EngagementScope; report: ProgramScopeEntry[]; warnings: string[] }
  | { ok: false; error: string; report: ProgramScopeEntry[] };

export interface ProgramScopeMeta {
  requestBudget?: number;
  pagesPlanned?: number;
  rateLimit?: { requests: number; perSeconds: number };
  programId?: string;
  programVersion?: string;
  authorizedBy?: string;
  authorizedAt?: string;
}

interface RawEntry {
  identifier: string;
  inScope: boolean;
  web: boolean;
}

const H1_WEB = new Set(['URL', 'WILDCARD', 'DOMAIN', 'IP_ADDRESS', 'CIDR']);
const BUGCROWD_WEB = new Set(['website', 'api', 'network']);
const HOST = new RegExp(SCOPE_HOST_PATTERN);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function parseH1(input: string): RawEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    throw new Error('Not a HackerOne structured-scope JSON file.');
  }
  const root = asRecord(json);
  const relationships = asRecord(root?.relationships);
  const data = root?.data ?? asRecord(relationships?.structured_scopes)?.data;
  if (!Array.isArray(data)) throw new Error('Not a HackerOne structured-scope JSON file.');
  return data.flatMap((item) => {
    const attributes = asRecord(asRecord(item)?.attributes);
    const identifier = attributes?.asset_identifier;
    if (typeof identifier !== 'string') return [];
    return [
      {
        identifier,
        inScope: attributes?.eligible_for_submission === true,
        web: H1_WEB.has(String(attributes?.asset_type ?? '')),
      },
    ];
  });
}

function parseBugcrowd(input: string): RawEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    throw new Error('Not a Bugcrowd target-group JSON file.');
  }
  const groups = asRecord(json)?.target_groups;
  if (!Array.isArray(groups)) throw new Error('Not a Bugcrowd target-group JSON file.');
  return groups.flatMap((group) => {
    const record = asRecord(group);
    const targets = record?.targets;
    if (!Array.isArray(targets)) return [];
    return targets.flatMap((target) => {
      const t = asRecord(target);
      const identifier = typeof t?.uri === 'string' ? t.uri : t?.name;
      if (typeof identifier !== 'string') return [];
      return [
        {
          identifier,
          inScope: record?.in_scope === true,
          web: BUGCROWD_WEB.has(String(t?.category ?? '')),
        },
      ];
    });
  });
}

function parseText(input: string): RawEntry[] {
  return input.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return [];
    const out = trimmed.startsWith('-') || trimmed.startsWith('!');
    return [{ identifier: out ? trimmed.slice(1).trim() : trimmed, inScope: !out, web: true }];
  });
}

type Classified =
  | { ok: true; pattern: string; path?: string; scheme?: string }
  | { ok: false; reason: string };

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

function classify(raw: string): Classified {
  const text = raw.trim();
  let scheme: string | undefined;
  let authority: string;
  let path: string;
  const url = text.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i);
  if (url !== null) {
    scheme = (url[1] ?? '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https')
      return { ok: false, reason: `${scheme}: is not a web scheme` };
    authority = url[2] ?? '';
    path = url[3] ?? '';
  } else {
    const slash = text.indexOf('/');
    authority = slash === -1 ? text : text.slice(0, slash);
    path = slash === -1 ? '' : (text.slice(slash).split(/[?#]/)[0] ?? '');
  }
  if (authority.includes('@')) return { ok: false, reason: 'credentials in the entry' };
  if (!authority.startsWith('[') && (authority.match(/:/g)?.length ?? 0) > 1)
    return { ok: false, reason: 'an IPv6 literal must be bracketed' };
  let host = authority.toLowerCase();
  const port = host.match(/:(\d+)$/);
  if (port !== null) {
    if (scheme === undefined || DEFAULT_PORTS[scheme] !== port[1])
      return { ok: false, reason: 'a per-host port is not expressible (ports are scope-wide)' };
    host = host.slice(0, -port[0].length);
  }
  host = host.replace(/\.+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && /^\/\d{1,2}$/.test(path))
    return { ok: false, reason: 'a CIDR range is not expressible' };
  let pattern = host;
  if (host.includes('*')) {
    const base = host.slice(2);
    if (!host.startsWith('*.') || base.includes('*'))
      return { ok: false, reason: 'an ambiguous wildcard is not expressible' };
    if (
      !base.includes('.') ||
      tldts().getPublicSuffix(base, { allowPrivateDomains: true }) === base
    )
      return { ok: false, reason: 'a wildcard over a public suffix is not expressible' };
    pattern = `.${base}`;
  }
  if (pattern === '' || !HOST.test(pattern))
    return { ok: false, reason: 'not an ASCII hostname (write IDNs in punycode)' };
  // A trailing "/*" means "everything under": the bare prefix, exact under segment-bounded
  // matching. Any other "*" in a path (e.g. "/admin*", "/a/*/b") has no segment-bounded form.
  // An encoded "*" is a glob too: decode it before the check.
  const unescaped = path.replace(/%2a/gi, '*');
  let trimmed = unescaped.endsWith('/*') ? unescaped.slice(0, -2) : unescaped;
  if (trimmed.includes('*'))
    return { ok: false, reason: 'a path wildcard other than a trailing "/*" is not expressible' };
  trimmed = trimmed.replace(/\/+$/, '');
  const prefix = trimmed === '' ? undefined : trimmed;
  return {
    ok: true,
    pattern,
    ...(prefix !== undefined ? { path: prefix } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
  };
}

/** Is host pattern `p` entirely inside one of `full` (exact match or a covering suffix)? */
const covered = (p: string, full: string[]): boolean =>
  full.some((f) => f === p || (f.startsWith('.') && p.endsWith(f)));

/** Do two host patterns admit at least one common host? */
const overlaps = (a: string, b: string): boolean => {
  if (!a.startsWith('.') && !b.startsWith('.')) return a === b;
  if (!a.startsWith('.')) return a.endsWith(b);
  if (!b.startsWith('.')) return b.endsWith(a);
  return a.endsWith(b) || b.endsWith(a);
};

export function importProgramScope(
  input: string,
  format: ProgramScopeFormat,
  meta: ProgramScopeMeta = {}
): ProgramScopeImport {
  if ((meta.authorizedBy === undefined) !== (meta.authorizedAt === undefined))
    throw new Error('Program authorization needs both authorizedBy and authorizedAt.');
  if (meta.authorizedBy !== undefined && meta.programId === undefined)
    throw new Error('Program authorization needs a programId.');
  if (meta.requestBudget !== undefined && meta.pagesPlanned !== undefined)
    throw new Error('Choose requestBudget or pagesPlanned, not both.');
  for (const value of [meta.requestBudget, meta.pagesPlanned])
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error('Budget and planned pages must be positive safe integers.');
  const requestBudget =
    meta.requestBudget ??
    (meta.pagesPlanned !== undefined ? Math.max(150, meta.pagesPlanned * 120) : undefined);
  if (requestBudget !== undefined && !Number.isSafeInteger(requestBudget))
    throw new Error('Planned budget is too large.');
  const raw =
    format === 'h1'
      ? parseH1(input)
      : format === 'bugcrowd'
        ? parseBugcrowd(input)
        : parseText(input);
  const report: ProgramScopeEntry[] = [];
  const accepted: Array<{ index: number; pattern: string; path?: string; scheme?: string }> = [];
  const exclusions: Array<{ index: number; pattern: string; path?: string }> = [];
  for (const entry of raw) {
    const index = report.length;
    const base = { entry: entry.identifier, inScope: entry.inScope };
    if (!entry.web) {
      report.push(
        entry.inScope
          ? { ...base, decision: 'refused', reason: 'not a web target' }
          : { ...base, decision: 'ignored', note: 'not a web target' }
      );
      continue;
    }
    const classified = classify(entry.identifier);
    if (!classified.ok) {
      if (!entry.inScope)
        return {
          ok: false,
          error: `exclusion ${entry.identifier} cannot be expressed: ${classified.reason}; the scope would be wider than the program`,
          report: [...report, { ...base, decision: 'refused', reason: classified.reason }],
        };
      report.push({ ...base, decision: 'refused', reason: classified.reason });
      continue;
    }
    report.push({ ...base, decision: entry.inScope ? 'in' : 'out' });
    (entry.inScope ? accepted : exclusions).push({ index, ...classified });
  }
  const full = accepted.filter((item) => item.path === undefined).map((item) => item.pattern);
  // A path-bearing entry whose host is already fully in scope adds nothing.
  const allowedHosts: string[] = [];
  for (const item of accepted)
    if (
      (item.path === undefined || !covered(item.pattern, full)) &&
      !allowedHosts.includes(item.pattern)
    )
      allowedHosts.push(item.pattern);
  if (allowedHosts.length === 0)
    return { ok: false, error: 'nothing in scope can be expressed', report };
  const pathRules: ScopePathRule[] = [];
  for (const item of accepted) {
    const entry = report[item.index] as ProgramScopeEntry;
    if (item.path === undefined) {
      entry.mapped = item.pattern;
      if (item.pattern.startsWith('.') && !allowedHosts.includes(item.pattern.slice(1)))
        entry.note = `the apex ${item.pattern.slice(1)} is not in scope unless listed`;
      continue;
    }
    if (covered(item.pattern, full)) {
      entry.mapped = item.pattern;
      entry.note = 'the host is fully in scope through another entry; no path rule added';
      continue;
    }
    entry.mapped = `${item.pattern} ${item.path}`;
    pathRules.push({ hostSuffix: item.pattern, prefix: item.path });
    const narrowed = full.filter(
      (host) => !host.startsWith('.') && item.pattern.startsWith('.') && host.endsWith(item.pattern)
    );
    if (narrowed.length > 0)
      entry.note = `this path rule also restricts ${narrowed.join(', ')}, listed in full (path rules are per host)`;
  }
  const excludeHosts: string[] = [];
  const excludePaths: ScopePathRule[] = [];
  for (const item of exclusions) {
    const entry = report[item.index] as ProgramScopeEntry;
    if (!allowedHosts.some((allowed) => overlaps(item.pattern, allowed))) {
      entry.decision = 'ignored';
      entry.note = 'already outside the scope';
      continue;
    }
    if (item.path === undefined) {
      if (!excludeHosts.includes(item.pattern)) excludeHosts.push(item.pattern);
      entry.mapped = item.pattern;
    } else {
      excludePaths.push({ hostSuffix: item.pattern, prefix: item.path });
      entry.mapped = `${item.pattern} ${item.path}`;
    }
  }
  // Schemes are scope-wide. One shared scheme set is kept as given; mixed or unstated schemes
  // narrow to web traffic (http, https), noted in the report.
  const named = [...new Set(accepted.map((item) => item.scheme ?? '*'))];
  const schemes = named.length === 1 && named[0] !== '*' ? named : ['http', 'https'];
  if (named.length > 1 || named[0] === '*')
    for (const item of accepted) {
      const entry = report[item.index] as ProgramScopeEntry;
      const note = 'schemes are scope-wide: http and https are both allowed';
      entry.note = entry.note === undefined ? note : `${entry.note}; ${note}`;
    }
  const scope: EngagementScope = {
    ...(requestBudget !== undefined ? { requestBudget } : {}),
    ...(meta.rateLimit !== undefined ? { rateLimit: { ...meta.rateLimit } } : {}),
    allowedHosts,
    ...(pathRules.length > 0 ? { pathRules } : {}),
    allowedSchemes: schemes,
    // Every accepted entry is on its scheme's default port (per-host ports are refused).
    allowedPorts: [...new Set(schemes.map((scheme) => (scheme === 'https' ? 443 : 80)))].sort(
      (a, b) => a - b
    ),
    ...(excludeHosts.length > 0 ? { excludeHosts } : {}),
    ...(excludePaths.length > 0 ? { excludePaths } : {}),
    ...(meta.programId !== undefined &&
    meta.authorizedBy !== undefined &&
    meta.authorizedAt !== undefined
      ? {
          program: {
            id: meta.programId,
            ...(meta.programVersion !== undefined ? { version: meta.programVersion } : {}),
            authorizedBy: meta.authorizedBy,
            authorizedAt: meta.authorizedAt,
          },
        }
      : {}),
  };
  const valid = validateEngagementScope(scope);
  if (!valid.ok)
    return {
      ok: false,
      error: `the converted scope is invalid: ${valid.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      report,
    };
  return {
    ok: true,
    scope,
    report,
    warnings:
      requestBudget !== undefined && requestBudget < 150
        ? [
            'A single JS-heavy page load consumes 50–120 requests; budget counts every subrequest and redirect hop. Plan about pages × 120 requests, with at least 150 for one page.',
          ]
        : [],
  };
}

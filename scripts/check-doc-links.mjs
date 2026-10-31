#!/usr/bin/env node
/**
 * Check all relative markdown links in the repo resolve to existing files
 * and (where a fragment is present) to a heading that slugifies to it,
 * approximating GitHub's anchor algorithm.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', 'dist', 'dist-bin', '.git', '.cache', 'coverage']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (entry.endsWith('.md')) yield p;
  }
}

/** GitHub-style slug of a markdown heading. */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/`/g, '')
    // drop emoji/punctuation except word chars, spaces, hyphens, underscores
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .replace(/\s+/g, '-');
}

/** Collect heading slugs for a file (ATX headings inside fenced code excluded). */
function headingSlugs(file) {
  const slugs = new Map(); // slug -> count
  let inCode = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const m = /^(#{1,6})\s+(.*?)(\s*#*)?\s*$/.exec(line);
    if (m) {
      const base = slugify(m[2]);
      const n = slugs.get(base) ?? 0;
      slugs.set(base, n + 1);
    }
  }
  return slugs;
}

function anchorExists(slugs, anchor) {
  // direct hit
  if (slugs.has(anchor)) return true;
  // GitHub appends -1, -2… for duplicate headings
  const dup = /^(.+)-(\d+)$/.exec(anchor);
  if (dup) {
    const n = slugs.get(dup[1]);
    return n !== undefined && Number(dup[2]) >= 1 && Number(dup[2]) < n;
  }
  return false;
}

let files = 0;
let links = 0;
const broken = [];

for (const file of walk(ROOT)) {
  files++;
  const slugs = headingSlugs(file);
  const text = readFileSync(file, 'utf8');
  const rx = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const m of text.matchAll(rx)) {
    const [, label, target] = m;
    if (/^(https?:|mailto:|#)/i.test(target) === false && !target.startsWith('#')) {
      if (/^https?:/i.test(target)) continue;
    }
    if (/^https?:/i.test(target) || /^(mailto:)/i.test(target)) continue;
    links++;
    const [pathPart, anchorPart] = target.split('#');
    if (pathPart === '') {
      // same-file anchor
      if (!anchorExists(slugs, decodeURIComponent(anchorPart ?? ''))) {
        broken.push({ file: relative(ROOT, file), target, label, why: 'missing anchor in same file' });
      }
      continue;
    }
    const abs = resolve(dirname(file), decodeURIComponent(pathPart));
    const candidates = [abs, `${abs}.md`];
    const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
    if (!hit) {
      const asDir = existsSync(abs) && statSync(abs).isDirectory();
      if (!asDir) {
        broken.push({ file: relative(ROOT, file), target, label, why: 'missing file' });
        continue;
      }
      if (anchorPart) {
        broken.push({ file: relative(ROOT, file), target, label, why: 'anchor on directory link' });
      }
      continue;
    }
    if (anchorPart) {
      const targetSlugs = headingSlugs(hit);
      if (!anchorExists(targetSlugs, decodeURIComponent(anchorPart))) {
        broken.push({ file: relative(ROOT, file), target, label, why: `missing anchor in ${relative(ROOT, hit)}` });
      }
    }
  }
}

console.log(`checked ${links} relative links across ${files} markdown files`);
if (broken.length === 0) {
  console.log('all links OK');
} else {
  for (const b of broken) {
    console.log(`BROKEN [${b.why}] ${b.file} -> ${b.target} (${b.label})`);
  }
  console.log(`${broken.length} broken link(s)`);
  process.exit(1);
}

/** Narrow checks for fixed, locally produced Node JUnit; never a general XML importer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const MAX_BYTES = 64 * 1024;
const failure = () => new Error('Node test qualification failed');
const fixedText = (value) => typeof value === 'string' && /^[A-Za-z0-9 .:_-]{1,128}$/u.test(value);

export function validateNativeNodeReport(junit, { cases, failureMessage, diagnostic } = {}) {
  try {
    assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= 16);
    assert.ok(cases.every((entry) => fixedText(entry?.name) && typeof entry.passing === 'boolean'));
    assert.equal(new Set(cases.map((entry) => entry.name)).size, cases.length);
    assert.ok(fixedText(failureMessage));
    assert.ok(typeof junit === 'string' && Buffer.byteLength(junit) <= MAX_BYTES);
    assert.match(junit, /^<\?xml\b/u);
    assert.equal((junit.match(/<testsuites>/gu) ?? []).length, 1);
    assert.equal((junit.match(/<\/testsuites>/gu) ?? []).length, 1);
    assert.match(junit, /<\/testsuites>\s*$/u);
    assert.ok(!/<(?:error|skipped)\b|<!DOCTYPE|<!ENTITY/u.test(junit));
    const entries = [...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)];
    const failed = cases.filter((entry) => !entry.passing).length;
    assert.equal(entries.length, cases.length);
    assert.equal((junit.match(/<testcase\b/gu) ?? []).length, cases.length);
    assert.equal((junit.match(/<failure\b/gu) ?? []).length, failed);
    assert.equal((junit.match(/<\/failure>/gu) ?? []).length, failed);
    for (const [index, match] of entries.entries()) {
      const expected = cases[index];
      const names = [...match[1].matchAll(/(?:^|\s)name="([^"]*)"/gu)];
      assert.equal(names.length, 1);
      assert.equal(names[0][1], expected.name);
      const failures = [...(match[2] ?? '').matchAll(/<failure\b([^>]*)>/gu)];
      assert.equal(failures.length, expected.passing ? 0 : 1);
      if (failures.length) {
        const attributes = failures[0][1];
        const types = [...attributes.matchAll(/(?:^|\s)type="([^"]*)"/gu)];
        const messages = [...attributes.matchAll(/(?:^|\s)message="([^"]*)"/gu)];
        assert.equal(types.length, 1);
        assert.equal(types[0][1], 'testCodeFailure');
        assert.equal(messages.length, 1);
        assert.equal(messages[0][1], failureMessage);
      }
    }
    for (const [name, count] of Object.entries({
      tests: cases.length, suites: 0, pass: cases.length - failed, fail: failed,
      cancelled: 0, skipped: 0, todo: 0,
    })) {
      const matches = [...junit.matchAll(new RegExp(`<!--\\s*${name} (\\d+)\\s*-->`, 'gu'))];
      assert.equal(matches.length, 1);
      assert.equal(Number(matches[0][1]), count);
    }
    if (diagnostic !== undefined) {
      assert.match(diagnostic, /^Private evaluation artifact: sha256:[a-f0-9]{64}$/u);
      const diagnostics = [...junit.matchAll(/<!--\s*(Private evaluation artifact:[\s\S]*?)-->/gu)];
      assert.deepEqual(diagnostics.map((entry) => entry[1].trim()), [diagnostic]);
    }
    return { tests: cases.length, passed: cases.length - failed, failed, cancelled: 0, skipped: 0 };
  } catch { throw failure(); }
}

/** Summarize bytes only after structural/lifecycle validation; do not retain private XML. */
export function summarizeNativeNodeReport(junit) {
  if (typeof junit !== 'string' || !junit.length || Buffer.byteLength(junit) > MAX_BYTES) throw failure();
  return {
    mediaType: 'application/xml', sizeBytes: Buffer.byteLength(junit),
    sha256: createHash('sha256').update(junit).digest('hex'),
  };
}

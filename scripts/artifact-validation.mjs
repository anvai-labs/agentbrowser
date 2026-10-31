/** Bounded capture validation for the deterministic Chromium release fixture. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { runExecutable } from './release-smoke.mjs';

const MAX_BYTES = 8 * 1024 * 1024;

// PNG CRC-32 (ISO 3309 polynomial); vector checked independently in tests.
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Invalid PNG signature');
  let offset = 8;
  let header;
  let ended = false;
  let dataEnded = false;
  const data = [];
  let chunks = 0;
  while (offset < bytes.length) {
    assert.ok(++chunks <= 4096 && offset + 12 <= bytes.length, 'Invalid PNG chunk bounds');
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    assert.ok(end <= bytes.length, 'Truncated PNG chunk');
    const name = bytes.toString('latin1', offset + 4, offset + 8);
    assert.match(name, /^[A-Za-z]{2}[A-Z][A-Za-z]$/, 'Invalid PNG chunk name or reserved bit');
    assert.equal(crc32(bytes.subarray(offset + 4, end - 4)), bytes.readUInt32BE(end - 4), 'PNG CRC mismatch');
    const payload = bytes.subarray(offset + 8, end - 4);
    if (!header) {
      assert.ok(name === 'IHDR' && size === 13, 'PNG must start with a complete IHDR');
      header = payload;
    } else {
      assert.notEqual(name, 'IHDR', 'Duplicate PNG header');
      if (name === 'IDAT') {
        assert.ok(!dataEnded, 'Nonconsecutive PNG data');
        data.push(payload);
      } else {
        if (data.length) dataEnded = true;
        if (name === 'IEND') {
          assert.equal(size, 0, 'Invalid PNG end chunk');
          assert.equal(end, bytes.length, 'PNG bytes after end chunk');
          ended = true;
        } else assert.ok(name[0] === name[0].toLowerCase(), 'Unsupported critical PNG chunk (including palettes)');
      }
    }
    offset = end;
  }
  assert.ok(header && ended && data.length, 'Incomplete PNG image');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  // Chromium screenshots use noninterlaced eight-bit RGB/RGBA. Other valid
  // encodings are unsupported by this fixture validator, not silently passed.
  assert.ok(header[8] === 8 && [2, 6].includes(header[9]) && header[10] === 0 && header[11] === 0 && header[12] === 0, 'Unsupported PNG screenshot encoding');
  const row = 1 + width * (header[9] === 6 ? 4 : 3);
  const expected = row * height;
  assert.ok(width > 0 && height > 0 && expected <= 32 * 1024 * 1024, 'PNG dimensions exceed acceptance limit');
  const compressed = Buffer.concat(data);
  const decoded = inflateSync(compressed, { maxOutputLength: expected + 1, info: true });
  assert.equal(decoded.engine.bytesWritten, compressed.length, 'PNG trailing compressed bytes');
  const raw = decoded.buffer;
  assert.equal(raw.length, expected, 'PNG scanline length mismatch');
  for (let offset = 0; offset < raw.length; offset += row) assert.ok(raw[offset] <= 4, 'Invalid PNG row filter');
}

/** PDF here receives a preliminary check; callers MUST also await validatePdf. */
export function validateArtifact(value, type) {
  assert.equal(typeof value?.contentBase64, 'string', 'Artifact omitted bytes');
  assert.ok(value.contentBase64.length <= Math.ceil(MAX_BYTES / 3) * 4, 'Artifact exceeds acceptance limit');
  const bytes = Buffer.from(value.contentBase64, 'base64');
  assert.ok(bytes.length > 0, 'Artifact is empty');
  assert.equal(bytes.toString('base64'), value.contentBase64, 'Invalid artifact base64');
  assert.equal(bytes.length, value.metadata?.sizeBytes, 'Artifact size mismatch');
  assert.ok(bytes.length <= MAX_BYTES, 'Artifact exceeds acceptance limit');
  if (type === 'png') png(bytes);
  else if (type === 'pdf') assert.ok(/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(bytes.toString('ascii', 0, 10)) && /%%EOF\s*$/.test(bytes.subarray(-1024).toString('ascii')), 'Invalid or truncated PDF');
  else assert.equal(type, 'bytes', 'Unknown artifact validation type');
  return bytes;
}

/** Use an actual PDF parser, not a home-grown regex parser. No rendering claim. */
export async function validatePdf(bytes, options = {}) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BYTES, 'Invalid PDF byte bounds');
  const directory = await mkdtemp(join(tmpdir(), 'agentbrowser-pdf-check-'));
  const file = join(directory, 'capture.pdf');
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    // Errors AND warnings reject the candidate. Do not use --warning-exit-0.
    await runExecutable(['qpdf', '--check', file], options);
    const result = await runExecutable(['qpdf', '--show-npages', file], options);
    assert.match(result.stdout.trim(), /^[1-9][0-9]*$/, 'PDF contains no pages');
    const pages = Number(result.stdout.trim());
    assert.ok(Number.isSafeInteger(pages) && pages <= 100, 'PDF page count exceeds fixture limit');
    const version = await runExecutable(['qpdf', '--version'], options);
    return { pages, validatorVersion: version.stdout.trim() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

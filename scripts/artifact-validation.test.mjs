import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { crc32, validateArtifact, validatePdf } from './artifact-validation.mjs';

const capture = (bytes) => ({ metadata: { sizeBytes: bytes.length }, contentBase64: bytes.toString('base64') });
function chunk(name, bytes) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  result.write(name, 4);
  bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function png(raw = Buffer.from([0, 255, 0, 0, 255]), { palette, tail = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(palette ? [chunk('PLTE', palette)] : []), chunk('IDAT', Buffer.concat([deflateSync(raw), tail])), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG verifies CRC, complete compressed scanlines and legal row filters', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.deepEqual(validateArtifact(capture(png()), 'png'), png());
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => validateArtifact(capture(corrupt), 'png'), /CRC/);
  assert.throws(() => validateArtifact(capture(png(Buffer.alloc(3))), 'png'), /scanline/);
  assert.throws(() => validateArtifact(capture(png(Buffer.from([5, 0, 0, 0, 0]))), 'png'), /filter/);
  assert.throws(() => validateArtifact(capture(png(Buffer.alloc(1024 * 1024))), 'png'), /large|length|buffer/i);
});

test('PNG rejects unsupported palettes and trailing compressed garbage', () => {
  assert.throws(() => validateArtifact(capture(png(undefined, { palette: Buffer.from([1]) })), 'png'), /PNG/);
  assert.throws(() => validateArtifact(capture(png(undefined, { tail: Buffer.from('garbage') })), 'png'), /PNG/);
});

test('PNG rejects high-bit chunk names and a lowercase reserved bit', () => {
  const high = png();
  high[12] = 0xc9;
  high.writeUInt32BE(crc32(high.subarray(12, 29)), 29);
  assert.throws(() => validateArtifact(capture(high), 'png'), /PNG chunk name/);
  const normal = png();
  const reserved = Buffer.concat([normal.subarray(0, 33), chunk('tesT', Buffer.alloc(0)), normal.subarray(33)]);
  assert.throws(() => validateArtifact(capture(reserved), 'png'), /PNG chunk name/);
});

test('magic markers alone do not validate PNG or PDF', async () => {
  const fake = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(fake);
  fake.write('IHDR', 12); fake.writeUInt32BE(1, 16); fake.writeUInt32BE(1, 20); fake.write('IEND', 25);
  assert.throws(() => validateArtifact(capture(fake), 'png'), /PNG/);
  assert.throws(() => validateArtifact(capture(Buffer.from('%PDF-not-a-version\n%%EOF')), 'pdf'), /PDF/);
  // A syntactically plausible header/footer still must reach the actual parser.
  await assert.rejects(validatePdf(Buffer.from('%PDF-1.7\n%%EOF')), /PDF|exited/);
});

test('PDF parser accepts a complete single-page document and reports its validator', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(source);
  source += 'xref\n0 5\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const result = await validatePdf(Buffer.from(source));
  assert.equal(result.pages, 1);
  assert.match(result.validatorVersion, /qpdf version/);
});

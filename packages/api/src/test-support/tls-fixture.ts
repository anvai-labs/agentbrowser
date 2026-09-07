import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Disposable test trust material. Never imported by production code. */
export function certificates() {
  let key: string;
  let cert: string;
  let wrongIpCert: string;

  // Ephemeral fixture-only key, with exact cleanup even if OpenSSL fails.
  // No host CA installation, disabled verification or extra npm dependency.
  key = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const directory = mkdtempSync(join(tmpdir(), 'agentbrowser-tls-'));
  const keyPath = join(directory, 'fixture-key.pem');
  try {
    writeFileSync(keyPath, key, { mode: 0o600 });
    const certificate = (ip: string) =>
      execFileSync(
        'openssl',
        [
          'req',
          '-new',
          '-x509',
          '-key',
          // Linux cannot reopen a socket-backed child /dev/stdin as a file;
          // req's -key loader does not interpret '-' as standard input either.
          keyPath,
          '-subj',
          '/CN=download.invalid',
          '-days',
          '2',
          '-addext',
          `subjectAltName=DNS:download.invalid,IP:${ip}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    cert = certificate('127.0.0.1');
    wrongIpCert = certificate('127.0.0.2');
  } finally {
    // Only the known fixture file and its newly-created directory are removed.
    rmSync(keyPath, { force: true });
    rmdirSync(directory);
  }
  return { key, cert, wrongIpCert };
}

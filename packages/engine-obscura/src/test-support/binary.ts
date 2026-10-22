import { existsSync } from 'node:fs';

/**
 * The suites' shared availability gate: OBSCURA_BIN wins when it points at a real file,
 * otherwise the version-pinned cache under .cache/obscura. undefined => soft-skip the
 * suite (the availability-gated Firefox pattern; the smoke test is the CI gate).
 */
export function resolveBinary(): string | undefined {
  const override = process.env.OBSCURA_BIN;
  if (override !== undefined && override !== '' && existsSync(override)) {
    return override;
  }
  const version = process.env.OBSCURA_VERSION ?? 'v0.2.1';
  const binName = process.platform === 'win32' ? 'obscura.exe' : 'obscura';
  // Four levels up from src/test-support: the repo-root .cache the suites ran with.
  const cached = new URL(`../../../../.cache/obscura/${version}/${binName}`, import.meta.url)
    .pathname;
  return existsSync(cached) ? cached : undefined;
}

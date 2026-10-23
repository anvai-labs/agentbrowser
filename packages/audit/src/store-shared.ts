/** Helpers the label-addressed baseline stores share (finding + visual audits):
 * both persisted stores validate labels identically and commit their manifest with
 * the same write-temp-then-rename discipline — one definition so the two stores
 * cannot drift on either behavior. */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { VisualAuditError } from '@agentbrowser/engagement';

/** Strict filename component: no path separators, bounded length. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new VisualAuditError(
      'INVALID_LABEL',
      `label must match ${LABEL_PATTERN.source} (no path separators): ${JSON.stringify(label)}`
    );
  }
}

/** Atomic manifest commit: write the sibling temp file, then rename over the manifest. */
export function writeJsonManifest(
  directory: string,
  manifestPath: string,
  manifest: unknown
): void {
  mkdirSync(directory, { recursive: true });
  const temp = `${manifestPath}.pending`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2));
  renameSync(temp, manifestPath);
}

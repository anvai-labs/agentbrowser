import { ArtifactStore, DEFAULT_MAX_ARTIFACT_BYTES } from '@agentbrowser/core';

/** Startup-only aggregate artifact ceiling; invalid values abort before service creation.
 * Undefined keeps the store default (256 MiB). */
export function artifactStoreFromEnvironment(env: {
  AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES?: string | undefined;
}): ArtifactStore | undefined {
  const raw = env.AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES;
  if (raw === undefined) return undefined;
  const text = raw.trim();
  const value = /^[1-9][0-9]*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_ARTIFACT_BYTES)
    throw new Error(
      `AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES must be a decimal safe integer of at least ${DEFAULT_MAX_ARTIFACT_BYTES} (the per-artifact ceiling)`
    );
  return new ArtifactStore({ maxTotalBytes: value });
}

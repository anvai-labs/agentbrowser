import { DEFAULT_EXTRACT_MAX_BYTES, parseExtractMaxBytesText } from '@agentbrowser/protocol';

/** Startup-only operator ceiling; invalid values abort before service/engine creation. */
export function extractMaxBytesFromEnvironment(env: {
  AGENTBROWSER_EXTRACT_MAX_BYTES?: string | undefined;
}): number {
  const raw = env.AGENTBROWSER_EXTRACT_MAX_BYTES;
  if (raw === undefined) return DEFAULT_EXTRACT_MAX_BYTES;
  try {
    return parseExtractMaxBytesText(raw.trim());
  } catch {
    throw new Error('AGENTBROWSER_EXTRACT_MAX_BYTES must be a positive decimal safe integer');
  }
}

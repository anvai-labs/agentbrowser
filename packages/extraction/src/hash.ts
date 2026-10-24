/** Deterministic content hash shared by the extraction surfaces (evidence: the same
 * byte-identical FNV-1a helper had been copied into three extractor modules — the
 * contentHash values feed persisted extraction evidence and must stay identical
 * across surfaces, so one definition is the safety property, not just DRY). */

/** 32-bit FNV-1a, rendered as 8 lowercase hex chars — stable across runs and Node versions. */
export function fnv1aHash(content: string): string {
  let digest = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    digest ^= content.charCodeAt(i);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
}

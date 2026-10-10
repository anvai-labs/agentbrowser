/**
 * Compact observation projection (compact-output increment 3).
 *
 * Response-shaping only: runs AFTER secret redaction and BEFORE the byte/
 * element budget, on the full normalized observation. Ref stores, revision
 * semantics and the engine contract are untouched — a ref filtered out of a
 * response stays valid for actions.
 *
 * Invariants (tested in observation-projection.test.ts):
 * - No projection fields set => the source passes through unchanged.
 * - Elements are processed in document order (restored from ref ordinals when
 *   the normalizer's >300-element priority sort reordered them).
 * - A scope ref participates in revision semantics: older revision =>
 *   STALE_TARGET (ADR-004 symmetry), removed element => TARGET_NOT_FOUND —
 *   never a silent empty result.
 * - The name predicate matches NAMES only, on redacted output; never values
 *   (a withheld-value substring match would leak a redaction side channel).
 * - The protected element core (ref, role, name, value, valueRedacted,
 *   checked, risk, focused, non-default visible/enabled, depth/block) can
 *   never be dropped; href/attributes/required are additive opt-ins.
 * - Continuation ordinals are page ordinals; `remaining` counts matches only.
 */

import { EngineError } from '@agentbrowser/engine';
import type {
  ElementChange,
  ObservationProjectionEcho,
  PageElement,
  PageState,
} from '@agentbrowser/protocol';
import { parseRef } from '@agentbrowser/protocol';
import { clampUtf16 } from './canonical-json.js';

/** The projection subset of ObservationRequest (protocol-declared fields). */
export interface ObservationProjection {
  roles?: string[] | undefined;
  name?: string | undefined;
  scopeRef?: string | undefined;
  limit?: number | undefined;
  includeFields?: Array<'href' | 'attributes' | 'required'> | undefined;
}

export interface ProjectionContext {
  /**
   * The full (already redacted) observation of the current revision. Required
   * on the sinceRevision diff path, whose element list is the changed subset:
   * scope resolution and document-order restoration need the whole page.
   */
  full?: PageState | undefined;
  /** Ordinal floor: matches below this page ordinal are skipped (cursor resume). */
  continueFrom?: number | undefined;
}

const NAME_CAP = 200;

export function projectionActive(projection: ObservationProjection | undefined): boolean {
  if (projection === undefined) return false;
  // Empty opt-ins are no-ops, not activation: `includeFields: []` must never
  // trigger full response reshaping (which would drop href/attributes the
  // unprojected default always carries). Same for an empty roles list or a
  // blank name needle.
  const rolesActive = projection.roles !== undefined && projection.roles.length > 0;
  const nameActive = projection.name !== undefined && projection.name.trim().length > 0;
  const fieldsActive =
    projection.includeFields !== undefined && projection.includeFields.length > 0;
  return (
    rolesActive ||
    nameActive ||
    projection.scopeRef !== undefined ||
    projection.limit !== undefined ||
    fieldsActive
  );
}

export function projectObservation(
  source: PageState,
  projection: ObservationProjection,
  context: ProjectionContext = {}
): PageState {
  if (!projectionActive(projection)) return source;

  const full = context.full ?? source;
  // Document order: the normalizer's truncation prioritization may have
  // sorted the >300-element list; ordinals restore the original order.
  const ordered = [...full.elements].sort(
    (a, b) => (parseRef(a.ref)?.ordinal ?? 0) - (parseRef(b.ref)?.ordinal ?? 0)
  );

  // Scope resolution against the full page (never the changed-subset diff).
  let allowedRefs: Set<string> | undefined;
  if (projection.scopeRef !== undefined) {
    const parsed = parseRef(projection.scopeRef);
    if (parsed === null) {
      throw new EngineError(
        'INVALID_REQUEST',
        `Invalid scopeRef '${projection.scopeRef}': expected a ref of the form e<revision>_<ordinal>.`
      );
    }
    if (parsed.revision !== source.revision) {
      throw new EngineError(
        'STALE_TARGET',
        `Scope ref ${projection.scopeRef} was minted at revision ${parsed.revision}; the page is at revision ${source.revision}. Observe again and re-scope to a current ref.`
      );
    }
    const scopeIndex = ordered.findIndex((el) => el.ref === projection.scopeRef);
    if (scopeIndex === -1) {
      throw new EngineError(
        'TARGET_NOT_FOUND',
        `Scope ref ${projection.scopeRef} is not present in the current observation. Observe again for current refs.`
      );
    }
    const scope = ordered[scopeIndex] as (typeof ordered)[number];
    const scopeBlock = scope.block ?? 0;
    const scopeDepth = scope.depth ?? 0;
    allowedRefs = new Set<string>([scope.ref]);
    for (let i = scopeIndex + 1; i < ordered.length; i += 1) {
      const el = ordered[i];
      if (el === undefined) break;
      // Block-local: frame blocks are appended at the list end with their own
      // depth scale, so a main-block scope must stop at the block boundary.
      if ((el.block ?? 0) !== scopeBlock) break;
      if ((el.depth ?? 0) <= scopeDepth) break;
      allowedRefs.add(el.ref);
    }
  }

  const roles =
    projection.roles !== undefined && projection.roles.length > 0
      ? new Set(projection.roles)
      : undefined;
  // Blank needles are inert (projectionActive already treats them as no-ops).
  const trimmedName = projection.name?.trim();
  const needle =
    trimmedName !== undefined && trimmedName.length > 0 ? trimmedName.toLowerCase() : undefined;

  const matchesFilter = (element: PageElement): boolean => {
    if (allowedRefs !== undefined && !allowedRefs.has(element.ref)) return false;
    if (roles !== undefined && !roles.has(element.role)) return false;
    if (needle !== undefined && !(element.name ?? '').toLowerCase().includes(needle)) return false;
    return true;
  };

  // The shaped list is the source's own elements (diff path: changed subset)
  // that satisfy the predicate, in document order, above the cursor floor.
  const sourceOrder = new Map(source.elements.map((el) => [el.ref, el]));
  const matched: PageElement[] = [];
  for (const el of ordered) {
    const candidate = sourceOrder.get(el.ref);
    if (candidate === undefined || !matchesFilter(candidate)) continue;
    const ordinal = parseRef(candidate.ref)?.ordinal ?? 0;
    if (context.continueFrom !== undefined && ordinal < context.continueFrom) continue;
    matched.push(candidate);
  }

  const total = source.elements.length;
  const includeFields =
    projection.includeFields !== undefined ? new Set(projection.includeFields) : undefined;
  const shape = (element: PageElement): PageElement => shapeElement(element, includeFields);

  const windowed =
    projection.limit !== undefined && matched.length > projection.limit
      ? matched.slice(0, projection.limit)
      : matched;
  // Matches above the cursor floor that this window did not return.
  const remaining = matched.length - windowed.length;

  const echo: ObservationProjectionEcho = {
    ...(projection.roles !== undefined ? { roles: projection.roles } : {}),
    ...(projection.name !== undefined ? { name: projection.name } : {}),
    ...(projection.scopeRef !== undefined ? { scopeRef: projection.scopeRef } : {}),
    // The PREDICATE match count, not the windowed length: "matched 100 of
    // 373" with a limit window and continuation.remaining stays honest about
    // how many matching elements exist, not just how many returned.
    matched: matched.length,
    total,
  };

  const surviving = new Set(windowed.map((el) => el.ref));
  const focusedRef =
    source.focusedRef !== undefined && surviving.has(source.focusedRef)
      ? source.focusedRef
      : undefined;

  // focusedRef is rebuilt from the surviving set (dropped when its element
  // was filtered out) rather than inherited from the source spread.
  const { focusedRef: _sourceFocusedRef, ...sourceWithoutFocus } = source;
  const result: PageState = {
    ...sourceWithoutFocus,
    elements: windowed.map(shape),
    truncated: source.truncated || remaining > 0,
    ...(focusedRef !== undefined ? { focusedRef } : {}),
    // A projection cursor points at the first unreturned MATCH (page ordinal);
    // when the window covers every match there is nothing left to resume here.
    // `windowed` is a prefix slice of `matched`, so the first unreturned match
    // is exactly matched[windowed.length].
    ...(remaining > 0
      ? {
          continuation: {
            nextOrdinal: parseRef(matched[windowed.length]?.ref ?? '')?.ordinal ?? 0,
            remaining,
          },
        }
      : {}),
    projection: echo,
  };

  if (source.changes !== undefined) {
    // Added/modified changes carry current-revision refs: keep them when the
    // element survived the window. Removed changes carry the OLD revision's
    // ref, which can never be in `surviving` — filter those by applying the
    // roles/name predicate to the embedded element instead. A removal is the
    // highest-value diff signal; it must never vanish just because the page
    // moved on. (Scope membership of a removed element cannot be resolved
    // against current refs, so scope filtering applies to current entries
    // only.)
    result.changes = source.changes
      .filter((change) => {
        if (surviving.has(change.ref)) return true;
        if (change.change !== 'removed') return false;
        const old = (change.properties.element as { old?: PageElement | null } | undefined)?.old;
        if (old === null || old === undefined) return false;
        if (roles !== undefined && !roles.has(old.role)) return false;
        if (needle !== undefined && !(old.name ?? '').toLowerCase().includes(needle)) {
          return false;
        }
        return true;
      })
      .map((change) => shapeChange(change, shape));
  }

  return result;
}

/**
 * Protected-core element shaping. Never drops ref/role/name/value/
 * valueRedacted/checked/risk/focused/depth/block (visible/enabled are part of
 * the wire contract and always present); href(+hrefTruncated)/attributes/
 * required ride only on includeFields.
 */
function shapeElement(element: PageElement, includeFields: Set<string> | undefined): PageElement {
  const shaped: PageElement = {
    ref: element.ref,
    role: element.role,
    visible: element.visible,
    enabled: element.enabled,
  };
  if (element.name !== undefined) {
    if (element.name.length > NAME_CAP) {
      // Round-11/F9: a raw UTF-16 slice can split a surrogate pair at the
      // cap — drop a trailing lone high surrogate.
      shaped.name = clampUtf16(element.name, NAME_CAP);
      shaped.nameTruncated = true;
    } else {
      shaped.name = element.name;
    }
  }
  if (element.value !== undefined) shaped.value = element.value;
  if (element.valueRedacted !== undefined) shaped.valueRedacted = element.valueRedacted;
  if (element.checked !== undefined) shaped.checked = element.checked;
  if (element.risk !== undefined) shaped.risk = element.risk;
  if (element.focused !== undefined) shaped.focused = element.focused;
  if (element.depth !== undefined) shaped.depth = element.depth;
  // G1 context is protected core: compact projection must not strip the
  // disambiguator from generic-named controls (review G1/F1).
  if (element.context !== undefined) shaped.context = element.context;
  if (element.block !== undefined) shaped.block = element.block;
  if (includeFields?.has('href')) {
    if (element.href !== undefined) shaped.href = element.href;
    if (element.hrefTruncated !== undefined) shaped.hrefTruncated = element.hrefTruncated;
  }
  if (includeFields?.has('attributes') && element.attributes !== undefined) {
    shaped.attributes = element.attributes;
  }
  if (includeFields?.has('required') && element.required !== undefined) {
    shaped.required = element.required;
  }
  return shaped;
}

/** Apply the element shaper to embedded diff snapshots ({old,new} elements). */
function shapeChange(
  change: ElementChange,
  shape: (element: PageElement) => PageElement
): ElementChange {
  const shaped: ElementChange = { ...change };
  const element = change.properties.element as
    | { old: PageElement | null; new: PageElement | null }
    | undefined;
  if (element !== undefined) {
    shaped.properties = {
      ...change.properties,
      element: {
        old: element.old !== null ? shape(element.old) : null,
        new: element.new !== null ? shape(element.new) : null,
      },
    };
  }
  return shaped;
}

/**
 * Application-owned eligibility policy. Requires a built workspace; not a standalone CLI.
 * Source qualification is a trusted caller assertion, never authentication by this module.
 */
import {
  VERIFICATION_SNAPSHOT_LIMITS,
  snapshotJsonData,
} from '../../packages/protocol/dist/index.js';

/** @typedef {'eligible'|'hold'|'reject'} Decision */
/** @typedef {'satisfied'|'violated'|'unknown'} CriterionStatus */
/** @typedef {'confirmed'|'unknown'|'conflicting'} Scope */
/** @typedef {'employment'|'location'|'travel'|'benefit'|'role'} CriterionKind */
/** @typedef {{source:string,jobId:string,employerId:string,requisitionId:string|null,resolution:Scope}} Identity */
/** @typedef {{id:string,kind:CriterionKind,expected:string|number|boolean}} Criterion */
/** @typedef {{id:string,value:string|number|boolean|null,scope:Scope,evidenceRefs:string[]}} Fact */
/** @typedef {{currency:string|null,minorUnitDigits:number|null,period:string,component:string,min:number|null,max:number|null,scope:Scope,evidenceRefs:string[]}} Pay */
/** @typedef {{state:'configured',id:string,version:string,compensation:{currency:string,minorUnitDigits:number,period:'annual',component:'base',floor:number,rangeRule:'guaranteed-minimum'},freshness:{maxAgeMs:number,clockToleranceMs:number}|null,criteria:Criterion[],unconstrained:CriterionKind[]}} Policy */
/** @typedef {{id:string,kind:'listing'|'profile'|'attempts',subject:string,revision:string,observedAt:number,qualified:boolean}} Evidence */
/** @typedef {{operationId:string,identity:Identity,status:'accepted'|'pending'|'unknown'|'not_submitted',possibleDuplicate:boolean,evidenceRefs:string[]}} Attempt */
/** @typedef {{schemaVersion:1,policy:Policy|{state:'unconfigured'},listing:{id:string,revision:string,identity:Identity,status:'open'|'closed'|'unknown',evidenceRefs:string[],compensation:Pay,facts:Fact[]},profile:{id:string,revision:string},history:{revision:string,profileId:string,complete:boolean,evidenceRefs:string[],attempts:Attempt[]},evidence:Evidence[]}} EligibilityInput */
/** @typedef {{now:number,previous:number|null}} Clock */
/** @typedef {{id:string,status:CriterionStatus,reason:string,evidenceRefs:string[]}} CriterionResult */
/** @typedef {{schemaVersion:1,ruleVersion:'1',policy:{id:string,version:string}|null,candidateId:string,listingRevision:string,profile:{id:string,revision:string},historyRevision:string,evaluatedAt:number,validUntil:number|null,decision:Decision,reasons:string[],criteria:CriterionResult[]}} EligibilityResult */

// These checks describe the application's closed record shapes. Traversal, own-data
// capture, cycle rejection and byte/node/depth budgets belong to snapshotJsonData.
const CRITERION_KINDS = Object.freeze(['employment', 'location', 'travel', 'benefit', 'role']);
const invalid = () => {
  throw new TypeError('Invalid job eligibility input');
};
const ensure = (condition) => {
  if (!condition) invalid();
};
function record(value, keys) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  const actual = Object.keys(value);
  ensure(actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
const integer = (value) => ensure(Number.isSafeInteger(value) && value >= 0);
const identifier = (value) =>
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value));
const choice = (value, values) => ensure(values.includes(value));
const scope = (value) => choice(value, ['confirmed', 'unknown', 'conflicting']);
const currency = (value) => ensure(typeof value === 'string' && /^[A-Z]{3}$/.test(value));
const precision = (value) => {
  integer(value);
  ensure(value <= 4);
};
function boundedList(value) {
  ensure(Array.isArray(value) && value.length <= 128);
}
function unique(values) {
  ensure(new Set(values).size === values.length);
}
function refs(values, known) {
  boundedList(values);
  unique(values);
  for (const value of values) {
    identifier(value);
    ensure(known.has(value));
  }
}
function identity(value) {
  record(value, ['source', 'jobId', 'employerId', 'requisitionId', 'resolution']);
  for (const key of ['source', 'jobId', 'employerId']) identifier(value[key]);
  if (value.requisitionId !== null) identifier(value.requisitionId);
  scope(value.resolution);
}
function criterionValue(kind, value) {
  if (kind === 'travel') {
    integer(value);
    ensure(value <= 100);
  } else if (kind === 'benefit' || kind === 'role') ensure(typeof value === 'boolean');
  else ensure(typeof value === 'string' && value.length > 0 && value.length <= 256);
}

/** Validate the entire detached input, including records not used by the policy. */
function validate(input, clock) {
  record(clock, ['now', 'previous']);
  integer(clock.now);
  if (clock.previous !== null) integer(clock.previous);
  record(input, ['schemaVersion', 'policy', 'listing', 'profile', 'history', 'evidence']);
  ensure(input.schemaVersion === 1);
  boundedList(input.evidence);
  for (const item of input.evidence) {
    record(item, ['id', 'kind', 'subject', 'revision', 'observedAt', 'qualified']);
    for (const key of ['id', 'subject', 'revision']) identifier(item[key]);
    choice(item.kind, ['listing', 'profile', 'attempts']);
    integer(item.observedAt);
    ensure(typeof item.qualified === 'boolean');
  }
  unique(input.evidence.map((item) => item.id));
  const known = new Set(input.evidence.map((item) => item.id));
  const policy = input.policy;
  ensure(policy !== null && typeof policy === 'object');
  if (policy.state === 'unconfigured') record(policy, ['state']);
  else {
    record(policy, [
      'state',
      'id',
      'version',
      'compensation',
      'freshness',
      'criteria',
      'unconstrained',
    ]);
    ensure(policy.state === 'configured');
    identifier(policy.id);
    identifier(policy.version);
    const pay = policy.compensation;
    record(pay, ['currency', 'minorUnitDigits', 'period', 'component', 'floor', 'rangeRule']);
    currency(pay.currency);
    precision(pay.minorUnitDigits);
    integer(pay.floor);
    ensure(
      pay.period === 'annual' && pay.component === 'base' && pay.rangeRule === 'guaranteed-minimum'
    );
    if (policy.freshness !== null) {
      record(policy.freshness, ['maxAgeMs', 'clockToleranceMs']);
      integer(policy.freshness.maxAgeMs);
      integer(policy.freshness.clockToleranceMs);
      // Do not let overflow silently extend freshness or turn a bound into Infinity.
      integer(clock.now + policy.freshness.clockToleranceMs);
      for (const item of input.evidence) integer(item.observedAt + policy.freshness.maxAgeMs);
    }
    boundedList(policy.criteria);
    unique(policy.criteria.map((item) => item.id));
    for (const criterion of policy.criteria) {
      record(criterion, ['id', 'kind', 'expected']);
      identifier(criterion.id);
      ensure(criterion.id !== 'compensation');
      choice(criterion.kind, CRITERION_KINDS);
      criterionValue(criterion.kind, criterion.expected);
    }
    boundedList(policy.unconstrained);
    unique(policy.unconstrained);
    for (const kind of policy.unconstrained) choice(kind, CRITERION_KINDS);
    for (const kind of CRITERION_KINDS) {
      const constrained = policy.criteria.some((item) => item.kind === kind);
      ensure(constrained !== policy.unconstrained.includes(kind));
    }
  }
  const listing = input.listing;
  record(listing, [
    'id',
    'revision',
    'identity',
    'status',
    'evidenceRefs',
    'compensation',
    'facts',
  ]);
  identifier(listing.id);
  identifier(listing.revision);
  identity(listing.identity);
  choice(listing.status, ['open', 'closed', 'unknown']);
  refs(listing.evidenceRefs, known);
  const pay = listing.compensation;
  record(pay, [
    'currency',
    'minorUnitDigits',
    'period',
    'component',
    'min',
    'max',
    'scope',
    'evidenceRefs',
  ]);
  if (pay.currency !== null) currency(pay.currency);
  if (pay.minorUnitDigits !== null) precision(pay.minorUnitDigits);
  choice(pay.period, ['annual', 'monthly', 'hourly', 'unknown']);
  choice(pay.component, ['base', 'total', 'bonus', 'equity', 'unknown']);
  if (pay.min !== null) integer(pay.min);
  if (pay.max !== null) integer(pay.max);
  ensure(pay.min === null || pay.max === null || pay.min <= pay.max);
  scope(pay.scope);
  refs(pay.evidenceRefs, known);
  boundedList(listing.facts);
  unique(listing.facts.map((item) => item.id));
  for (const fact of listing.facts) {
    record(fact, ['id', 'value', 'scope', 'evidenceRefs']);
    identifier(fact.id);
    ensure(fact.id !== 'compensation');
    scope(fact.scope);
    refs(fact.evidenceRefs, known);
    ensure(fact.value === null || ['boolean', 'string', 'number'].includes(typeof fact.value));
    if (typeof fact.value === 'number') integer(fact.value);
    if (typeof fact.value === 'string') ensure(fact.value.length > 0 && fact.value.length <= 256);
    const criterion =
      policy.state === 'configured' && policy.criteria.find((item) => item.id === fact.id);
    if (criterion && fact.value !== null) criterionValue(criterion.kind, fact.value);
  }
  record(input.profile, ['id', 'revision']);
  identifier(input.profile.id);
  identifier(input.profile.revision);
  const history = input.history;
  record(history, ['revision', 'profileId', 'complete', 'evidenceRefs', 'attempts']);
  identifier(history.profileId);
  identifier(history.revision);
  ensure(typeof history.complete === 'boolean');
  refs(history.evidenceRefs, known);
  boundedList(history.attempts);
  unique(history.attempts.map((item) => item.operationId));
  for (const attempt of history.attempts) {
    record(attempt, ['operationId', 'identity', 'status', 'possibleDuplicate', 'evidenceRefs']);
    identifier(attempt.operationId);
    identity(attempt.identity);
    choice(attempt.status, ['accepted', 'pending', 'unknown', 'not_submitted']);
    ensure(typeof attempt.possibleDuplicate === 'boolean');
    refs(attempt.evidenceRefs, known);
  }
}

/**
 * Pure conditional screening, never submission authorization. All timestamps are
 * integer milliseconds supplied by the trusted caller; this function reads no clock.
 * @param {unknown} input
 * @param {unknown} clock
 * @returns {EligibilityResult}
 */
export function evaluateEligibility(input, clock) {
  /** @type {{input: EligibilityInput, clock: Clock}} */
  let captured;
  try {
    // Snapshot both arguments together before consulting any decision state.
    captured = /** @type {{input: EligibilityInput, clock: Clock}} */ (
      snapshotJsonData({ input, clock }, VERIFICATION_SNAPSHOT_LIMITS)
    );
    validate(captured.input, captured.clock);
  } catch {
    invalid();
  }
  const data = /** @type {EligibilityInput} */ (captured.input);
  const time = /** @type {Clock} */ (captured.clock);
  const { policy, listing, profile, history } = data;
  /** @type {EligibilityResult} */
  const result = {
    schemaVersion: 1,
    ruleVersion: '1',
    policy: policy.state === 'configured' ? { id: policy.id, version: policy.version } : null,
    candidateId: listing.id,
    listingRevision: listing.revision,
    profile: { ...profile },
    historyRevision: history.revision,
    evaluatedAt: time.now,
    validUntil: null,
    decision: 'hold',
    reasons: [],
    criteria: [],
  };
  if (policy.state === 'unconfigured') {
    result.reasons = ['policy-unconfigured'];
    return result;
  }
  const holds = new Set();
  const evidence = new Map(data.evidence.map((item) => [item.id, item]));
  const freshness = policy.freshness;
  if (!freshness) holds.add('freshness-unconfigured');
  if (time.previous !== null && time.previous > time.now) holds.add('clock-invalid');
  if (listing.identity.resolution !== 'confirmed') holds.add('identity-unresolved');
  if (history.profileId !== profile.id) holds.add('history-profile-mismatch');
  const subjects = {
    listing: { subject: listing.id, revision: listing.revision },
    profile: { subject: profile.id, revision: profile.revision },
    attempts: { subject: listing.id, revision: history.revision },
  };
  // One evidence checker for listing, criteria and history, with app-owned revision pins.
  const checkEvidence = (references, requiredKinds) => {
    let valid =
      freshness !== null &&
      listing.identity.resolution === 'confirmed' &&
      (time.previous === null || time.previous <= time.now);
    const kinds = new Set();
    for (const ref of references) {
      const item = evidence.get(ref);
      kinds.add(item.kind);
      const pin = subjects[item.kind];
      if (!item.qualified || item.subject !== pin.subject || item.revision !== pin.revision) {
        holds.add('evidence-unqualified');
        valid = false;
      }
      if (freshness) {
        const expiry = item.observedAt + freshness.maxAgeMs;
        result.validUntil = Math.min(result.validUntil ?? expiry, expiry);
        if (time.now >= expiry) {
          holds.add('evidence-stale');
          valid = false;
        }
        if (item.observedAt > time.now + freshness.clockToleranceMs) {
          holds.add('clock-invalid');
          valid = false;
        }
      }
    }
    if (requiredKinds.some((kind) => !kinds.has(kind))) {
      holds.add('evidence-unqualified');
      valid = false;
    }
    return valid;
  };
  const criterion = (id, status, reason, references) => {
    result.criteria.push({ id, status, reason, evidenceRefs: [...references].sort() });
  };
  checkEvidence(listing.evidenceRefs, ['listing']);
  checkEvidence(history.evidenceRefs, ['attempts']);
  const pay = listing.compensation;
  const payQualified = checkEvidence(pay.evidenceRefs, ['listing']);
  if (pay.scope === 'conflicting') holds.add('evidence-conflicting');
  if (
    !payQualified ||
    pay.scope !== 'confirmed' ||
    pay.currency !== policy.compensation.currency ||
    pay.minorUnitDigits !== policy.compensation.minorUnitDigits ||
    pay.period !== 'annual' ||
    pay.component !== 'base' ||
    pay.min === null
  ) {
    criterion('compensation', 'unknown', 'pay-unqualified', pay.evidenceRefs);
  } else if (pay.min >= policy.compensation.floor) {
    criterion('compensation', 'satisfied', 'pay-floor-met', pay.evidenceRefs);
  } else if (pay.max !== null && pay.max < policy.compensation.floor) {
    criterion('compensation', 'violated', 'pay-below-floor', pay.evidenceRefs);
  } else criterion('compensation', 'unknown', 'pay-range-unresolved', pay.evidenceRefs);
  const facts = new Map(listing.facts.map((item) => [item.id, item]));
  for (const rule of policy.criteria) {
    const fact = facts.get(rule.id);
    if (!fact) {
      criterion(rule.id, 'unknown', 'fact-missing', []);
      continue;
    }
    const factQualified = checkEvidence(
      fact.evidenceRefs,
      rule.kind === 'role' ? ['listing', 'profile'] : ['listing']
    );
    if (fact.scope === 'conflicting') holds.add('evidence-conflicting');
    if (!factQualified || fact.value === null || fact.scope !== 'confirmed') {
      criterion(rule.id, 'unknown', 'fact-unqualified', fact.evidenceRefs);
      continue;
    }
    const satisfied =
      rule.kind === 'travel'
        ? /** @type {number} */ (fact.value) <= /** @type {number} */ (rule.expected)
        : fact.value === rule.expected;
    criterion(
      rule.id,
      satisfied ? 'satisfied' : 'violated',
      satisfied ? 'fact-matched' : 'fact-mismatched',
      fact.evidenceRefs
    );
  }
  let accepted = false;
  let pending = false;
  for (const attempt of history.attempts) {
    checkEvidence(attempt.evidenceRefs, ['attempts']);
    const a = attempt.identity;
    const b = listing.identity;
    const sameSource = a.source === b.source && a.jobId === b.jobId;
    const sameEmployer = a.employerId === b.employerId;
    const sameRequisition = a.requisitionId !== null && a.requisitionId === b.requisitionId;
    if (
      sameSource &&
      (!sameEmployer || (a.requisitionId !== null && b.requisitionId !== null && !sameRequisition))
    )
      holds.add('identity-conflicting');
    if (attempt.possibleDuplicate || a.resolution !== 'confirmed') holds.add('possible-duplicate');
    if (sameEmployer && (sameSource || sameRequisition) && a.resolution === 'confirmed') {
      accepted ||= attempt.status === 'accepted';
      pending ||= attempt.status === 'pending' || attempt.status === 'unknown';
    }
  }
  result.criteria.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Global grounding failures precede positive fit and apparent violations. Unknown
  // history cannot be repaired by changing an operation ID or by a local empty list.
  if (holds.size) result.reasons = [...holds].sort();
  else if (accepted) {
    result.decision = 'reject';
    result.reasons = ['already-accepted'];
  } else if (!history.complete || pending)
    result.reasons = [!history.complete ? 'history-incomplete' : 'prior-write-unresolved'];
  else if (listing.status === 'closed') {
    result.decision = 'reject';
    result.reasons = ['listing-closed'];
  } else if (listing.status !== 'open') result.reasons = ['listing-unknown'];
  else if (result.criteria.some((item) => item.status === 'violated')) {
    result.decision = 'reject';
    result.reasons = ['criterion-violated'];
  } else if (result.criteria.some((item) => item.status === 'unknown'))
    result.reasons = ['criterion-unknown'];
  else result.decision = 'eligible';
  return result;
}

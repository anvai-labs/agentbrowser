import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEligibility } from '../examples/job-application/eligibility.mjs';

const clock = { now: 100_000, previous: 90_000 };
function fixture() {
  return {
    schemaVersion: 1,
    policy: {
      state: 'configured',
      id: 'policy-1',
      version: '1',
      compensation: {
        currency: 'USD',
        minorUnitDigits: 2,
        period: 'annual',
        component: 'base',
        floor: 10_000_000,
        rangeRule: 'guaranteed-minimum',
      },
      freshness: { maxAgeMs: 60_000, clockToleranceMs: 100 },
      unconstrained: [],
      criteria: [
        { id: 'employment', kind: 'employment', expected: 'full-time' },
        { id: 'health', kind: 'benefit', expected: true },
        { id: 'location', kind: 'location', expected: 'remote' },
        { id: 'role', kind: 'role', expected: true },
        { id: 'travel', kind: 'travel', expected: 20 },
      ],
    },
    listing: {
      id: 'candidate-1',
      revision: 'listing-1',
      identity: {
        source: 'portal-a',
        jobId: 'job-1',
        employerId: 'employer-a',
        requisitionId: 'req-1',
        resolution: 'confirmed',
      },
      status: 'open',
      evidenceRefs: ['listing-source'],
      compensation: {
        currency: 'USD',
        minorUnitDigits: 2,
        period: 'annual',
        component: 'base',
        min: 10_000_000,
        max: 12_000_000,
        scope: 'confirmed',
        evidenceRefs: ['listing-source'],
      },
      facts: [
        {
          id: 'employment',
          value: 'full-time',
          scope: 'confirmed',
          evidenceRefs: ['listing-source'],
        },
        { id: 'health', value: true, scope: 'confirmed', evidenceRefs: ['listing-source'] },
        { id: 'location', value: 'remote', scope: 'confirmed', evidenceRefs: ['listing-source'] },
        {
          id: 'role',
          value: true,
          scope: 'confirmed',
          evidenceRefs: ['listing-source', 'profile-source'],
        },
        { id: 'travel', value: 10, scope: 'confirmed', evidenceRefs: ['listing-source'] },
      ],
    },
    profile: { id: 'profile-1', revision: 'facts-1' },
    history: {
      revision: 'history-1',
      profileId: 'profile-1',
      complete: true,
      evidenceRefs: ['history-source'],
      attempts: [],
    },
    evidence: [
      {
        id: 'listing-source',
        kind: 'listing',
        subject: 'candidate-1',
        revision: 'listing-1',
        observedAt: 90_000,
        qualified: true,
      },
      {
        id: 'profile-source',
        kind: 'profile',
        subject: 'profile-1',
        revision: 'facts-1',
        observedAt: 80_000,
        qualified: true,
      },
      {
        id: 'history-source',
        kind: 'attempts',
        subject: 'candidate-1',
        revision: 'history-1',
        observedAt: 95_000,
        qualified: true,
      },
    ],
  };
}
const evaluate = (input = fixture(), time = clock) => evaluateEligibility(input, time);
const fact = (input, id) => input.listing.facts.find((item) => item.id === id);
function attempt(input, change = {}) {
  input.history.attempts.push({
    operationId: 'operation-1',
    identity: { ...input.listing.identity },
    status: 'accepted',
    possibleDuplicate: false,
    evidenceRefs: ['history-source'],
    ...change,
  });
}
function decision(change, expected, reason) {
  const input = fixture();
  change(input);
  const result = evaluate(input);
  assert.equal(result.decision, expected);
  if (reason) assert.ok(result.reasons.includes(reason), JSON.stringify(result));
  return result;
}

test('all gates satisfied yields bounded conditional eligibility at the exact base floor', () => {
  const result = evaluate();
  assert.equal(result.decision, 'eligible');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.validUntil, 140_000);
  assert.deepEqual(
    result.criteria.map((item) => item.id),
    ['compensation', 'employment', 'health', 'location', 'role', 'travel']
  );
  assert.ok(result.criteria.every((item) => item.status === 'satisfied'));
});

for (const [name, change, expected] of [
  ['below', (x) => Object.assign(x, { min: 8_000_000, max: 9_999_999 }), 'reject'],
  ['straddling', (x) => Object.assign(x, { min: 9_000_000, max: 11_000_000 }), 'hold'],
  [
    'upper bound exactly floor',
    (x) => Object.assign(x, { min: 9_000_000, max: 10_000_000 }),
    'hold',
  ],
  [
    'missing lower bound',
    (x) => {
      x.min = null;
    },
    'hold',
  ],
  [
    'above floor without upper bound',
    (x) => {
      x.max = null;
    },
    'eligible',
  ],
  [
    'wrong currency',
    (x) => {
      x.currency = 'EUR';
    },
    'hold',
  ],
  [
    'unknown currency',
    (x) => {
      x.currency = null;
    },
    'hold',
  ],
  [
    'wrong precision',
    (x) => {
      x.minorUnitDigits = 0;
    },
    'hold',
  ],
  [
    'hourly',
    (x) => {
      x.period = 'hourly';
    },
    'hold',
  ],
  [
    'total compensation',
    (x) => {
      x.component = 'total';
    },
    'hold',
  ],
  [
    'bonus',
    (x) => {
      x.component = 'bonus';
    },
    'hold',
  ],
  [
    'ambiguous geography',
    (x) => {
      x.scope = 'unknown';
    },
    'hold',
  ],
])
  test(`compensation: ${name}`, () => {
    decision((x) => change(x.listing.compensation), expected);
  });

test('benefit absence rejects; omission, unknown scope or unknown value hold', () => {
  decision(
    (x) => {
      fact(x, 'health').value = false;
    },
    'reject',
    'criterion-violated'
  );
  decision(
    (x) => {
      x.listing.facts = x.listing.facts.filter((item) => item.id !== 'health');
    },
    'hold',
    'criterion-unknown'
  );
  decision((x) => {
    fact(x, 'health').value = null;
  }, 'hold');
  decision((x) => {
    fact(x, 'health').scope = 'unknown';
  }, 'hold');
});
test('travel maximum and employment/location mismatch reject; role requires profile anchors', () => {
  decision((x) => {
    fact(x, 'travel').value = 21;
  }, 'reject');
  decision((x) => {
    fact(x, 'employment').value = 'part-time';
  }, 'reject');
  decision((x) => {
    fact(x, 'location').value = 'onsite';
  }, 'reject');
  decision(
    (x) => {
      fact(x, 'role').evidenceRefs = ['listing-source'];
    },
    'hold',
    'evidence-unqualified'
  );
  decision((x) => {
    fact(x, 'role').value = false;
  }, 'reject');
});
test('explicit unconfigured policy holds, never invents defaults', () => {
  const result = decision(
    (x) => {
      x.policy = { state: 'unconfigured' };
    },
    'hold',
    'policy-unconfigured'
  );
  assert.equal(result.policy, null);
  assert.equal(result.validUntil, null);
  assert.deepEqual(result.criteria, []);
});

for (const [name, change, reason] of [
  [
    'unresolved identity',
    (x) => {
      x.listing.identity.resolution = 'unknown';
    },
    'identity-unresolved',
  ],
  [
    'unqualified source',
    (x) => {
      x.evidence[0].qualified = false;
    },
    'evidence-unqualified',
  ],
  [
    'wrong subject',
    (x) => {
      x.evidence[0].subject = 'other-job';
    },
    'evidence-unqualified',
  ],
  [
    'changed listing revision',
    (x) => {
      x.listing.revision = 'changed';
    },
    'evidence-unqualified',
  ],
  [
    'changed profile revision',
    (x) => {
      x.profile.revision = 'changed';
    },
    'evidence-unqualified',
  ],
  [
    'changed history revision',
    (x) => {
      x.history.revision = 'changed';
    },
    'evidence-unqualified',
  ],
  [
    'stale evidence',
    (x) => {
      x.evidence[0].observedAt = 40_000;
    },
    'evidence-stale',
  ],
  [
    'future evidence',
    (x) => {
      x.evidence[0].observedAt = 100_101;
    },
    'clock-invalid',
  ],
  [
    'conflicting facts',
    (x) => {
      fact(x, 'health').scope = 'conflicting';
    },
    'evidence-conflicting',
  ],
  [
    'missing expiry policy',
    (x) => {
      x.policy.freshness = null;
    },
    'freshness-unconfigured',
  ],
  [
    'incomplete history',
    (x) => {
      x.history.complete = false;
    },
    'history-incomplete',
  ],
  [
    'unqualified empty history',
    (x) => {
      x.history.evidenceRefs = [];
    },
    'evidence-unqualified',
  ],
])
  test(`hold takes precedence over apparent violations: ${name}`, () => {
    decision(
      (x) => {
        change(x);
        fact(x, 'employment').value = 'part-time';
      },
      'hold',
      reason
    );
  });

test('clock regression holds and freshness expires at the exact boundary', () => {
  assert.equal(evaluate(fixture(), { ...clock, previous: clock.now + 1 }).decision, 'hold');
  assert.equal(evaluate(fixture(), { now: 140_000, previous: 100_000 }).decision, 'hold');
  assert.equal(evaluate(fixture(), { now: 139_999, previous: 100_000 }).decision, 'eligible');
});
test('known closed rejects; unknown or unqualified listing status holds', () => {
  decision(
    (x) => {
      x.listing.status = 'closed';
    },
    'reject',
    'listing-closed'
  );
  decision(
    (x) => {
      x.listing.status = 'unknown';
    },
    'hold',
    'listing-unknown'
  );
  decision((x) => {
    x.listing.status = 'closed';
    x.evidence[0].qualified = false;
  }, 'hold');
});
test('known acceptance rejects exact source identity and employer-scoped cross-portal requisitions', () => {
  decision(
    (x) => {
      attempt(x);
    },
    'reject',
    'already-accepted'
  );
  decision(
    (x) => {
      attempt(x);
      Object.assign(x.history.attempts[0].identity, {
        source: 'portal-b',
        jobId: 'other-source-id',
      });
    },
    'reject',
    'already-accepted'
  );
  decision((x) => {
    attempt(x);
    Object.assign(x.history.attempts[0].identity, {
      employerId: 'other-employer',
      source: 'portal-b',
      jobId: 'other-job',
    });
  }, 'eligible');
});
test('same source job with conflicting employer and fuzzy matches hold without merging identities', () => {
  decision(
    (x) => {
      attempt(x);
      x.history.attempts[0].identity.employerId = 'other-employer';
    },
    'hold',
    'identity-conflicting'
  );
  decision(
    (x) => {
      attempt(x, { possibleDuplicate: true });
      Object.assign(x.history.attempts[0].identity, {
        source: 'other',
        jobId: 'other',
        requisitionId: null,
      });
    },
    'hold',
    'possible-duplicate'
  );
});
for (const status of ['pending', 'unknown'])
  test(`prior ${status} holds despite operation-ID changes`, () => {
    decision(
      (x) => {
        attempt(x, { status, operationId: 'new-operation' });
      },
      'hold',
      'prior-write-unresolved'
    );
  });
test('a confirmed not-submitted attempt is not acceptance, but missing its evidence holds', () => {
  decision((x) => {
    attempt(x, { status: 'not_submitted' });
  }, 'eligible');
  decision(
    (x) => {
      attempt(x, { status: 'not_submitted', evidenceRefs: [] });
    },
    'hold',
    'evidence-unqualified'
  );
});

for (const [name, change] of [
  [
    'omitted policy',
    (x) => {
      Reflect.deleteProperty(x, 'policy');
    },
  ],
  [
    'extra policy field',
    (x) => {
      x.policy.secret = 'PRIVATE';
    },
  ],
  [
    'schema version',
    (x) => {
      x.schemaVersion = 2;
    },
  ],
  [
    'missing fact refs',
    (x) => {
      Reflect.deleteProperty(x.listing.facts[0], 'evidenceRefs');
    },
  ],
  [
    'dangling ref',
    (x) => {
      x.listing.evidenceRefs = ['missing'];
    },
  ],
  [
    'duplicate evidence',
    (x) => {
      x.evidence.push({ ...x.evidence[0] });
    },
  ],
  [
    'duplicate criterion',
    (x) => {
      x.policy.criteria.push({ ...x.policy.criteria[0] });
    },
  ],
  [
    'reserved criterion',
    (x) => {
      x.policy.criteria[0].id = 'compensation';
    },
  ],
  [
    'duplicate fact',
    (x) => {
      x.listing.facts.push({ ...x.listing.facts[0] });
    },
  ],
  [
    'unsafe integer',
    (x) => {
      x.listing.compensation.max = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'fractional pay',
    (x) => {
      x.listing.compensation.min = 1.5;
    },
  ],
  [
    'inverted range',
    (x) => {
      x.listing.compensation.min = x.listing.compensation.max + 1;
    },
  ],
  [
    'wrong criterion value type',
    (x) => {
      fact(x, 'travel').value = 'PRIVATE';
    },
  ],
  [
    '129 evidence entries',
    (x) => {
      x.evidence = Array.from({ length: 129 }, (_, i) => ({ ...x.evidence[0], id: `source-${i}` }));
    },
  ],
  [
    'oversized input',
    (x) => {
      x.listing.facts[0].value = 'PRIVATE'.repeat(10000);
    },
  ],
])
  test(`malformed input fails with static diagnostics: ${name}`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => evaluate(input), {
      name: 'TypeError',
      message: 'Invalid job eligibility input',
    });
  });
test('accessors are never invoked, cycles and non-JSON values refuse before evaluation', () => {
  let invoked = false;
  const input = fixture();
  Object.defineProperty(input.policy, 'criteria', {
    enumerable: true,
    get() {
      invoked = true;
      throw Error('PRIVATE');
    },
  });
  assert.throws(() => evaluate(input), /Invalid job eligibility input/);
  assert.equal(invoked, false);
  const cyclic = fixture();
  cyclic.profile = cyclic;
  assert.throws(() => evaluate(cyclic), /Invalid job eligibility input/);
  assert.throws(
    () => evaluate(fixture(), { now: Number.NaN, previous: null }),
    /Invalid job eligibility input/
  );
});
test('outputs are deterministic and detached, contain no values, and do not persist state between candidates', () => {
  const input = fixture();
  fact(input, 'location').value = 'PRIVATE-LOCATION';
  const original = structuredClone(input);
  const first = evaluate(input);
  assert.deepEqual(input, original);
  assert.ok(!JSON.stringify(first).includes('PRIVATE'));
  input.evidence.reverse();
  input.policy.criteria.reverse();
  input.listing.facts.reverse();
  assert.deepEqual(evaluate(input), first);
  first.criteria[0].evidenceRefs.push('mutation');
  assert.notDeepEqual(evaluate(input), first);
  assert.equal(evaluate().decision, 'eligible');
});

test('empty or incomplete configured criteria cannot silently disable mandatory categories', () => {
  const input = fixture();
  input.policy.criteria = [];
  assert.throws(() => evaluate(input), /Invalid job eligibility input/);
  const partial = fixture();
  partial.policy.criteria = partial.policy.criteria.filter((item) => item.kind !== 'benefit');
  assert.throws(() => evaluate(partial), /Invalid job eligibility input/);
});
test('a host can explicitly leave named categories unconstrained; declarations cannot conflict', () => {
  const input = fixture();
  input.policy.criteria = [];
  input.policy.unconstrained = ['employment', 'location', 'travel', 'benefit', 'role'];
  assert.equal(evaluate(input).decision, 'eligible');
  const conflict = fixture();
  conflict.policy.unconstrained = ['role'];
  assert.throws(() => evaluate(conflict), /Invalid job eligibility input/);
});
test('role requires both evidence kinds and listing/history sources cannot substitute for one another', () => {
  decision(
    (x) => {
      fact(x, 'role').evidenceRefs = ['profile-source'];
    },
    'hold',
    'evidence-unqualified'
  );
  decision(
    (x) => {
      x.listing.evidenceRefs = ['history-source'];
    },
    'hold',
    'evidence-unqualified'
  );
  decision(
    (x) => {
      x.history.evidenceRefs = ['listing-source'];
    },
    'hold',
    'evidence-unqualified'
  );
});
test('a later not-submitted record cannot erase acceptance and unknown attempt identity holds', () => {
  decision(
    (x) => {
      attempt(x);
      attempt(x, { operationId: 'operation-2', status: 'not_submitted' });
    },
    'reject',
    'already-accepted'
  );
  decision(
    (x) => {
      attempt(x);
      x.history.attempts[0].identity.resolution = 'unknown';
    },
    'hold',
    'possible-duplicate'
  );
});
test('expiry and clock tolerance cannot overflow safe integer arithmetic', () => {
  const input = fixture();
  input.evidence[0].observedAt = Number.MAX_SAFE_INTEGER;
  assert.throws(() => evaluate(input), /Invalid job eligibility input/);
  assert.throws(
    () => evaluate(fixture(), { now: Number.MAX_SAFE_INTEGER, previous: null }),
    /Invalid job eligibility input/
  );
  const boundary = fixture();
  boundary.policy.freshness = { maxAgeMs: 1, clockToleranceMs: 0 };
  for (const item of boundary.evidence) item.observedAt = Number.MAX_SAFE_INTEGER - 1;
  const result = evaluate(boundary, { now: Number.MAX_SAFE_INTEGER - 1, previous: null });
  assert.equal(result.decision, 'eligible');
  assert.equal(result.validUntil, Number.MAX_SAFE_INTEGER);
});

test('a criterion cannot claim satisfaction or violation from unqualified evidence', () => {
  for (const change of [
    (x) => {
      fact(x, 'role').evidenceRefs = ['listing-source'];
    },
    (x) => {
      x.policy.freshness = null;
    },
    (x) => {
      x.listing.identity.resolution = 'unknown';
    },
    (x) => {
      x.evidence[1].qualified = false;
    },
    (x) => {
      x.evidence[1].observedAt = 1;
    },
    (x) => {
      x.evidence[1].revision = 'old';
    },
    (x) => {
      x.evidence[1].observedAt = clock.now + 101;
    },
  ]) {
    const input = fixture();
    change(input);
    for (const value of [true, false]) {
      fact(input, 'role').value = value;
      const result = evaluate(input);
      assert.equal(result.decision, 'hold');
      assert.equal(result.criteria.find((item) => item.id === 'role').status, 'unknown');
    }
  }
  const input = fixture();
  input.evidence[0].observedAt = 1;
  assert.equal(
    evaluate(input).criteria.find((item) => item.id === 'compensation').status,
    'unknown'
  );
  assert.ok(
    evaluate(fixture(), { now: 100_000, previous: 100_001 }).criteria.every(
      (item) => item.status === 'unknown'
    )
  );
});
test('history from another profile and conflicting requisitions hold rather than prove eligibility', () => {
  decision(
    (x) => {
      x.history.profileId = 'other-profile';
    },
    'hold',
    'history-profile-mismatch'
  );
  decision(
    (x) => {
      attempt(x);
      x.history.attempts[0].identity.requisitionId = 'other-requisition';
    },
    'hold',
    'identity-conflicting'
  );
});

test('opaque IDs and currencies reject trailing line terminators rather than aliasing valid records', () => {
  for (const change of [
    (x) => {
      x.listing.id = 'candidate-1\n';
    },
    (x) => {
      x.policy.id = 'policy-1\r\n';
    },
    (x) => {
      x.policy.compensation.currency = 'USD\n';
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => evaluate(input), /Invalid job eligibility input/);
  }
});

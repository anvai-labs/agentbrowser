/**
 * T5 J3b: the read-only historical lookup surface over the durable journal (accepted J-design,
 * D1 as amended: the operator key OR a tenant API key may read, tenant-scoped; writes stay
 * operator-only and are J3c).
 *
 * These are transport projections only: every field here is derived from a stored journal record,
 * and everything identity-bearing that a caller must not see (keyed fingerprints, live digests,
 * inputs, evidence content, actor) is stripped before it leaves the server. Absence is reported
 * as absence, never as proof of non-execution.
 */
import { type Static, Type } from '@sinclair/typebox';

const strict = { additionalProperties: false };

export const JournalHistoricalRecordSchema = Type.Object(
  {
    /** The namespace holding the record (J3b searches the configured namespace only). */
    namespace: Type.String({ maxLength: 128 }),
    /**
     * The accepted classification vocabulary: undispatched (rev 1), in_doubt (rev 2, dispatched,
     * no terminal), failed_before_dispatch (rev 2, failed), or a terminal state (rev 3):
     * completed, failed, settled_unknown.
     */
    classification: Type.Union(
      [
        Type.Literal('undispatched'),
        Type.Literal('in_doubt'),
        Type.Literal('failed_before_dispatch'),
        Type.Literal('completed'),
        Type.Literal('failed'),
        Type.Literal('settled_unknown'),
      ],
      { $id: 'urn:agentbrowser:journal-classification:v1' }
    ),
    /** True only for classifications J3c can still change (close/continue/reconcile/settle). */
    actionable: Type.Boolean(),
    application: Type.Object(
      {
        adapter: Type.String({ maxLength: 128 }),
        resource: Type.String({ maxLength: 128 }),
        bindingGeneration: Type.String({ maxLength: 255 }),
      },
      strict
    ),
    /** Opaque identity of the departed session; never a live session reference. */
    session: Type.Object(
      {
        sessionIncarnation: Type.String({ maxLength: 22 }),
        epoch: Type.Integer({ minimum: 0 }),
      },
      strict
    ),
  },
  strict
);
export type JournalHistoricalRecord = Static<typeof JournalHistoricalRecordSchema>;

export const JournalLookupResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: Type.String({ maxLength: 128 }),
    /**
     * True when no record matched in the searched namespace: scoped absence, never proof that
     * nothing executed (the operation may live in a rotated-away namespace, see D7).
     */
    absent: Type.Boolean(),
    truncated: Type.Boolean(),
    /**
     * J3d: searched namespaces that could not be read this time. Present only when some were
     * unreadable; `absent` is then always false (the history is partly unread, not absent).
     */
    unreadNamespaces: Type.Optional(
      Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 17 })
    ),
    records: Type.Array(JournalHistoricalRecordSchema, { maxItems: 16 }),
  },
  { ...strict, $id: 'urn:agentbrowser:journal-lookup:v1' }
);
export type JournalLookupResult = Static<typeof JournalLookupResultSchema>;

export const JournalStatusSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    configured: Type.Boolean(),
    namespace: Type.Optional(Type.String({ maxLength: 128 })),
    health: Type.Optional(
      Type.Union([
        Type.Literal('open'),
        Type.Literal('quarantined'),
        Type.Literal('poisoned'),
        Type.Literal('closed'),
      ])
    ),
    /** ISO-8601 instants from the namespace descriptor. */
    acceptUntil: Type.Optional(Type.String({ maxLength: 40 })),
    retainUntil: Type.Optional(Type.String({ maxLength: 40 })),
    runtime: Type.Object(
      {
        platform: Type.String({ maxLength: 32 }),
        node: Type.String({ maxLength: 32 }),
        /** The qualified matrix from the accepted design: Node 24 on Linux or macOS. */
        qualified: Type.Boolean(),
      },
      strict
    ),
    /**
     * True when recovery work is qualified here: the journal is configured and healthy on a
     * qualified runtime. Advisory only; there is no exactly-once promise.
     */
    recoveryQualified: Type.Boolean(),
    /**
     * J3d (D7): the namespaces rotated away from and listed in AGENTBROWSER_JOURNAL_HISTORY_FILE:
     * open (searched and recoverable until retainUntil) or refused (with the store's reason).
     */
    history: Type.Optional(
      Type.Array(
        Type.Object(
          {
            namespace: Type.String({ maxLength: 128 }),
            /** The configured current namespace, listed recover-only once its horizon passed. */
            current: Type.Optional(Type.Literal(true)),
            state: Type.Union([
              Type.Literal('open'),
              Type.Literal('refused'),
              Type.Literal('unavailable'),
            ]),
            reason: Type.Optional(Type.String({ maxLength: 128 })),
            acceptUntil: Type.String({ maxLength: 40 }),
            retainUntil: Type.String({ maxLength: 40 }),
          },
          strict
        ),
        // 16 history entries plus the past-horizon current namespace.
        { maxItems: 17 }
      )
    ),
  },
  { ...strict, $id: 'urn:agentbrowser:journal-status:v1' }
);
export type JournalStatus = Static<typeof JournalStatusSchema>;

/** Derives the projection's classification from a stored record's legal state. */
export function classifyJournalRecord(record: {
  revision: number;
  dispatched: boolean;
  terminal?: { status: string } | undefined;
}): { classification: JournalHistoricalRecord['classification']; actionable: boolean } {
  if (record.revision === 1) return { classification: 'undispatched', actionable: true };
  if (record.revision === 2 && record.dispatched && record.terminal === undefined)
    return { classification: 'in_doubt', actionable: true };
  if (record.revision === 2 && !record.dispatched && record.terminal?.status === 'failed')
    return { classification: 'failed_before_dispatch', actionable: false };
  if (record.revision === 3) {
    const status = record.terminal?.status;
    if (status === 'completed') return { classification: 'completed', actionable: false };
    if (status === 'failed') return { classification: 'failed', actionable: false };
    if (status === 'outcome_unknown')
      return { classification: 'settled_unknown', actionable: false };
  }
  throw new Error('Illegal journal record state');
}

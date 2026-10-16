/**
 * T5 B-dur (B5): the application identity browser-operation journal records use (adapter
 * `browser`, resource `act` | `plan` | `autofill`). Reserved: no application adapter may register
 * it, so lookup can always tell a browser record apart and reconcile always refuses one.
 */
export const RESERVED_BROWSER_ADAPTER_ID = 'browser';

/** T5 B-dur (B5): the fingerprint domain of durable browser operations (never an application's). */
export const BROWSER_OPERATION_FINGERPRINT = 'browser-operation:v1-durable';

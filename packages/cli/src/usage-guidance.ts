import { INTERACTION_GUIDANCE } from '@agentbrowser/sdk-typescript';

/** Static, credential-free guidance shared by --help and offline describe. */
export interface UsageGuidance {
  notes: readonly string[];
  examples: readonly string[];
}

export const ROOT_USAGE: UsageGuidance = {
  notes: [
    'Start with health, session list and page list SESSION to reuse authorized work. ' +
      'Use describe COMMAND --schema for syntax, examples and supported JSON schemas without a server.',
    'CLI endpoint: --base-url. MCP adapter endpoint: AGENTBROWSER_BASE_URL. ' +
      'Both accept AGENTBROWSER_API_KEY; port 5709 is REST, not an HTTP MCP endpoint.',
    'Server startup variables belong on agentbrowser-server: HOST and PORT select its listener; ' +
      'AGENTBROWSER_API_KEYS configures key:tenant pairs. Keep keys out of command history and logs.',
    INTERACTION_GUIDANCE.networkPolicy,
    'A running service keeps its startup environment. Preserve active sessions before an authorized restart, ' +
      'or use a separate local instance on an unused port. Compare --version and health; installed ' +
      'help is not proof of the running server version or configuration.',
  ],
  examples: [
    'agentbrowser --json health',
    'agentbrowser --json session list',
    'agentbrowser describe session create',
    'agentbrowser describe plan --schema',
    '# Operator-authorized example: allow one lab host on a separate local service',
    'AGENTBROWSER_ALLOWED_CIDRS=192.168.1.89/32 HOST=127.0.0.1 PORT=5719 agentbrowser-server',
    'agentbrowser --base-url http://127.0.0.1:5719 --json health',
  ],
};

export const SESSION_CREATE_USAGE: UsageGuidance = {
  notes: [
    'The CLI returns a sessionId; create a page separately with page create SESSION --url URL. ' +
      'MCP browser_create instead returns both sessionId and an initial pageId. Never invent IDs.',
    INTERACTION_GUIDANCE.headedSession,
    'Cookie JSON must be an array, not an export wrapper. File formats are explicit; extensions do not select them. ' +
      'Use describe session cookies for format details and private export.',
    INTERACTION_GUIDANCE.networkPolicy,
    INTERACTION_GUIDANCE.livePush,
    'Authorized security testing: --scope-file pins the engagement (hosts, paths, methods, ' +
      'identity bindings, expiry, request budget) as the outermost restrict-only layer; denials ' +
      'carry SCOPE_* reasons and a spent budget stops all traffic. The .suffix host form covers ' +
      'subdomains only — list the apex explicitly.',
    'CDP attachment is a separate operator-configured lane, not a workaround for denied egress. ' +
      'Use a dedicated profile; --cdp-attach cannot be combined with launch or cookie settings.',
  ],
  examples: [
    'agentbrowser session create --tenant TENANT --no-headless --viewport 1440x1000 --ttl 14400000 --idle-timeout 3600000',
    'agentbrowser session create --tenant TENANT --no-headless --cookies-file /private/path/cookies.json --cookies-format json',
    'agentbrowser page create SESSION --url https://example.com',
    'agentbrowser snapshot SESSION PAGE --max-elements 40',
  ],
};

export const COOKIE_USAGE: UsageGuidance = {
  notes: [
    'Without --output this command prints credential values. --output creates a new 0600 JSON file ' +
      'and prints only its path/count; existing paths and symlink destinations are refused.',
    'Import with session create --cookies-file PATH --cookies-format FORMAT. JSON is a cookie array; ' +
      'Netscape uses exactly 7 tab-separated columns. chrome-devtools-tsv uses exactly 12 columns: ' +
      'Name, Value, Domain, Path, Expires, Size, HttpOnly, Secure, SameSite, Partition Key, ' +
      'Cross Site Ancestor, Priority. No header or extra trailing column; preserve blank cells.',
    'JSON expiry is future Unix seconds or -1. DevTools expiry accepts Unix seconds, UTC ISO ' +
      '(YYYY-MM-DDTHH:mm:ss[.sss]Z), or Session; Netscape 0 means session expiry. ' +
      'DevTools boolean cells are a checkmark (✓) or empty. Expired entries are rejected.',
    'Imports are limited to 1 MiB and 1000 cookies. Unsupported partition attributes are refused; ' +
      '--cookies-skip-unsupported omits whole partitioned records, never widens their scope. ' +
      'It does not skip expired or malformed entries. Export a fresh supported format rather than stripping attributes.',
    INTERACTION_GUIDANCE.headedSession,
  ],
  examples: [
    'agentbrowser session cookies SESSION --output /private/path/cookies.json',
    'agentbrowser session create --tenant TENANT --no-headless --cookies-file /private/path/cookies.json',
    'agentbrowser session create --tenant TENANT --cookies-file /private/path/cookies.tsv --cookies-format chrome-devtools-tsv',
  ],
};

export const NAVIGATION_USAGE: UsageGuidance = {
  notes: [
    INTERACTION_GUIDANCE.networkPolicy,
    INTERACTION_GUIDANCE.livePush,
    'Use --json and inspect stderr as well as the exit status for bounded failure details. ' +
      'Transport errors and timeouts do not establish a bot challenge or successful navigation.',
    'After navigation, take a new snapshot for current refs. Do not reuse refs from another page or revision.',
    INTERACTION_GUIDANCE.uncertainWrite,
  ],
  examples: [
    'agentbrowser --json navigate SESSION PAGE https://example.com',
    'agentbrowser snapshot SESSION PAGE --max-elements 40',
    'agentbrowser --json session operation SESSION OPERATION_ID',
  ],
};

export const PLAN_USAGE: UsageGuidance = {
  notes: [
    'Discover canonical input with describe plan --schema. The input is an array of act argument objects: ' +
      'use action and target: {ref}, not CLI positional arguments or CSS selectors. Get current refs from snapshot.',
    'Use @file or - (stdin) for private values; the JSON reader has a 1 MiB bound and 30-second input deadline. ' +
      'A failed report may contain partial effects. Inspect ok and every result; do not automatically retry.',
  ],
  examples: [
    'agentbrowser describe plan --schema',
    'agentbrowser --json plan SESSION PAGE @/private/path/steps.json',
    'agentbrowser --json plan SESSION PAGE - < /private/path/steps.json',
  ],
};

import { API_VERSION } from '@openanalytics/contracts'
import { GRANT_SCOPES, type GrantScope } from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import type { RequestContextVariables } from '@openanalytics/observability/hono'
import { Hono } from 'hono'
import { SITE_HEADER } from './read-key.ts'

/**
 * The MCP server (ADR-0043 D10; plan 04 §Milestone 16 item 3).
 *
 * **Plan item 3 — "typed tools use the same service, metric and cost-limit
 * layer" — is met structurally here, not asserted.** Every tool call is
 * translated into an ordinary `Request` against this same api's `/v1/read/*`
 * route and dispatched through it, carrying the caller's own `Authorization`
 * header. So the tool does not *resemble* the read path; it **is** the read
 * path:
 *
 * - the same `readAuth` resolves the credential and charges the same limiter
 *   under the same `oauth:<id>` key;
 * - the same `X-OA-Site` membership check runs, per request, against live
 *   membership;
 * - the same scope checks, the same billing gate, the same declared-range
 *   ceiling and the same `elapsed_ms` ledger apply;
 * - the same `AnalyticsService`, the same query gateway, the same `cache_epoch`
 *   and the same import pointer produce the numbers.
 *
 * The alternative — tools that call the service methods directly — would have
 * been a second path that *starts* identical and drifts the first time somebody
 * adds a middleware to one and not the other. A test drives a tool and the route
 * with one credential and compares the bodies; another spends the cost budget
 * through a tool and watches the route refuse. Neither would be possible to write
 * honestly against a parallel implementation.
 *
 * ## Why the protocol is hand-written
 *
 * `@modelcontextprotocol/sdk` is not a dependency of this repository, and the
 * part of MCP this server needs is three JSON-RPC methods over one POST —
 * `initialize`, `tools/list`, `tools/call`. That is framing, not cryptography.
 * It is the opposite of D9's reasoning about the authorization server, where the
 * parts worth not re-deriving were PKCE, code replay and token hashing; there is
 * no security-critical algorithm here, and adding a dependency to the api's
 * install path to avoid ~120 lines of dispatch would be the worse trade.
 *
 * ## Authentication
 *
 * An OAuth access token, and **it is verified here rather than only where a tool
 * dispatches**. The first version checked that an `Authorization` header was
 * merely *present* and left validation to the `/v1/read` route each tool calls —
 * so `initialize` and `tools/list` answered `200` to an expired or revoked
 * token, and the client learned nothing was wrong until every tool call failed.
 * Found by presenting a token that had just been withdrawn, during this
 * milestone's production proof.
 *
 * That is not a data leak — `tools/list` is a static catalogue — it is a
 * *protocol* defect, and the protocol is the point: RFC 9728's `401` plus
 * `WWW-Authenticate` is precisely the signal that makes a client re-authorize.
 * A `200` in its place is a client that never refreshes.
 *
 * **Private keys are not accepted here, deliberately.** This endpoint is an
 * OAuth 2.1 protected resource by definition; its metadata names an
 * authorization server, and `WWW-Authenticate` sends a caller there. A key
 * holder has `/v1/read` directly and needs no tool catalogue. Keeping the rule
 * "OAuth tokens only" means the pointer we hand out is always the right advice.
 */

type Env = { Variables: RequestContextVariables }

/**
 * The MCP revision this server implements.
 *
 * Echoed back on `initialize` rather than negotiated: a client asking for a
 * revision we do not speak is better told what we do speak than silently handed
 * a shape it will misread.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/**
 * MCP tool annotations (spec `2025-06-18`, ADR-0048 D3).
 *
 * A client like Claude or Cursor reads `readOnlyHint: false` and auto-prompts
 * the human for confirmation before the call — the behaviour Vercel's and
 * Stripe's MCP docs both push. They are hints the *client* acts on, never a
 * substitute for the server's own gate: the grant allowlist and the role check
 * refuse a write whatever a client does with the hint.
 */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
}

export interface McpToolDefinition {
  readonly name: string
  /**
   * Human-readable display name (MCP spec `2025-06-18`, `Tool.title`).
   * Directory reviews (Anthropic's connector directory, ChatGPT's app review)
   * require every tool to carry one; clients show it in consent prompts where
   * `create_site` reads worse than "Create Site".
   */
  readonly title: string
  readonly description: string
  /**
   * The `/v1` path this tool dispatches into. A read tool names a `/read/*`
   * path; a write tool names a business path with `{...}` tokens
   * (`/sites/{site_id}/funnels`) that are substituted from the arguments.
   */
  readonly path: string
  /** The HTTP method the tool dispatches with. Absent means `GET` — every read
   * tool, unchanged. */
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Query parameters the tool forwards, in the order they are documented. */
  readonly params: readonly {
    readonly name: string
    readonly description: string
    readonly required: boolean
  }[]
  /**
   * For a write tool, the JSON Schema of its request body. The model supplies
   * it under a `body` argument, which `buildToolRequest` sends as the request
   * body verbatim — the handler's own strict schema is the real validator, so
   * a body the handler rejects comes back as tool content the model reads.
   */
  readonly bodySchema?: Record<string, unknown>
  /**
   * Whether the tool needs a site selected via the `X-OA-Site` header (the read
   * arm). Write tools carry the site in a `{site_id}` path token instead, so
   * they leave this `false`.
   */
  readonly needsSite: boolean
  /** The scope the underlying route requires — for the tool's description only;
   * the route itself is what enforces it. */
  readonly scope: GrantScope
  /** Read-only unless stated. Read tools omit it and default to read-only. */
  readonly annotations?: McpToolAnnotations
}

/** The `{token}` path parameters a tool substitutes from its arguments. */
function pathTokens(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => match[1] as string)
}

/** A tool the assistant and any read-only consumer may show (ADR-0048 D3): the
 * read tools, which either say so or say nothing. */
export function isReadOnlyTool(tool: McpToolDefinition): boolean {
  return tool.annotations?.readOnlyHint !== false
}

/**
 * Read-only annotations, the default every existing tool carries.
 *
 * All three hints are spelled out rather than left to a client's defaults.
 * The spec says `destructiveHint` is only consulted when `readOnlyHint` is
 * false, but ChatGPT's app review scans for the annotation itself and marks a
 * tool that omits it as unannotated (2026-08-29), and a reviewer reading
 * hints should never have to infer one from the absence of another.
 */
const READ_ONLY: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
}

const RANGE_PARAMS = [
  { name: 'from', description: 'Range start, ISO-8601 UTC (inclusive).', required: true },
  { name: 'to', description: 'Range end, ISO-8601 UTC (exclusive).', required: true },
  {
    name: 'timezone',
    description:
      'Optional IANA timezone the days and weeks are cut on (for example Asia/Kolkata). ' +
      "Defaults to the site's own reporting timezone, which is the zone its owner reads " +
      'the dashboard in — send one only to answer a question about a different calendar. ' +
      'A UTC offset such as +05:30 is refused; the answer names the zone it used in ' +
      '`meta.timezone`.',
    required: false,
  },
] as const

const LIMIT_PARAM = {
  name: 'limit',
  description: 'How many rows to return. Defaults to the API default.',
  required: false,
} as const

/**
 * The session-scoped filter set (ADR-0075, D-F1).
 *
 * Declared here so a model can ask the question the dashboard can ask, and
 * declared with the GRAIN RULE IN ITS DESCRIPTION rather than a bare schema —
 * because the rule is the part a model gets wrong. "Filter to sessions from
 * google.com" and "filter to pageviews whose referrer was google.com" are
 * different questions with different answers, and only the first one is what
 * this parameter does. A model that assumes the second will misreport a
 * customer's channel as bouncing.
 *
 * The value is a JSON string rather than a structured argument because every
 * tool parameter here forwards into a query string; the api parses and refuses
 * it in exactly one place, so a bad dimension comes back as a named
 * `VALIDATION_FAILED` in the tool content — which is something a model can read
 * and correct, rather than an empty result it would report as "no traffic".
 */
const FILTERS_PARAM = {
  name: 'filters',
  description:
    'Optional session filter, as a JSON array of {dimension, operator, values}. ' +
    'Dimensions: referrer_domain, country, city, device_type. Operators: eq, in. ' +
    'Clauses combine with AND; values within one clause are OR. ' +
    'It selects SESSIONS whose ENTRY carried the value and then reports everything ' +
    'those sessions did — so a visit that arrived from youtube.com and read five ' +
    'pages contributes all five, not just the landing one. ' +
    'A filtered read covers at most 92 days and reads live data only. ' +
    'Example: [{"dimension":"country","operator":"in","values":["US","CA"]}]',
  required: false,
} as const

/**
 * Revenue's grain, and the one parameter no analytics row declares.
 *
 * The analytics reads have four resolutions and an automatic choice that is
 * almost always the right one; revenue has exactly **two** rollups (ADR-0033
 * D7), so "revenue per day last month" is a question a model can only ask by
 * naming the grain. A value the range cannot honestly serve comes back as
 * `RESOLUTION_NOT_AVAILABLE` in the tool content, which the model can act on.
 */
const REVENUE_RESOLUTION_PARAM = {
  name: 'resolution',
  description: 'Bucket grain: "hour" or "day". Omit to let the range choose.',
  required: false,
} as const

/**
 * A no-code rule's property extraction, as JSON Schema (ADR-0034 D8).
 *
 * Written out rather than left as a free-form object, because `source` is a
 * closed vocabulary and `argument` is conditional on it: a model that is shown
 * the eight sources and told which three take an argument writes a rule the
 * handler accepts, where one shown `{ "type": "object" }` writes
 * `{ "source": "innerText" }` and reads a validation error instead. The
 * conditional itself is not expressible here and is not restated — the domain
 * schema is the validator, and its message names the field.
 */
const RULE_PROPERTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'source'],
  properties: {
    key: {
      type: 'string',
      description:
        'The property name, which must also appear in property_schema. May not start with oa_.',
    },
    source: {
      type: 'string',
      enum: [
        'text',
        'element_tag',
        'page_path',
        'page_url',
        'page_title',
        'attribute',
        'url_param',
        'constant',
      ],
      description: 'Where the value is read from.',
    },
    argument: {
      type: 'string',
      description:
        'Required by attribute (the attribute name), url_param (the query key) and constant (the literal); rejected by the other five sources.',
    },
  },
} as const

/**
 * The versioned content of an event definition, shared by the two tools that
 * write one.
 *
 * `create_event_definition` sends this plus `event_name`;
 * `draft_event_version` sends exactly this, because a version is immutable and
 * complete and a partial update would make "what did v3 contain" a question you
 * answer by replaying v1 and v2 (ADR-0034 D3). One constant rather than two
 * literals, for the reason the tool table itself is a table: two copies of the
 * property allowlist is how one of them stops matching the handler.
 */
const EVENT_DEFINITION_CONTENT_PROPERTIES = {
  display_name: { type: 'string', description: 'Human label for the event.' },
  description: { type: ['string', 'null'] },
  category: { type: ['string', 'null'], description: 'Optional grouping label.' },
  property_schema: {
    type: 'array',
    description:
      'The property allowlist. A rule may only map to a key declared here; an ingested property this does not declare is dropped.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: { type: 'string' },
        type: { type: 'string', enum: ['string', 'number', 'boolean'] },
      },
    },
  },
  display_template: {
    type: ['string', 'null'],
    description:
      'A sentence with {{property}} placeholders, each naming a key declared in property_schema. Markup is refused.',
  },
  rules: {
    type: 'array',
    description:
      'What the tracker watches for. A click or submit rule carries a CSS selector; a url_pattern rule carries a url_pattern instead — never both.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['rule_id', 'trigger'],
      properties: {
        rule_id: {
          type: 'string',
          description:
            'A UUID, stable across versions: a rule edited in v2 keeps the id it had in v1. Reuse the existing id when editing a rule, mint a new one for a new rule.',
        },
        trigger: { type: 'string', enum: ['click', 'submit', 'url_pattern'] },
        selector: { type: 'string', description: 'CSS selector — click and submit only.' },
        url_pattern: { type: 'string', description: 'Path pattern — url_pattern trigger only.' },
        properties: { type: 'array', items: RULE_PROPERTY_SCHEMA },
      },
    },
  },
} as const

/**
 * The tools, as data.
 *
 * A table rather than a function per tool, because every one of them is the same
 * operation — forward these parameters to that path — and writing a handler per
 * row would be one opportunity per row for one of them to stop going through the
 * read route. The only thing that varies is what a model needs to be told, and
 * the argument gets stronger every time the table grows. How many rows there are
 * is deliberately not written here: the sentence that named a number went stale
 * inside one milestone and no test noticed. `tests/unit/mcp-write-tools.test.ts`
 * pins the roster as a literal list, which is the only place a count belongs.
 *
 * **Revenue's two aggregates are here since ADR-0049**, and they arrived the way
 * ADR-0046 D3 said they would have to: by a named one-decision ADR with a
 * privacy argument and a role story, not as two more entries somebody added
 * because the service method existed. What travels is `summary` and
 * `timeseries` — totals and buckets in the site's reporting currency, carrying
 * no per-customer dimension. What does not, and what ADR-0043 D15 still keeps
 * off this surface entirely, is `transactions` and its `journey`: an email, a
 * customer id, an order id. There is no row for them here because there is no
 * route for them there, which is the stronger of the two claims.
 *
 * The two revenue rows are safe to show every consumer of this table, including
 * an MCP host, and that is a property of the *route* rather than of the
 * catalogue: reaching it needs a credential carrying `revenue:read` **and** a
 * principal that resolves to an owner of the selected site (ADR-0043 D5's
 * intersection). Everyone the dashboard refuses is refused here, and the
 * refusal arrives as tool content the model has to read.
 *
 * Still deliberately **not** here: realtime. `/v1/read/realtime/token` mints a
 * *token*; a tool that hands a model a bearer credential is a category error
 * regardless of what the credential opens.
 */
const mcpTools: McpToolDefinition[] = [
  {
    name: 'list_sites',
    title: 'List Sites',
    description:
      'List the analytics sites this credential may read, with their slug, name, status and the caller’s role. Call this first: every other tool needs a site id from here.',
    path: '/read/sites',
    params: [],
    needsSite: false,
    scope: 'site:read',
  },
  {
    name: 'site_overview',
    title: 'Site Overview',
    description:
      'Totals for one site over a date range — events, pageviews, billable events, visitors — with data-freshness metadata.',
    path: '/read/analytics/overview',
    params: [...RANGE_PARAMS, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'site_timeseries',
    title: 'Site Timeseries',
    description: 'The same totals bucketed over time, for trends and comparisons.',
    path: '/read/analytics/timeseries',
    params: [...RANGE_PARAMS, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'top_pages',
    title: 'Top Pages',
    description: 'The most-viewed pages on one site over a range.',
    path: '/read/analytics/pages',
    params: [...RANGE_PARAMS, LIMIT_PARAM, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'top_sources',
    title: 'Top Sources',
    description: 'Where a site’s traffic came from — referrers and campaigns.',
    path: '/read/analytics/sources',
    params: [...RANGE_PARAMS, LIMIT_PARAM, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'geography',
    title: 'Geography',
    description: 'Visitors by country and city.',
    path: '/read/analytics/geography',
    params: [...RANGE_PARAMS, LIMIT_PARAM, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'devices',
    title: 'Devices',
    description: 'Visitors by device, browser and operating system.',
    path: '/read/analytics/devices',
    params: [...RANGE_PARAMS, LIMIT_PARAM, FILTERS_PARAM],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'sessions',
    title: 'Sessions',
    description:
      'Session counts and durations, with the finalizer watermark that says how much of the range can still be revised.',
    path: '/read/analytics/sessions',
    params: [...RANGE_PARAMS],
    needsSite: true,
    scope: 'analytics:read',
  },
  {
    name: 'revenue_summary',
    title: 'Revenue Summary',
    description:
      'Revenue totals for one site over a date range: gross charges, refunds, withdrawn and reinstated disputes, provider fees and net, plus charge, refund and dispute counts. Every amount is an integer in the minor unit of the site’s reporting currency (`totals.currency`) — 91000 in USD is $910.00, never divide before you have said which currency. Owner-only: any other role is refused with FORBIDDEN, which you must report rather than work around. Read `meta.revenue.connection_status` before calling a zero "no sales": `not_connected` means no payment provider was ever connected.',
    path: '/read/revenue/summary',
    params: [...RANGE_PARAMS, REVENUE_RESOLUTION_PARAM],
    needsSite: true,
    scope: 'revenue:read',
  },
  {
    name: 'revenue_timeseries',
    title: 'Revenue Timeseries',
    description:
      'The same revenue measures bucketed over time, one point per hour or per day, for trends. Same currency, minor-unit and owner-only rules as revenue_summary, and the same `meta.revenue.connection_status` caveat. It returns no customer, order or transaction identifiers; individual transactions are not readable from any tool.',
    path: '/read/revenue/timeseries',
    params: [...RANGE_PARAMS, REVENUE_RESOLUTION_PARAM],
    needsSite: true,
    scope: 'revenue:read',
  },

  // --- Account reads (ADR-0048 D3). These dispatch to the business subtree's
  // GET routes through the grant arm, not to `/read/*`, so their site id is a
  // path token, not the `X-OA-Site` header.
  {
    name: 'site_install',
    title: 'Install Snippet',
    description:
      'The tracking snippet and site key for one site — the public token that ships in page source. Read it to drop the tracker into a site’s HTML so it starts reporting. It is public by design; the private read key is never returned here.',
    path: '/read/site',
    params: [],
    needsSite: true,
    scope: 'site:read',
  },
  {
    name: 'team_members',
    title: 'Team Members',
    description:
      'The members of one site’s team — user id, role and email address. Needs the team:read scope, which is named on the consent screen because it carries emails.',
    path: '/sites/{site_id}/members',
    params: [],
    needsSite: false,
    scope: 'team:read',
  },
  {
    name: 'list_funnels',
    title: 'List Funnels',
    description:
      'The funnels defined on one site, for reading and analyzing their steps. Include archived ones with include_archived=true.',
    path: '/sites/{site_id}/funnels',
    params: [
      {
        name: 'include_archived',
        description: 'true to include archived funnels.',
        required: false,
      },
    ],
    needsSite: false,
    scope: 'analytics:read',
  },
  {
    name: 'list_event_definitions',
    title: 'List Event Definitions',
    description:
      'The dashboard-defined custom events on one site — each with its name, status and currently published version number. Read this before writing a definition: the version number is what publish and rollback need to state which change they expect to replace. Include archived ones with include_archived=true.',
    path: '/sites/{site_id}/event-definitions',
    params: [
      {
        name: 'include_archived',
        description: 'true to include archived definitions.',
        required: false,
      },
    ],
    needsSite: false,
    scope: 'analytics:read',
    annotations: READ_ONLY,
  },
  {
    name: 'list_widgets',
    title: 'List Widgets',
    description: 'The embeddable widgets configured on one site.',
    path: '/sites/{site_id}/widgets',
    params: [],
    needsSite: false,
    scope: 'analytics:read',
  },
  {
    name: 'share_settings',
    title: 'Share Settings',
    description:
      'One site’s public-dashboard settings: which surfaces are shared and the current public link.',
    path: '/sites/{site_id}/public-dashboard',
    params: [],
    needsSite: false,
    scope: 'analytics:read',
  },

  // --- Writes (ADR-0048 D3): narrow, additive, reversible. A client that is
  // not read-only prompts the human for confirmation before each of these.
  {
    name: 'create_site',
    title: 'Create Site',
    description:
      'Create a new analytics site. Returns its id and its tracking key, so the snippet can be installed in the same flow. There is deliberately no domain field: a new site accepts events from any origin until its owner sets an origin allowlist, and that allowlist is a dashboard-only setting, never writable over MCP. Rename or restyle later with update_site.',
    path: '/sites',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'sites:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'name'],
      properties: {
        slug: { type: 'string', description: 'URL-safe short id, unique to the account.' },
        name: { type: 'string', description: 'Human display name.' },
      },
    },
  },
  {
    name: 'update_site',
    title: 'Update Site',
    description:
      'Change a site’s name or reporting timezone. This tool cannot change the domain allowlist or any other setting — those are not writable over MCP.',
    path: '/sites/{site_id}',
    method: 'PATCH',
    params: [],
    needsSite: false,
    scope: 'sites:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        reporting_timezone: { type: 'string', description: 'An IANA timezone identifier.' },
      },
    },
  },
  {
    name: 'create_funnel',
    title: 'Create Funnel',
    description:
      'Create a funnel on one site from an ordered list of page-path or event-name steps.',
    path: '/sites/{site_id}/funnels',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'funnels:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'steps', 'window_ms'],
      properties: {
        name: { type: 'string' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered step keys — a page path or a custom event name.',
        },
        window_ms: { type: 'integer', description: 'Conversion window in milliseconds.' },
        scope: { type: 'string', enum: ['visitor', 'session'] },
      },
    },
  },
  {
    name: 'update_funnel',
    title: 'Update Funnel',
    description: 'Edit a funnel’s name, steps, scope or window.',
    path: '/sites/{site_id}/funnels/{funnel_id}',
    method: 'PATCH',
    params: [],
    needsSite: false,
    scope: 'funnels:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        steps: { type: 'array', items: { type: 'string' } },
        window_ms: { type: 'integer' },
        scope: { type: 'string', enum: ['visitor', 'session'] },
      },
    },
  },
  {
    name: 'archive_funnel',
    title: 'Archive Funnel',
    description: 'Archive a funnel. Reversible — an archived funnel is hidden, not deleted.',
    path: '/sites/{site_id}/funnels/{funnel_id}',
    method: 'DELETE',
    params: [],
    needsSite: false,
    scope: 'funnels:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  // Event definitions (ADR-0034; allowlist rows in `grant-arm.ts`). The four
  // that ADR-0048 D3 named: create, draft, publish, rollback. `DELETE` is
  // deliberately absent, because it has no allowlist row: archiving a
  // definition stops its rules being served site-wide.
  {
    name: 'create_event_definition',
    title: 'Create Event Definition',
    description:
      'Define a new custom event on one site, with its first version’s content. The definition starts unpublished: nothing reaches a visitor’s browser until publish_event_definition names a version. The event name is permanent — it is the key every chart and funnel will refer to.',
    path: '/sites/{site_id}/event-definitions',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'events:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['event_name', 'display_name'],
      properties: {
        event_name: {
          type: 'string',
          description:
            'The permanent event key: starts with a letter, then letters, digits, underscore, dot or hyphen. Unique on the site.',
        },
        ...EVENT_DEFINITION_CONTENT_PROPERTIES,
      },
    },
  },
  {
    name: 'draft_event_version',
    title: 'Draft Event Version',
    description:
      'Save a new draft version of an existing event definition. The whole content is restated, not patched — a version is immutable and complete. A draft is in nobody’s browser until it is published, so this is the safe half of editing an event.',
    path: '/sites/{site_id}/event-definitions/{definition_id}/versions',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'events:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['display_name'],
      properties: { ...EVENT_DEFINITION_CONTENT_PROPERTIES },
    },
  },
  {
    name: 'publish_event_definition',
    title: 'Publish Event Definition',
    description:
      'Make one version of an event definition live — from this call on, visitors’ browsers evaluate its rules. Reversible with rollback_event_definition, which is why publishing is on this surface at all. `expected_published_version` is not optional bookkeeping: state the version you read from list_event_definitions (or null if nothing is published yet), and a concurrent publish by someone else comes back as a conflict naming what is actually live instead of silently overwriting it.',
    path: '/sites/{site_id}/event-definitions/{definition_id}/publish',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'events:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'expected_published_version'],
      properties: {
        version: { type: 'integer', description: 'The version number to publish.' },
        expected_published_version: {
          type: ['integer', 'null'],
          description:
            'The version you believe is currently live, or null for "nothing is published yet". A mismatch is refused.',
        },
      },
    },
  },
  {
    name: 'rollback_event_definition',
    title: 'Rollback Event Definition',
    description:
      'Republish an older version’s content as a new version — the undo for publish_event_definition. It rewinds nothing: calling it twice produces two versions, and the response says which one is now live. Same `expected_published_version` rule as publishing.',
    path: '/sites/{site_id}/event-definitions/{definition_id}/rollback',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'events:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'expected_published_version'],
      properties: {
        version: { type: 'integer', description: 'The version whose content to republish.' },
        expected_published_version: {
          type: ['integer', 'null'],
          description: 'The version you believe is currently live, or null. A mismatch is refused.',
        },
      },
    },
  },

  {
    name: 'create_widget',
    title: 'Create Widget',
    description: 'Create an embeddable widget on one site.',
    path: '/sites/{site_id}/widgets',
    method: 'POST',
    params: [],
    needsSite: false,
    scope: 'widgets:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    bodySchema: {
      type: 'object',
      additionalProperties: true,
      description:
        'The widget configuration (surface, title, range and so on). See list_widgets for the shape a site already uses.',
    },
  },
  {
    name: 'update_widget',
    title: 'Update Widget',
    description:
      'Edit a widget, or enable/disable it. Disabling is the reversible way to take a widget down — there is no delete over MCP, because a widget id is never reissued.',
    path: '/sites/{site_id}/widgets/{widget_id}',
    method: 'PATCH',
    params: [],
    needsSite: false,
    scope: 'widgets:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bodySchema: {
      type: 'object',
      additionalProperties: true,
      description: 'The fields to change, e.g. { "enabled": false } to take a widget down.',
    },
  },
  {
    name: 'update_share_settings',
    title: 'Update Share Settings',
    description:
      'Change which surfaces a site’s public dashboard shows, and optionally rotate its public link. Rotating the link revokes the old one — the safe direction.',
    path: '/sites/{site_id}/public-dashboard',
    method: 'PUT',
    params: [],
    needsSite: false,
    scope: 'share:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    bodySchema: {
      type: 'object',
      additionalProperties: true,
      description:
        'The full set of share flags (an omitted surface is turned off), plus rotate_slug:true to rotate the link. See share_settings for the current state.',
    },
  },
]

/**
 * The tools this build serves.
 *
 * A live view of the table above rather than a frozen copy, because an optional
 * surface contributes tools for the routes it mounts (`registerMcpTools`): the
 * hosted deployment's `billing_usage` was declared inline here until the
 * open-core split, and a self-hosted build that advertised it would be offering
 * a model a plan and a usage window nothing in it computes.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = mcpTools

/**
 * Declares the tools an optional surface adds. Idempotent by name, so importing
 * the surface twice registers once; a name that is already taken is refused
 * rather than shadowed — two tools answering to one name would make which route
 * a model reached depend on import order.
 */
export function registerMcpTools(tools: readonly McpToolDefinition[]): void {
  for (const tool of tools) {
    const existing = mcpTools.find((candidate) => candidate.name === tool.name)
    if (existing === tool) continue
    if (existing) throw new Error(`an MCP tool named "${tool.name}" is already registered`)
    mcpTools.push(tool)
  }
}

/**
 * JSON Schema for a tool's arguments, derived from its table row.
 *
 * Exported since M17: the assistant shows the model the same schema this server
 * shows an MCP host (ADR-0046 D3). Two derivations of "what may this tool be
 * called with" would be two answers the day a parameter is added.
 */
export function inputSchema(tool: McpToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  // A `{site_id}` (or `{funnel_id}`, …) path token becomes a required string
  // argument, substituted into the path by `buildToolRequest`.
  for (const token of pathTokens(tool.path)) {
    properties[token] = {
      type: 'string',
      description:
        token === 'site_id' ? 'The site, as returned by list_sites.' : `The ${token} to act on.`,
    }
    required.push(token)
  }
  // The read arm carries the site in a header instead of the path.
  if (tool.needsSite) {
    properties['site_id'] = {
      type: 'string',
      description: 'The site to read, as returned by list_sites.',
    }
    required.push('site_id')
  }
  for (const param of tool.params) {
    properties[param.name] = { type: 'string', description: param.description }
    if (param.required) required.push(param.name)
  }
  if (tool.bodySchema !== undefined) {
    properties['body'] = tool.bodySchema
    required.push('body')
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * The arguments a tool row requires but the caller did not supply, as the
 * sentence to hand back — or null when nothing is missing.
 *
 * Shared with the assistant for the reason `buildToolRequest` is (ADR-0046 D3):
 * "what may this tool be called with" is a property of the row, and the two
 * consumers differ only in how they *deliver* the refusal — a JSON-RPC
 * `invalidParams` here, a `tool` message the model has to read there.
 */
export function toolArgumentRefusal(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
): string | null {
  for (const token of pathTokens(tool.path)) {
    if (typeof args[token] !== 'string' || (args[token] as string).length === 0) {
      return token === 'site_id'
        ? `${tool.name} requires site_id (see list_sites)`
        : `${tool.name} requires ${token}`
    }
  }
  if (tool.needsSite && typeof args['site_id'] !== 'string') {
    return `${tool.name} requires site_id (see list_sites)`
  }
  for (const param of tool.params) {
    if (param.required && typeof args[param.name] !== 'string') {
      return `${tool.name} requires ${param.name}`
    }
  }
  if (
    tool.bodySchema !== undefined &&
    (typeof args['body'] !== 'object' || args['body'] === null)
  ) {
    return `${tool.name} requires a body object`
  }
  return null
}

/**
 * Turn a tool row plus the model's arguments into a real `Request` against this
 * api's own `/v1/read/*` route.
 *
 * **One home, two consumers** (ADR-0046 D3). MCP copies the caller's
 * `Authorization`; the assistant copies the caller's `Cookie`. That single
 * header is the entire difference between them, and it is a parameter here
 * rather than a second function, because a copy of this logic is a second place
 * where a path could be named that the first one would never have named.
 *
 * What the built request carries is exactly three things: the caller's own
 * credential, the site selector, and `accept`. **There is no internal marker of
 * any kind** — no header, no flag saying "this request came from the
 * assistant". The moment a read path trusts something other than a real
 * credential, the tool loop stops being the route and starts being a bypass with
 * a header on it (ADR-0046 D4), and the one-row-in-the-ledger proof stops
 * meaning anything.
 */
export function buildToolRequest(input: {
  readonly tool: McpToolDefinition
  readonly args: Record<string, unknown>
  /** The api's own public origin — the URL the request is addressed to. */
  readonly resourceUrl: string
  /**
   * The site's own reporting timezone, for a ranged read whose caller named no
   * zone (ADR-0079 D5). Resolved by the surface, which is where a database and
   * a principal are; `undefined` falls back to `UTC`, which is what a caller
   * that cannot resolve one gets rather than a refusal.
   */
  readonly siteTimezone?: string
  /** The caller's credential, copied verbatim under the header it arrived on. */
  readonly credential: {
    readonly header: 'authorization' | 'cookie'
    readonly value: string
  }
  /** The caller's abort — a closed browser tab (ADR-0046 D10). */
  readonly signal?: AbortSignal
}): Request {
  const { tool, args } = input
  // Substitute `{token}` path parameters from the arguments. Each is
  // URL-encoded, so a value can never break out of its path segment.
  let path = tool.path
  for (const token of pathTokens(tool.path)) {
    const value = args[token]
    if (typeof value === 'string') {
      path = path.replace(`{${token}}`, encodeURIComponent(value))
    }
  }
  const url = new URL(`${input.resourceUrl}/${API_VERSION}${path}`)
  // Only what the row declares. The table is the allowlist, so an argument the
  // model invented is not forwarded rather than being refused.
  for (const param of tool.params) {
    const value = args[param.name]
    if (typeof value === 'string' && value.length > 0) url.searchParams.set(param.name, value)
  }
  // Every ranged read names a zone, because the read route requires one. The
  // model's own `timezone` argument is already on the URL if it sent one — it is
  // a declared parameter like any other — and what fills the gap otherwise is
  // **the site's** reporting timezone (ADR-0079 D5): the calendar its owner
  // reads the dashboard on, so "last week" means to a model what it means to
  // them. `UTC` remains the floor for a caller that could not resolve one, which
  // is a defined zone rather than one invented from a token.
  if (tool.params.some((param) => param.name === 'from') && !url.searchParams.has('timezone')) {
    url.searchParams.set('timezone', input.siteTimezone ?? 'UTC')
  }

  const headers = new Headers({ accept: 'application/json' })
  headers.set(input.credential.header, input.credential.value)
  // The read arm carries the site in a header; a path-templated write tool
  // carries it in the path, so the header is only set when the row uses it.
  const siteId = args['site_id']
  if (tool.needsSite && typeof siteId === 'string') headers.set(SITE_HEADER, siteId)

  // A write tool sends its declared `body` argument as the request body. The
  // handler's own strict schema validates it — this forwards it verbatim, the
  // same way the read tools forward query params verbatim.
  const method = tool.method ?? 'GET'
  let body: string | undefined
  if (tool.bodySchema !== undefined && typeof args['body'] === 'object' && args['body'] !== null) {
    body = JSON.stringify(args['body'])
    headers.set('content-type', 'application/json')
  }

  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}

interface JsonRpcRequest {
  readonly jsonrpc?: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, unknown>
}

/** JSON-RPC 2.0's reserved codes, plus nothing of our own. */
const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const

export interface McpRoutesDeps {
  /**
   * Dispatches a `Request` into this same api.
   *
   * The whole of plan item 3: a tool call becomes a real request against the
   * real `/v1/read` route, through every middleware that route carries. Injected
   * rather than imported so `app.ts` can hand over the assembled app without a
   * cycle.
   */
  readonly dispatch: (request: Request) => Promise<Response>
  /** The api's own public origin, for building the internal request's URL and
   * the RFC 9728 metadata. */
  readonly resourceUrl: string
  /** The authorization server's issuer — Better Auth's base. */
  readonly authorizationServer: string
  /**
   * Resolves a bearer to a live OAuth grant, or nothing.
   *
   * The *same* repository function the read arm's resolver uses, injected rather
   * than imported so this file keeps no database of its own. Sharing it is what
   * stops "is this token valid" from having two answers.
   */
  readonly verifyBearer: (token: string) => Promise<{ userId: string } | null>
  /**
   * The reporting timezone of a site **this caller is a member of**, or null.
   *
   * Injected for the same reason `verifyBearer` is: this file keeps no database.
   * Membership-scoped rather than by id alone, so answering "which calendar does
   * this tool read on" cannot become a way to ask about a site the caller may
   * not read (ADR-0079 D5).
   */
  readonly siteTimezone: (params: { siteId: string; userId: string }) => Promise<string | null>
  readonly logger?: Logger
}

export function createMcpRoutes(deps: McpRoutesDeps): Hono<Env> {
  const app = new Hono<Env>()

  /**
   * RFC 9728 protected-resource metadata, **at the resource's root**.
   *
   * Better Auth's `mcp` plugin serves this too, but under `/api/auth`, and RFC
   * 9728 §3 says a client discovers it at `/.well-known/oauth-protected-resource`
   * on the resource server's own origin. A client that has only our `/mcp` URL
   * looks there and nowhere else.
   */
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: deps.resourceUrl,
      authorization_servers: [deps.authorizationServer],
      // The product grant vocabulary plus OAuth's refresh scope. MCP clients
      // build their authorization request from this document; omitting
      // `offline_access` means the authorization server issues a refresh token
      // that its own token endpoint then refuses to use.
      scopes_supported: [...GRANT_SCOPES, 'offline_access'],
      bearer_methods_supported: ['header'],
    }),
  )

  /**
   * RFC 8414 authorization-server metadata, at the origin's root (ADR-0047 D7).
   *
   * The issuer is `<origin>/api/auth`, so RFC 8414 §3.1's well-known URL is the
   * *path-insertion* spelling — `/.well-known/oauth-authorization-server/api/auth`
   * — while many OAuth clients (MCP hosts among them) also try the bare root
   * document. Both answer here, and neither is a second authorship: the request
   * is forwarded through `dispatch` to Better Auth's own document, which
   * carries the ADR-0047 overrides (`registration_endpoint`, the full scope
   * list). An alias that re-stated the JSON would age the first time the
   * plugin's document moved.
   */
  const forwardAuthorizationServerMetadata = async (): Promise<Response> => {
    const response = await deps.dispatch(
      new Request(`${deps.authorizationServer}/.well-known/oauth-authorization-server`),
    )
    // Re-wrapped rather than returned as-is: the inner response is the
    // dispatched app's, and returning it directly would carry that route's
    // context headers into this one.
    return new Response(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  app.get('/.well-known/oauth-authorization-server', forwardAuthorizationServerMetadata)
  app.get('/.well-known/oauth-authorization-server/api/auth', forwardAuthorizationServerMetadata)

  /**
   * `401` with the pointer RFC 9728 §5.1 requires.
   *
   * The header goes on **this** `Response`, not through `c.header()`. Hono's
   * context headers are applied to responses Hono builds; a handler that returns
   * its own `Response` gets exactly the headers it names, and the first version
   * of this set the header on the context and returned a fresh `Response` — so
   * the one thing that lets an MCP host start an authorization flow silently did
   * not travel. Caught by the test that reads the header back.
   */
  const unauthorized = (): Response =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC.invalidRequest, message: 'Authentication required' },
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${deps.resourceUrl}/.well-known/oauth-protected-resource"`,
        },
      },
    )

  // The transport is POST-only (no SSE stream, no sessions), which streamable
  // HTTP permits; what it does not permit is a `404` for the other verbs on a
  // URL that plainly exists. `405` plus `Allow` tells a probing client "right
  // door, wrong verb" instead of "no such door". `GET` is the optional
  // server-to-client stream, `DELETE` the optional session teardown; refusing
  // both is within spec.
  app.on(
    ['GET', 'DELETE'],
    '/mcp',
    () => new Response(null, { status: 405, headers: { Allow: 'POST' } }),
  )

  app.post('/mcp', async (c) => {
    const authorization = c.req.header('authorization')
    if (!authorization) return unauthorized()

    // Verified before any method is answered — including `initialize` and
    // `tools/list`, which is where the first version let a dead token through.
    const bearer = /^Bearer (.+)$/iu.exec(authorization.trim())?.[1]
    const principal = bearer ? await deps.verifyBearer(bearer) : null
    if (!principal) return unauthorized()

    let body: JsonRpcRequest
    try {
      body = (await c.req.json()) as JsonRpcRequest
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.parseError, message: 'Invalid JSON' } },
        400,
      )
    }

    const id = body.id ?? null
    const reply = (result: unknown): Response => c.json({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string): Response =>
      c.json({ jsonrpc: '2.0', id, error: { code, message } }, 200)

    switch (body.method) {
      case 'initialize':
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'openanalytics', version: API_VERSION },
        })

      case 'notifications/initialized':
        // A notification carries no id and expects no result. Answering `204`
        // rather than a JSON-RPC envelope, because an envelope with a null id is
        // a response to nothing.
        return new Response(null, { status: 204 })

      case 'ping':
        return reply({})

      case 'tools/list':
        return reply({
          tools: MCP_TOOLS.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: inputSchema(tool),
            // A client reads the hints to decide whether to prompt for
            // confirmation (ADR-0048 D3). Read tools carry no `annotations`
            // field and default to read-only here. `openWorldHint` is stamped
            // in one place because it is uniformly false: every tool
            // dispatches into this same api, a closed system, and no tool
            // reaches the open internet.
            annotations: { openWorldHint: false, ...(tool.annotations ?? READ_ONLY) },
          })),
        })

      case 'tools/call': {
        const name = body.params?.['name']
        const args = (body.params?.['arguments'] ?? {}) as Record<string, unknown>
        const tool = MCP_TOOLS.find((candidate) => candidate.name === name)
        if (!tool) return fail(JSON_RPC.invalidParams, `No such tool: ${String(name)}`)

        const refusal = toolArgumentRefusal(tool, args)
        if (refusal !== null) return fail(JSON_RPC.invalidParams, refusal)

        // The site's own clock, for a ranged tool whose caller named no zone
        // (ADR-0079 D5). Read here rather than inside the builder because this
        // is where a principal and a database are, and only for the tools that
        // can use it — a listing takes no range and asks nothing.
        //
        // **Best-effort, and it has to be.** This resolves a presentational
        // *default*; the read itself is fine without it, because `UTC` is a
        // defined answer. A database hiccup here must therefore cost a caller
        // the site's calendar and nothing else — turning a working analytics
        // read into a 500 for the sake of a default would be a worse failure
        // than the one it reports.
        const siteId = args['site_id']
        let siteTimezone: string | null = null
        if (tool.params.some((param) => param.name === 'timezone') && typeof siteId === 'string') {
          try {
            siteTimezone = await deps.siteTimezone({ siteId, userId: principal.userId })
          } catch (err) {
            deps.logger?.warn('mcp_site_timezone_unresolved', { tool: tool.name, err })
          }
        }

        // **This is plan item 3.** Not a service call that resembles the route's
        // — the route itself, with its auth, its limiter, its membership check,
        // its scope check, its billing gate and its cost ledger. The `Request`
        // is built by the shared builder the assistant also uses (ADR-0046 D3),
        // so the two consumers cannot drift.
        const response = await deps.dispatch(
          buildToolRequest({
            tool,
            args,
            resourceUrl: deps.resourceUrl,
            credential: { header: 'authorization', value: authorization },
            ...(siteTimezone === null ? {} : { siteTimezone }),
          }),
        )
        const text = await response.text()

        deps.logger?.info('mcp_tool_called', { tool: tool.name, status: response.status })

        // A refusal comes back as tool content with `isError`, not as a
        // JSON-RPC error: the model has to *read* it — "you are not an owner of
        // this site", "narrow the range" — and a transport-level error would be
        // swallowed by the host before it ever reached the conversation.
        return reply({
          content: [{ type: 'text', text }],
          isError: !response.ok,
        })
      }

      default:
        return fail(JSON_RPC.methodNotFound, `Unsupported method: ${String(body.method)}`)
    }
  })

  return app
}

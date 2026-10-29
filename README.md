# @pipeworx/apollo

Company and people data from Apollo.io: organization search and enrichment,
people search and enrichment, and a company's current job postings. Bring
your own Apollo API key — every call runs on your own Apollo account and its
own credit balance.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `apollo_search_organizations(...)` — search companies by industry, headcount,
  HQ location, technologies in use, and funding history/size.
- `apollo_enrich_organization(...)` — enrich one company by domain, website,
  or LinkedIn URL: industry, headcount, revenue, funding rounds, technologies.
- `apollo_search_people(...)` — search people by job title, seniority, and
  employer domain/org id. Returns an obfuscated last name and never an email
  or phone — pair with `apollo_enrich_person` to resolve a real contact.
- `apollo_enrich_person(...)` — enrich one specific person by email,
  LinkedIn URL, or name+domain/organization: title, seniority, department,
  employer, and (if your account has unlocked it) a work email.
- `apollo_org_job_postings(...)` — a company's current job postings (title,
  location, posted/last-seen dates), given an Apollo `organization_id`.

## Auth

BYO only. Every tool requires `_apiKey` — your own Apollo API key, from the
Apollo app under **Settings → Integrations → API** (see
https://docs.apollo.io/docs/create-api-key). Pipeworx holds no Apollo key and
never substitutes one: with no `_apiKey`, every tool refuses before making any
network call, and the refusal names the argument and the key page.

A scoped key needs that specific endpoint enabled (Apollo lets you scope a key
per endpoint); a master key works for all five. Apollo documents a limit of
600 calls/hour per endpoint.

## Credit costs (Apollo's own, charged to your account)

- `apollo_search_organizations` — 1 credit per page (up to 100 results/page).
- `apollo_enrich_organization` — 1 credit per organization enriched.
- `apollo_search_people` — 0 credits (this endpoint never returns email/phone).
- `apollo_enrich_person` — 1 credit if email/demographic data is found, +8 more
  only for a mobile phone (not requested by this pack), 0 if nothing matches.
- `apollo_org_job_postings` — 1 credit per page, up to 10,000 postings total.

Pipeworx never marks these up or resells them — they are Apollo's own usage,
billed by Apollo to your account. Pipeworx's own per-call charge is separate
and unrelated to Apollo's credit cost.

## Data sources

- Apollo.io — company and contact database (organizations, people, job
  postings) that your own Apollo account already has access to.

## Known gaps and gotchas

- **`apollo_search_people` never returns an email or phone.** Apollo
  deliberately keeps this endpoint credit-free by never including them —
  you get a first name, an obfuscated last name, and booleans like
  `has_email`. Call `apollo_enrich_person` on a result to try to resolve a
  real contact.
- **A matched-but-locked email comes back from Apollo as the literal string
  `email_not_unlocked@<domain>`**, HTTP 200 — not null, not an error. This
  pack treats that placeholder as a miss: `apollo_enrich_person` maps it to
  `email: null, email_locked: true` rather than ever returning the placeholder
  text itself. Unlocking it costs your own Apollo credits/plan tier; this pack
  cannot change that.
- **No phone-number reveal.** Apollo's `reveal_phone_number` is asynchronous —
  it delivers the number later to a `webhook_url` rather than in the response —
  which has no honest mapping onto a single stateless tool call. This pack
  does not implement it; use Apollo's own dashboard/API directly for that leg.
- **No sequences, no contact/list creation, no email sending.** Apollo's API
  supports all three; this pack implements none of them by design (D3 in
  docs/gtm-wave-2026-10-08.md).
- **No platform key, ever.** This is a BYOK-only pack by design (D4): Apollo is
  a person-data vendor, and D4 bars adding a new platform-keyed one. Do not add
  `platformKeyEnv` to this pack's gateway manifest entry.
- **No baked enum data.** Apollo's industry tag ids and 1,500+ technology UIDs
  are both open-ended lists maintained by Apollo, not enumerated here — they
  are plain `string`/`string[]` fields. Look up exact values in the Apollo UI's
  own filters.
- Also usable as a vendor leg (`_apolloKey`) in `enrich_find_email`
  (`@pipeworx/enrich-waterfall`), alongside its other email-finder vendors.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "apollo": {
      "url": "https://gateway.pipeworx.io/apollo/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/apollo/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

This pack takes your own API key (`_apiKey`) — we don't front one for it, so there's no curl here that would run without it. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/apollo_search_organizations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-apollo` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/apollo/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "apollo": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-apollo"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Apollo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

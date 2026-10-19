interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * Apollo.io MCP — company and people data via api.apollo.io, the caller's OWN
 * Apollo account (fleet #3084, GTM wave: docs/gtm-wave-2026-10-08.md D4).
 *
 * BYOK ONLY. Pipeworx holds no Apollo key and never will for this pack — D4
 * bars a new platform-keyed person-data vendor. Every tool requires `_apiKey`,
 * the caller's own Apollo API key (Settings -> Integrations -> API in the
 * Apollo app; see https://docs.apollo.io/docs/create-api-key). With no key,
 * every tool throws before any network call, and the message SAYS "requires
 * an API key" (D4, and the fleet's gated-refusal wording convention).
 *
 * Scope, per the brief:
 *   - Read-only: organization search, organization enrich, people search,
 *     person enrich, organization job postings.
 *   - NO sequences, NO contact/list creation, NO email sending (D3) — Apollo's
 *     API supports all three and this pack deliberately implements none of
 *     them.
 *   - Person-enrich phone reveal is likewise NOT implemented: Apollo's
 *     `reveal_phone_number` is asynchronous (it POSTs the number to a
 *     `webhook_url` later rather than returning it in this response), which
 *     has no honest synchronous mapping for a stateless gateway tool call. A
 *     caller who needs a phone number should use Apollo's own API/dashboard
 *     directly for that leg.
 *   - People-data fields returned here are the caller's own Apollo contact
 *     data, already covered by their Apollo licence — Pipeworx stores and
 *     caches nothing beyond the gateway default.
 *
 * CREDIT COSTS quoted in each tool's description are APOLLO's own, charged to
 * the caller's Apollo account — never a Pipeworx cost. Pipeworx charges its
 * normal per-call credit (see `meter` below) for routing the request; it does
 * not mark up or resell Apollo's own usage.
 *
 * NO BAKED ENUM DATA. Apollo's industry tag ids and the 1,500+ technology
 * UIDs are both open-ended, vendor-maintained lists with no static JSON
 * Schema `enum` here — baking either in would cost real bundle size for a
 * value the gateway's binding/size budget can't spare (docs/gateway-text-binding-limit.md).
 * These are plain `string`/`string[]` fields; look the exact values up in
 * Apollo's own UI or docs.
 *
 * UNPROVEN LIVE: built and committed with NO Apollo API key available to this
 * builder. The refusal path (no key -> throw) is proven live. Every other
 * code path — request building and response mapping — is unit-tested in
 * `src/__tests__/apollo.test.ts` against Apollo's DOCUMENTED request/response
 * shapes (docs.apollo.io/reference/*, fetched 2026-10-14), not against a real
 * call. Flag this when reviewing: a documented shape can still drift from the
 * live one.
 */


const UA = 'pipeworx-mcp-apollo/1.0 (+https://pipeworx.io)';
const BASE_URL = 'https://api.apollo.io/api/v1';
const APOLLO_NAME = 'Apollo';
const API_KEY_HELP = 'https://docs.apollo.io/docs/create-api-key (Apollo app: Settings -> Integrations -> API)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, APOLLO_NAME);
}

// ── shared BYOK plumbing ──────────────────────────────────────────────────

/** Every tool calls this FIRST, before any network access. Throws a message
 *  that SAYS "requires an API key" (D4 / gated-refusal convention), names
 *  the arg, and points at Apollo's own key page. Never silently substitutes
 *  anything — there is no platform key for this pack, by design. */
export function requireApiKey(tool: string, args: Record<string, unknown>): string {
  const key = args._apiKey;
  delete (args as Record<string, unknown>)._apiKey;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(
      `Apollo ${tool} requires an API key. Pass it via _apiKey — your own Apollo account's key, ` +
        `from ${API_KEY_HELP}. Pipeworx never substitutes a platform key for this pack — none exists.`,
    );
  }
  return key.trim();
}

function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
}

/** Apollo's error body is inconsistent across endpoints: sometimes a bare
 *  `{"error": "message"}`, sometimes `{"error": {"message": "..."}}` or a
 *  rails-style `{"errors": ["..."]}`. Pull whichever is there rather than
 *  betting on one shape. */
export function apolloErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const err = b.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }
  if (Array.isArray(b.errors) && b.errors.length) {
    return b.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
  }
  const msg = b.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  return null;
}

export function apolloHttpError(tool: string, status: number, detail: string | null): Error {
  const where = detail ? ` — ${detail}` : '';
  // Apollo answers 403 for endpoints outside the caller's PLAN with a body like
  // "The api/v1/people/match API is not included in your Free plan". The key is
  // valid; the plan is the limit, so say that rather than "auth failed".
  if (status === 403 && detail && /not included in your .* plan/i.test(detail)) {
    return new Error(
      `Apollo ${tool}: this endpoint requires a paid Apollo plan (HTTP 403) — ${detail}. Your key is valid; ` +
        'Apollo\'s free plan only covers apollo_enrich_organization and apollo_org_job_postings.',
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      `Apollo ${tool}: auth failed (HTTP ${status})${where}. Check your _apiKey is valid and has access to ` +
        `this endpoint (a scoped key needs this specific endpoint enabled, or use a master key). ${API_KEY_HELP}`,
    );
  }
  if (status === 422) {
    return new Error(`Apollo ${tool}: Apollo rejected the request parameters (HTTP 422)${where}.`);
  }
  if (status === 429) {
    return new Error(
      `Apollo ${tool}: rate-limited by Apollo (HTTP 429)${where}. Apollo documents a limit of 600 calls/hour ` +
        'per endpoint for this API — slow down or wait before retrying.',
    );
  }
  return new Error(`Apollo ${tool}: HTTP ${status}${where}`);
}

async function apolloRequest(tool: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await pwFetch(url, init);
  } catch (e) {
    // fetchWithTimeout/parseJson can throw a message carrying a routing token
    // (e.g. `upstream_down:`) at position 0 — hoist it ahead of our own
    // preamble instead of letting the wrap push it off position 0.
    const { token, body } = splitClassPrefix((e as Error).message);
    throw new Error(`${token}Apollo ${tool}: network error reaching api.apollo.io — ${body}`);
  }
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body = (await res.clone().json()) as unknown;
      detail = apolloErrorDetail(body);
    } catch {
      // body wasn't JSON (or was empty) — fall through to httpError's own
      // best-effort text read, which degrades gracefully on that too.
    }
    if (detail) throw apolloHttpError(tool, res.status, detail);
    throw await httpError(res, `Apollo ${tool}`);
  }
  return parseJson<Record<string, unknown>>(res, `Apollo ${tool}`);
}

// ── small shape helpers used by every mapper ───────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strArr = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function appendArrayParams(params: URLSearchParams, key: string, values: unknown): void {
  for (const v of strArr(values)) params.append(key, v);
}

// ════════════════════════════════════════════════════════════════════════
// apollo_search_organizations — POST /mixed_companies/search
// ════════════════════════════════════════════════════════════════════════

export function buildOrgSearchParams(args: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  if (str(args.q_organization_name)) p.set('q_organization_name', str(args.q_organization_name) as string);
  appendArrayParams(p, 'q_organization_domains_list[]', args.domains);
  appendArrayParams(p, 'organization_industries[]', args.industries);
  appendArrayParams(p, 'organization_industry_tag_ids[]', args.industry_tag_ids);
  appendArrayParams(p, 'organization_num_employees_ranges[]', args.employee_ranges);
  appendArrayParams(p, 'organization_locations[]', args.locations);
  appendArrayParams(p, 'organization_not_locations[]', args.exclude_locations);
  appendArrayParams(p, 'currently_using_any_of_technology_uids[]', args.technologies);
  appendArrayParams(p, 'q_organization_keyword_tags[]', args.keyword_tags);
  if (num(args.revenue_min) !== null) p.set('revenue_range[min]', String(args.revenue_min));
  if (num(args.revenue_max) !== null) p.set('revenue_range[max]', String(args.revenue_max));
  if (num(args.total_funding_min) !== null) p.set('total_funding_range[min]', String(args.total_funding_min));
  if (num(args.total_funding_max) !== null) p.set('total_funding_range[max]', String(args.total_funding_max));
  if (str(args.latest_funding_date_min)) p.set('latest_funding_date_range[min]', str(args.latest_funding_date_min) as string);
  if (str(args.latest_funding_date_max)) p.set('latest_funding_date_range[max]', str(args.latest_funding_date_max) as string);
  p.set('page', String(num(args.page) ?? 1));
  p.set('per_page', String(Math.min(num(args.per_page) ?? 10, 100)));
  return p;
}

interface MappedOrgSummary {
  id: string | null;
  name: string | null;
  website_url: string | null;
  primary_domain: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  founded_year: number | null;
  naics_codes: string[];
  sic_codes: string[];
  raw: unknown;
}

export function mapOrgSearchOrg(org: unknown): MappedOrgSummary {
  const o = (org ?? {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    name: str(o.name),
    website_url: str(o.website_url),
    primary_domain: str(o.primary_domain),
    linkedin_url: str(o.linkedin_url),
    twitter_url: str(o.twitter_url),
    facebook_url: str(o.facebook_url),
    founded_year: num(o.founded_year),
    naics_codes: strArr(o.naics_codes),
    sic_codes: strArr(o.sic_codes),
    raw: org,
  };
}

export function mapOrgSearchResponse(raw: Record<string, unknown>) {
  const pagination = (raw.pagination ?? {}) as Record<string, unknown>;
  return {
    organizations: arr(raw.organizations).map(mapOrgSearchOrg),
    pagination: {
      page: num(pagination.page),
      per_page: num(pagination.per_page),
      total_entries: num(pagination.total_entries),
      total_pages: num(pagination.total_pages),
    },
    partial_results_only: bool(raw.partial_results_only),
  };
}

async function searchOrganizations(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireApiKey('apollo_search_organizations', args);
  const params = buildOrgSearchParams(args);
  const body: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    body[key] = key.endsWith('[]') ? values : values[0];
  }
  const raw = await apolloRequest('apollo_search_organizations', `${BASE_URL}/mixed_companies/search`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return mapOrgSearchResponse(raw);
}

// ════════════════════════════════════════════════════════════════════════
// apollo_enrich_organization — GET /organizations/enrich
// ════════════════════════════════════════════════════════════════════════

export function mapOrgEnrichResponse(raw: Record<string, unknown>) {
  if (!raw.organization) return { found: false, organization: null };
  const o = raw.organization as Record<string, unknown>;
  return {
    found: true,
    organization: {
      id: str(o.id),
      name: str(o.name),
      website_url: str(o.website_url),
      primary_domain: str(o.primary_domain),
      linkedin_url: str(o.linkedin_url),
      industry: str(o.industry),
      industries: strArr(o.industries),
      estimated_num_employees: num(o.estimated_num_employees),
      founded_year: num(o.founded_year),
      annual_revenue: num(o.annual_revenue),
      annual_revenue_printed: str(o.annual_revenue_printed),
      total_funding: num(o.total_funding),
      total_funding_printed: str(o.total_funding_printed),
      latest_funding_stage: str(o.latest_funding_stage),
      latest_funding_round_date: str(o.latest_funding_round_date),
      technology_names: strArr(o.technology_names),
      city: str(o.city),
      state: str(o.state),
      country: str(o.country),
      raw: o,
    },
  };
}

async function enrichOrganization(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireApiKey('apollo_enrich_organization', args);
  const domain = str(args.domain);
  const website = str(args.website);
  const linkedinUrl = str(args.linkedin_url);
  if (!domain && !website && !linkedinUrl) {
    throw new Error(
      'Apollo apollo_enrich_organization requires at least one of `domain`, `website`, or `linkedin_url` ' +
        '(`name` alone cannot resolve a match).',
    );
  }
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (website) params.set('website', website);
  if (linkedinUrl) params.set('linkedin_url', linkedinUrl);
  if (str(args.name)) params.set('name', str(args.name) as string);

  const raw = await apolloRequest('apollo_enrich_organization', `${BASE_URL}/organizations/enrich?${params}`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  return mapOrgEnrichResponse(raw);
}

// ════════════════════════════════════════════════════════════════════════
// apollo_search_people — POST /mixed_people/api_search (0 Apollo credits;
// does NOT return email/phone — use apollo_enrich_person for that)
// ════════════════════════════════════════════════════════════════════════

export function buildPeopleSearchParams(args: Record<string, unknown>): URLSearchParams {
  const p = new URLSearchParams();
  appendArrayParams(p, 'person_titles[]', args.titles);
  appendArrayParams(p, 'person_seniorities[]', args.seniorities);
  appendArrayParams(p, 'person_locations[]', args.person_locations);
  appendArrayParams(p, 'organization_ids[]', args.organization_ids);
  appendArrayParams(p, 'q_organization_domains_list[]', args.domains);
  appendArrayParams(p, 'organization_locations[]', args.organization_locations);
  if (str(args.q_keywords)) p.set('q_keywords', str(args.q_keywords) as string);
  if (str(args.q_person_name)) p.set('q_person_name', str(args.q_person_name) as string);
  p.set('page', String(num(args.page) ?? 1));
  p.set('per_page', String(Math.min(num(args.per_page) ?? 10, 100)));
  return p;
}

export function mapPeopleSearchResponse(raw: Record<string, unknown>) {
  const people = arr(raw.people).map((p) => {
    const person = (p ?? {}) as Record<string, unknown>;
    const org = (person.organization ?? {}) as Record<string, unknown>;
    return {
      id: str(person.id),
      first_name: str(person.first_name),
      last_name_obfuscated: str(person.last_name_obfuscated),
      title: str(person.title),
      organization_name: str(org.name),
      has_email: bool(person.has_email),
      has_direct_phone: person.has_direct_phone ?? null,
      raw: person,
    };
  });
  return {
    total_entries: num(raw.total_entries),
    people,
    note:
      'This endpoint returns an obfuscated last name and never an email or phone number (Apollo documents it as ' +
      '0-credit for exactly that reason). Call apollo_enrich_person with the full name + domain, or linkedin_url, ' +
      'to resolve a real contact.',
  };
}

async function searchPeople(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireApiKey('apollo_search_people', args);
  const params = buildPeopleSearchParams(args);
  const body: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    body[key] = key.endsWith('[]') ? values : values[0];
  }
  const raw = await apolloRequest('apollo_search_people', `${BASE_URL}/mixed_people/api_search`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return mapPeopleSearchResponse(raw);
}

// ════════════════════════════════════════════════════════════════════════
// apollo_enrich_person — POST /people/match
// ════════════════════════════════════════════════════════════════════════

/** Apollo's documented footgun: an email the account hasn't "unlocked" comes
 *  back as the literal placeholder string "email_not_unlocked@<domain>",
 *  HTTP 200, not null and not an error. Treating that string as a real
 *  address is the single most common integration bug reported against this
 *  endpoint (Apollo/Clay/n8n community threads, 2026). Match on the fixed
 *  substring rather than the whole string, since the domain half varies. */
export function isUnlockedEmailPlaceholder(email: string | null): boolean {
  return Boolean(email && email.includes('email_not_unlocked@'));
}

export function mapPersonEnrichResponse(raw: Record<string, unknown>) {
  const person = raw.person as Record<string, unknown> | null | undefined;
  if (!person) {
    return { found: false, person: null, match_confidence: null };
  }
  const org = (person.organization ?? {}) as Record<string, unknown>;
  const rawEmail = str(person.email);
  const emailLocked = isUnlockedEmailPlaceholder(rawEmail);
  return {
    found: true,
    match_confidence: str(person.match_confidence),
    person: {
      id: str(person.id),
      name: str(person.name),
      first_name: str(person.first_name),
      last_name: str(person.last_name),
      title: str(person.title),
      headline: str(person.headline),
      email: emailLocked ? null : rawEmail,
      email_locked: emailLocked,
      email_status: str(person.email_status),
      linkedin_url: str(person.linkedin_url),
      city: str(person.city),
      state: str(person.state),
      country: str(person.country),
      seniority: str(person.seniority),
      departments: strArr(person.departments),
      functions: strArr(person.functions),
      organization: {
        id: str(org.id),
        name: str(org.name),
        website_url: str(org.website_url),
        industry: str(org.industry),
        estimated_num_employees: num(org.estimated_num_employees),
        annual_revenue: num(org.annual_revenue),
        founded_year: num(org.founded_year),
      },
      raw: person,
    },
    note: emailLocked
      ? 'Apollo matched a person but the email is locked ("email_not_unlocked@..." placeholder) — your account ' +
        'has not unlocked/paid for this contact\'s email. `email` is reported as null rather than the placeholder.'
      : 'Phone-number reveal is not requested by this tool: Apollo\'s reveal_phone_number is asynchronous ' +
        '(delivered later to a webhook_url), which this stateless call cannot receive.',
  };
}

async function enrichPerson(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireApiKey('apollo_enrich_person', args);
  const email = str(args.email);
  const linkedinUrl = str(args.linkedin_url);
  const name = str(args.name);
  const firstName = str(args.first_name);
  const lastName = str(args.last_name);
  if (!email && !linkedinUrl && !name && !(firstName && lastName)) {
    throw new Error(
      'Apollo apollo_enrich_person requires at least one of: `email`, `linkedin_url`, `name`, or ' +
        '`first_name`+`last_name` (ideally with `domain` or `organization_name` too, to disambiguate).',
    );
  }
  const body: Record<string, unknown> = {};
  if (email) body.email = email;
  if (linkedinUrl) body.linkedin_url = linkedinUrl;
  if (name) body.name = name;
  if (firstName) body.first_name = firstName;
  if (lastName) body.last_name = lastName;
  if (str(args.organization_name)) body.organization_name = str(args.organization_name);
  if (str(args.domain)) body.domain = str(args.domain);
  if (typeof args.reveal_personal_emails === 'boolean') body.reveal_personal_emails = args.reveal_personal_emails;

  const raw = await apolloRequest('apollo_enrich_person', `${BASE_URL}/people/match`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return mapPersonEnrichResponse(raw);
}

// ════════════════════════════════════════════════════════════════════════
// apollo_org_job_postings — GET /organizations/{organization_id}/job_postings
// ════════════════════════════════════════════════════════════════════════

export function mapJobPostingsResponse(raw: Record<string, unknown>) {
  return {
    job_postings: arr(raw.organization_job_postings).map((jp) => {
      const j = (jp ?? {}) as Record<string, unknown>;
      return {
        id: str(j.id),
        title: str(j.title),
        url: str(j.url),
        city: str(j.city),
        state: str(j.state),
        country: str(j.country),
        posted_at: str(j.posted_at),
        last_seen_at: str(j.last_seen_at),
      };
    }),
  };
}

async function orgJobPostings(args: Record<string, unknown>): Promise<unknown> {
  const apiKey = requireApiKey('apollo_org_job_postings', args);
  const organizationId = str(args.organization_id);
  if (!organizationId) {
    throw new Error(
      'Apollo apollo_org_job_postings requires `organization_id` — the Apollo company id, e.g. from ' +
        '`id` in an apollo_search_organizations or apollo_enrich_organization result.',
    );
  }
  const params = new URLSearchParams();
  if (num(args.page) !== null) params.set('page', String(args.page));
  if (num(args.per_page) !== null) params.set('per_page', String(args.per_page));
  const qs = params.toString();

  const raw = await apolloRequest(
    'apollo_org_job_postings',
    `${BASE_URL}/organizations/${encodeURIComponent(organizationId)}/job_postings${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers: authHeaders(apiKey) },
  );
  return mapJobPostingsResponse(raw);
}

// ════════════════════════════════════════════════════════════════════════
// tool defs + dispatch
// ════════════════════════════════════════════════════════════════════════

const tools: McpToolExport['tools'] = [
  {
    name: 'apollo_search_organizations',
    description:
      'Requires a PAID Apollo plan (the free plan answers 403). ' +
      'Search Apollo\'s company database by industry, headcount, HQ location, technologies used, and funding. ' +
      'BYOK: pass your own Apollo _apiKey (Settings -> Integrations -> API in the Apollo app). Apollo cost: ' +
      '1 Apollo credit per page of results (up to 100 results/page), billed to your account. Example: ' +
      'apollo_search_organizations({ industries: ["information technology & services"], employee_ranges: ["11,50"], locations: ["San Francisco, California, US"], _apiKey: "your-apollo-key" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        q_organization_name: { type: 'string', description: 'Company name, partial match accepted, e.g. "Pipeworx".' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Company domains, no protocol, e.g. ["apollo.io"].' },
        industries: { type: 'array', items: { type: 'string' }, description: 'Industry names, lowercase, exact match per Apollo\'s own taxonomy, e.g. ["information technology & services"]. Apollo does not publish a fixed enum via this API — look up exact spellings in the Apollo UI\'s company filter.' },
        industry_tag_ids: { type: 'array', items: { type: 'string' }, description: 'Apollo industry tag ids, if you already have them (alternative to `industries`).' },
        employee_ranges: { type: 'array', items: { type: 'string' }, description: 'Headcount ranges as "min,max" strings, e.g. ["1,10", "11,50"].' },
        locations: { type: 'array', items: { type: 'string' }, description: 'Company HQ locations, e.g. ["San Francisco, California, US"].' },
        exclude_locations: { type: 'array', items: { type: 'string' }, description: 'HQ locations to exclude.' },
        technologies: { type: 'array', items: { type: 'string' }, description: 'Apollo technology UIDs currently in use, e.g. ["salesforce", "hubspot"]. Apollo supports 1,500+ of these; look them up in the Apollo UI\'s technology filter rather than guessing.' },
        keyword_tags: { type: 'array', items: { type: 'string' }, description: 'Keywords associated with the company.' },
        revenue_min: { type: 'number', description: 'Minimum annual revenue, in dollars.' },
        revenue_max: { type: 'number', description: 'Maximum annual revenue, in dollars.' },
        total_funding_min: { type: 'number', description: 'Minimum total funding raised, in dollars.' },
        total_funding_max: { type: 'number', description: 'Maximum total funding raised, in dollars.' },
        latest_funding_date_min: { type: 'string', description: 'Earliest most-recent-funding-round date, YYYY-MM-DD.' },
        latest_funding_date_max: { type: 'string', description: 'Latest most-recent-funding-round date, YYYY-MM-DD.' },
        page: { type: 'number', description: 'Page number, default 1.' },
        per_page: { type: 'number', description: 'Results per page, default 10, max 100.' },
        _apiKey: { type: 'string', description: 'Your Apollo API key. Get one at https://docs.apollo.io/docs/create-api-key.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'apollo_enrich_organization',
    description:
      'Enrich a single company by domain, website, or LinkedIn URL: industry, headcount, revenue, funding history, ' +
      'technologies in use, and more. BYOK: pass your own Apollo _apiKey. Apollo cost: 1 Apollo credit per ' +
      'organization enriched. Example: apollo_enrich_organization({ domain: "apollo.io", _apiKey: "your-apollo-key" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Company domain, no protocol/www, e.g. "apollo.io".' },
        website: { type: 'string', description: 'Full website URL, e.g. "http://www.apollo.io". Alternative to `domain`.' },
        linkedin_url: { type: 'string', description: 'Company LinkedIn URL. Alternative to `domain`/`website`.' },
        name: { type: 'string', description: 'Company name, to improve match accuracy. Cannot be used alone — pair with domain/website/linkedin_url.' },
        _apiKey: { type: 'string', description: 'Your Apollo API key. Get one at https://docs.apollo.io/docs/create-api-key.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'apollo_search_people',
    description:
      'Requires a PAID Apollo plan (the free plan answers 403). ' +
      'Search Apollo\'s people database by job title, seniority, and employer domain/org id. BYOK: pass your own ' +
      'Apollo _apiKey. Apollo cost: 0 credits — but this endpoint returns an OBFUSCATED last name and never an ' +
      'email or phone number; call apollo_enrich_person on a result to resolve a real contact. Example: ' +
      'apollo_search_people({ titles: ["VP of Sales"], seniorities: ["vp"], domains: ["apollo.io"], _apiKey: "your-apollo-key" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        titles: { type: 'array', items: { type: 'string' }, description: 'Job titles to match, e.g. ["VP of Sales", "Head of Growth"]. Matches on contained terms too (e.g. "marketing manager" also matches "content marketing manager").' },
        seniorities: { type: 'array', items: { type: 'string' }, description: 'Apollo seniority levels: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Employer domains, no protocol, e.g. ["apollo.io"].' },
        organization_ids: { type: 'array', items: { type: 'string' }, description: 'Apollo company ids (from apollo_search_organizations results).' },
        person_locations: { type: 'array', items: { type: 'string' }, description: 'Person\'s own location, e.g. ["California, US"].' },
        organization_locations: { type: 'array', items: { type: 'string' }, description: 'Employer\'s HQ location.' },
        q_person_name: { type: 'string', description: 'Search by person name.' },
        q_keywords: { type: 'string', description: 'Free-text keyword search.' },
        page: { type: 'number', description: 'Page number, default 1.' },
        per_page: { type: 'number', description: 'Results per page, default 10, max 100.' },
        _apiKey: { type: 'string', description: 'Your Apollo API key. Get one at https://docs.apollo.io/docs/create-api-key.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'apollo_enrich_person',
    description:
      'Requires a PAID Apollo plan (the free plan answers 403). ' +
      'Enrich one specific person by email, LinkedIn URL, or name+domain/organization: title, seniority, ' +
      'department, employer, and (if your account has unlocked it) a work email. BYOK: pass your own Apollo ' +
      '_apiKey — this returns data your OWN Apollo licence already covers; Pipeworx caches nothing. Apollo cost: ' +
      '1 credit if email/demographic data is found, +8 more only for a mobile phone (not requested by this tool, ' +
      'see `note` in the response), 0 if nothing matches. NOT implemented: phone-number reveal (Apollo delivers it ' +
      'asynchronously to a webhook, which this stateless tool call cannot receive). Example: ' +
      'apollo_enrich_person({ name: "Patrick Collison", domain: "stripe.com", _apiKey: "your-apollo-key" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Person\'s email address, if known.' },
        name: { type: 'string', description: 'Person\'s full name, e.g. "Patrick Collison". Alternative to first_name+last_name.' },
        first_name: { type: 'string', description: 'First name (pair with last_name).' },
        last_name: { type: 'string', description: 'Last name (pair with first_name).' },
        organization_name: { type: 'string', description: 'Current or former employer NAME, e.g. "Stripe".' },
        domain: { type: 'string', description: 'Employer domain, e.g. "stripe.com". Helps disambiguate a common name.' },
        linkedin_url: { type: 'string', description: 'Person\'s LinkedIn profile URL.' },
        reveal_personal_emails: { type: 'boolean', description: 'Default false. If true, also attempts to reveal a personal (non-work) email, consuming Apollo credit accordingly.' },
        _apiKey: { type: 'string', description: 'Your Apollo API key. Get one at https://docs.apollo.io/docs/create-api-key.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'apollo_org_job_postings',
    description:
      'List a company\'s current job postings (title, location, posted/last-seen dates) — a signal for headcount ' +
      'growth in a specific team. BYOK: pass your own Apollo _apiKey. Needs an Apollo `organization_id` (get one ' +
      'from apollo_search_organizations or apollo_enrich_organization first). Apollo cost: 1 Apollo credit per ' +
      'page, up to 10,000 postings total. Example: apollo_org_job_postings({ organization_id: "5e66b6381e05b4008c8331b8", _apiKey: "your-apollo-key" })',
    inputSchema: {
      type: 'object' as const,
      properties: {
        organization_id: { type: 'string', description: 'Apollo company id, e.g. from an apollo_search_organizations/apollo_enrich_organization result\'s `id` field.' },
        page: { type: 'number', description: 'Page number.' },
        per_page: { type: 'number', description: 'Results per page.' },
        _apiKey: { type: 'string', description: 'Your Apollo API key. Get one at https://docs.apollo.io/docs/create-api-key.' },
      },
      required: ['organization_id', '_apiKey'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'apollo_search_organizations':
      return searchOrganizations(args);
    case 'apollo_enrich_organization':
      return enrichOrganization(args);
    case 'apollo_search_people':
      return searchPeople(args);
    case 'apollo_enrich_person':
      return enrichPerson(args);
    case 'apollo_org_job_postings':
      return orgJobPostings(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

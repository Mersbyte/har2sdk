/**
 * Decide which exchanges are API calls and which are page noise
 * (images, fonts, scripts, analytics beacons, CORS preflights, ...).
 */
import { isJsonMime, type Exchange } from "./har.js";
import { isValueSegment } from "./template.js";

export type DropReason =
  | "preflight"
  | "not-http"
  | "tracker"
  | "telemetry"
  | "static-asset"
  | "document"
  | "host-filter"
  | "failed"
  | "unknown-type"
  | "not-api";

const TRACKER_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "stats.g.doubleclick.net",
  "facebook.net",
  "connect.facebook.net",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "hotjar.io",
  "sentry.io",
  "fullstory.com",
  "datadoghq.com",
  "datadoghq.eu",
  "browser-intake-datadoghq.com",
  "nr-data.net",
  "newrelic.com",
  "clarity.ms",
  "bat.bing.com",
  "ads.linkedin.com",
  "analytics.tiktok.com",
  "intercom.io",
  "intercomcdn.com",
  "launchdarkly.com",
  "posthog.com",
  "heapanalytics.com",
  "quantserve.com",
  "scorecardresearch.com",
  "cloudflareinsights.com",
  "rum.hlx.page",
  "m.stripe.network",
  "pendo.io",
  "logrocket.io",
  "lr-ingest.io",
  "bugsnag.com",
  "rollbar.com",
  "onesignal.com",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "firebaselogging-pa.googleapis.com",
  "firebaselogging.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "recaptcha.net",
  "mc.yandex.ru",
  "mc.yandex.com",
  "r.stripe.com",
  "m.stripe.com",
  "cookielaw.org",
  "onetrust.com",
  "tr.snapchat.com",
  "sc-static.net",
  "ct.pinterest.com",
  "analytics.twitter.com",
  "ads-twitter.com",
  "track.hubspot.com",
  "hs-analytics.net",
  "hs-banner.com",
  "optimizely.com",
  "braze.com",
  "braze.eu",
  "statsigapi.net",
  "plausible.io",
  "stats.wp.com",
  "mxpnl.com",
  "sentry-cdn.com",
  "smartlook.com",
  "mouseflow.com",
  "adsrvr.org",
  "doubleverify.com",
  "cookiebot.com",
  "usercentrics.eu",
  "trustarc.com",
];

/**
 * Telemetry that lives on the app's own origin (or on hosts that also serve
 * real APIs). Generic path words ("telemetry", "rum", "beacon") only count for
 * fire-and-forget POSTs: `GET /api/vehicles/42/telemetry` is a real API.
 */
const TELEMETRY_PATHS: { host?: RegExp; path: RegExp; query?: RegExp; when?: (ex: Exchange) => boolean }[] = [
  { path: /^\/(g|j|r)\/collect$|^\/collect$/, when: (ex) => ex.query.some(([k]) => k === "tid" || k === "v") || ex.method === "POST" },
  { path: /^\/_vercel\/(insights|speed-insights)(\/|$)/ },
  { path: /^\/cdn-cgi\/(rum|challenge-platform|beacon|trace)(\/|$)/ },
  // Sentry ingest / tunnel: only with Sentry's own query parameters or event payloads.
  { path: /^\/api\/\d+\/envelope\/?$/, when: (ex) => ex.method === "POST" },
  { path: /^\/api\/\d+\/store\/?$/, when: (ex) => ex.method === "POST" && (ex.query.some(([k]) => /^sentry_/.test(k)) || sentryPayload(ex)) },
  { path: /^\/monitoring\/?$/, query: /(^|&)o=/, when: (ex) => ex.method === "POST" },
  { path: /(^|\/)(rum|beacon|telemetry)(\/|$)/, when: fireAndForget },
  { host: /^play\.google\.com$/, path: /^\/log$/ },
  { host: /(^|\.)google\.com$/, path: /^\/recaptcha\// },
  { host: /(^|\.)gstatic\.com$/, path: /^\/recaptcha\// },
  { host: /(^|\.)facebook\.com$/, path: /^\/tr\/?$/ },
];

function sentryPayload(ex: Exchange): boolean {
  const b = ex.requestBody;
  const text = b?.kind === "text" || b?.kind === "unparsed" ? b.raw : b?.kind === "json" ? JSON.stringify(b.value).slice(0, 400) : "";
  return /"(event_id|sent_at|dsn)"/.test(text.slice(0, 400));
}

/** A POST/PUT whose answer carries no data (204, empty, or a bare {ok}) — how beacons look. */
function fireAndForget(ex: Exchange): boolean {
  if (ex.method === "GET" || ex.method === "HEAD" || ex.method === "DELETE") return false;
  if (ex.resourceType === "ping" || ex.resourceType === "beacon") return true;
  const r = ex.responseBody;
  if (!r || ex.status === 204 || ex.status === 202) return true;
  if (r.kind === "json") return r.value === null || (typeof r.value === "object" && !Array.isArray(r.value) && Object.keys(r.value as object).length <= 2);
  return r.kind !== "unparsed" && r.kind !== "missing";
}

const STATIC_EXT = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|m4a|pdf|zip|wasm|html?)$/i;
const STATIC_TYPES = new Set(["image", "stylesheet", "font", "media", "script", "manifest", "texttrack", "ping", "cspviolationreport"]);

export interface FilterOptions {
  /** Only keep these hosts (exact host, or a suffix such as "example.com"). */
  hosts?: string[];
  /** Drop these hosts (exact host or suffix). */
  excludeHosts?: string[];
  /** Drop paths matching these globs ("*" matches anything), e.g. "/internal/*". */
  excludePaths?: string[];
  /** Always keep paths matching these globs, even if they look like telemetry or static files. */
  includePaths?: string[];
  /** Keep failed requests (status 0). Default false. */
  keepFailed?: boolean;
}

export function isTrackerHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return TRACKER_HOSTS.some((t) => h === t || h.endsWith("." + t));
}

export function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  const bare = h.replace(/:\d+$/, "");
  return patterns.some((p) => {
    const q = p.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return h === q || bare === q || bare.endsWith("." + q.replace(/:\d+$/, ""));
  });
}

/** Returns undefined if the exchange should be kept, otherwise the reason it was dropped. */
export function classify(ex: Exchange, opts: FilterOptions = {}): DropReason | undefined {
  if (ex.url.protocol !== "http:" && ex.url.protocol !== "https:") return "not-http";
  if (ex.method === "OPTIONS") return "preflight";
  if (opts.hosts?.length && !hostMatches(ex.host, opts.hosts)) return "host-filter";
  if (opts.excludeHosts?.length && hostMatches(ex.host, opts.excludeHosts)) return "host-filter";
  if (opts.excludePaths?.some((g) => globToRegExp(g).test(ex.pathname))) return "host-filter";
  if (opts.includePaths?.some((g) => globToRegExp(g).test(ex.pathname))) return undefined;
  if (isTrackerHost(ex.host)) return "tracker";
  const search = ex.url.search.replace(/^\?/, "");
  const hostname = ex.url.hostname;
  if (TELEMETRY_PATHS.some((t) => (!t.host || t.host.test(hostname)) && t.path.test(ex.pathname) && (!t.query || t.query.test(search)) && (!t.when || t.when(ex)))) {
    return t_host(hostname) ? "tracker" : "telemetry";
  }
  if (ex.status === 0 && !opts.keepFailed) return "failed";

  const rt = ex.resourceType?.toLowerCase();
  if (rt === "document") return "document";
  if (rt && STATIC_TYPES.has(rt)) return "static-asset";

  const resMime = (ex.responseHeaders.get("content-type") ?? (ex.responseBody && "mimeType" in ex.responseBody ? ex.responseBody.mimeType : "")).toLowerCase();
  const bodyIsJson = ex.responseBody?.kind === "json" || ex.responseBody?.kind === "missing" || ex.responseBody?.kind === "unparsed";
  const reqIsData = ex.requestBody?.kind === "json" || ex.requestBody?.kind === "form" || ex.requestBody?.kind === "multipart";

  if (STATIC_EXT.test(ex.pathname) && !bodyIsJson) return "static-asset";
  if (/^(image|font|audio|video)\//.test(resMime) || /text\/css|javascript|ecmascript/.test(resMime)) return "static-asset";
  if (resMime.startsWith("text/html") && !reqIsData) return "document";

  if (bodyIsJson || isJsonMime(resMime) || reqIsData) return undefined;
  if (rt === "xhr" || rt === "fetch") return undefined;
  // Mutations that return nothing (204, empty 200) are still API calls.
  if (ex.method !== "GET" && ex.method !== "HEAD" && !ex.responseBody) return undefined;
  // "No Content" is an API's answer, not a page's.
  if ((ex.status === 204 || ex.status === 205) && !ex.responseBody) return undefined;
  // Nothing says what this is (no body, no content type, no resource type): a 304
  // revalidation, an empty 200. Kept if the same call was kept for another reason.
  if (!ex.responseBody && !resMime && !rt) return "unknown-type";
  return "not-api";
}

/** Google / Facebook endpoints are third-party trackers; everything else matched a first-party path rule. */
function t_host(hostname: string): boolean {
  return /(^|\.)(google|gstatic|facebook)\.com$/.test(hostname);
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

export interface FilterResult {
  kept: Exchange[];
  dropped: Partial<Record<DropReason, number>>;
  /** First-party requests dropped as telemetry ("POST /rum"), at most five — worth a warning. */
  telemetry: string[];
  /** Requests dropped because nothing said what they are (empty body, no content type), at most five. */
  untyped: string[];
  /**
   * Dropped requests that can still show which values are data (trackers, pages, telemetry, other
   * hosts): the leak guard reads them, nothing is generated from them. Static assets (scripts,
   * styles, images) are code and media, not records, and are left out.
   */
  evidence: Exchange[];
}

export function filterExchanges(exchanges: Exchange[], opts: FilterOptions = {}): FilterResult {
  const kept: Exchange[] = [];
  const dropped: Partial<Record<DropReason, number>> = {};
  const telemetry = new Set<string>();
  const untyped: Exchange[] = [];
  const evidence: Exchange[] = [];
  const label = (ex: Exchange) => `${ex.method.replace(/[^A-Za-z]/g, "").slice(0, 12)} ${maskedPath(ex.pathname)}`;
  for (const ex of exchanges) {
    const reason = classify(ex, opts);
    if (reason === "unknown-type") untyped.push(ex);
    else if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
    else kept.push(ex);
    // A WebSocket entry has a ws:// or wss:// URL: its frames are still evidence.
    if (reason && reason !== "unknown-type" && reason !== "static-asset" && (reason !== "not-http" || ex.evidence?.length)) evidence.push(ex);
    if (reason === "telemetry" && telemetry.size < 5) telemetry.add(label(ex));
  }
  // An untyped answer to a call the capture shows elsewhere (a 304 after a 200) is that call.
  const known = new Set(kept.map((ex) => `${ex.method} ${ex.origin}${ex.pathname}`));
  const skipped = new Set<string>();
  for (const ex of untyped) {
    if (known.has(`${ex.method} ${ex.origin}${ex.pathname}`)) kept.push(ex);
    else {
      evidence.push(ex);
      dropped["unknown-type"] = (dropped["unknown-type"] ?? 0) + 1;
      if (skipped.size < 5) skipped.add(label(ex));
    }
  }
  if (untyped.length) kept.sort((a, b) => a.index - b.index);
  return { kept, dropped, telemetry: [...telemetry], untyped: [...skipped], evidence };
}

/**
 * A dropped request's path for a warning, with every segment that could be a value replaced by `{…}`:
 * ids and emails by their shape, and anything that isn't a plain word. Warnings reach `inspect --json`
 * and MCP, and a dropped request's path is never templated.
 */
export function maskedPath(pathname: string): string {
  let prev: string | undefined;
  const out: string[] = [];
  for (const raw of pathname.split("/").slice(1, 9)) {
    let seg = raw;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      /* keep */
    }
    const plain = /^[A-Za-z][A-Za-z_-]{0,39}$/.test(seg) || /^v\d{1,2}$/i.test(seg) || /^[A-Za-z][\w-]{0,39}\.(js|json|css|html?|php|aspx?|xml|txt)$/i.test(seg);
    out.push(!seg ? "" : plain && !isValueSegment(seg, prev) ? seg : "{…}");
    prev = seg;
  }
  const more = pathname.split("/").length > 9 ? "/…" : "";
  return "/" + out.join("/") + more;
}

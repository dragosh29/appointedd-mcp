// Minimal Appointedd API client used by the MCP tools.
// Docs: https://developers.appointedd.com  Spec: one OpenAPI 3.1 definition per reference page on
// developers.appointedd.com (assembled into spec.json by test/assemble-spec.mjs).
import { redactContacts } from "./format.js";

export class AppointeddError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AppointeddError";
  }
}

// Pagination page: every paginated endpoint returns data, total, prev and next (Pagination page).
export interface Page<T> {
  data?: T[];
  total?: number;
  prev?: string | null;
  next?: string | null;
}

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET: repeating a POST /bookings could create the same booking twice, and repeating a POST
// /availability/slots could hold two slots. The two availability searches are POSTs too; they change
// nothing, but the same GET-only rule is applied and the error message says they are safe to repeat.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// Pagination page: limit "Accepts integers ranging from 1 to 100 and defaults to 10 if not set."
export const PAGE_SIZE = 100;
// Limitations page: "our API has a hard limit of 10240 bytes (or 10.24 kilobytes) for request sizes."
export const MAX_REQUEST_BYTES = 10240;

export type QueryValue = string | number | boolean | string[] | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The request changes nothing (the availability searches are POSTs): shapes the gateway-error message only. */
  readOnly?: boolean;
}

export class AppointeddClient {
  private readonly baseUrl: string;
  // Appointedd does not document a rate limit. Space requests at about four per second so a tool
  // call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(private readonly apiKey: string, baseUrl = "https://api.appointedd.com/v1") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      // ids, services, categories, customers and resources are typed as arrays of strings; the spec
      // does not say how to serialise them, so the OpenAPI 3 default is used (style form, explode
      // true: the key repeated once per value).
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (body !== undefined) {
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        throw new AppointeddError(
          `Not sent: the request body is ${bytes} bytes and Appointedd's documented maximum request size is ${MAX_REQUEST_BYTES} bytes (Limitations page). Shorten free-text fields such as notes, question answers or custom fields, or store the data elsewhere and attach a link.`,
        );
      }
    }

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            // Authentication page: "API key based authentication set via the X-API-KEY HTTP request header."
            "X-API-KEY": this.apiKey,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body,
          // No documented endpoint redirects and the API is JSON-only. Following a redirect (fetch's
          // default) would forward the X-API-KEY header to wherever a misconfigured APPOINTEDD_BASE_URL
          // points, so a redirect is an error and the key never travels to a second host.
          redirect: "error",
        });
      } catch (err) {
        if (/redirect/i.test(String((err as Error)?.cause ?? ""))) {
          throw new AppointeddError(
            `Appointedd answered ${method} ${path} with a redirect, which this server does not follow (the API key is only ever sent to ${this.baseUrl}). Check APPOINTEDD_BASE_URL.`,
          );
        }
        throw new AppointeddError(`Could not reach Appointedd at ${this.baseUrl}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new AppointeddError(
            `Appointedd asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`,
            res.status,
          );
        }
        // The body of a response that is about to be retried is never read; release the connection.
        await res.body?.cancel().catch(() => {});
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 2xx body (other than the 204s) is a JSON object. A 200 with HTML (a proxy, a
        // captive portal, a login page) must not be mistaken for an empty list or an empty record.
        if (!json || typeof json !== "object") {
          throw new AppointeddError(
            `Appointedd returned ${res.status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify(text.slice(0, 60))}). Check APPOINTEDD_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Appointedd's error messages are free text and the documented examples echo request data
      // (IDs, dates); redact anything that looks like a contact detail in case the live API ever
      // echoes a customer's email or phone number back.
      const detail = redactContacts(describeError(json) ?? text.slice(0, 300), false);
      const suffix = detail ? " " + detail : "";
      if (res.status === 401 || res.status === 403) {
        throw new AppointeddError(
          `Appointedd rejected the API key (${res.status}). Check APPOINTEDD_API_KEY: it is your organisation's API key from Settings > API in Appointedd (app.appointedd.com/management/settings/api), sent as the X-API-KEY header.${suffix}`,
          res.status,
        );
      }
      if (res.status === 404 && path === "/availability/slots") {
        // Create Reservation 404 example: "Could not find availability <start> for resource <id>".
        throw new AppointeddError(`Appointedd found no availability to reserve (404). Use a start time returned by find_available_intervals for the same service (and resource, if one was given), and check the resource is assigned to the service.${suffix}`, 404);
      }
      if (res.status === 404) throw new AppointeddError(`Not found: ${path}. Check the ID.${suffix}`, 404);
      if (res.status === 429) throw new AppointeddError("Appointedd rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (res.status === 400) throw new AppointeddError(`Appointedd rejected ${method} ${path} (400 Bad Request).${suffix}`, 400);
      if (res.status === 422) throw new AppointeddError(`Appointedd could not process ${method} ${path} (422).${suffix}`, 422);
      if (res.status === 413) {
        throw new AppointeddError(`Appointedd refused ${method} ${path} (413): the request is larger than the documented maximum of ${MAX_REQUEST_BYTES} bytes. Shorten free-text fields or store the data elsewhere and attach a link.${suffix}`, 413);
      }
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        if (opts.readOnly) {
          throw new AppointeddError(
            `Appointedd returned ${res.status} for ${method} ${path}. This request is a query that changes nothing, so it is safe to call again; the service may be unavailable, try again in a few minutes.${suffix}`,
            res.status,
          );
        }
        const how = path.startsWith("/customers") ? "find_customers or get_customer" : path.startsWith("/availability/slots") ? "create_reservation again only if the first slot expires (reservations are single use and expire on their own)" : "list_bookings";
        throw new AppointeddError(
          `Appointedd returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with ${how} before repeating it.${suffix}`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a JSON
        // message is passed on.
        const jsonDetail = redactContacts(describeError(json), false);
        throw new AppointeddError(
          `Appointedd returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`,
          res.status,
        );
      }
      throw new AppointeddError(`Appointedd returned ${res.status} for ${method} ${path}.${suffix}`, res.status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch a range-paginated collection (Pagination page): each page carries `data`, `total`, `prev`
   * and `next`; `next` is the ID of the first document of the next page, or null on the last page,
   * and is sent back as the `start` parameter to fetch that page. `limit` is min(100, what is still
   * wanted). Stops at `maxItems`, at `maxPages`, on an empty page, or when `next` is null. Because
   * `start` is the ID of the first document on a page, a continuation is always exact: `next_start`
   * is either the API's `next` or, if the API ever returned more items than asked for, the ID of the
   * first item not returned.
   */
  async list<T extends { id?: string } = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, start = undefined as string | undefined, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; total?: number; complete: boolean; next_start?: string }> {
    const items: T[] = [];
    let total: number | undefined;
    let cursor = start;
    for (let page = 0; page < maxPages; page++) {
      const limit = Math.max(1, Math.min(PAGE_SIZE, maxItems - items.length));
      const res = await this.get<Page<T>>(path, { ...query, limit, start: cursor });
      // Every documented list response carries `data` as an array. A JSON 200 without one is some
      // other document (a proxy's JSON, a different API behind APPOINTEDD_BASE_URL) and must not be
      // mistaken for an empty list, just as a non-JSON 200 is not (see request()).
      if (!Array.isArray(res?.data)) {
        const excerpt = redactContacts(JSON.stringify(res ?? null).slice(0, 60), false);
        throw new AppointeddError(
          `Appointedd returned 200 for GET ${path} but the JSON has ${res?.data === undefined ? 'no "data" list' : '"data" that is not a list'} (starts with: ${JSON.stringify(excerpt)}). Check APPOINTEDD_BASE_URL; this is not an empty list.`,
          200,
        );
      }
      const data = res.data;
      total = intOrUndefined(res?.total) ?? total;
      const next = typeof res?.next === "string" && res.next !== "" ? res.next : undefined;
      items.push(...data);
      if (items.length >= maxItems) {
        const extra = items.length > maxItems ? items[maxItems]?.id : undefined;
        const nextStart = extra ?? next;
        return { items: items.slice(0, maxItems), total, complete: nextStart === undefined, next_start: nextStart };
      }
      if (data.length === 0 || next === undefined) return { items, total, complete: true };
      cursor = next;
    }
    return { items, total, complete: false, next_start: cursor };
  }
}

function intOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Documented error bodies: {statusCode, error, message, validation: {source, keys}} on most endpoints,
// {message} on POST /bookings/{id}/cancel 422, and {errors: [{message}]} on the cancel-customer 422.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  for (const k of ["error", "message"]) if (typeof json[k] === "string" && json[k].trim()) parts.push(json[k].trim());
  if (Array.isArray(json.errors)) {
    const msgs = json.errors.map((e: any) => (typeof e?.message === "string" ? e.message.trim() : "")).filter(Boolean);
    if (msgs.length) parts.push(msgs.join("; "));
  }
  const keys = json.validation?.keys;
  if (Array.isArray(keys) && keys.length) parts.push(`(invalid ${json.validation.source ?? "input"}: ${keys.join(", ")})`);
  return parts.length ? parts.join(" ") : undefined;
}

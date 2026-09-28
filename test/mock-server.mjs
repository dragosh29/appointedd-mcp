// Local stand-in for api.appointedd.com/v1, serving the fixtures with the documented range-based
// pagination (limit/start/end in, data/total/prev/next out) and X-API-KEY authentication.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const API_KEY = "apk-test-key-123";

// Error shapes from the spec: {statusCode, error, message, validation?} on most endpoints (hapi/Joi
// style, e.g. 'child "limit" fails because ["limit" must be a number]'), {message} on the cancel 422,
// {statusCode, message} on the reservation 404. The 401 body is not documented; the first shape is used.
const err = (statusCode, error, message, validation) => ({ statusCode, error, message, ...(validation ? { validation } : {}) });
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer. The suite starts with a single 429 on
  // GET /resources/groups so the retry path is exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/resources/groups", status: 429, times: 1, headers: { "Retry-After": "1" }, body: err(429, "Too Many Requests", "Rate limit exceeded.") });
  let failures = [failure429()];
  // Reservations created by POST /availability/slots, consumed (single use) by POST /bookings.
  const reservations = new Map();
  const cancelled = new Set([fx.BK_CANCELLED]);
  const customersById = new Map(fx.customers.map((c) => [c.id, c]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/^\/v1(?=\/|$)/, "");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path, query, auth: req.headers["x-api-key"], contentType: req.headers["content-type"], body, bytes: Buffer.byteLength(raw), t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    const notFound = () => send(404, err(404, "Not Found", "ID does not exist")); // GET /services/{id} 404 example
    const badId = () => send(400, err(400, "Bad Request", 'child "id" fails because ["id" must only contain hexadecimal characters]', { source: "params", keys: ["id"] }));
    if (req.headers["x-api-key"] !== API_KEY) return send(401, err(401, "Unauthorized", "Invalid API key"));

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }
    // Limitations page: a hard limit of 10240 bytes on request sizes (the status for a larger request is not documented).
    if (Buffer.byteLength(raw) > 10240) return send(413, err(413, "Request Entity Too Large", "Payload content length greater than maximum allowed: 10240"));

    // Pagination page: limit 1..100 (default 10), start = ID of the first document of the page (the previous
    // page's `next`), end = ID of the last document of the page (the previous page's `prev`). Bookings are
    // capped at 3 per page and customers at 50 whatever is asked, so lists span several pages.
    const rawLimit = url.searchParams.get("limit");
    const limitAsked = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isInteger(limitAsked) || limitAsked < 1 || limitAsked > 100) {
      return send(400, err(400, "Bad Request", `child "limit" fails because ["limit" must be ${limitAsked < 1 ? "larger than or equal to 1" : "less than or equal to 100"}]`, { source: "query", keys: ["limit"] }));
    }
    const cap = path === "/bookings" ? 3 : path === "/customers" ? 50 : 100;
    const limit = Math.min(limitAsked, cap);
    const paged = (sorted) => {
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      let from = 0;
      if (start) {
        const i = sorted.findIndex((x) => x.id === start);
        if (i < 0) return send(200, { data: [], total: sorted.length, prev: null, next: null });
        from = i;
      } else if (end) {
        const i = sorted.findIndex((x) => x.id === end);
        if (i < 0) return send(200, { data: [], total: sorted.length, prev: null, next: null });
        from = Math.max(0, i - limit + 1);
      }
      const data = sorted.slice(from, from + limit);
      return send(200, { data, total: sorted.length, prev: from > 0 ? sorted[from - 1].id : null, next: from + limit < sorted.length ? sorted[from + limit].id : null });
    };
    const ordered = (items, sortBy, allowedSorts) => {
      const sort = url.searchParams.get("sort_by") ?? "natural";
      if (!allowedSorts.includes(sort)) return send(400, err(400, "Bad Request", `child "sort_by" fails because ["sort_by" must be one of [${allowedSorts.join(", ")}]]`, { source: "query", keys: ["sort_by"] }));
      const order = url.searchParams.get("order_by") ?? "descending";
      if (!["asc", "ascending", "desc", "descending"].includes(order)) return send(400, err(400, "Bad Request", 'child "order_by" fails because ["order_by" must be one of [asc, ascending, desc, descending]]', { source: "query", keys: ["order_by"] }));
      const key = sortBy[sort];
      const sorted = key ? [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) : [...items];
      if (order.startsWith("desc")) sorted.reverse();
      return paged(sorted);
    };
    const list = (name) => [].concat(query[name] ?? []);
    const withIds = (items) => (list("ids").length ? items.filter((x) => list("ids").includes(x.id)) : items);

    const p = path.split("/").filter(Boolean);
    const m = req.method;

    if (p[0] === "services") {
      if (m === "GET" && p.length === 1) return paged(withIds(fx.services));
      if (m === "GET" && p[1] === "categories" && p.length === 2) return paged(withIds(fx.categories));
      if (m === "GET" && p[1] === "categories" && p.length === 3) {
        if (!OBJECT_ID.test(p[2])) return badId();
        const c = fx.categories.find((x) => x.id === p[2]);
        return c ? send(200, { data: c }) : notFound();
      }
      if (m === "GET" && p.length === 2) {
        if (!OBJECT_ID.test(p[1])) return badId();
        const s = fx.services.find((x) => x.id === p[1]);
        return s ? send(200, { data: s }) : notFound();
      }
    }

    if (p[0] === "resources" && m === "GET") {
      if (p.length === 2 && p[1] === "groups") return ordered(withIds(fx.resourceGroups), {}, ["natural"]);
      if (p.length === 1) {
        const services = list("services");
        const items = withIds(fx.resources).filter((r) => !services.length || r.services.some((s) => services.includes(s)));
        return ordered(items, { creation: (r) => r.created }, ["natural", "creation"]);
      }
    }

    if (p[0] === "customers") {
      if (m === "GET" && p.length === 1) return ordered(withIds(fx.customers), { created: (c) => c.created, "profile.firstname": (c) => c.profile.firstname, "profile.lastname": (c) => c.profile.lastname }, ["natural", "created", "profile.firstname", "profile.lastname"]);
      if (m === "POST" && p.length === 1) {
        // POST /customers 400 example: a missing lastname.
        const profile = body?.data?.profile ?? {};
        for (const k of ["firstname", "lastname"]) {
          if (typeof profile[k] !== "string" || !profile[k]) return send(400, err(400, "Bad Request", `child "data" fails because [child "profile" fails because [child "${k}" fails because ["${k}" is required]]]`));
        }
        const created = fx.createdCustomer(body);
        customersById.set(created.id, { ...created, custom_fields: {}, marketing_opt_in: false });
        return send(201, { data: created });
      }
      if (p.length === 2) {
        if (!OBJECT_ID.test(p[1])) return badId();
        const c = customersById.get(p[1]);
        if (!c) return notFound();
        if (m === "GET") return send(200, { data: c });
        if (m === "PUT") {
          const updated = fx.updatedCustomer(c, body ?? {});
          customersById.set(c.id, { ...c, ...updated });
          return send(200, { data: updated });
        }
      }
    }

    if (p[0] === "bookings") {
      if (m === "GET" && p.length === 1) {
        const q = url.searchParams;
        const ms = (s) => Date.parse(s);
        const ids = list("ids"), services = list("services"), categories = list("categories"), customers = list("customers"), resources = list("resources");
        const statuses = list("statuses");
        const items = fx.bookings.filter(
          (b) =>
            (!q.get("after") || ms(b.start_buffer) >= ms(q.get("after"))) &&
            (!q.get("before") || ms(b.end_buffer) <= ms(q.get("before"))) &&
            (!q.get("created_after") || ms(b.created) >= ms(q.get("created_after"))) &&
            (!q.get("created_before") || ms(b.created) <= ms(q.get("created_before"))) &&
            (!q.get("updated_after") || ms(b.updated) >= ms(q.get("updated_after"))) &&
            (!q.get("updated_before") || ms(b.updated) <= ms(q.get("updated_before"))) &&
            (!ids.length || ids.includes(b.id)) &&
            (!services.length || services.includes(b.service)) &&
            (!categories.length || categories.includes(fx.services.find((s) => s.id === b.service)?.category_id)) &&
            (!customers.length || b.customers.some((c) => customers.includes(c.customer_id))) &&
            (!resources.length || resources.includes(b.resource)) &&
            (!statuses.length || statuses.includes(cancelled.has(b.id) ? "cancelled" : b.status)),
        )
          .map((b) => (cancelled.has(b.id) ? { ...b, status: "cancelled" } : b))
          .map((b) => (q.get("return_matching_customers_only") === "true" && customers.length ? { ...b, customers: b.customers.filter((c) => customers.includes(c.customer_id)) } : b));
        return ordered(items, { creation: (b) => b.created, updated: (b) => b.updated, start: (b) => b.start }, ["natural", "creation", "updated", "start"]);
      }
      if (m === "POST" && p.length === 1) {
        // POST /bookings 422 example: "Could not find reservation <id>" (an unknown, used or expired slot).
        const slot = body?.slot_id ? reservations.get(body.slot_id) : undefined;
        if (!body?.slot_id || !body?.data) return send(400, err(400, "Bad Request", `child "${!body?.slot_id ? "slot_id" : "data"}" fails because ["${!body?.slot_id ? "slot_id" : "data"}" is required]`));
        if (!slot) return send(422, { statusCode: 422, error: "Unprocessible Entity", message: `Could not find reservation ${body.slot_id}` });
        reservations.delete(body.slot_id);
        return send(201, { data: fx.createdBooking(slot, body) });
      }
      if (m === "POST" && p.length === 3 && p[2] === "cancel") {
        if (!OBJECT_ID.test(p[1])) return badId();
        if (!fx.bookings.some((b) => b.id === p[1])) return notFound();
        // POST /bookings/{id}/cancel 422 example.
        if (cancelled.has(p[1])) return send(422, { message: `Could not cancel booking with ID ${p[1]} because it is already cancelled.` });
        cancelled.add(p[1]);
        return send(204);
      }
    }

    if (p[0] === "availability" && m === "POST") {
      if (p.length === 2 && p[1] === "slots") {
        const d = body?.data;
        if (!d?.service_id || !d?.start) return send(400, { statusCode: 400 }); // Create Reservation 400 example carries only statusCode
        const avail = (fx.intervals[d.service_id] ?? []).find((i) => Date.parse(i.start) === Date.parse(d.start) && (!d.resource_id || i.resource_ids.includes(d.resource_id)));
        // Create Reservation 404 example.
        if (!avail) return send(404, { statusCode: 404, message: `Could not find availability ${new Date(Date.parse(d.start)).toISOString()} for resource ${d.resource_id ?? "undefined"}` });
        const slot = { ...fx.reservation, service_id: d.service_id, resource_id: d.resource_id ?? avail.resource_ids[0], resources: [{ id: d.resource_id ?? avail.resource_ids[0] }], reserved_spaces: d.required_spaces ?? 1, allow_additional_spaces: d.allow_additional_spaces ?? false };
        reservations.set(slot.id, slot);
        return send(201, { data: slot });
      }
      if (p.length === 3 && (p[1] === "intervals" || p[1] === "days") && p[2] === "search") {
        const b = body ?? {};
        if (!b.service_id || !Array.isArray(b.ranges) || !b.ranges.length) return send(400, err(400, "Bad Request", `child "${!b.service_id ? "service_id" : "ranges"}" fails because ["${!b.service_id ? "service_id" : "ranges"}" is required]`));
        const source = (p[1] === "intervals" ? fx.intervals : fx.days)[b.service_id] ?? [];
        const inRange = (s) => b.ranges.some((r) => Date.parse(s) >= Date.parse(r.start) && Date.parse(s) < Date.parse(r.end));
        const data = source
          .filter((i) => inRange(i.start))
          .map((i) => (Array.isArray(b.resource_ids) ? { ...i, resource_ids: i.resource_ids.filter((r) => b.resource_ids.includes(r)) } : i))
          .filter((i) => i.resource_ids.length || i.group_bookings.length)
          .filter((i) => !b.spaces || !i.group_bookings.length || i.group_bookings.some((g) => g.spaces >= b.spaces));
        return send(200, { data });
      }
    }

    return notFound();
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, reservations, cancelled })));
}

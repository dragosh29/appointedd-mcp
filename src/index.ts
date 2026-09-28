#!/usr/bin/env node
// Appointedd MCP server: lets Claude, ChatGPT and other MCP clients work with an Appointedd booking organisation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AppointeddClient, AppointeddError, PAGE_SIZE } from "./client.js";
import * as fmt from "./format.js";

const apiKey = process.env.APPOINTEDD_API_KEY?.trim();
if (!apiKey) {
  console.error("APPOINTEDD_API_KEY is not set. Use your organisation's API key from Settings > API in Appointedd (app.appointedd.com/management/settings/api).");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.APPOINTEDD_ALLOW_WRITES ?? "");
const baseUrl = process.env.APPOINTEDD_BASE_URL || "https://api.appointedd.com/v1";
const api = new AppointeddClient(apiKey, baseUrl);

const server = new McpServer(
  { name: "appointedd", version: "0.1.0" },
  {
    instructions: [
      "Tools for an Appointedd booking organisation (availability, services and categories, resources such as staff and rooms, bookings, customers).",
      "Every ID is a 24-character hexadecimal string. Dates and times are ISO 8601 (2026-10-05T09:00:00Z or 2026-10-05T10:00:00+01:00); timezones are IANA names such as Europe/London.",
      "Typical flow for 'what is on tomorrow?': list_bookings with after and before set to the day's bounds, then get_customer for the customer_id of each participant.",
      "Making a booking is three steps (Appointedd's own guide): find_available_intervals for a service and date range, create_reservation for one of the returned start times (this holds the slot for a few minutes), then create_booking with the reservation's id and the customer's details. The last two need APPOINTEDD_ALLOW_WRITES=true.",
      "Customer contact details (email, mobile, phone, address), staff contact details, customers' free-text answers and single-use reschedule links are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Every ID in the API is a MongoDB-style ObjectId: the documented 400 for a malformed reservation ID
// quotes the regex ^[0-9a-fA-F]{24}$, and the customer 400 says IDs "must only contain hexadecimal
// characters". Anything else is refused before any call is made.
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const id = (what: string) => z.string().regex(OBJECT_ID, `${what} IDs are 24 hexadecimal characters, e.g. 619bc11396362e0009f5798c`).describe(`${what} ID (24 hexadecimal characters)`);
const ids = (what: string) => z.array(id(what)).min(1).max(100).optional();

// The date filters and availability ranges are documented as "a valid ISO8601 formatted date and
// time". A date (2026-10-05), or a date-time with a "T" separator, with or without seconds,
// fractions and a zone, is accepted and passed through unchanged; anything else (12/08/2026, "next
// tuesday", a bare year, a Unix timestamp, a space instead of the "T") is refused locally rather
// than guessed. Date.parse alone is not enough: V8 rolls an impossible day such as 2026-02-30 over
// to 2 March instead of returning NaN, so the calendar fields are checked to round-trip as well.
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const isIsoDateTime = (v: string) => {
  const m = ISO_8601.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
};
const isoDateTime = (what: string) =>
  z
    .string()
    .trim()
    .refine(isIsoDateTime, {
      message: `${what} must be an ISO 8601 date or date-time, e.g. 2026-10-05 or 2026-10-05T09:00:00Z (a bare year, a Unix timestamp, 12/08/2026 or an impossible date such as 2026-02-30 are not accepted)`,
    });
const msOf = (iso: string) => Date.parse(iso);

// Timezone parameters must be "a valid, non-deprecated, IANA Timezone". The value must look like an
// IANA name (Area/Location, or a bare name such as UTC) and Node's Intl data decides whether it
// exists. The shape check matters because Intl also accepts offsets such as "+01:00" (ES2024), which
// are not IANA names; "deprecated" (Asia/Calcutta and the like) is not something this server can check.
const IANA_SHAPE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/;
const isIanaZone = (tz: string) => {
  if (!IANA_SHAPE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const timezone = (what: string) => z.string().trim().min(1).max(64).refine(isIanaZone, { message: "Timezones must be IANA names such as Europe/London or UTC (an offset such as +01:00 is not accepted)" }).optional().describe(what);

const ORDER = ["asc", "ascending", "desc", "descending"] as const;
const maxResults = (what: string, dflt: number, max: number) => z.number().int().min(1).max(max).default(dflt).describe(`Maximum number of ${what} to return`);
const startId = (what: string) => id(what).optional().describe(`ID of the first ${what.toLowerCase()} of the page to return: the next_start of a previous call`);
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}`);

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof AppointeddError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const listMeta = (r: { items: unknown[]; total?: number; complete: boolean; next_start?: string }) => ({
  count: r.items.length,
  total: r.total,
  complete: r.complete,
  next_start: r.next_start,
  note: r.complete ? undefined : `More results exist; call again with start "${r.next_start}" to continue.`,
});

// ---- Availability (two POST endpoints that are queries: they change nothing) ----

const parts = z
  .array(z.object({ type: z.enum(["block", "free"]), duration: z.number().int().min(1).max(1440).describe("Minutes") }))
  .min(1)
  .max(20)
  .optional()
  .describe("Parts of the potential booking (block = booked time, free = gap); when given, duration is ignored. Omit to use the service's own duration or parts");
const buffers = z.object({ before: z.number().int().min(0).max(1440).optional(), after: z.number().int().min(0).max(1440).optional() }).optional().describe("Minutes before/after a potential booking that must be free; omit to use the service's buffers");

const availabilityInput = {
  service_id: id("Service"),
  from: isoDateTime("from").describe("Start of the range to search (ISO 8601)"),
  to: isoDateTime("to").describe("End of the range to search (ISO 8601), after from"),
  resource_ids: ids("Resource").describe("Only these resources; omit for every resource assigned to the service"),
  resource_group_id: id("Resource group").optional().describe("Only resources in this resource group (the API's resource_group_ids field, which its spec types as a single string). Not with resource_ids"),
  duration: z.number().int().min(1).max(1440).optional().describe("Minutes that must be free from the start of an interval; omit to use the service's default duration"),
  parts,
  spaces: z.number().int().min(1).max(1000).optional().describe("Spaces required (excludes group bookings with fewer spaces left); the API defaults to 1"),
  buffers,
  timezone: timezone("IANA timezone to return the results in; the API defaults to Europe/London"),
  ignore_bookings: ids("Booking").describe("Booking IDs to ignore for this search (they neither block availability nor count as available group bookings)"),
  ignore_past_restriction: z.boolean().optional().describe("Do not exclude times before now"),
  ignore_notice_restriction: z.boolean().optional().describe("Ignore the organisation's and service's notice-period settings"),
  ignore_service_schedule: z.boolean().optional().describe("Ignore the service's schedule"),
  ignore_service_assignment: z.boolean().optional().describe("Do not fail when a resource is not assigned to the service"),
  ignore_group_setting: z.boolean().optional().describe("Return group bookings with space even if online group bookings are off"),
  max_results: maxResults("intervals", 200, 2000),
};
type AvailabilityArgs = { [K in keyof typeof availabilityInput]: z.infer<(typeof availabilityInput)[K]> } & { ignore_block_restriction?: boolean };

// Body shape: spec POST /availability/intervals/search and POST /availability/days/search (the two
// request schemas differ only in ignore_block_restriction, which the days search does not take).
function availabilityBody(a: AvailabilityArgs) {
  const problems: string[] = [];
  if (msOf(a.from) >= msOf(a.to)) problems.push(`"to" (${a.to}) must be after "from" (${a.from}).`);
  if (a.resource_ids && a.resource_group_id) problems.push("Give either resource_ids or resource_group_id, not both (the spec says they are mutually exclusive).");
  if (problems.length) throw new AppointeddError(`Not searched. ${problems.join(" ")}`);
  return {
    ranges: [{ start: a.from, end: a.to }],
    service_id: a.service_id,
    ...(a.resource_ids ? { resource_ids: a.resource_ids } : {}),
    ...(a.resource_group_id ? { resource_group_ids: a.resource_group_id } : {}),
    ...(a.duration !== undefined ? { duration: a.duration } : {}),
    ...(a.parts ? { parts: a.parts } : {}),
    ...(a.spaces !== undefined ? { spaces: a.spaces } : {}),
    ...(a.buffers ? { buffers: a.buffers } : {}),
    ...(a.timezone ? { timezone: a.timezone } : {}),
    ...(a.ignore_bookings ? { ignore_bookings: a.ignore_bookings } : {}),
    ...(a.ignore_past_restriction !== undefined ? { ignore_past_restriction: a.ignore_past_restriction } : {}),
    ...(a.ignore_notice_restriction !== undefined ? { ignore_notice_restriction: a.ignore_notice_restriction } : {}),
    ...(a.ignore_service_schedule !== undefined ? { ignore_service_schedule: a.ignore_service_schedule } : {}),
    ...(a.ignore_service_assignment !== undefined ? { ignore_service_assignment: a.ignore_service_assignment } : {}),
    ...(a.ignore_group_setting !== undefined ? { ignore_group_setting: a.ignore_group_setting } : {}),
    ...(a.ignore_block_restriction !== undefined ? { ignore_block_restriction: a.ignore_block_restriction } : {}),
  };
}

const availabilityResult = (res: any, maxItems: number) => {
  const all = Array.isArray(res?.data) ? res.data : [];
  return {
    count: Math.min(all.length, maxItems),
    total_returned_by_api: all.length,
    note: all.length > maxItems ? `The API returned ${all.length} results; only the first ${maxItems} are shown. Narrow the range or raise max_results.` : undefined,
    results: all.slice(0, maxItems).map(fmt.availability),
  };
};

server.registerTool(
  "find_available_intervals",
  {
    title: "Find available start times",
    description:
      "Available start times (intervals) for a service between two dates/times, with the resources free at each and any group bookings with space. This is a query sent as POST /availability/intervals/search; it changes nothing. Use one of the returned start times with create_reservation.",
    inputSchema: {
      ...availabilityInput,
      ignore_block_restriction: z.boolean().optional().describe("Ignore the organisation's 'block after' setting"),
    },
    annotations: READ,
  },
  safe(async (a) => availabilityResult(await api.request("POST", "/availability/intervals/search", { body: availabilityBody(a), readOnly: true }), a.max_results)),
);

server.registerTool(
  "find_available_dates",
  {
    title: "Find available dates",
    description:
      "Dates on which a service has availability between two dates/times, with the resources free on each. This is a query sent as POST /availability/days/search; it changes nothing. Use find_available_intervals for the start times within a date.",
    inputSchema: availabilityInput,
    annotations: READ,
  },
  safe(async (a) => availabilityResult(await api.request("POST", "/availability/days/search", { body: availabilityBody(a), readOnly: true }), a.max_results)),
);

// ---- Services ----

server.registerTool(
  "list_services",
  {
    title: "List services",
    description: "Services offered by this organisation: name, category, booking type, occupancy, durations with prices, buffers, and the booking questions asked. Emails and phone numbers in names, descriptions and question text are redacted unless include_contact_details is set.",
    inputSchema: {
      service_ids: ids("Service").describe("Only these services (the API's ids filter)"),
      max_results: maxResults("services", 100, 1000),
      start: startId("Service"),
      include_contact_details: includeContact("emails and phone numbers typed into service names, descriptions and question text"),
    },
    annotations: READ,
  },
  safe(async ({ service_ids, max_results, start, include_contact_details }) => {
    const r = await api.list("/services", { maxItems: max_results, maxPages: 20, start, query: { ids: service_ids } });
    return { ...listMeta(r), services: r.items.map((s) => fmt.service(s, include_contact_details)) };
  }),
);

server.registerTool(
  "get_service",
  {
    title: "Get a service",
    description: "One service by ID, with its booking settings (type, occupancy, durations and prices, buffers, group bookings) and booking questions.",
    inputSchema: { service_id: id("Service"), include_contact_details: includeContact("emails and phone numbers typed into the name, description and question text") },
    annotations: READ,
  },
  safe(async ({ service_id, include_contact_details }) => ({ service: fmt.service((await api.get(`/services/${service_id}`))?.data ?? {}, include_contact_details) })),
);

server.registerTool(
  "list_service_categories",
  {
    title: "List service categories",
    description: "Service categories (id and name) used to group services.",
    inputSchema: {
      category_ids: ids("Service category").describe("Only these categories (the API's ids filter)"),
      max_results: maxResults("categories", 100, 1000),
      start: startId("Service category"),
      include_contact_details: includeContact("emails and phone numbers typed into category names"),
    },
    annotations: READ,
  },
  safe(async ({ category_ids, max_results, start, include_contact_details }) => {
    const r = await api.list("/services/categories", { maxItems: max_results, maxPages: 20, start, query: { ids: category_ids } });
    return { ...listMeta(r), categories: r.items.map((c) => fmt.serviceCategory(c, include_contact_details)) };
  }),
);

// ---- Resources (staff, rooms, equipment) ----

server.registerTool(
  "list_resources",
  {
    title: "List resources (staff, rooms)",
    description:
      "Resources in the organisation (staff members, rooms, equipment) with the services each is assigned to and its resource groups. Filter by service to see who can deliver it. A resource's email, phone and address are only returned with include_contact_details.",
    inputSchema: {
      service_ids: ids("Service").describe("Only resources assigned to at least one of these services (the API's services filter)"),
      resource_ids: ids("Resource").describe("Only these resources (the API's ids filter)"),
      sort_by: z.enum(["natural", "creation"]).optional().describe("Sort property (the API defaults to natural)"),
      order_by: z.enum(ORDER).optional().describe("Sort direction (the API defaults to descending)"),
      max_results: maxResults("resources", 100, 1000),
      start: startId("Resource"),
      include_contact_details: includeContact("each resource's email, phone and address, and stop redacting emails and phone numbers in names and descriptions"),
    },
    annotations: READ,
  },
  safe(async ({ service_ids, resource_ids, sort_by, order_by, max_results, start, include_contact_details }) => {
    const r = await api.list("/resources", { maxItems: max_results, maxPages: 20, start, query: { services: service_ids, ids: resource_ids, sort_by, order_by } });
    return { ...listMeta(r), resources: r.items.map((x) => fmt.resource(x, include_contact_details)) };
  }),
);

server.registerTool(
  "list_resource_groups",
  {
    title: "List resource groups",
    description: "Resource groups (id and name), e.g. teams or locations that resources belong to. Useful as resource_group_id in the availability searches.",
    inputSchema: {
      group_ids: ids("Resource group").describe("Only these groups (the API's ids filter)"),
      order_by: z.enum(ORDER).optional().describe("Sort direction (the API defaults to descending; the only sort property is natural)"),
      max_results: maxResults("groups", 100, 1000),
      start: startId("Resource group"),
      include_contact_details: includeContact("emails and phone numbers typed into group names"),
    },
    annotations: READ,
  },
  safe(async ({ group_ids, order_by, max_results, start, include_contact_details }) => {
    const r = await api.list("/resources/groups", { maxItems: max_results, maxPages: 20, start, query: { ids: group_ids, order_by } });
    return { ...listMeta(r), groups: r.items.map((g) => fmt.resourceGroup(g, include_contact_details)) };
  }),
);

// ---- Bookings ----

server.registerTool(
  "list_bookings",
  {
    title: "List bookings",
    description:
      "Bookings with status, service, resource, times, price, spaces and participants (customer IDs, spaces, arrival status, source). Filter by a date range (after/before compare with the booking's start/end including buffers), creation or update time, status, service, category, resource, customer or booking IDs. Participants carry customer_id only; use get_customer for names. Customers' free-text answers and single-use reschedule links are withheld unless include_contact_details is set.",
    inputSchema: {
      after: isoDateTime("after").optional().describe("Only bookings that start at or after this date/time (ISO 8601)"),
      before: isoDateTime("before").optional().describe("Only bookings that end at or before this date/time (ISO 8601)"),
      created_after: isoDateTime("created_after").optional(),
      created_before: isoDateTime("created_before").optional(),
      updated_after: isoDateTime("updated_after").optional(),
      updated_before: isoDateTime("updated_before").optional(),
      status: z.enum(["confirmed", "declined", "cancelled", "pending"]).optional().describe("Only bookings with this status (the API's statuses parameter, typed as one value)"),
      booking_ids: ids("Booking").describe("Only these bookings (the API's ids filter); the API has no single-booking endpoint, so use this to fetch one booking"),
      service_ids: ids("Service").describe("Only bookings for these services"),
      category_ids: ids("Service category").describe("Only bookings whose service is in one of these categories"),
      customer_ids: ids("Customer").describe("Only bookings with one of these customers on them"),
      resource_ids: ids("Resource").describe("Only bookings for these resources"),
      return_matching_customers_only: z.boolean().optional().describe("The API's return_matching_customers_only flag: only list the participants whose customer IDs were given in the filter (useful for large group bookings)"),
      timezone: timezone("IANA timezone to return every date and time in; the documentation gives no default for this endpoint (its example shows +00:00 offsets)"),
      sort_by: z.enum(["natural", "creation", "updated", "start"]).optional().describe("Sort property (the API defaults to natural)"),
      order_by: z.enum(ORDER).optional().describe("Sort direction (the API defaults to descending)"),
      max_results: maxResults("bookings", 100, 2000),
      start: startId("Booking"),
      include_contact_details: includeContact("participants' question answers as stored, and each participant's single-use reschedule link"),
    },
    annotations: READ,
  },
  safe(async (a) => {
    if (a.after && a.before && msOf(a.after) >= msOf(a.before)) throw new AppointeddError(`Not searched. "before" (${a.before}) must be after "after" (${a.after}).`);
    const r = await api.list("/bookings", {
      maxItems: a.max_results,
      maxPages: 40,
      start: a.start,
      query: {
        after: a.after,
        before: a.before,
        created_after: a.created_after,
        created_before: a.created_before,
        updated_after: a.updated_after,
        updated_before: a.updated_before,
        statuses: a.status,
        ids: a.booking_ids,
        services: a.service_ids,
        categories: a.category_ids,
        customers: a.customer_ids,
        resources: a.resource_ids,
        return_matching_customers_only: a.return_matching_customers_only,
        timezone: a.timezone,
        sort_by: a.sort_by,
        order_by: a.order_by,
      },
    });
    return { ...listMeta(r), bookings: r.items.map((b) => fmt.booking(b, a.include_contact_details)) };
  }),
);

// ---- Customers ----

server.registerTool(
  "get_customer",
  {
    title: "Get a customer",
    description:
      "One customer by ID: name, tags, marketing opt-in, custom fields and, unless max_bookings is 0, their bookings with the latest start first. Email, mobile, phone and address are only returned with include_contact_details.",
    inputSchema: {
      customer_id: id("Customer"),
      max_bookings: z.number().int().min(0).max(100).default(10).describe("How many of the customer's bookings to include (0 for none)"),
      include_contact_details: includeContact("the customer's email, mobile, phone, address and gender, custom fields that look like contact data, and their question answers on bookings"),
    },
    annotations: READ,
  },
  safe(async ({ customer_id, max_bookings, include_contact_details }) => {
    const c = await api.get(`/customers/${customer_id}`);
    const out: Record<string, unknown> = { customer: fmt.customer(c?.data ?? {}, include_contact_details) };
    if (max_bookings > 0) {
      const r = await api.list("/bookings", { maxItems: max_bookings, maxPages: 1, query: { customers: [customer_id], sort_by: "start", order_by: "descending" } });
      out.bookings_total = r.total;
      out.bookings = r.items.map((b) => fmt.booking(b, include_contact_details));
    }
    return out;
  }),
);

server.registerTool(
  "find_customers",
  {
    title: "Find customers",
    description:
      "Search customers by part of their name, email, mobile or phone (UK numbers match with 0 or +44). The API has no search parameter, so this pages through the customer list (100 per call) up to max_pages. Names only by default; contact details with include_contact_details. Note that a match on an email or phone fragment still confirms that such a detail exists on the account.",
    inputSchema: {
      query: z.string().trim().min(2).max(200).describe("Name, email or phone fragment"),
      max_results: z.number().int().min(1).max(100).default(10),
      max_pages: z.number().int().min(1).max(50).default(10).describe("Pages of 100 customers to scan"),
      include_contact_details: includeContact("each match's email, mobile, phone, address and gender, and custom fields that look like contact data"),
    },
    annotations: READ,
  },
  safe(async ({ query, max_results, max_pages, include_contact_details }) => {
    const q = query.toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const qTail = qDigits.slice(-9); // lets 07700 900123 match +44 7700 900123
    const { items, complete } = await api.list("/customers", { maxItems: max_pages * PAGE_SIZE, maxPages: max_pages });
    const matches = items
      .filter((c) => {
        const p = c.profile ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ").toLowerCase();
        const phones = [p.mobile, p.phone].map((x) => String(x ?? "").replace(/\D/g, ""));
        return (
          name.includes(q) ||
          String(p.email ?? "").toLowerCase().includes(q) ||
          (qDigits.length >= 5 && phones.some((ph) => ph.includes(qDigits) || (qTail.length >= 7 && ph.endsWith(qTail))))
        );
      })
      .slice(0, max_results)
      .map((c) => fmt.customer(c, include_contact_details));
    return {
      matches,
      customers_scanned: items.length,
      note: complete ? undefined : `Only the first ${items.length} customers were scanned; raise max_pages to search further.`,
    };
  }),
);

// ---- Writes ----

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    "create_reservation",
    {
      title: "Reserve a slot",
      description:
        "Hold a start time for a service (and optionally a resource) so it cannot be double-booked while the booking details are collected. Use a start time returned by find_available_intervals; the API answers 404 when that time is not available. The hold expires after the organisation's reservation setting (or expires_after minutes) and is single use: pass its id to create_booking. If Appointedd answers with a gateway error (502/503/504) the request is NOT retried. Only available when APPOINTEDD_ALLOW_WRITES=true.",
      inputSchema: {
        service_id: id("Service"),
        start: isoDateTime("start").describe("Start date and time of the reservation (ISO 8601), from find_available_intervals"),
        resource_id: id("Resource").optional().describe("Resource to assign; omit to let the API pick one assigned to the service"),
        resource_group_ids: ids("Resource group").describe("Without resource_id: restrict the API's choice to resources in at least one of these groups"),
        timezone: timezone("IANA timezone that start is expressed in; the API defaults to Europe/London (give start with a zone offset or Z to avoid ambiguity)"),
        expires_after: z.number().int().min(1).max(1440).optional().describe("Minutes until the reservation expires; omit for the organisation's setting"),
        required_spaces: z.number().int().min(1).max(1000).optional().describe("Spaces this reservation needs (the API defaults to 1)"),
        max_spaces: z.number().int().min(1).max(1000).optional().describe("Maximum spaces the resulting booking can hold; omit for the service's setting"),
        allow_additional_spaces: z.boolean().optional().describe("Let other reservations join this one (the resulting booking becomes a group booking); omit for the service's online group booking setting"),
        parts,
        ignore_past_restriction: z.boolean().optional(),
        ignore_notice_restriction: z.boolean().optional(),
        ignore_block_restriction: z.boolean().optional(),
        ignore_service_schedule: z.boolean().optional(),
        ignore_group_setting: z.boolean().optional(),
        response_timezone: timezone("IANA timezone to return the reservation's times in"),
      },
      annotations: WRITE,
    },
    safe(async (a) => {
      // Body shape: spec POST /availability/slots.
      const body = {
        ...(a.ignore_past_restriction !== undefined ? { ignore_past_restriction: a.ignore_past_restriction } : {}),
        ...(a.ignore_notice_restriction !== undefined ? { ignore_notice_restriction: a.ignore_notice_restriction } : {}),
        ...(a.ignore_block_restriction !== undefined ? { ignore_block_restriction: a.ignore_block_restriction } : {}),
        ...(a.ignore_service_schedule !== undefined ? { ignore_service_schedule: a.ignore_service_schedule } : {}),
        ...(a.ignore_group_setting !== undefined ? { ignore_group_setting: a.ignore_group_setting } : {}),
        ...(a.response_timezone ? { timezone: a.response_timezone } : {}),
        data: {
          service_id: a.service_id,
          start: a.start,
          ...(a.resource_id ? { resource_id: a.resource_id } : {}),
          ...(a.resource_group_ids ? { resource_group_ids: a.resource_group_ids } : {}),
          ...(a.timezone ? { timezone: a.timezone } : {}),
          ...(a.expires_after !== undefined ? { expires_after: a.expires_after } : {}),
          ...(a.required_spaces !== undefined ? { required_spaces: a.required_spaces } : {}),
          ...(a.max_spaces !== undefined ? { max_spaces: a.max_spaces } : {}),
          ...(a.allow_additional_spaces !== undefined ? { allow_additional_spaces: a.allow_additional_spaces } : {}),
          ...(a.parts ? { parts: a.parts } : {}),
        },
      };
      const res = await api.request("POST", "/availability/slots", { body });
      return { result: "reserved", reservation: fmt.reservation(res?.data ?? {}) };
    }),
  );

  const customerOnBooking = z.object({
    first_name: z.string().trim().min(1).max(200),
    last_name: z.string().trim().min(1).max(200),
    email: z.string().email().optional(),
    mobile: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, "Mobile numbers are digits with an optional leading +, e.g. +447700900123").optional(),
    marketing_subscribed: z.boolean().optional().describe("The customer has agreed to marketing emails (the API defaults to false)"),
    custom_fields: z.array(z.object({ id: id("Custom field"), value: z.string().max(2000) })).max(50).optional().describe("CRM custom field values by custom field ID"),
    booking_source: z.string().trim().min(1).max(100).optional().describe("Recorded as the source that added this customer (the API defaults to \"api\")"),
    locale: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "ISO 639 language code, e.g. en or en-GB").optional(),
    notes: z.string().max(4000).optional().describe("Free-text notes for this customer on this booking"),
    questions: z.array(z.object({ label: z.string().min(1).max(500), value: z.string().max(2000).optional(), type: z.enum(["text", "checkbox", "dropdown", "terms"]).optional() })).max(50).optional().describe("Booking questions asked and the answers given"),
    status: z.enum(["Arrived", "Complete", "No Show", "No Status"]).optional().describe("Arrival status (the API defaults to No Status)"),
    timezone: timezone("IANA timezone the customer booked in; omit for the booking's timezone"),
    total_spaces: z.number().int().min(1).max(1000).optional().describe("Spaces this customer takes (the API defaults to 1)"),
  });

  server.registerTool(
    "create_booking",
    {
      title: "Create a booking from a reservation",
      description:
        "Turn an active reservation (from create_reservation) into a booking, adding zero or more customers. The API matches each customer to an existing customer by name, email and/or mobile, or creates one. send_payment_request defaults to false here (the API's own default is true); set it to true to email each customer a payment request. If Appointedd answers with a gateway error (502/503/504) the request is NOT retried, because the booking may already exist: check with list_bookings first. Only available when APPOINTEDD_ALLOW_WRITES=true.",
      inputSchema: {
        reservation_id: id("Reservation").describe("The id returned by create_reservation (the API's slot_id); single use"),
        customers: z.array(customerOnBooking).max(100).default([]).describe("Customers to put on the booking; an empty list creates an empty booking"),
        send_payment_request: z.boolean().default(false).describe("Send a payment request to each customer (defaults to false here; the API's default is true)"),
        created_source: z.string().trim().min(1).max(100).optional().describe("Recorded as the source that created the booking (the API defaults to \"api\")"),
        label: z.string().trim().min(1).max(200).optional().describe("Label shown on the booking in the Appointedd appointment screen"),
        timezone: timezone("IANA timezone to return the booking's times in; the API defaults to UTC"),
        include_contact_details: includeContact("the participants' question answers as stored, and their single-use reschedule links, in the result"),
      },
      annotations: WRITE,
    },
    safe(async ({ reservation_id, customers, send_payment_request, created_source, label, timezone, include_contact_details }) => {
      // Body shape: spec POST /bookings (data.customers is an array; the "Creating a new booking"
      // guide's example uses a singular data.customer, see README Status).
      const body = {
        slot_id: reservation_id,
        send_payment_request,
        ...(timezone ? { timezone } : {}),
        data: {
          ...(created_source ? { created_source } : {}),
          ...(label ? { label } : {}),
          customers: customers.map((c) => ({
            customer: {
              profile: { firstname: c.first_name, lastname: c.last_name, ...(c.email ? { email: c.email } : {}), ...(c.mobile ? { mobile: c.mobile } : {}) },
              ...(c.marketing_subscribed !== undefined ? { marketing_subscribed: c.marketing_subscribed } : {}),
              ...(c.custom_fields?.length ? { custom_fields: c.custom_fields } : {}),
            },
            ...(c.booking_source ? { booking_source: c.booking_source } : {}),
            ...(c.locale ? { locale: c.locale } : {}),
            ...(c.notes ? { notes: c.notes } : {}),
            ...(c.questions?.length ? { questions: c.questions } : {}),
            ...(c.status ? { status: c.status } : {}),
            ...(c.timezone ? { timezone: c.timezone } : {}),
            ...(c.total_spaces !== undefined ? { total_spaces: c.total_spaces } : {}),
          })),
        },
      };
      const res = await api.request("POST", "/bookings", { body });
      return { result: "booked", booking: fmt.booking(res?.data ?? {}, include_contact_details) };
    }),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel a booking",
      description:
        "Cancel a booking and every customer's place on it (to cancel one customer on a group booking, Appointedd has a separate endpoint this server does not expose). Cannot be undone. The API answers 422 if the booking is already cancelled. Only available when APPOINTEDD_ALLOW_WRITES=true.",
      inputSchema: {
        booking_id: id("Booking"),
        source: z.string().trim().min(1).max(100).default("api").describe("Recorded as the source that cancelled the booking"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ booking_id, source }) => {
      // Body shape: spec POST /bookings/{booking_id}/cancel; a 204 means done.
      await api.request("POST", `/bookings/${booking_id}/cancel`, { body: { source } });
      return { result: "cancelled", booking_id };
    }),
  );

  const customerProfile = {
    email: z.string().email().optional().describe("Used for email communications"),
    mobile: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, "Mobile numbers are digits with an optional leading +, e.g. +447700900123").optional().describe("Used for SMS communications"),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, "Phone numbers are digits with an optional leading +").optional().describe("Landline; SMS goes to mobile only"),
  };

  server.registerTool(
    "create_customer",
    {
      title: "Create a customer",
      description: "Add a customer to the organisation's CRM with a name and optional email, mobile, phone and tags. The result carries the new customer's ID and name; the contact details are returned only with include_contact_details, like every other customer-returning tool. Only available when APPOINTEDD_ALLOW_WRITES=true.",
      inputSchema: {
        first_name: z.string().trim().min(1).max(200),
        last_name: z.string().trim().min(1).max(200),
        ...customerProfile,
        tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
        include_contact_details: includeContact("the customer's contact details in the result"),
      },
      annotations: WRITE,
    },
    safe(async ({ first_name, last_name, email, mobile, phone, tags, include_contact_details }) => {
      // Body shape: spec POST /customers.
      const body = {
        data: {
          ...(tags?.length ? { tags } : {}),
          profile: { firstname: first_name, lastname: last_name, ...(email ? { email } : {}), ...(mobile ? { mobile } : {}), ...(phone ? { phone } : {}) },
        },
      };
      const res = await api.request("POST", "/customers", { body });
      return { result: "created", customer: fmt.customer(res?.data ?? {}, include_contact_details) };
    }),
  );

  server.registerTool(
    "update_customer",
    {
      title: "Update a customer",
      description: "Change a customer's name, email, mobile, phone or tags. Only the fields given are sent; tags, when given, REPLACE the customer's existing tags. Only available when APPOINTEDD_ALLOW_WRITES=true.",
      inputSchema: {
        customer_id: id("Customer"),
        first_name: z.string().trim().min(1).max(200).optional(),
        last_name: z.string().trim().min(1).max(200).optional(),
        ...customerProfile,
        tags: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe("Replaces all existing tags"),
        include_contact_details: includeContact("the customer's full contact details in the result"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ customer_id, first_name, last_name, email, mobile, phone, tags, include_contact_details }) => {
      const profile = { ...(first_name ? { firstname: first_name } : {}), ...(last_name ? { lastname: last_name } : {}), ...(email ? { email } : {}), ...(mobile ? { mobile } : {}), ...(phone ? { phone } : {}) };
      if (Object.keys(profile).length === 0 && tags === undefined) throw new AppointeddError("Not updated. Give at least one of first_name, last_name, email, mobile, phone or tags.");
      // Body shape: spec PUT /customers/{customer_id}.
      const body = { data: { ...(tags !== undefined ? { tags } : {}), ...(Object.keys(profile).length ? { profile } : {}) } };
      const res = await api.request("PUT", `/customers/${customer_id}`, { body });
      return { result: "updated", customer: fmt.customer(res?.data ?? {}, include_contact_details) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Appointedd MCP server running against ${baseUrl} (writes ${allowWrites ? "enabled" : "disabled"}).`);

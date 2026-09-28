// End-to-end test: fixtures are validated against Appointedd's published OpenAPI schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, API_KEY } from "./mock-server.mjs";
import { assembleSpec, REFERENCE_URL } from "./assemble-spec.mjs";
import { looksLikeContactField } from "../dist/format.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
// Appointedd publishes one OpenAPI definition per reference page; spec.json is assembled from them.
if (!existsSync(`${root}spec.json`)) {
  try {
    const r = await assembleSpec(`${root}spec.json`);
    console.log(`Assembled spec.json from ${REFERENCE_URL}: ${r.pages} pages with a definition, ${r.operations} operations.`);
  } catch (err) {
    console.error(`Could not assemble the Appointedd spec (${err?.cause?.code ?? err.message}). Build it manually:\n  node test/assemble-spec.mjs`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
// The definitions carry no component schemas: every request and response schema is inline in its
// operation, so they are compiled from the spec's paths directly.
const compiled = new Map();
const compile = (schema) => {
  const key = JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, ajv.compile(schema));
  return compiled.get(key);
};
const validateWith = (schema, obj, label) => {
  const v = compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const op = (method, path) => {
  const o = spec.paths[path]?.[method];
  assert.ok(o, `spec has no ${method.toUpperCase()} ${path}`);
  return o;
};
const responseSchema = (method, path, status) => op(method, path).responses[status].content["application/json"].schema;
const requestSchema = (method, path) => op(method, path).requestBody.content["application/json"].schema;
const itemSchema = (method, path, status = "200") => responseSchema(method, path, status).properties.data.items;
const dataSchema = (method, path, status = "200") => responseSchema(method, path, status).properties.data;

console.log("fixtures vs OpenAPI spec");
await check("bookings, customers, services, categories, resources, resource groups, availability, reservation, created booking and customer", async () => {
  fx.bookings.forEach((b) => validateWith(itemSchema("get", "/bookings"), b, `booking ${b.id}`));
  fx.customers.forEach((c) => validateWith(itemSchema("get", "/customers"), c, `customer ${c.id}`));
  fx.customers.forEach((c) => validateWith(dataSchema("get", "/customers/{customer_id}"), c, `customer ${c.id} (get)`));
  fx.services.forEach((s) => validateWith(itemSchema("get", "/services"), s, `service ${s.id}`));
  fx.services.forEach((s) => validateWith(dataSchema("get", "/services/{service_id}"), s, `service ${s.id} (get)`));
  fx.categories.forEach((c) => validateWith(itemSchema("get", "/services/categories"), c, `category ${c.id}`));
  fx.resources.forEach((r) => validateWith(itemSchema("get", "/resources"), r, `resource ${r.id}`));
  fx.resourceGroups.forEach((g) => validateWith(itemSchema("get", "/resources/groups"), g, `resource group ${g.id}`));
  Object.values(fx.intervals).flat().forEach((i) => validateWith(itemSchema("post", "/availability/intervals/search"), i, `interval ${i.start}`));
  Object.values(fx.days).flat().forEach((d) => validateWith(itemSchema("post", "/availability/days/search"), d, `day ${d.start}`));
  validateWith(dataSchema("post", "/availability/slots", "201"), fx.reservation, "reservation");
  validateWith(dataSchema("get", "/availability/slots/{reservation_id}"), fx.reservation, "reservation (get)");
  const booking = fx.createdBooking(fx.reservation, { data: { customers: [{ customer: { profile: { firstname: "Jo", lastname: "Bloggs" } } }] } });
  validateWith(dataSchema("post", "/bookings", "201"), booking, "created booking");
  validateWith(dataSchema("post", "/customers", "201"), fx.createdCustomer({ data: { profile: { firstname: "Ada", lastname: "Lovelace", email: "ada@example.org" } } }), "created customer");
  validateWith(dataSchema("put", "/customers/{customer_id}"), fx.updatedCustomer(fx.customers[0], { data: { tags: ["x"] } }), "updated customer");
});

// 2. The mock's responses (lists, single records, actions, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, reservations, cancelled } = await startMock();
const base = `http://127.0.0.1:${port}/v1`;
const raw = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { "X-API-KEY": API_KEY, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
};
await check("mock responses match the documented list, detail, action and error schemas, with range-based pagination", async () => {
  // The response schemas mark nothing as required, so assert the documented pagination keys explicitly.
  const listKeys = (obj) => ["data", "total", "prev", "next"].forEach((k) => assert.ok(k in obj, `list response is missing "${k}"`));
  // The Pagination page documents prev and next as null on the first and last page (and the categories,
  // resources and resource-groups examples show "next": null), but the bookings, customers and services
  // schemas type next as a string. The mock follows the documented behaviour; a null prev/next is dropped
  // before validating against the schema, everything else is validated as served.
  const validateList = (schema, obj, label) => {
    listKeys(obj);
    validateWith(schema, Object.fromEntries(Object.entries(obj).filter(([k, v]) => !((k === "prev" || k === "next") && v === null))), label);
  };
  const page1 = (await raw("GET", "/bookings?limit=3")).json;
  validateList(responseSchema("get", "/bookings", "200"), page1, "GET /bookings");
  assert.deepEqual([page1.data.length, page1.total, page1.prev, page1.next], [3, 7, null, fx.BK_CANCELLED], "first page of three, newest-first by default, next = ID of the first booking of the next page");
  const page2 = (await raw("GET", `/bookings?limit=3&start=${page1.next}`)).json;
  assert.deepEqual([page2.data[0].id, page2.prev, page2.next], [fx.BK_CANCELLED, fx.BK_PENDING, fx.BK_HAIRCUT_JO], "start = next gives the next page; prev = ID of the last booking of the previous page");
  const back = (await raw("GET", `/bookings?limit=3&end=${page2.prev}`)).json;
  assert.deepEqual(back.data.map((b) => b.id), page1.data.map((b) => b.id), "end = prev gives the previous page");
  const last = (await raw("GET", `/bookings?limit=3&start=${page2.next}`)).json;
  assert.deepEqual([last.data.length, last.next], [1, null]);
  validateList(responseSchema("get", "/bookings", "200"), last, "GET /bookings (last page)");
  const customers = (await raw("GET", "/customers?limit=100")).json;
  validateList(responseSchema("get", "/customers", "200"), customers, "GET /customers");
  assert.deepEqual([customers.data.length, customers.total], [50, 121], "the mock caps customers at 50 per page");
  validateWith(responseSchema("get", "/customers/{customer_id}", "200"), (await raw("GET", `/customers/${fx.CUST_JO}`)).json, "GET /customers/{id}");
  const services = (await raw("GET", "/services")).json;
  validateList(responseSchema("get", "/services", "200"), services, "GET /services");
  validateWith(responseSchema("get", "/services/{service_id}", "200"), (await raw("GET", `/services/${fx.SVC_HAIRCUT}`)).json, "GET /services/{id}");
  const categories = (await raw("GET", "/services/categories")).json;
  validateList(responseSchema("get", "/services/categories", "200"), categories, "GET /services/categories");
  const resources = (await raw("GET", "/resources")).json;
  validateList(responseSchema("get", "/resources", "200"), resources, "GET /resources");
  const limited = await raw("GET", "/resources/groups"); // the mock answers the first resource-groups call with a 429
  assert.equal(limited.status, 429);
  const groups = (await raw("GET", "/resources/groups")).json;
  validateList(responseSchema("get", "/resources/groups", "200"), groups, "GET /resources/groups");
  const search = { ranges: [{ start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z" }], service_id: fx.SVC_HAIRCUT };
  validateWith(requestSchema("post", "/availability/intervals/search"), search, "intervals search body");
  const intervals = await raw("POST", "/availability/intervals/search", search);
  assert.equal(intervals.status, 200);
  validateWith(responseSchema("post", "/availability/intervals/search", "200"), intervals.json, "POST /availability/intervals/search");
  assert.equal(intervals.json.data.length, 3);
  const daysRes = await raw("POST", "/availability/days/search", search);
  validateWith(responseSchema("post", "/availability/days/search", "200"), daysRes.json, "POST /availability/days/search");
  const reserve = { data: { service_id: fx.SVC_HAIRCUT, resource_id: fx.RES_SAM, start: fx.AVAILABLE_START } };
  validateWith(requestSchema("post", "/availability/slots"), reserve, "reservation body");
  const reserved = await raw("POST", "/availability/slots", reserve);
  assert.equal(reserved.status, 201);
  validateWith(responseSchema("post", "/availability/slots", "201"), reserved.json, "POST /availability/slots 201");
  const noSlot = await raw("POST", "/availability/slots", { data: { service_id: fx.SVC_HAIRCUT, start: "2026-10-05T03:00:00Z" } });
  assert.equal(noSlot.status, 404);
  validateWith(responseSchema("post", "/availability/slots", "404"), noSlot.json, "POST /availability/slots 404");
  const book = { slot_id: reserved.json.data.id, data: { customers: [{ customer: { profile: { firstname: "Jo", lastname: "Bloggs", email: "jo.bloggs@example.com" } } }] } };
  validateWith(requestSchema("post", "/bookings"), book, "booking body");
  const booked = await raw("POST", "/bookings", book);
  assert.equal(booked.status, 201);
  validateWith(responseSchema("post", "/bookings", "201"), booked.json, "POST /bookings 201");
  const reused = await raw("POST", "/bookings", book);
  assert.equal(reused.status, 422, "a reservation is single use");
  validateWith(responseSchema("post", "/bookings", "422"), reused.json, "POST /bookings 422");
  assert.equal((await raw("POST", `/bookings/${fx.BK_PENDING}/cancel`, { source: "api" })).status, 204);
  const already = await raw("POST", `/bookings/${fx.BK_CANCELLED}/cancel`, { source: "api" });
  assert.equal(already.status, 422);
  validateWith(responseSchema("post", "/bookings/{booking_id}/cancel", "422"), already.json, "POST /bookings/{id}/cancel 422");
  const newCustomer = { data: { tags: ["Engineer"], profile: { firstname: "Ada", lastname: "Lovelace", email: "ada@example.org" } } };
  validateWith(requestSchema("post", "/customers"), newCustomer, "customer body");
  const created = await raw("POST", "/customers", newCustomer);
  assert.equal(created.status, 201);
  validateWith(responseSchema("post", "/customers", "201"), created.json, "POST /customers 201");
  const badCustomer = await raw("POST", "/customers", { data: { profile: { firstname: "Ada" } } });
  assert.equal(badCustomer.status, 400);
  validateWith(responseSchema("post", "/customers", "400"), badCustomer.json, "POST /customers 400");
  validateWith(responseSchema("put", "/customers/{customer_id}", "200"), (await raw("PUT", `/customers/${fx.CUST_ADA}`, { data: { tags: ["Engineer", "English"] } })).json, "PUT /customers/{id} 200");
  const missing = await raw("GET", `/services/${"0".repeat(24)}`);
  assert.equal(missing.status, 404);
  validateWith(responseSchema("get", "/services/{service_id}", "404"), missing.json, "GET /services/{id} 404");
  const badId = await raw("GET", "/customers/not-hex");
  assert.equal(badId.status, 400);
  validateWith(responseSchema("get", "/customers/{customer_id}", "400"), badId.json, "GET /customers/{id} 400");
  const badLimit = await raw("GET", "/services?limit=0");
  assert.equal(badLimit.status, 400);
  validateWith(responseSchema("get", "/services", "400"), badLimit.json, "GET /services 400");
  assert.equal((await fetch(base + "/services", { headers: { "X-API-KEY": "wrong" } })).status, 401);
});
requests.length = 0; // only count what the MCP server does from here on
reservations.clear(); // the raw checks above held and used slots and cancelled a booking; start the MCP run clean
cancelled.clear();
cancelled.add(fx.BK_CANCELLED);
arm429();

// 3. Drive the server through MCP. `writes` is the literal APPOINTEDD_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ key = API_KEY, writes = "true" } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, APPOINTEDD_API_KEY: key, APPOINTEDD_BASE_URL: base };
  delete env.APPOINTEDD_ALLOW_WRITES;
  if (writes !== null) env.APPOINTEDD_ALLOW_WRITES = writes;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [`${root}dist/index.js`],
      env,
      stderr: "ignore",
    }),
  );
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const WRITES = ["cancel_booking", "create_booking", "create_customer", "create_reservation", "update_customer"];
const READS = ["find_available_dates", "find_available_intervals", "find_customers", "get_customer", "get_service", "list_bookings", "list_resource_groups", "list_resources", "list_service_categories", "list_services"];
const NO_LEAK = ["@example", "07700 900", "7700900", "0117 496", "0117) 496", "7700 900789", "448787981295", "reschedule.appointedd.com", "Plymouth Road", "CF64", "BS1 1AA", "High Street"];
const noLeak = (text, what) => {
  for (const leak of NO_LEAK) assert.ok(!text.includes(leak), `${leak} leaked in ${what}`);
};

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 15 tools; reads (including the two availability POSTs) are read-only, cancel_booking destructive, update_customer idempotent", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...WRITES, ...READS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, READS.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITES.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "cancel_booking", `${t.name} destructiveHint`);
  }
  assert.equal(tools.find((t) => t.name === "update_customer").annotations.idempotentHint, true);
  assert.equal(tools.find((t) => t.name === "create_booking").annotations.idempotentHint, false);
});

await check("list_services returns durations, buffers and booking questions, redacts descriptions by default and passes the ids filter through", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_services");
  assert.deepEqual(since(n).map((r) => [r.path, r.query.limit, r.query.start, r.query.ids]), [["/services", "100", undefined, undefined]]);
  assert.deepEqual([data.count, data.total, data.complete, data.next_start, data.note], [3, 3, true, undefined, undefined]);
  const haircut = data.services[0];
  assert.deepEqual([haircut.id, haircut.name, haircut.category_id, haircut.description], [fx.SVC_HAIRCUT, "Haircut", fx.CAT_HAIR, "Wash, cut and finish."]);
  assert.deepEqual(haircut.booking, { type: "ONLINE_BOOKING", occupancy: 1, allow_group: false, buffers: { before: 0, after: 0 }, durations: [{ minutes: 30, price: 25, old_price: 0, default: true }, { minutes: 45, price: 35, old_price: 0, default: false }], tiers: 0 });
  assert.deepEqual(haircut.booking_questions.map((q) => [q.name, q.type, q.options?.map((o) => o.value), q.subquestions?.map((s) => s.name)]), [["Any allergies? (or email [email redacted])", "text", [], []], ["How did you hear about us?", "dropdown", ["Friend", "Search ([email redacted])"], ["Which friend?"]]], "question labels and options are redacted by default");
  assert.equal(data.services[1].description, "60 minutes. Questions? Call [phone redacted] or email [email redacted].", "the organisation's own description text is redacted by default");
  assert.deepEqual([data.services[2].booking.occupancy, data.services[2].booking.allow_group, data.services[2].description], [10, true, undefined]);
  noLeak(JSON.stringify(data), "list_services");
  const asStored = await call(client, "list_services", { include_contact_details: true, service_ids: [fx.SVC_MASSAGE] });
  assert.equal(asStored.data.services[0].description, fx.services[1].description);
  assert.deepEqual([requests.at(-1).query.ids, asStored.data.count], [fx.SVC_MASSAGE, 1], "ids filter sent as the documented query parameter");
  const questionsRaw = await call(client, "list_services", { include_contact_details: true, service_ids: [fx.SVC_HAIRCUT] });
  assert.deepEqual([questionsRaw.data.services[0].booking_questions[0].name, questionsRaw.data.services[0].booking_questions[1].options[1].value], ["Any allergies? (or email allergies@example.com)", "Search (ads@example.com)"]);
  const two = await call(client, "list_services", { service_ids: [fx.SVC_MASSAGE, fx.SVC_YOGA] });
  assert.deepEqual(requests.at(-1).query.ids, [fx.SVC_MASSAGE, fx.SVC_YOGA], "an array filter is sent as the key repeated once per value (OpenAPI form/explode default)");
  assert.equal(two.data.count, 2);
});

await check("get_service returns one service; an unknown ID gives the documented 404 message", async () => {
  const { data } = await call(client, "get_service", { service_id: fx.SVC_YOGA });
  assert.equal(requests.at(-1).path, `/services/${fx.SVC_YOGA}`);
  assert.deepEqual([data.service.id, data.service.name, data.service.booking.occupancy, data.service.booking_questions], [fx.SVC_YOGA, "Group yoga class", 10, undefined]);
  const missing = await call(client, "get_service", { service_id: "0".repeat(24) });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/services\/0{24}\. Check the ID\. Not Found ID does not exist$/);
});

await check("list_service_categories and list_resource_groups (after a 429 retry that waits for Retry-After) list ids and names, redacting emails and phone numbers in names", async () => {
  const cats = await call(client, "list_service_categories");
  assert.deepEqual(cats.data.categories, [{ id: fx.CAT_HAIR, name: "Hair" }, { id: fx.CAT_MASSAGE, name: "Massage & wellbeing (ask [email redacted])" }]);
  const catsRaw = await call(client, "list_service_categories", { category_ids: [fx.CAT_MASSAGE], include_contact_details: true });
  assert.deepEqual([requests.at(-1).query.ids, catsRaw.data.categories[0].name], [fx.CAT_MASSAGE, fx.categories[1].name]);
  const n = requests.length;
  const groups = await call(client, "list_resource_groups");
  const tries = since(n).filter((r) => r.path === "/resources/groups");
  assert.equal(tries.length, 2, "resource groups should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(groups.data.groups.map((g) => g.name), ["Rooms (keys: [phone redacted])", "Therapists", "Stylists"], "the API's default order is descending; a phone number in a group name is redacted");
  assert.deepEqual([groups.data.total, groups.data.complete], [3, true]);
  const asc = await call(client, "list_resource_groups", { order_by: "ascending", group_ids: [fx.GRP_STYLISTS, fx.GRP_ROOMS] });
  assert.deepEqual([requests.at(-1).query.order_by, requests.at(-1).query.ids], ["ascending", [fx.GRP_STYLISTS, fx.GRP_ROOMS]]);
  assert.deepEqual(asc.data.groups.map((g) => g.name), ["Stylists", "Rooms (keys: [phone redacted])"]);
  const groupsRaw = await call(client, "list_resource_groups", { group_ids: [fx.GRP_ROOMS], include_contact_details: true });
  assert.equal(groupsRaw.data.groups[0].name, "Rooms (keys: 07700 900999)");
});

await check("list_resources passes the services filter and sort through as documented and withholds staff contact details unless asked", async () => {
  const { data } = await call(client, "list_resources", { service_ids: [fx.SVC_HAIRCUT], sort_by: "creation", order_by: "asc" });
  assert.deepEqual([requests.at(-1).query.services, requests.at(-1).query.sort_by, requests.at(-1).query.order_by, requests.at(-1).query.ids], [fx.SVC_HAIRCUT, "creation", "asc", undefined]);
  assert.deepEqual(data.resources.map((r) => r.name), ["Sam Evans"]);
  const sam = data.resources[0];
  assert.deepEqual([sam.id, sam.description, sam.service_ids, sam.resource_group_ids, sam.email, sam.phone, sam.address], [fx.RES_SAM, "Senior stylist, direct line [phone redacted]", [fx.SVC_HAIRCUT, fx.SVC_YOGA], [fx.GRP_STYLISTS], undefined, undefined, undefined], "a phone number in a resource description is redacted by default");
  const all = await call(client, "list_resources", { order_by: "ascending" });
  assert.deepEqual(all.data.resources.map((r) => r.name), ["Sam Evans", "Priya Shah", "Studio 1 (call [phone redacted] to unlock)"], "a phone number typed into a resource name is redacted by default");
  noLeak(JSON.stringify(all.data), "list_resources");
  const withContact = await call(client, "list_resources", { resource_ids: [fx.RES_SAM, fx.RES_PRIYA], order_by: "ascending", include_contact_details: true });
  assert.deepEqual(requests.at(-1).query.ids, [fx.RES_SAM, fx.RES_PRIYA]);
  assert.deepEqual([withContact.data.resources[0].email, withContact.data.resources[0].phone, withContact.data.resources[0].description, withContact.data.resources[0].address], ["sam.evans@example.com", "07700 900321", "Senior stylist, direct line 07700 900321", { house_no: "12", address_1: "High Street", city: "Bristol", postcode: "BS1 1AA" }]);
  assert.deepEqual([withContact.data.resources[1].email, withContact.data.resources[1].phone, withContact.data.resources[1].address], ["priya.shah@example.com", undefined, {}]);
});

await check("list_bookings pages with limit and start = next until next is null, and sorts as asked", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_bookings");
  const pages = since(n);
  assert.deepEqual(pages.map((r) => [r.path, r.query.limit, r.query.start]), [["/bookings", "100", undefined], ["/bookings", "97", fx.BK_CANCELLED], ["/bookings", "94", fx.BK_HAIRCUT_JO]], "three pages: the mock serves three per page; start carries the previous page's next; limit is what is still wanted");
  assert.deepEqual([data.count, data.total, data.complete, data.next_start, data.note], [7, 7, true, undefined, undefined]);
  assert.deepEqual(data.bookings.map((b) => b.id), [fx.BK_PAST, fx.BK_MASSAGE_JO, fx.BK_PENDING, fx.BK_CANCELLED, fx.BK_YOGA, fx.BK_MASSAGE_PRIYA, fx.BK_HAIRCUT_JO], "the API's default order (natural, descending) is kept");
  const byStart = await call(client, "list_bookings", { sort_by: "start", order_by: "ascending" });
  assert.deepEqual([requests.at(-1).query.sort_by, requests.at(-1).query.order_by], ["start", "ascending"]);
  assert.deepEqual(byStart.data.bookings.map((b) => b.id), [fx.BK_PAST, fx.BK_HAIRCUT_JO, fx.BK_MASSAGE_PRIYA, fx.BK_YOGA, fx.BK_CANCELLED, fx.BK_PENDING, fx.BK_MASSAGE_JO]);
  const b = byStart.data.bookings[1];
  assert.deepEqual([b.status, b.service_id, b.resource_id, b.start, b.end, b.end_buffer, b.price, b.total_spaces, b.spaces_booked, b.created_source, b.video_conference_link], ["confirmed", fx.SVC_HAIRCUT, fx.RES_SAM, "2026-10-05T09:00:00.000+00:00", "2026-10-05T09:30:00.000+00:00", "2026-10-05T09:30:00.000+00:00", 25, 1, 1, "online_booking", undefined]);
  assert.deepEqual([byStart.data.bookings[2].video_conference_type_name, byStart.data.bookings[2].video_conference_link, byStart.data.bookings[2].end_buffer], ["microsoft", fx.bookings[1].video_conference_link, "2026-10-05T11:15:00.000+00:00"], "the organisation's own meeting link is returned as stored");
});

await check("list_bookings honours max_results with an exact continuation: following next_start yields every booking exactly once", async () => {
  const two = await call(client, "list_bookings", { max_results: 2 });
  assert.deepEqual([two.data.count, two.data.complete, two.data.next_start, requests.at(-1).query.limit], [2, false, fx.BK_PENDING, "2"]);
  assert.match(two.data.note, new RegExp(`call again with start "${fx.BK_PENDING}"`));
  const ids = [];
  let start;
  const calls = [];
  for (let i = 0; i < 10; i++) {
    const n = requests.length;
    const { data, text } = await call(client, "list_bookings", { max_results: 4, ...(start ? { start } : {}) });
    assert.ok(data, text);
    calls.push([data.count, since(n).length, data.next_start]);
    ids.push(...data.bookings.map((b) => b.id));
    if (data.complete) break;
    start = data.next_start;
  }
  assert.deepEqual(calls, [[4, 2, fx.BK_YOGA], [3, 1, undefined]], "four wanted: a page of three then a page of one; the continuation is the first booking not returned");
  assert.deepEqual(ids, [fx.BK_PAST, fx.BK_MASSAGE_JO, fx.BK_PENDING, fx.BK_CANCELLED, fx.BK_YOGA, fx.BK_MASSAGE_PRIYA, fx.BK_HAIRCUT_JO], "every booking once, in order, no gaps and no repeats");
  const past = await call(client, "list_bookings", { start: "f".repeat(24) });
  assert.deepEqual([past.data.count, past.data.complete], [0, true], "an unknown start gives an empty, complete list from the mock");
});

await check("list_bookings passes every documented filter through exactly and refuses an inverted or malformed range locally", async () => {
  const day = await call(client, "list_bookings", { after: "2026-10-05T00:00:00Z", before: "2026-10-05T23:59:59Z", sort_by: "start", order_by: "asc" });
  let q = requests.at(-1).query;
  assert.deepEqual([q.after, q.before, q.statuses, q.timezone], ["2026-10-05T00:00:00Z", "2026-10-05T23:59:59Z", undefined, undefined]);
  assert.deepEqual(day.data.bookings.map((b) => b.id), [fx.BK_HAIRCUT_JO, fx.BK_MASSAGE_PRIYA, fx.BK_YOGA]);
  const dateOnly = await call(client, "list_bookings", { after: "2026-10-06", before: "2026-10-08", timezone: "Europe/London" });
  q = requests.at(-1).query;
  assert.deepEqual([q.after, q.before, q.timezone], ["2026-10-06", "2026-10-08", "Europe/London"], "a date is passed through as given, not converted");
  assert.equal(dateOnly.data.count, 3);
  const cancelled = await call(client, "list_bookings", { status: "cancelled" });
  assert.deepEqual([requests.at(-1).query.statuses, cancelled.data.bookings.map((b) => b.id)], ["cancelled", [fx.BK_CANCELLED]]);
  const created = await call(client, "list_bookings", { created_after: "2026-09-22T00:00:00Z", created_before: "2026-09-25T12:00:00Z", updated_after: "2026-09-01T00:00:00Z", updated_before: "2026-12-31T00:00:00Z" });
  q = requests.at(-1).query;
  assert.deepEqual([q.created_after, q.created_before, q.updated_after, q.updated_before], ["2026-09-22T00:00:00Z", "2026-09-25T12:00:00Z", "2026-09-01T00:00:00Z", "2026-12-31T00:00:00Z"]);
  assert.deepEqual(created.data.bookings.map((b) => b.id), [fx.BK_PENDING, fx.BK_MASSAGE_PRIYA]);
  const byIds = await call(client, "list_bookings", { booking_ids: [fx.BK_YOGA, fx.BK_PAST], service_ids: [fx.SVC_YOGA, fx.SVC_HAIRCUT], category_ids: [fx.CAT_MASSAGE, fx.CAT_HAIR], resource_ids: [fx.RES_SAM] });
  q = requests.at(-1).query;
  assert.deepEqual([q.ids, q.services, q.categories, q.resources], [[fx.BK_YOGA, fx.BK_PAST], [fx.SVC_YOGA, fx.SVC_HAIRCUT], [fx.CAT_MASSAGE, fx.CAT_HAIR], fx.RES_SAM]);
  assert.deepEqual(byIds.data.bookings.map((b) => b.id), [fx.BK_PAST, fx.BK_YOGA]);
  const byCategory = await call(client, "list_bookings", { category_ids: [fx.CAT_MASSAGE] });
  assert.deepEqual(byCategory.data.bookings.map((b) => b.id), [fx.BK_MASSAGE_JO, fx.BK_YOGA, fx.BK_MASSAGE_PRIYA]);
  const byCustomer = await call(client, "list_bookings", { customer_ids: [fx.CUST_JO], return_matching_customers_only: true });
  q = requests.at(-1).query;
  assert.deepEqual([q.customers, q.return_matching_customers_only], [fx.CUST_JO, "true"]);
  assert.deepEqual(byCustomer.data.bookings.map((b) => [b.id, b.participants.length]), [[fx.BK_MASSAGE_JO, 1], [fx.BK_YOGA, 1], [fx.BK_HAIRCUT_JO, 1]], "only Jo's participation is listed on the group booking");
  const before = requests.length;
  for (const [args, why] of [
    [{ after: "2026-10-06", before: "2026-10-05" }, /"before" \(2026-10-05\) must be after "after" \(2026-10-06\)/],
    [{ after: "12/08/2026" }, /must be an ISO 8601 date or date-time/],
    [{ after: "2026" }, /must be an ISO 8601 date or date-time/],
    [{ after: "1756000000" }, /must be an ISO 8601 date or date-time/],
    [{ before: "2026-13-45" }, /must be an ISO 8601 date or date-time/],
    [{ after: "2026-02-30" }, /must be an ISO 8601 date or date-time/], // V8's Date.parse rolls this over to 2 March
    [{ after: "2026-04-31T09:00:00Z" }, /must be an ISO 8601 date or date-time/],
    [{ after: "2026-10-05 09:00:00Z" }, /must be an ISO 8601 date or date-time/], // a space instead of the T is not ISO 8601
    [{ timezone: "Mars/Olympus" }, /IANA names/],
    [{ timezone: "+01:00" }, /IANA names.*an offset such as \+01:00 is not accepted/], // Intl accepts offsets; the API wants IANA names
  ]) {
    const bad = await client.callTool({ name: "list_bookings", arguments: args });
    assert.ok(bad.isError, `${JSON.stringify(args)} must be refused`);
    assert.match(bad.content[0].text, why, JSON.stringify(args));
  }
  assert.equal(requests.length, before, "no request was made for a refused filter");
  const leap = await call(client, "list_bookings", { after: "2026-02-28", before: "2028-02-29T23:59:59+01:00", timezone: "America/Argentina/Buenos_Aires" });
  assert.ok(!leap.res.isError, `a real leap day and a three-part zone name must be accepted: ${leap.text}`);
});

await check("list_bookings withholds participants' answers and reschedule links by default and returns them on request", async () => {
  const { data } = await call(client, "list_bookings", { booking_ids: [fx.BK_HAIRCUT_JO, fx.BK_YOGA], sort_by: "start", order_by: "asc" });
  const jo = data.bookings[0].participants[0];
  assert.deepEqual([jo.customer_id, jo.customer_booking_id, jo.spaces, jo.status, jo.booking_source, jo.total_price, jo.reschedule_url], [fx.CUST_JO, fx.bookings[0].customers[0].customer_booking_id, 1, "No Status", "online_booking", 25, undefined]);
  assert.deepEqual(jo.questions, [
    { label: "Any allergies?", type: "text", value: "None. Text me on [phone redacted] or [email redacted] if running late." },
    { label: "How did you hear about us?", type: "dropdown", value: "Friend" },
    { label: "Which friend?", type: "text", value: "Ada, [phone redacted], [phone redacted], [phone redacted], [phone redacted], [phone redacted] or [phone redacted]" },
    { label: "http://example.org/terms", type: "terms", value: "true" },
  ]);
  const yoga = data.bookings[1];
  assert.deepEqual([yoga.total_spaces, yoga.spaces_booked, yoga.participants.map((p) => [p.customer_id, p.spaces, p.status])], [10, 4, [[fx.CUST_JO, 2, "No Status"], [fx.CUST_LEE, 1, "Arrived"], [fx.CUST_ADA, 1, "No Status"]]]);
  const text = JSON.stringify(data);
  noLeak(text, "list_bookings");
  for (const leak of ["+44 (0)7700 900789", "20 7946 0958", "07700.900555", "07700-900556", "448787981295"]) assert.ok(!text.includes(leak), `${leak} leaked: the +44 (0), 00-prefixed, dot-separated, hyphenated and bare-44 phone forms must be redacted`);
  const withContact = await call(client, "list_bookings", { booking_ids: [fx.BK_HAIRCUT_JO], include_contact_details: true });
  const raw = withContact.data.bookings[0].participants[0];
  assert.equal(raw.reschedule_url, fx.bookings[0].customers[0].reschedule_url);
  assert.deepEqual([raw.questions[0].value, raw.questions[2].value], [fx.bookings[0].customers[0].questions[0].value, fx.bookings[0].customers[0].questions[2].value]);
});

await check("get_customer withholds contact details, contact-like custom fields and emails in tags by default, returns them on request, and lists the customer's bookings", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_customer", { customer_id: fx.CUST_JO });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.customers, r.query.sort_by, r.query.order_by, r.query.limit]), [[`/customers/${fx.CUST_JO}`, undefined, undefined, undefined, undefined], ["/bookings", fx.CUST_JO, "start", "descending", "10"]]);
  assert.deepEqual(data.customer, {
    id: fx.CUST_JO,
    first_name: "Jo",
    last_name: "Bloggs",
    marketing_opt_in: true,
    tags: ["VIP", "Referred by [email redacted]"],
    custom_fields: { "Date of birth": "[withheld: looks like contact data; available with include_contact_details]", Notes: "Prefers Sam. Confirm by text to [phone redacted] or [email redacted]", "Loyalty number": "LOY-0001" },
    created: fx.customers[0].created,
    updated: fx.customers[0].updated,
  });
  assert.deepEqual([data.bookings_total, data.bookings.map((b) => b.id)], [3, [fx.BK_MASSAGE_JO, fx.BK_YOGA, fx.BK_HAIRCUT_JO]], "latest start first");
  // Custom-field names that mark a value as contact data, in the spellings organisations use.
  for (const name of ["Date of birth", "dateOfBirth", "E-mail", "Email Address", "phoneNumber", "Mobile", "homeAddress", "home_address", "Postcode", "customerName", "Full name", "nhsnumber", "NI number", "ipaddress", "Passport no", "zip"]) assert.ok(looksLikeContactField(name), `${name} should count as contact data`);
  for (const name of ["Notes", "Loyalty number", "description", "Preferred stylist", "Membership tier", "Source"]) assert.ok(!looksLikeContactField(name), `${name} should not count as contact data`);
  assert.equal(data.bookings[2].participants[0].questions[0].value, "None. Text me on [phone redacted] or [email redacted] if running late.");
  noLeak(JSON.stringify(data), "get_customer");
  const m = requests.length;
  const noBookings = await call(client, "get_customer", { customer_id: fx.CUST_LEE, max_bookings: 0 });
  assert.equal(since(m).length, 1, "max_bookings 0 makes no bookings call");
  assert.deepEqual([noBookings.data.customer.last_name, noBookings.data.bookings], ["Chen ([email redacted])", undefined], "an email typed into a name is redacted by default");
  const withContact = await call(client, "get_customer", { customer_id: fx.CUST_JO, include_contact_details: true, max_bookings: 1 });
  const c = withContact.data.customer;
  assert.deepEqual([c.email, c.mobile, c.phone, c.address_1, c.address_2, c.city, c.postcode, c.gender, c.tags, c.custom_fields], ["jo.bloggs@example.com", "+447700900123", "0117 496 0000", "1 Plymouth Road", undefined, "Penarth", "CF64 3DH", undefined, fx.customers[0].tags, fx.customers[0].custom_fields]);
  assert.equal(withContact.data.bookings[0].participants[0].reschedule_url, fx.bookings[5].customers[0].reschedule_url);
  const missing = await call(client, "get_customer", { customer_id: "0".repeat(24) });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /^Not found: \/customers\/0{24}\. Check the ID\./);
});

await check("find_customers scans 100-per-call pages (the mock serves 50) with start = next, matches name, email and UK phone formats, names only by default", async () => {
  const n = requests.length;
  const byName = await call(client, "find_customers", { query: "jo bloggs" });
  const scan = since(n);
  assert.deepEqual(scan.map((r) => [r.path, r.query.limit]), [["/customers", "100"], ["/customers", "100"], ["/customers", "100"]]);
  assert.deepEqual([scan[0].query.start, typeof scan[1].query.start, typeof scan[2].query.start], [undefined, "string", "string"]);
  assert.deepEqual(byName.data.matches.map((m) => m.id), [fx.CUST_JO]);
  assert.deepEqual([byName.data.matches[0].first_name, byName.data.matches[0].email, byName.data.customers_scanned, byName.data.note], ["Jo", undefined, 121, undefined]);
  noLeak(JSON.stringify(byName.data), "find_customers");
  const byPhone = await call(client, "find_customers", { query: "07700 900456" });
  assert.deepEqual(byPhone.data.matches.map((m) => m.id), [fx.CUST_PRIYA], "a 0-prefixed UK number matches a +44 mobile");
  const byLandline = await call(client, "find_customers", { query: "+44 117 496 0000" });
  assert.deepEqual(byLandline.data.matches.map((m) => m.id), [fx.CUST_JO]);
  const byEmail = await call(client, "find_customers", { query: "priya.shah@", include_contact_details: true });
  assert.deepEqual(byEmail.data.matches.map((m) => [m.id, m.email, m.mobile]), [[fx.CUST_PRIYA, "priya.shah@example.com", "+447700900456"]]);
  const partial = await call(client, "find_customers", { query: "person", max_results: 3, max_pages: 1 });
  assert.deepEqual([partial.data.matches.length, partial.data.customers_scanned], [3, 50]);
  assert.match(partial.data.note, /Only the first 50 customers were scanned/);
});

const intervalsSchema = requestSchema("post", "/availability/intervals/search");
const daysSchema = requestSchema("post", "/availability/days/search");

await check("find_available_intervals posts a body that validates against the spec, passes the documented options through and refuses bad input locally", async () => {
  const n = requests.length;
  const { data } = await call(client, "find_available_intervals", { service_id: fx.SVC_HAIRCUT, from: "2026-10-05T00:00:00Z", to: "2026-10-06T00:00:00Z" });
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.contentType]), [["POST", "/availability/intervals/search", "application/json"]]);
  validateWith(intervalsSchema, requests.at(-1).body, "intervals body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { ranges: [{ start: "2026-10-05T00:00:00Z", end: "2026-10-06T00:00:00Z" }], service_id: fx.SVC_HAIRCUT }, "nothing beyond the required fields unless asked");
  assert.deepEqual([data.count, data.total_returned_by_api, data.note], [3, 3, undefined]);
  assert.deepEqual(data.results, [
    { start: fx.AVAILABLE_START, resource_ids: [fx.RES_SAM], group_bookings: [] },
    { start: "2026-10-05T10:00:00Z", resource_ids: [fx.RES_SAM], group_bookings: [] },
    { start: "2026-10-05T10:30:00Z", resource_ids: [fx.RES_SAM], group_bookings: [] },
  ]);
  const full = await call(client, "find_available_intervals", {
    service_id: fx.SVC_YOGA, from: "2026-10-05", to: "2026-10-06", resource_ids: [fx.RES_SAM], duration: 60, spaces: 2, buffers: { before: 0, after: 10 }, timezone: "Europe/London",
    ignore_bookings: [fx.BK_PAST], ignore_past_restriction: true, ignore_notice_restriction: false, ignore_service_schedule: false, ignore_service_assignment: false, ignore_group_setting: true, ignore_block_restriction: false, max_results: 1,
  });
  validateWith(intervalsSchema, requests.at(-1).body, "full intervals body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, {
    ranges: [{ start: "2026-10-05", end: "2026-10-06" }], service_id: fx.SVC_YOGA, resource_ids: [fx.RES_SAM], duration: 60, spaces: 2, buffers: { before: 0, after: 10 }, timezone: "Europe/London",
    ignore_bookings: [fx.BK_PAST], ignore_past_restriction: true, ignore_notice_restriction: false, ignore_service_schedule: false, ignore_service_assignment: false, ignore_group_setting: true, ignore_block_restriction: false,
  });
  assert.deepEqual(full.data.results, [{ start: "2026-10-05T18:00:00Z", resource_ids: [fx.RES_SAM], group_bookings: [{ id: fx.BK_YOGA, resource_id: fx.RES_SAM, spaces: 6 }] }], "an existing group booking with space is returned");
  const tooMany = await call(client, "find_available_intervals", { service_id: fx.SVC_YOGA, from: "2026-10-05", to: "2026-10-06", spaces: 8 });
  assert.equal(tooMany.data.count, 0, "the mock excludes group bookings with too few spaces, as the spaces parameter documents");
  const group = await call(client, "find_available_intervals", { service_id: fx.SVC_HAIRCUT, from: "2026-10-05", to: "2026-10-06", resource_group_id: fx.GRP_STYLISTS, parts: [{ type: "block", duration: 30 }] });
  validateWith(intervalsSchema, requests.at(-1).body, "group body vs requestBody schema");
  assert.deepEqual([requests.at(-1).body.resource_group_ids, requests.at(-1).body.parts, group.data.count], [fx.GRP_STYLISTS, [{ type: "block", duration: 30 }], 3], "resource_group_ids is sent as the single string the spec types it as");
  const before = requests.length;
  for (const [args, why] of [
    [{ service_id: fx.SVC_HAIRCUT, from: "2026-10-06", to: "2026-10-05" }, /"to" \(2026-10-05\) must be after "from" \(2026-10-06\)/],
    [{ service_id: fx.SVC_HAIRCUT, from: "2026-10-05", to: "2026-10-06", resource_ids: [fx.RES_SAM], resource_group_id: fx.GRP_STYLISTS }, /either resource_ids or resource_group_id, not both/],
    [{ service_id: fx.SVC_HAIRCUT, from: "next monday", to: "2026-10-06" }, /must be an ISO 8601 date or date-time/],
    [{ service_id: fx.SVC_HAIRCUT, from: "2026-10-05", to: "2026-10-06", timezone: "London" }, /IANA names/],
    [{ service_id: "haircut", from: "2026-10-05", to: "2026-10-06" }, /24 hexadecimal characters/],
  ]) {
    const bad = await client.callTool({ name: "find_available_intervals", arguments: args });
    assert.ok(bad.isError, `${JSON.stringify(args)} must be refused`);
    assert.match(bad.content[0].text, why, JSON.stringify(args));
  }
  assert.equal(requests.length, before, "no request was made for refused input");
});

await check("find_available_dates posts a body that validates against the spec and returns the available days", async () => {
  const { data } = await call(client, "find_available_dates", { service_id: fx.SVC_HAIRCUT, from: "2026-10-05", to: "2026-10-08", timezone: "UTC" });
  assert.equal(requests.at(-1).path, "/availability/days/search");
  validateWith(daysSchema, requests.at(-1).body, "days body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { ranges: [{ start: "2026-10-05", end: "2026-10-08" }], service_id: fx.SVC_HAIRCUT, timezone: "UTC" });
  assert.deepEqual(data.results.map((d) => d.start), ["2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"]);
  const none = await call(client, "find_available_dates", { service_id: fx.SVC_HAIRCUT, from: "2026-11-01", to: "2026-11-08" });
  assert.deepEqual([none.data.count, none.data.results], [0, []]);
});

const reservationSchema = requestSchema("post", "/availability/slots");
const bookingSchema = requestSchema("post", "/bookings");
const goodBooking = {
  customers: [{ first_name: "Jo", last_name: "Bloggs", email: "jo.bloggs@example.com", mobile: "+447700900123", marketing_subscribed: true, notes: "Running 5 minutes late", questions: [{ label: "Any allergies?", value: "None", type: "text" }], total_spaces: 1 }],
  label: "VIP",
};
const reserve = async (extra = {}) => {
  const { data, text } = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, resource_id: fx.RES_SAM, start: fx.AVAILABLE_START, ...extra });
  assert.ok(data, text);
  return data.reservation.id;
};

await check("create_reservation posts a body that validates against the spec; an unavailable time gives the documented 404 as a clear message", async () => {
  const n = requests.length;
  const { data } = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, resource_id: fx.RES_SAM, start: fx.AVAILABLE_START, expires_after: 15, required_spaces: 1, timezone: "Europe/London", response_timezone: "UTC", ignore_notice_restriction: true });
  assert.deepEqual(since(n).map((r) => [r.method, r.path]), [["POST", "/availability/slots"]]);
  validateWith(reservationSchema, requests.at(-1).body, "reservation body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { ignore_notice_restriction: true, timezone: "UTC", data: { service_id: fx.SVC_HAIRCUT, start: fx.AVAILABLE_START, resource_id: fx.RES_SAM, timezone: "Europe/London", expires_after: 15, required_spaces: 1 } });
  assert.deepEqual([data.result, data.reservation.id, data.reservation.service_id, data.reservation.resource_id, data.reservation.resource_ids, data.reservation.start, data.reservation.end, data.reservation.expiry, data.reservation.reserved_spaces], ["reserved", fx.RESERVATION_ID, fx.SVC_HAIRCUT, fx.RES_SAM, [fx.RES_SAM], fx.reservation.start, fx.reservation.end, fx.reservation.expiry, 1]);
  const minimal = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, start: fx.AVAILABLE_START, resource_group_ids: [fx.GRP_STYLISTS], parts: [{ type: "block", duration: 30 }], allow_additional_spaces: false, max_spaces: 1 });
  validateWith(reservationSchema, requests.at(-1).body, "second reservation body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { data: { service_id: fx.SVC_HAIRCUT, start: fx.AVAILABLE_START, resource_group_ids: [fx.GRP_STYLISTS], max_spaces: 1, allow_additional_spaces: false, parts: [{ type: "block", duration: 30 }] } });
  assert.equal(minimal.data.result, "reserved");
  const unavailable = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, resource_id: fx.RES_SAM, start: "2026-10-05T03:00:00Z" });
  assert.ok(unavailable.res.isError);
  assert.match(unavailable.text, /found no availability to reserve \(404\)\. Use a start time returned by find_available_intervals.*Could not find availability 2026-10-05T03:00:00\.000Z for resource/);
  const wrongResource = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, resource_id: fx.RES_PRIYA, start: fx.AVAILABLE_START });
  assert.ok(wrongResource.res.isError);
  assert.match(wrongResource.text, /found no availability to reserve \(404\)/);
});

await check("create_booking posts a body that validates against the spec (send_payment_request false by default); a used reservation gives the documented 422 message", async () => {
  const slot = await reserve();
  const n = requests.length;
  const { data } = await call(client, "create_booking", { reservation_id: slot, ...goodBooking });
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.contentType]), [["POST", "/bookings", "application/json"]]);
  validateWith(bookingSchema, requests.at(-1).body, "booking body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, {
    slot_id: slot,
    send_payment_request: false,
    data: {
      label: "VIP",
      customers: [{ customer: { profile: { firstname: "Jo", lastname: "Bloggs", email: "jo.bloggs@example.com", mobile: "+447700900123" }, marketing_subscribed: true }, notes: "Running 5 minutes late", questions: [{ label: "Any allergies?", value: "None", type: "text" }], total_spaces: 1 }],
    },
  });
  assert.deepEqual([data.result, data.booking.id, data.booking.status, data.booking.service_id, data.booking.resource_id, data.booking.start, data.booking.end, data.booking.created_source, data.booking.total_spaces, data.booking.spaces_booked], ["booked", fx.NEW_BOOKING_ID, "confirmed", fx.SVC_HAIRCUT, fx.RES_SAM, fx.reservation.start, fx.reservation.end, "api", 1, 1]);
  assert.deepEqual([data.booking.participants.length, data.booking.participants[0].spaces, data.booking.participants[0].paid, data.booking.participants[0].reschedule_url], [1, 1, false, undefined], "the new participant's reschedule link is withheld unless asked");
  assert.deepEqual(data.booking.parts, [{ start: fx.reservation.start, end: fx.reservation.end }]);
  const reused = await call(client, "create_booking", { reservation_id: slot, ...goodBooking });
  assert.ok(reused.res.isError, "a reservation is single use");
  assert.match(reused.text, new RegExp(`could not process POST /bookings \\(422\\)\\. Unprocessible Entity Could not find reservation ${slot}`));
  const slot2 = await reserve();
  const empty = await call(client, "create_booking", { reservation_id: slot2, send_payment_request: true, created_source: "front-desk", timezone: "Europe/London", include_contact_details: true, customers: [{ first_name: "Ada", last_name: "Lovelace", status: "Arrived", locale: "en-GB", custom_fields: [{ id: fx.CAT_HAIR, value: "x" }], booking_source: "walk-in", timezone: "Europe/London", total_spaces: 2 }] });
  validateWith(bookingSchema, requests.at(-1).body, "second booking body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { slot_id: slot2, send_payment_request: true, timezone: "Europe/London", data: { created_source: "front-desk", customers: [{ customer: { profile: { firstname: "Ada", lastname: "Lovelace" }, custom_fields: [{ id: fx.CAT_HAIR, value: "x" }] }, booking_source: "walk-in", locale: "en-GB", status: "Arrived", timezone: "Europe/London", total_spaces: 2 }] } });
  assert.deepEqual([empty.data.booking.created_source, empty.data.booking.participants[0].status, empty.data.booking.participants[0].spaces, typeof empty.data.booking.participants[0].reschedule_url], ["front-desk", "Arrived", 2, "string"]);
  const noCustomers = await call(client, "create_booking", { reservation_id: await reserve() });
  assert.deepEqual([requests.at(-1).body.data, noCustomers.data.booking.participants], [{ customers: [] }, []], "an empty customers array creates an empty booking, as documented");
});

await check("cancel_booking posts the documented body and reports a 204 as cancelled; an already cancelled booking gives the API's 422 message", async () => {
  const { data } = await call(client, "cancel_booking", { booking_id: fx.BK_PENDING });
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path, requests.at(-1).body], ["POST", `/bookings/${fx.BK_PENDING}/cancel`, { source: "api" }]);
  validateWith(requestSchema("post", "/bookings/{booking_id}/cancel"), requests.at(-1).body, "cancel body vs requestBody schema");
  assert.deepEqual(data, { result: "cancelled", booking_id: fx.BK_PENDING });
  const listed = await call(client, "list_bookings", { booking_ids: [fx.BK_PENDING] });
  assert.equal(listed.data.bookings[0].status, "cancelled");
  const again = await call(client, "cancel_booking", { booking_id: fx.BK_PENDING, source: "front-desk" });
  assert.ok(again.res.isError);
  assert.equal(requests.at(-1).body.source, "front-desk");
  assert.match(again.text, new RegExp(`could not process POST /bookings/${fx.BK_PENDING}/cancel \\(422\\)\\. Could not cancel booking with ID ${fx.BK_PENDING} because it is already cancelled\\.`));
  const missing = await call(client, "cancel_booking", { booking_id: "0".repeat(24) });
  assert.match(missing.text, /^Not found: \/bookings\/0{24}\/cancel\. Check the ID\./);
});

await check("create_customer and update_customer post bodies that validate against the spec and withhold contact details unless asked; update refuses an empty change locally and passes the API's error text on redacted", async () => {
  const { data } = await call(client, "create_customer", { first_name: "Ada", last_name: "Lovelace", email: "ada@example.org", mobile: "+447700900555", phone: "0117 496 0001", tags: ["Engineer", "Referred by jo.bloggs@example.com"] });
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path], ["POST", "/customers"]);
  validateWith(requestSchema("post", "/customers"), requests.at(-1).body, "create customer body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { data: { tags: ["Engineer", "Referred by jo.bloggs@example.com"], profile: { firstname: "Ada", lastname: "Lovelace", email: "ada@example.org", mobile: "+447700900555", phone: "0117 496 0001" } } });
  assert.deepEqual([data.result, data.customer.id, data.customer.first_name, data.customer.last_name, data.customer.tags], ["created", fx.NEW_CUSTOMER_ID, "Ada", "Lovelace", ["Engineer", "Referred by [email redacted]"]]);
  assert.deepEqual([data.customer.email, data.customer.mobile, data.customer.phone], [undefined, undefined, undefined], "the contact details just supplied are still withheld by default, like every other customer-returning tool");
  noLeak(JSON.stringify(data), "create_customer");
  const createdRaw = await call(client, "create_customer", { first_name: "Ada", last_name: "Lovelace", email: "ada@example.org", mobile: "+447700900555", phone: "0117 496 0001", include_contact_details: true });
  assert.deepEqual([createdRaw.data.customer.email, createdRaw.data.customer.mobile, createdRaw.data.customer.phone], ["ada@example.org", "+447700900555", "0117 496 0001"], "returned on request");
  const n = requests.length;
  const updated = await call(client, "update_customer", { customer_id: fx.CUST_JO, email: "jo@example.com", tags: ["VIP"] });
  assert.deepEqual(since(n).map((r) => [r.method, r.path]), [["PUT", `/customers/${fx.CUST_JO}`]]);
  validateWith(requestSchema("put", "/customers/{customer_id}"), requests.at(-1).body, "update customer body vs requestBody schema");
  assert.deepEqual(requests.at(-1).body, { data: { tags: ["VIP"], profile: { email: "jo@example.com" } } }, "only the fields given are sent");
  assert.deepEqual([updated.data.result, updated.data.customer.first_name, updated.data.customer.tags, updated.data.customer.email], ["updated", "Jo", ["VIP"], undefined], "the full profile comes back but contact details are withheld unless asked");
  const asStored = await call(client, "update_customer", { customer_id: fx.CUST_JO, last_name: "Bloggs-Smith", include_contact_details: true });
  assert.deepEqual(requests.at(-1).body, { data: { profile: { lastname: "Bloggs-Smith" } } });
  assert.deepEqual([asStored.data.customer.last_name, asStored.data.customer.email, asStored.data.customer.postcode], ["Bloggs-Smith", "jo@example.com", "CF64 3DH"]);
  const before = requests.length;
  const nothing = await call(client, "update_customer", { customer_id: fx.CUST_JO });
  assert.ok(nothing.res.isError);
  assert.match(nothing.text, /Not updated\. Give at least one of/);
  const badEmail = await client.callTool({ name: "create_customer", arguments: { first_name: "Ada", last_name: "Lovelace", email: "not-an-email" } });
  assert.ok(badEmail.isError);
  assert.equal(requests.length, before, "no request for a locally refused write");
  arm({ method: "PUT", path: `/customers/${fx.CUST_JO}`, status: 400, body: { statusCode: 400, error: "Bad Request", message: "Email jo.bloggs@example.com is already used by the customer on 07700 900123", validation: { source: "payload", keys: ["data.profile.email"] } } });
  const echoed = await call(client, "update_customer", { customer_id: fx.CUST_JO, email: "jo.bloggs@example.com" });
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /rejected PUT \/customers\/\w+ \(400 Bad Request\)\. Bad Request Email \[email redacted\] is already used by the customer on \[phone redacted\] \(invalid payload: data\.profile\.email\)/);
  disarm();
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_service", { service_id: "5f87048ae2ee4d44b35df50" }], // 23 characters
    ["get_service", { service_id: "5f87048ae2ee4d44b35df508z" }],
    ["get_customer", { customer_id: "../customers" }],
    ["get_customer", { customer_id: "" }],
    ["list_bookings", { booking_ids: ["not-hex"] }],
    ["list_bookings", { start: "1" }],
    ["list_resources", { service_ids: ["x".repeat(24)] }],
    ["find_available_dates", { service_id: "0".repeat(23), from: "2026-10-05", to: "2026-10-06" }],
    ["cancel_booking", { booking_id: "12345" }],
    ["create_reservation", { service_id: fx.SVC_HAIRCUT, resource_id: "sam", start: fx.AVAILABLE_START }],
    ["create_booking", { reservation_id: "slot/1" }],
    ["update_customer", { customer_id: "0".repeat(25), email: "x@example.com" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
    assert.match(bad.content[0].text, /24 hexadecimal characters/, `${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_service", { service_id: "0".repeat(24) });
  assert.match(missing.text, /^Not found: \/services\/0{24}\. Check the ID\. Not Found ID does not exist$/);
});

await check("a persistent 429 gives up after 3 attempts with the rate-limit message", async () => {
  arm429({ persistent: true });
  const n = requests.length;
  const { res, text } = await call(client, "list_resource_groups");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/resources/groups").length, 3, "exactly three attempts");
  assert.match(text, /Appointedd rate limit reached \(the limit is not documented\)\. Wait a minute and try again\./);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once; an HTTP-date and a fractional Retry-After are honoured", async () => {
  arm429({ retryAfter: "600" });
  let n = requests.length;
  const long = await call(client, "list_resource_groups");
  assert.ok(long.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/resources/groups").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/resources\/groups \(HTTP 429\)/);
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  n = requests.length;
  const dated = await call(client, "list_resource_groups");
  assert.ok(!dated.res.isError);
  let tries = since(n).filter((r) => r.path === "/resources/groups");
  assert.equal(tries.length, 2);
  let gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  n = requests.length;
  const fractional = await call(client, "list_resource_groups");
  assert.ok(!fractional.res.isError);
  tries = since(n).filter((r) => r.path === "/resources/groups");
  assert.equal(tries.length, 2);
  gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a 502 on a GET is retried (even with a non-JSON gateway body); a GET failing three times with 503 reports advice without the HTML; a non-JSON 200 is an error", async () => {
  arm({ method: "GET", path: "/services/categories", status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, data } = await call(client, "list_service_categories");
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 2);
  assert.equal(since(n).filter((r) => r.path === "/services/categories").length, 2);
  arm({ method: "GET", path: "/services", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "list_services");
  assert.ok(down.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/services").length, 3);
  assert.match(down.text, /Appointedd returned 503 for GET \/services 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!down.text.includes("<html>"), "gateway HTML should not be passed on");
  arm({ method: "GET", path: "/bookings", status: 200 }); // the mock answers with an HTML page
  const html = await call(client, "list_bookings");
  assert.ok(html.res.isError, `a non-JSON 200 must not be reported as success: ${html.text}`);
  assert.match(html.text, /returned 200 for GET \/bookings but the body was not JSON \(starts with: "<html>.*Check APPOINTEDD_BASE_URL/);
  disarm();
  const ok = await call(client, "list_bookings", { max_results: 1 });
  assert.ok(!ok.res.isError);
});

await check("a JSON 200 whose data is not a list is an error, never an empty list; a redirect is not followed, so the key never reaches a second host", async () => {
  arm({ method: "GET", path: "/services", status: 200, body: { data: { unexpected: true, contact: "jo.bloggs@example.com" }, total: 3, prev: null, next: null } });
  const notList = await call(client, "list_services");
  assert.ok(notList.res.isError, `a 200 whose data is an object must not be reported as an empty list: ${notList.text}`);
  assert.match(notList.text, /returned 200 for GET \/services but the JSON has "data" that is not a list \(starts with: "\{\\"data\\":\{\\"unexpected\\":true,\\"contact\\":\\"\[email redacted\]/);
  assert.match(notList.text, /Check APPOINTEDD_BASE_URL; this is not an empty list\./);
  arm({ method: "GET", path: "/customers", status: 200, body: { ok: true } });
  const noData = await call(client, "find_customers", { query: "jo" });
  assert.ok(noData.res.isError);
  assert.match(noData.text, /returned 200 for GET \/customers but the JSON has no "data" list/);
  // A redirect to another host (a misconfigured APPOINTEDD_BASE_URL, say) must not be followed with the
  // X-API-KEY header: nothing listens on the Location, and the mock must see exactly one request.
  arm({ method: "GET", path: "/services/categories", status: 302, headers: { Location: "http://127.0.0.1:9/elsewhere/services/categories" }, body: {} });
  const n = requests.length;
  const redirected = await call(client, "list_service_categories");
  assert.ok(redirected.res.isError);
  assert.equal(since(n).length, 1, "one request, no follow-up");
  assert.match(redirected.text, /answered GET \/services\/categories with a redirect, which this server does not follow \(the API key is only ever sent to http:\/\/127\.0\.0\.1:\d+\/v1\)\. Check APPOINTEDD_BASE_URL\./);
  disarm();
  const ok = await call(client, "list_services", { max_results: 1 });
  assert.ok(!ok.res.isError, ok.text);
});

await check("a gateway error on a POST is never retried: create_booking and create_reservation say what to check, the availability searches say they are safe to repeat", async () => {
  const slot = await reserve();
  arm({ method: "POST", path: "/bookings", status: 502, headers: { "Retry-After": "1" } });
  let n = requests.length;
  const { res, text } = await call(client, "create_booking", { reservation_id: slot, ...goodBooking });
  assert.ok(res.isError, "a 502 on a booking must surface as an error, not a success");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 1, "exactly one POST /bookings");
  assert.match(text, /returned 502 for POST \/bookings\. The request was not retried because it may already have been processed: check with list_bookings before repeating it\./);
  arm({ method: "POST", path: "/availability/slots", status: 504 });
  n = requests.length;
  const held = await call(client, "create_reservation", { service_id: fx.SVC_HAIRCUT, start: fx.AVAILABLE_START });
  assert.ok(held.res.isError);
  assert.equal(since(n).length, 1);
  assert.match(held.text, /returned 504 for POST \/availability\/slots\. The request was not retried because it may already have been processed: check with create_reservation again only if the first slot expires/);
  arm({ method: "POST", path: "/availability/intervals/search", status: 503 });
  n = requests.length;
  const search = await call(client, "find_available_intervals", { service_id: fx.SVC_HAIRCUT, from: "2026-10-05", to: "2026-10-06" });
  assert.ok(search.res.isError);
  assert.equal(since(n).length, 1, "a read-only POST is not retried after a gateway error either");
  assert.match(search.text, /returned 503 for POST \/availability\/intervals\/search\. This request is a query that changes nothing, so it is safe to call again/);
  arm({ method: "PUT", path: `/customers/${fx.CUST_JO}`, status: 503 });
  n = requests.length;
  const put = await call(client, "update_customer", { customer_id: fx.CUST_JO, tags: [] });
  assert.ok(put.res.isError);
  assert.equal(since(n).length, 1);
  assert.match(put.text, /returned 503 for PUT .*not retried.*check with find_customers or get_customer/);
  disarm();
});

await check("a 429 on POST /bookings is retried once (a rate-limited request is assumed not to have been processed)", async () => {
  const slot = await reserve();
  arm({ method: "POST", path: "/bookings", status: 429, headers: { "Retry-After": "0" }, body: { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded." } });
  const n = requests.length;
  const { res, data } = await call(client, "create_booking", { reservation_id: slot, ...goodBooking });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.result, "booked");
  assert.equal(since(n).filter((r) => r.method === "POST" && r.path === "/bookings").length, 2, "one retry after the 429");
  disarm();
});

await check("a request body over the documented 10240-byte limit is refused locally, before any request", async () => {
  const slot = await reserve();
  const before = requests.length;
  const big = { reservation_id: slot, customers: Array.from({ length: 3 }, (_, i) => ({ first_name: "Jo", last_name: `Bloggs${i}`, notes: "x".repeat(4000) })) };
  const { res, text } = await call(client, "create_booking", big);
  assert.ok(res.isError);
  assert.match(text, /Not sent: the request body is \d+ bytes and Appointedd's documented maximum request size is 10240 bytes/);
  assert.equal(requests.length, before, "nothing was sent");
  const fits = await call(client, "create_booking", { reservation_id: slot, customers: [{ first_name: "Jo", last_name: "Bloggs", notes: "x".repeat(4000) }] });
  assert.ok(!fits.res.isError, fits.text);
  assert.ok(requests.at(-1).bytes <= 10240 && requests.at(-1).bytes > 4000);
});

await check("every request used the X-API-KEY header and a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[0-9a-fA-F]{24}") + "$") })));
  assert.ok(requests.length > 60);
  for (const r of requests) {
    assert.equal(r.auth, API_KEY, `${r.method} ${r.path} did not carry the API key`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    if (r.body !== undefined) assert.match(r.contentType ?? "", /^application\/json/, `${r.method} ${r.path} body without application/json`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    [
      "GET /bookings",
      "GET /customers",
      "GET /customers/{id}",
      "GET /resources",
      "GET /resources/groups",
      "GET /services",
      "GET /services/categories",
      "GET /services/{id}",
      "POST /availability/days/search",
      "POST /availability/intervals/search",
      "POST /availability/slots",
      "POST /bookings",
      "POST /bookings/{id}/cancel",
      "POST /customers",
      "PUT /customers/{id}",
    ],
  );
});
await client.close();

await check("writes are off when APPOINTEDD_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => WRITES.includes(t.name)), [], `writes exposed with APPOINTEDD_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, READS.length);
    await ro.close();
  }
});

await check("a wrong API key gives an actionable 401; a missing key stops the server at start-up", async () => {
  const bad = await connect({ key: "apk-wrong-key" });
  const { res, text } = await call(bad, "list_services");
  assert.ok(res.isError);
  assert.match(text, /rejected the API key \(401\)\. Check APPOINTEDD_API_KEY: it is your organisation's API key from Settings > API in Appointedd .* sent as the X-API-KEY header\./);
  await bad.close();
  await assert.rejects(connect({ key: "" }), /closed|exit|EPIPE|Connection/i, "server should exit without a key");
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock.`);

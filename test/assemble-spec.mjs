// Rebuilds spec.json from Appointedd's public documentation. Appointedd publishes its OpenAPI 3.1
// definition one operation per reference page on developers.appointedd.com: the Markdown version of
// each page (its URL + ".md") embeds an "OpenAPI definition" JSON block with that page's path, its
// operation and the security scheme. The concept pages (introduction, authentication, pagination,
// limitations, the booking entity) have no such block and are skipped. This script fetches every
// page listed below and merges them into one document; the merge refuses to continue if two pages
// define the same path+method or the same component differently.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REFERENCE_URL = "https://developers.appointedd.com/reference/";
// Every page under https://developers.appointedd.com/reference (from https://developers.appointedd.com/llms.txt).
export const PAGES = [
  "booking-entity",
  "cancel-booking",
  "cancel-booking-customer",
  "create-booking",
  "create-booking-customer-invoice",
  "create-customer",
  "create-reservation",
  "delete-customer",
  "delete-reservation",
  "delete-resource",
  "find-available-dates",
  "find-available-intervals",
  "get-bookings",
  "get-customer",
  "get-customers",
  "get-reservation",
  "get-resource-groups",
  "get-resources",
  "get-service",
  "get-service-categories",
  "get-service-category",
  "get-services-1",
  "getting-started",
  "introduction-1",
  "limitations",
  "pagination-1",
  "update-booking",
  "update-booking-customer",
  "update-customer",
  "update-resource",
];
const CONCURRENCY = 4;

const stable = (v) => JSON.stringify(v);

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "text/markdown, text/plain, */*" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** The JSON block under "# OpenAPI definition" on one reference page, or null for a concept page without one. */
export function extractDefinition(markdown, url) {
  const at = markdown.indexOf("# OpenAPI definition");
  if (at < 0) return null;
  const open = markdown.indexOf("```json", at);
  const close = open < 0 ? -1 : markdown.indexOf("\n```", open + 7);
  if (open < 0 || close < 0) throw new Error(`${url}: no JSON code block after the OpenAPI heading`);
  return JSON.parse(markdown.slice(open + 7, close));
}

export async function assembleSpec(outPath) {
  const urls = PAGES.map((slug) => `${REFERENCE_URL}${slug}.md`);
  const spec = { openapi: undefined, info: undefined, servers: undefined, security: undefined, paths: {}, components: { schemas: {}, securitySchemes: {} } };
  let operations = 0;
  let pages = 0;
  const merge = (def, url) => {
    for (const key of ["openapi", "info", "servers", "security"]) {
      if (def[key] === undefined) continue;
      if (spec[key] === undefined) spec[key] = def[key];
      else if (stable(spec[key]) !== stable(def[key])) throw new Error(`${url}: "${key}" differs from the other pages`);
    }
    for (const [path, ops] of Object.entries(def.paths ?? {})) {
      spec.paths[path] ??= {};
      for (const [method, op] of Object.entries(ops)) {
        if (spec.paths[path][method] !== undefined && stable(spec.paths[path][method]) !== stable(op)) throw new Error(`${url}: ${method.toUpperCase()} ${path} is defined differently on another page`);
        if (spec.paths[path][method] === undefined) operations++;
        spec.paths[path][method] = op;
      }
    }
    for (const group of ["schemas", "securitySchemes"]) {
      for (const [name, schema] of Object.entries(def.components?.[group] ?? {})) {
        const existing = spec.components[group][name];
        if (existing !== undefined && stable(existing) !== stable(schema)) throw new Error(`${url}: component ${group}.${name} is defined differently on another page`);
        spec.components[group][name] = schema;
      }
    }
  };

  let next = 0;
  const failures = [];
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const def = extractDefinition(await fetchText(url), url);
        if (def) {
          merge(def, url);
          pages++;
        }
      } catch (err) {
        failures.push(`${url}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  if (failures.length) throw new Error(`Could not assemble the spec:\n  ${failures.join("\n  ")}`);
  if (operations === 0) throw new Error("No operations found on any reference page");

  spec.info = { ...(spec.info ?? {}), "x-note": `Assembled on ${new Date().toISOString().slice(0, 10)} from the per-page OpenAPI definitions published on developers.appointedd.com (each reference page embeds one).` };
  // Pages are fetched concurrently; sort the paths so the output does not depend on arrival order.
  spec.paths = Object.fromEntries(Object.entries(spec.paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(outPath, JSON.stringify(spec, null, 2));
  return { pages, operations, schemas: Object.keys(spec.components.schemas).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] ?? fileURLToPath(new URL("../spec.json", import.meta.url));
  const r = await assembleSpec(out);
  console.log(`Wrote ${out}: ${r.pages} pages with a definition, ${r.operations} operations, ${r.schemas} component schemas.`);
}

# Appointedd MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with an Appointedd booking organisation: availability, services and categories, resources (staff, rooms), bookings and customers, and (when enabled) reserving a slot, creating and cancelling bookings, and adding or updating customers. It is built from Appointedd's public API documentation and the OpenAPI 3.1 definitions it publishes, one per reference page, on developers.appointedd.com.

Once it's connected, someone in the organisation can ask things like:

- "What's booked for tomorrow, and who is coming?"
- "When is the next free slot for a haircut with Sam this week?"
- "Which services does Priya deliver, and how long is each?"
- "Find Jo Bloggs and show me their last few bookings."
- With writes enabled: "Book Jo Bloggs in for a haircut at 9:30 on Monday." / "Cancel the 2pm massage on the 7th."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `find_available_intervals` | Available start times for a service between two dates/times, with the free resources and any group bookings with space. A query, sent as a POST because that is how the API takes it; it changes nothing. | `POST /availability/intervals/search` |
| `find_available_dates` | Dates with availability for a service between two dates/times. Also a POST that changes nothing. | `POST /availability/days/search` |
| `list_services` | Services with category, booking type, occupancy, durations and prices, buffers and booking questions; `ids` filter; range-paginated. | `GET /services` |
| `get_service` | One service. | `GET /services/{id}` |
| `list_service_categories` | Categories (id, name); `ids` filter. | `GET /services/categories` |
| `list_resources` | Staff, rooms and equipment with the services each is assigned to and its groups; `services`, `ids`, `sort_by`, `order_by` filters. | `GET /resources` |
| `list_resource_groups` | Resource groups (id, name); `ids`, `order_by`. | `GET /resources/groups` |
| `list_bookings` | Bookings with status, service, resource, times, price, spaces and participants; every documented filter (`after`/`before`, `created_*`, `updated_*`, `statuses`, `ids`, `services`, `categories`, `customers`, `resources`, `return_matching_customers_only`, `timezone`, `sort_by`, `order_by`); range-paginated. The API has no single-booking endpoint, so one booking is fetched with `booking_ids`. | `GET /bookings` |
| `get_customer` | One customer with tags, marketing opt-in and custom fields, plus their bookings with the latest start first unless `max_bookings` is 0. | `GET /customers/{id}`, `GET /bookings?customers=…` |
| `find_customers` | Search by part of a name, email, mobile or phone. The API has no search parameter, so this pages through the customer list (100 per call). Names only by default; a match on an email or phone fragment still confirms such a detail exists on the account. | `GET /customers` |
| `create_reservation` | Holds a start time for a service (and optionally a resource) for a few minutes so it cannot be double-booked. Writes only. | `POST /availability/slots` |
| `create_booking` | Turns a reservation into a booking with zero or more customers. Writes only. | `POST /bookings` |
| `cancel_booking` | Cancels a booking and every customer's place on it. Writes only, marked destructive. | `POST /bookings/{id}/cancel` |
| `create_customer` | Adds a customer (name, optional email, mobile, phone, tags). Writes only. | `POST /customers` |
| `update_customer` | Changes a customer's name, email, mobile, phone or tags (tags replace the existing ones). Writes only. | `PUT /customers/{id}` |

Making a booking is the three-step flow from Appointedd's own "Creating a new booking" guide: `find_available_intervals`, then `create_reservation` for one of the returned start times, then `create_booking` with the reservation's id.

Not covered on purpose: `GET /services/categories/{id}` (its documented response schema and example are both empty objects), get and delete reservation, delete customer, delete and update resource, update booking, update and cancel a single customer on a booking, and booking-customer invoices.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need your organisation's API key from Appointedd (Settings > API, `app.appointedd.com/management/settings/api`). The API authenticates with that key in the `X-API-KEY` header. Appointedd's Authentication page warns that anyone with the key can perform any operation on the organisation, so treat the key like a password.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appointedd": {
      "command": "node",
      "args": ["/absolute/path/to/appointedd-mcp/dist/index.js"],
      "env": { "APPOINTEDD_API_KEY": "your-key" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add appointedd -e APPOINTEDD_API_KEY=your-key -- node /absolute/path/to/appointedd-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `APPOINTEDD_API_KEY` | yes | Your organisation's API key, sent as the `X-API-KEY` header. |
| `APPOINTEDD_ALLOW_WRITES` | no | `true` to register `create_reservation`, `create_booking`, `cancel_booking`, `create_customer` and `update_customer`. Off by default. |
| `APPOINTEDD_BASE_URL` | no | Defaults to `https://api.appointedd.com/v1`. Used by the tests. |

## Safety defaults

- Read-only unless `APPOINTEDD_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation, including the two availability searches, which are POSTs that change nothing; `cancel_booking` is marked destructive; `update_customer` is marked idempotent.
- Customers are third parties. By default a customer's email, mobile, phone, postal address and gender are not returned (`get_customer`, `find_customers`, and the results of `create_customer` and `update_customer`, even though the caller has just supplied them); a custom field whose name looks like contact data (email, phone, mobile, name, address, postcode, date of birth, IP, NHS or passport number and the like, whether written as `Date of birth`, `E-mail`, `homeAddress` or `nhsnumber`) is replaced by a placeholder; and in free-text fields (customer names and tags, other custom-field values, participants' question answers, service descriptions, resource names and descriptions, category and group names, booking question labels and options) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]`. `include_contact_details=true` returns all of it as stored. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers written with a bare `44` country code such as `448787981295` (the form Appointedd's own Create Customer example uses), UK numbers with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings that happen to start with `0` (an order number, say) are redacted too; 24-character hex IDs, timestamps and references such as `LOY-0001` are left alone, and a non-UK number written with a bare country code (`33612345678`) is not recognised. The same redaction is applied to Appointedd's own error messages before they are passed on.
- Participants on a booking carry a `reschedule_url`, which the Bookings page documents as a single-use link that reschedules that customer's booking. It is withheld unless `include_contact_details` is set. Resources are usually people, so a resource's email, phone and address are withheld the same way. A booking's video conferencing link is the organisation's own meeting link and is returned as stored.
- No documented response carries card, bank or payment details; prices, `total_price` and the `paid` flag are returned as the API gives them.
- `create_booking` sends `send_payment_request: false` unless asked otherwise. The API's own default is `true`, which emails a payment request to every customer on the booking.
- IDs are checked before any call is made: every ID in the API is 24 hexadecimal characters (the documented 400 for a malformed reservation ID quotes the regex `^[0-9a-fA-F]{24}$`), so `12345`, `../customers` or a 23-character value is refused locally. Date filters and availability ranges must be an ISO 8601 date or date-time (`2026-10-05`, `2026-10-05T09:00:00Z`, `2026-10-05T10:00:00+01:00`) and are passed through unchanged; `12/08/2026`, a bare year, a Unix timestamp, a space instead of the `T` (`2026-10-05 09:00:00Z`) or an impossible date such as `2026-02-30` (which Node's `Date.parse` would silently roll over to 2 March) is refused rather than guessed, as is a range whose end is not after its start. Timezones must be IANA names (`Area/Location`, or `UTC`) that Node's Intl data recognises; an offset such as `+01:00`, which Intl would accept, is refused because the API asks for IANA names.
- No documented endpoint redirects, so the client does not follow redirects: a 3xx (from a misconfigured `APPOINTEDD_BASE_URL`, say) is reported as an error and the `X-API-KEY` header is only ever sent to the configured base URL, never to a second host.
- Appointedd does not document a rate limit anywhere in its Introduction, Authentication, Pagination or Limitations pages or on any reference page. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method, including `POST /bookings`, on the assumption that a rate-limited request was not processed (see Status). The retry waits for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds so a tool call stays under the MCP client's default 60-second request timeout: if Appointedd asks for a longer wait the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable and to try again in a few minutes, without the gateway's HTML. No POST or PUT is retried after a gateway error, because the request may already have been processed and a retry could create a booking or hold a slot twice; the error says what to check before repeating it (`list_bookings` for a booking, `find_customers`/`get_customer` for a customer). The two availability searches are not retried either, and their error says they are queries that are safe to call again.
- The Limitations page sets a hard limit of 10240 bytes on request size. A body larger than that is refused locally with a message saying which fields to shorten, before anything is sent.
- A 200 whose body is not JSON (a proxy or a login page in the way), or whose JSON has no `data` list where a list endpoint documents one, is reported as an error naming `APPOINTEDD_BASE_URL`, never as an empty list or an empty record.
- A rejected API key (401 or 403) produces a message that says which variable to fix and where the key comes from; a 400 or 422 from the API is passed on with Appointedd's own `error`/`message` text and the names of the invalid fields when the API lists them.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the inline response schemas in Appointedd's published OpenAPI definitions (Get Bookings, Get Customers, Get Customer, Get Services, Get Service, Get Service Categories, Get Resources, Get Resource Groups, Find Available Intervals, Find Available Dates, Create Reservation and Get Reservation, Create Booking, Create Customer, Update Customer). Appointedd publishes one OpenAPI document per reference page; `test/assemble-spec.mjs` fetches the 30 pages listed in it (`developers.appointedd.com/reference/<slug>.md`), takes the "OpenAPI definition" block from the 25 that have one, merges them into `spec.json` on the first run, and refuses to continue if two pages define the same operation or component differently. The definitions are assembled this way because the single "OpenAPI 3 specification" document the Introduction page links to (`developers.appointedd.com/openapi/6130b17d1447b2003acc5216`) answered 404 when this was built (28 September 2026). `spec.json` is not committed, so the first `npm test` on a fresh clone needs network access to developers.appointedd.com (30 small page fetches, a few seconds); later runs use the saved file. The definitions carry no component schemas: every request and response schema is inline in its operation.
2. Starts a local mock of the API under `/v1` that serves those fixtures with the documented range-based pagination (`limit`, `start` = the previous page's `next`, `end` = the previous page's `prev`; `data`, `total`, `prev`, `next` out; bookings are capped at 3 per page and customers at 50 whatever is asked, so lists span several pages), X-API-KEY 401s, the documented 400 (bad limit, non-hex ID), 404 and 422 shapes, a single-use reservation store, and answers the first `GET /resources/groups` with a 429. The mock's list, detail, action and error responses are validated against the response schemas the spec gives for each operation and status, the documented pagination keys are asserted explicitly (the schemas mark nothing as required), and the availability, reservation, booking and customer bodies it is sent are validated against the request schemas.
3. Starts the built server and drives it over stdio with the official MCP client: 28 checks (30 in the whole suite) covering every tool, tool annotations, range pagination to `next: null` with `start` carrying the previous `next` and `limit` what is still wanted, `max_results` with an exact continuation (following `next_start` yields every booking exactly once), every documented `list_bookings` filter passed through exactly (array filters as the key repeated once per value), `sort_by`/`order_by` on bookings, resources and groups, the `ids` and `services` filters, local refusal of an inverted range, malformed dates (including `2026-02-30` and a space-separated date-time), a bad timezone (an unknown name and an offset) and malformed IDs before any request, redaction of contact details, contact-like custom fields (and the name heuristic behind them, for spellings such as `dateOfBirth`, `E-mail`, `homeAddress` and `nhsnumber`), emails and phone numbers in tags, names, descriptions, group names, question labels, options and answers (the `+44 (0)…`, bare `44…`, bracketed, `00`-prefixed, dot-separated and hyphenated phone forms), reschedule links and staff contact details by default and their return on request, `create_customer`'s result withholding the contact details just supplied unless asked, `find_customers` matching name, email and UK phone forms across three pages, both availability searches with their bodies validated against the spec's request schemas (including `resource_group_ids` sent as a single string, `parts`, `buffers`, `spaces` and every `ignore_*` flag), `create_reservation`, `create_booking` (with and without customers, `send_payment_request` false by default), `cancel_booking`, `create_customer` and `update_customer` with their bodies validated against the request schemas, the documented 404 for an unavailable reservation time and 422s for a used reservation and an already cancelled booking, the local refusal of an empty update and of a body over 10240 bytes, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 429 on `POST /bookings` retried once, a gateway error (502/503/504) retried for `GET` and never for `POST /bookings`, `POST /availability/slots`, the availability searches or a `PUT`, a `GET` failing three times with 503 reported with advice and without the gateway HTML, a 200 with a non-JSON body or with JSON whose `data` is missing or not a list reported as an error (never as an empty list), a 302 not followed (one request reaches the mock and the error names the base URL as the only place the key goes), Appointedd's own error text passed on with contact details redacted, the write gate with the variable unset and set to `false`, the 401 message, the server refusing to start without a key, and that every request used the `X-API-KEY` header, `application/json` for bodies, and a documented method and path.

Two places where the published definitions disagree with themselves are handled as follows. The Pagination page (and the categories, resources and resource-groups examples) say `prev` and `next` are `null` on the first and last page, while the bookings, customers and services schemas type `next` as a string; the mock follows the documented behaviour and step 2 drops a null `prev`/`next` before validating those pages. The Get Services example shows `"description": null` while its schema types `description` as a string; the fixtures follow the schema and the server treats a missing, null or empty description the same way.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without an Appointedd account. Everything below is taken from the published documentation and should be confirmed on a real account:

- Authentication: the body of a 401 is not documented (the mock answers with the `{statusCode, error, message}` shape every other documented error uses), and whether a wrong key gives 401 or 403.
- Unknown IDs: only `GET /services/{id}` documents a 404 (`"ID does not exist"`); `GET /customers/{id}` documents a 400 for a non-hex ID and nothing for an unknown one. The server reports any 404 as "Not found" with the API's message.
- Pagination: whether `next` is `null` or absent on the last page (the client treats both, and an empty string, as the end); whether `total` counts the filtered set, as the Pagination page says ("matches your current request"); what the API answers for a `start` ID that no longer exists (the mock answers an empty page); and what the default `sort_by=natural` with `order_by=descending` means in practice (the server keeps whatever order the API returns and passes the sort parameters through).
- Query arrays: the spec types `ids`, `services`, `categories`, `customers` and `resources` as arrays of strings without saying how to serialise them. The server sends the key repeated once per value (`services=a&services=b`), the OpenAPI 3 default; the descriptions say a single value is accepted too.
- `GET /bookings`: `statuses` is typed as a single enum value although its description says "at least one of the provided statuses", so the tool takes one status; `return_matching_customers_only` is documented against "the IDs in the `ids` query parameter" although it clearly concerns customers, and is passed through as is; and whether `after`/`before` compare with `start_buffer`/`end_buffer` ("including the after buffer") as the mock does.
- Date filters and ranges are documented as "a valid ISO8601 formatted date and time". A date without a time (`2026-10-05`) is passed through as given; whether the API accepts it, and in which timezone it reads it, is not documented.
- Timezones are documented as "a valid, non-deprecated, IANA Timezone". The server checks the shape and that Node's Intl data knows the name; whether a name is deprecated (`Asia/Calcutta`, `EST`) it cannot tell, so such a value is sent and the API's answer decides.
- Availability searches: `resource_group_ids` is typed as a single string although its description says "one or more", so the tool takes one `resource_group_id` and sends it as that string. The default result timezone is documented as `Europe/London` for the searches and for a reservation's `start`, and as `UTC` for `POST /bookings` (Create Booking) only; `GET /bookings` documents no default (its example shows `+00:00` offsets). The server passes `timezone` through and converts nothing.
- `POST /bookings`: the spec's request schema has `data.customers` (an array of `{customer, notes, questions, …}` objects), which is what the server sends, while the "Creating a new booking" guide's example posts a singular `data.customer`. Whether `send_payment_request: false` suppresses every payment email, and how customers are matched to existing ones "using the name, email, and/or mobile fields".
- `POST /availability/slots`: the 404 message is the documented one; the guide also mentions a `duration` property on the reservation data that the schema does not list, so the server does not send it (`parts` covers the same need). A 429 on this endpoint or on `POST /bookings` is retried on the assumption that a rate-limited request was not processed; Appointedd documents no 429 and no rate limit at all, so the 250 ms spacing here is a guess on the polite side.
- Money: `service.durations[].price` is typed as an integer and the booking `price`/`total_price` as numbers (example `0.01`); the currency and units are not documented, and the server passes the numbers through.
- Custom fields on customers: an object keyed by field name whose "date" fields the docs say come back as UNIX timestamps; the server passes numbers through and applies the contact-data rules to the names. Which field names real organisations use decides how well the withholding heuristic fits.
- Video conferencing: the Bookings page says Zoom meeting properties appear asynchronously after a booking is created; the server returns whatever is present.
- The Limitations page documents the 10240-byte request limit but not the status the API answers with when it is exceeded (the mock uses 413).
- The wording of Appointedd's error messages and whether any of them echo request data such as a customer's email address; the texts here are the spec's examples, and the server redacts contact details from them regardless.

## Going to production

This version runs locally over stdio, with the organisation's own API key. For customers to connect from claude.ai or ChatGPT without handling keys, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Appointedd, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.

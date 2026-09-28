// Turn Appointedd API records into compact objects an assistant can read quickly.
// Field names follow the inline response schemas in Appointedd's OpenAPI definitions (Get Bookings,
// Get Customers / Get Customer, Get Services / Get Service, Get Service Categories, Get Resources,
// Get Resource Groups, Find Available Intervals / Dates, Create Reservation, Create Booking,
// Create Customer, Update Customer).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Four shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bare UK country code: "44" then 9-10 digits with no "+" or "00" (448787981295, the form
//     Appointedd's own Create Customer example uses; 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so 24-character hex IDs, timestamps
// (10 or 13 digits, none starting with 44 this century) and hyphenated references such as
// PO-0001-000123 are left alone. Any other 9-11 digit string starting with 0 (an order number, say) is
// redacted too; the raw text is available with include_contact_details. Other countries' numbers
// written with a bare country code (33612345678) are not recognised.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|44(?:[ .-]?\d){9,10}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/**
 * Replace email addresses and phone-number-like sequences inside free text (names, question answers,
 * notes, descriptions, tags, custom fields) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// Custom-field names that mark the value as contact data (a customer's email, phone, name, address,
// date of birth, IP address, or an official identifier). Such values are withheld entirely by default;
// other values get the email/phone redaction. The name is normalised first (camelCase split at each
// capital, spaces and hyphens turned into "_", lower-cased) so that "customerName", "E-Mail",
// "Date of birth" and "home_address" all read the same. Tokens that only ever mean contact data
// (email, phone, mobile, postcode, birth, passport, nhs, address) match anywhere in the name, so
// "ipaddress" and "nhsnumber" are caught; the rest match as whole words so that "zip" is caught but
// "description" (contains "ip") is not.
const CONTACT_ANYWHERE = /e_?mail|phone|mobile|post_?code|birth|passport|nhs|address/;
const CONTACT_WORD = /(?:^|_)(?:tel|fax|cell|names?|surname|forename|firstname|lastname|first_name|last_name|full_name|zip|dob|ip|ni_number|national_insurance|contact)(?:_|$)/;
const normaliseName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
export const looksLikeContactField = (name: unknown) => {
  if (typeof name !== "string") return false;
  const n = normaliseName(name);
  return CONTACT_ANYWHERE.test(n) || CONTACT_WORD.test(n);
};
const WITHHELD = "[withheld: looks like contact data; available with include_contact_details]";

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const strings = (v: unknown, includeContact: boolean) => (Array.isArray(v) ? v.map((x) => redactContacts(x, includeContact) ?? str(x)).filter((x) => x !== undefined) : undefined);

// custom_fields is an object keyed by field name (Get Customers: "test_text", "test_date"; the docs
// say "date" type fields come back as UNIX timestamps). A value whose name marks it as contact data
// is withheld by default; every other string value is redacted as text; numbers pass through.
function customFields(cf: unknown, includeContact: boolean) {
  if (!cf || typeof cf !== "object" || Array.isArray(cf)) return undefined;
  const out: Rec = {};
  for (const [k, v] of Object.entries(cf as Rec)) {
    if (!includeContact && looksLikeContactField(k)) out[k] = WITHHELD;
    else if (typeof v === "string") out[k] = redactContacts(v, includeContact) ?? "";
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Customer (Get Customers / Get Customer / Create Customer / Update Customer). Names are always
// returned, minus any email or phone typed into them; email, mobile, phone, the postal address and
// gender only on request.
export function customer(c: Rec, includeContact: boolean) {
  const p = c.profile ?? {};
  return {
    id: str(c.id),
    first_name: redactContacts(p.firstname, includeContact),
    last_name: redactContacts(p.lastname, includeContact),
    ...(includeContact
      ? {
          email: str(p.email),
          mobile: str(p.mobile),
          phone: str(p.phone),
          address_1: str(p.address_1),
          address_2: str(p.address_2),
          city: str(p.city),
          postcode: str(p.postcode),
          gender: str(p.gender),
        }
      : {}),
    marketing_opt_in: bool(c.marketing_opt_in),
    tags: strings(c.tags, includeContact),
    custom_fields: customFields(c.custom_fields, includeContact),
    created: str(c.created),
    updated: str(c.updated),
  };
}

// Booking question asked during the booking flow: label is the organisation's question, value the
// customer's answer (free text, possibly an email or phone number).
function question(q: Rec, includeContact: boolean) {
  return { label: redactContacts(q.label, includeContact), type: str(q.type), value: redactContacts(q.value, includeContact) };
}

// Participant on a booking (Bookings page: "the participation of a customer on a booking"). The
// reschedule_url is a single-use link that lets its holder move this customer's booking, so it is
// only returned on request.
export function participant(p: Rec, includeContact: boolean) {
  return {
    customer_id: str(p.customer_id) ?? str(p.id),
    customer_booking_id: str(p.customer_booking_id),
    spaces: num(p.spaces),
    total_spaces: num(p.total_spaces),
    status: str(p.status),
    paid: bool(p.paid),
    total_price: num(p.total_price),
    price_points: Array.isArray(p.price_points)
      ? p.price_points.map((pp: Rec) => ({ quantity: num(pp.quantity), price_per_quantity: num(pp.price_per_quantity), spaces_per_quantity: num(pp.spaces_per_quantity) }))
      : undefined,
    booking_source: str(p.booking_source),
    timezone: str(p.timezone),
    locale: str(p.locale),
    questions: Array.isArray(p.questions) ? p.questions.map((q: Rec) => question(q, includeContact)) : undefined,
    created: str(p.created),
    added: str(p.added),
    ...(includeContact ? { reschedule_url: str(p.reschedule_url) } : {}),
  };
}

// Booking (Get Bookings items use `service` and `resource`; the Create Booking response uses
// `service_id` and `resource_id`). The video conferencing link is the organisation's own meeting
// link (Bookings page, Video Conferencing) and is returned as stored.
export function booking(b: Rec, includeContact: boolean) {
  const customers = Array.isArray(b.customers) ? b.customers : [];
  return {
    id: str(b.id),
    status: str(b.status),
    service_id: str(b.service) ?? str(b.service_id),
    resource_id: str(b.resource) ?? str(b.resource_id),
    start: str(b.start),
    end: str(b.end),
    start_buffer: str(b.start_buffer),
    end_buffer: str(b.end_buffer),
    parts: Array.isArray(b.parts) ? b.parts.map((p: Rec) => ({ start: str(p.start), end: str(p.end), label: redactContacts(p.label, includeContact) })) : undefined,
    price: num(b.price),
    total_spaces: num(b.total_spaces),
    spaces_booked: customers.reduce((s: number, c: Rec) => s + (num(c.spaces) ?? 0), 0),
    participants: customers.map((c: Rec) => participant(c, includeContact)),
    allow_external_customers: bool(b.allow_external_customers),
    video_conference_type_name: str(b.video_conference_type_name),
    video_conference_link: str(b.video_conference_link),
    created_source: str(b.created_source),
    created: str(b.created),
    updated: str(b.updated),
  };
}

// Service (Get Services / Get Service). Names, descriptions and question text are the organisation's
// own content but get the email/phone redaction by default, as in every other tool.
function bookingQuestion(q: Rec, includeContact: boolean): Rec {
  return {
    id: str(q.id),
    name: redactContacts(q.name, includeContact),
    type: str(q.type),
    required: str(q.required),
    visibility: str(q.visibility),
    options: Array.isArray(q.options) ? q.options.map((o: Rec) => ({ id: str(o.id), value: redactContacts(o.value, includeContact) })) : undefined,
    subquestions: Array.isArray(q.subquestions) ? q.subquestions.map((s: Rec) => ({ ...bookingQuestion(s, includeContact), dropdown_triggers: strings(s.dropdown_triggers, true) })) : undefined,
  };
}

export function service(s: Rec, includeContact: boolean) {
  const b = s.booking ?? {};
  return {
    id: str(s.id),
    name: redactContacts(s.name, includeContact),
    category_id: str(s.category_id),
    description: redactContacts(s.description, includeContact),
    booking: {
      type: str(b.type),
      occupancy: num(b.occupancy),
      allow_group: bool(b.allow_group),
      buffers: b.buffers && typeof b.buffers === "object" ? { before: num(b.buffers.before), after: num(b.buffers.after) } : undefined,
      durations: Array.isArray(b.durations) ? b.durations.map((d: Rec) => ({ minutes: num(d.minutes), price: num(d.price), old_price: num(d.old_price), default: bool(d.default) })) : undefined,
      tiers: Array.isArray(b.tiers) ? b.tiers.length : undefined,
    },
    booking_questions: Array.isArray(s.booking_questions) ? s.booking_questions.map((q: Rec) => bookingQuestion(q, includeContact)) : undefined,
  };
}

export function serviceCategory(c: Rec, includeContact: boolean) {
  return { id: str(c.id), name: redactContacts(c.name, includeContact) };
}

export function resourceGroup(g: Rec, includeContact: boolean) {
  return { id: str(g.id), name: redactContacts(g.name, includeContact) };
}

// Resource (Get Resources): a staff member, room or piece of equipment. The Get Resources schema and
// example show only profile.name; the Update Resource (PUT /resources/{resource_id}) request and
// response schemas add profile email, phone and address (house_no, address_1, address_2, city,
// postcode), so a listed resource can carry them. A resource is usually a person, so those are only
// returned on request.
export function resource(r: Rec, includeContact: boolean) {
  const p = r.profile ?? {};
  const a = p.address && typeof p.address === "object" ? p.address : undefined;
  return {
    id: str(r.id),
    name: redactContacts(p.name, includeContact),
    description: redactContacts(p.description, includeContact),
    service_ids: strings(r.services, true),
    resource_group_ids: strings(r.resource_group_ids, true),
    ...(includeContact
      ? {
          email: str(p.email),
          phone: str(p.phone),
          address: a ? { house_no: str(a.house_no), address_1: str(a.address_1), address_2: str(a.address_2), city: str(a.city), postcode: str(a.postcode) } : undefined,
        }
      : {}),
    created: str(r.created),
    updated: str(r.updated),
  };
}

// Availability search result item (Find Available Intervals / Find Available Dates).
export function availability(a: Rec) {
  return {
    start: str(a.start),
    resource_ids: strings(a.resource_ids, true),
    group_bookings: Array.isArray(a.group_bookings) ? a.group_bookings.map((g: Rec) => ({ id: str(g.id), resource_id: str(g.resource_id), spaces: num(g.spaces) })) : undefined,
  };
}

// Reservation / availability slot (Create Reservation 201).
export function reservation(r: Rec) {
  return {
    id: str(r.id),
    service_id: str(r.service_id),
    resource_id: str(r.resource_id),
    resource_ids: Array.isArray(r.resources) ? r.resources.map((x: Rec) => str(x.id)).filter(Boolean) : undefined,
    start: str(r.start),
    end: str(r.end),
    start_buffer: str(r.start_buffer),
    end_buffer: str(r.end_buffer),
    parts: Array.isArray(r.parts) ? r.parts.map((p: Rec) => ({ start: str(p.start), end: str(p.end) })) : undefined,
    expiry: str(r.expiry),
    max_spaces: num(r.max_spaces),
    reserved_spaces: num(r.reserved_spaces),
    allow_additional_spaces: bool(r.allow_additional_spaces),
    created: str(r.created),
    updated: str(r.updated),
  };
}

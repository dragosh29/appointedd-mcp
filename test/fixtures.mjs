// Fake Appointedd data shaped exactly like the inline response schemas in the published OpenAPI
// definitions (validated in e2e.mjs). Every ID is a 24-character hex string, like every example in
// the spec; timestamps use the "+00:00" and "Z" forms the examples show.
const hex = (seed) => {
  // Deterministic 24-character lowercase hex string.
  let out = "";
  let x = seed * 2654435761 + 12345;
  while (out.length < 24) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += x.toString(16).padStart(8, "0");
  }
  return out.slice(0, 24);
};
const at = (day, h, m = 0, month = "10") => `2026-${month}-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000+00:00`;
const z = (day, h, m = 0, month = "09") => `2026-${month}-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

// ---- Service categories (Get Service Categories) ----
export const CAT_HAIR = hex(1);
export const CAT_MASSAGE = hex(2);
export const categories = [
  { id: CAT_HAIR, name: "Hair" },
  { id: CAT_MASSAGE, name: "Massage & wellbeing (ask spa@example.com)" },
];

// ---- Services (Get Services / Get Service) ----
export const SVC_HAIRCUT = hex(10);
export const SVC_MASSAGE = hex(11);
export const SVC_YOGA = hex(12);
const duration = (minutes, price, dflt = true) => ({ default: dflt, minutes, price, old_price: 0 });
export const services = [
  {
    id: SVC_HAIRCUT,
    category_id: CAT_HAIR,
    name: "Haircut",
    booking: { occupancy: 1, type: "ONLINE_BOOKING", buffers: { before: 0, after: 0 }, durations: [duration(30, 25), duration(45, 35, false)], tiers: [], allow_group: false },
    description: "Wash, cut and finish.",
    booking_questions: [
      // Question labels and options are the organisation's own text; contact details typed into them are redacted by default.
      { id: hex(101), name: "Any allergies? (or email allergies@example.com)", type: "text", required: "false", visibility: "online", options: [], subquestions: [] },
      {
        id: hex(102),
        name: "How did you hear about us?",
        type: "dropdown",
        required: "false",
        visibility: "online",
        options: [{ id: hex(103), value: "Friend" }, { id: hex(104), value: "Search (ads@example.com)" }],
        subquestions: [{ id: hex(105), name: "Which friend?", type: "text", dropdown_triggers: [hex(103)], required: "false", visibility: "online" }],
      },
    ],
  },
  {
    id: SVC_MASSAGE,
    category_id: CAT_MASSAGE,
    name: "Deep tissue massage",
    booking: { occupancy: 1, type: "ONLINE_BOOKING", buffers: { before: 0, after: 15 }, durations: [duration(60, 55)], tiers: [], allow_group: false },
    // The organisation's own text with contact details typed into it: redacted by default like everything else.
    description: "60 minutes. Questions? Call 0117 496 0000 or email spa@example.com.",
    booking_questions: [],
  },
  {
    id: SVC_YOGA,
    category_id: CAT_MASSAGE,
    name: "Group yoga class",
    booking: { occupancy: 10, type: "ONLINE_BOOKING", buffers: { before: 0, after: 0 }, durations: [duration(60, 12)], tiers: [], allow_group: true },
    // No description: the spec example shows null here, but its schema types description as a string, so the key is left out.
  },
];

// ---- Resource groups (Get Resource Groups) ----
export const GRP_STYLISTS = hex(20);
export const GRP_THERAPISTS = hex(21);
export const GRP_ROOMS = hex(22);
export const resourceGroups = [
  { id: GRP_STYLISTS, name: "Stylists" },
  { id: GRP_THERAPISTS, name: "Therapists" },
  { id: GRP_ROOMS, name: "Rooms (keys: 07700 900999)" },
];

// ---- Resources (Get Resources): staff members and a room ----
export const RES_SAM = hex(30);
export const RES_PRIYA = hex(31);
export const RES_ROOM = hex(32);
export const resources = [
  {
    created: z(1, 9),
    updated: z(20, 10),
    id: RES_SAM,
    services: [SVC_HAIRCUT, SVC_YOGA],
    // The Update Resource schemas (not the Get Resources example, which shows only a name) put phone, email and
    // address on a resource's profile; a resource is usually a person.
    profile: { name: "Sam Evans", phone: "07700 900321", email: "sam.evans@example.com", address: { house_no: "12", address_1: "High Street", address_2: "", city: "Bristol", postcode: "BS1 1AA" }, description: "Senior stylist, direct line 07700 900321" },
    resource_group_ids: [GRP_STYLISTS],
  },
  {
    created: z(1, 9, 5),
    updated: z(21, 11),
    id: RES_PRIYA,
    services: [SVC_MASSAGE],
    profile: { name: "Priya Shah", phone: "", email: "priya.shah@example.com", address: { house_no: "", address_1: "", address_2: "", city: "", postcode: "" }, description: "" },
    resource_group_ids: [GRP_THERAPISTS],
  },
  {
    created: z(2, 9),
    updated: z(2, 9),
    id: RES_ROOM,
    services: [SVC_YOGA],
    // A name with a phone number typed into it, to prove names are redacted by default.
    profile: { name: "Studio 1 (call 07700 900999 to unlock)" },
    resource_group_ids: [GRP_ROOMS],
  },
];

// ---- Customers (Get Customers / Get Customer) ----
export const CUST_JO = hex(40);
export const CUST_PRIYA = hex(41);
export const CUST_LEE = hex(42);
export const CUST_ADA = hex(43);
const mkCustomer = (id, firstname, lastname, extra = {}, profileExtra = {}) => ({
  id,
  profile: { firstname, lastname, ...profileExtra },
  created: z(1, 10),
  custom_fields: {},
  marketing_opt_in: false,
  tags: [],
  updated: z(1, 10),
  ...extra,
});
export const customers = [
  mkCustomer(
    CUST_JO,
    "Jo",
    "Bloggs",
    {
      marketing_opt_in: true,
      tags: ["VIP", "Referred by ada@example.org"],
      // A "date" type custom field comes back as a UNIX timestamp (Get Customers page); the name of the first
      // field marks it as contact data, the second carries an email inside free text.
      custom_fields: { "Date of birth": 1640995200, Notes: "Prefers Sam. Confirm by text to 07700 900123 or jo.bloggs@example.com", "Loyalty number": "LOY-0001" },
      updated: z(21, 10),
    },
    { mobile: "+447700900123", phone: "0117 496 0000", email: "jo.bloggs@example.com", address_1: "1 Plymouth Road", address_2: "", city: "Penarth", postcode: "CF64 3DH" },
  ),
  mkCustomer(CUST_PRIYA, "Priya", "Shah", {}, { mobile: "+447700900456", email: "priya.shah@example.com" }),
  // A customer whose name field has an email typed into it, to prove names are redacted by default.
  mkCustomer(CUST_LEE, "Lee", "Chen (lee.chen@example.net)", {}, { email: "lee.chen@example.net" }),
  mkCustomer(CUST_ADA, "Ada", "Lovelace", { tags: ["Engineer"] }, { email: "ada@example.org", mobile: "448787981295" }),
  // 117 more so the list spans three pages of 50 in the mock (total 121).
  ...Array.from({ length: 117 }, (_, i) => mkCustomer(hex(1000 + i), `Person${i}`, `Surname${i}`, {}, { email: `person${i}@example.org`, mobile: `+44790000${String(i).padStart(4, "0")}` })),
];

// ---- Bookings (Get Bookings) ----
export const BK_HAIRCUT_JO = hex(50);
export const BK_MASSAGE_PRIYA = hex(51);
export const BK_YOGA = hex(52);
export const BK_CANCELLED = hex(53);
export const BK_PENDING = hex(54);
export const BK_MASSAGE_JO = hex(55);
export const BK_PAST = hex(56);
export const RESCHEDULE_URL = (bookingId, participantId) => `https://reschedule.appointedd.com?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&bookingId=${bookingId}&participantId=${participantId}`;
const participant = (bookingId, customerId, seed, spaces, extra = {}) => ({
  id: customerId,
  customer_id: customerId,
  customer_booking_id: hex(seed),
  spaces,
  booking_source: "online_booking",
  timezone: "Europe/London",
  locale: "en",
  created: z(20, 12),
  added: z(20, 12),
  status: "No Status",
  questions: [],
  total_spaces: spaces,
  total_price: 0,
  price_points: [],
  reschedule_url: RESCHEDULE_URL(bookingId, hex(seed)),
  ...extra,
});
const mkBooking = (id, service, resource, day, h, minutes, customersOn, extra = {}) => {
  const end = h * 60 + minutes;
  return {
    id,
    service,
    resource,
    customers: customersOn,
    start: at(day, h),
    end: at(day, Math.floor(end / 60), end % 60),
    start_buffer: at(day, h),
    end_buffer: at(day, Math.floor(end / 60), end % 60),
    price: 0,
    total_spaces: 1,
    status: "confirmed",
    updated: z(21, 9),
    created: z(20, 12),
    created_source: "online_booking",
    ...extra,
  };
};
export const bookings = [
  mkBooking(BK_HAIRCUT_JO, SVC_HAIRCUT, RES_SAM, 5, 9, 30, [
    participant(BK_HAIRCUT_JO, CUST_JO, 500, 1, {
      total_price: 25,
      price_points: [{ quantity: 1, price_per_quantity: 25, spaces_per_quantity: 1 }],
      // Free-text answers typed by the customer, with contact details in the written forms the redaction must recognise.
      questions: [
        { label: "Any allergies?", type: "text", value: "None. Text me on 07700 900123 or jo.bloggs@example.com if running late." },
        { label: "How did you hear about us?", type: "dropdown", value: "Friend" },
        { label: "Which friend?", type: "text", value: "Ada, +44 (0)7700 900789, (0117) 496 0000, 0044 20 7946 0958, 07700.900555, 07700-900556 or 448787981295" },
        { label: "http://example.org/terms", type: "terms", value: "true" },
      ],
    }),
  ], { price: 25, created: z(20, 12), updated: z(21, 9) }),
  mkBooking(BK_MASSAGE_PRIYA, SVC_MASSAGE, RES_PRIYA, 5, 10, 60, [participant(BK_MASSAGE_PRIYA, CUST_PRIYA, 501, 1, { total_price: 55 })], {
    price: 55,
    end_buffer: at(5, 11, 15),
    video_conference_link: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_example",
    video_conference_type_name: "microsoft",
    created: z(22, 8),
    updated: z(22, 8),
  }),
  mkBooking(BK_YOGA, SVC_YOGA, RES_SAM, 5, 18, 60, [
    participant(BK_YOGA, CUST_JO, 502, 2, { total_spaces: 2, total_price: 24, price_points: [{ quantity: 2, price_per_quantity: 12, spaces_per_quantity: 1 }] }),
    participant(BK_YOGA, CUST_LEE, 503, 1, { total_price: 12, status: "Arrived" }),
    participant(BK_YOGA, CUST_ADA, 504, 1, { total_price: 12 }),
  ], { total_spaces: 10, price: 12, created: z(15, 9), updated: z(23, 9) }),
  mkBooking(BK_CANCELLED, SVC_HAIRCUT, RES_SAM, 6, 9, 30, [participant(BK_CANCELLED, CUST_ADA, 505, 1)], { status: "cancelled", price: 25, created: z(18, 9), updated: z(24, 9) }),
  mkBooking(BK_PENDING, SVC_HAIRCUT, RES_SAM, 6, 11, 30, [participant(BK_PENDING, CUST_PRIYA, 506, 1)], { status: "pending", price: 25, created: z(25, 9), updated: z(25, 9), created_source: "api" }),
  mkBooking(BK_MASSAGE_JO, SVC_MASSAGE, RES_PRIYA, 7, 14, 60, [participant(BK_MASSAGE_JO, CUST_JO, 507, 1, { total_price: 55 })], { price: 55, end_buffer: at(7, 15, 15), created: z(26, 9), updated: z(26, 9) }),
  mkBooking(BK_PAST, SVC_HAIRCUT, RES_SAM, 28, 15, 30, [participant(BK_PAST, CUST_LEE, 508, 1)], { start: at(28, 15, 0, "09"), end: at(28, 15, 30, "09"), start_buffer: at(28, 15, 0, "09"), end_buffer: at(28, 15, 30, "09"), price: 25, created: z(10, 9), updated: z(10, 9) }),
];

// ---- Availability (Find Available Intervals / Find Available Dates) ----
// Start times (UTC) at which the mock says a service is available, with the free resources.
export const AVAILABLE_START = "2026-10-05T09:30:00Z";
export const intervals = {
  [SVC_HAIRCUT]: [
    { start: AVAILABLE_START, resource_ids: [RES_SAM], group_bookings: [] },
    { start: "2026-10-05T10:00:00Z", resource_ids: [RES_SAM], group_bookings: [] },
    { start: "2026-10-05T10:30:00Z", resource_ids: [RES_SAM], group_bookings: [] },
    { start: "2026-10-06T09:30:00Z", resource_ids: [RES_SAM], group_bookings: [] },
  ],
  [SVC_MASSAGE]: [{ start: "2026-10-05T12:00:00Z", resource_ids: [RES_PRIYA], group_bookings: [] }],
  // The yoga class at 18:00 is an existing group booking with six of ten spaces left.
  [SVC_YOGA]: [{ start: "2026-10-05T18:00:00Z", resource_ids: [RES_SAM, RES_ROOM], group_bookings: [{ id: BK_YOGA, resource_id: RES_SAM, spaces: 6 }] }],
};
export const days = {
  [SVC_HAIRCUT]: [
    { start: "2026-10-05T00:00:00Z", resource_ids: [RES_SAM], group_bookings: [] },
    { start: "2026-10-06T00:00:00Z", resource_ids: [RES_SAM], group_bookings: [] },
  ],
  [SVC_MASSAGE]: [{ start: "2026-10-05T00:00:00Z", resource_ids: [RES_PRIYA], group_bookings: [] }],
  [SVC_YOGA]: [{ start: "2026-10-05T00:00:00Z", resource_ids: [RES_SAM, RES_ROOM], group_bookings: [{ id: BK_YOGA, resource_id: RES_SAM, spaces: 6 }] }],
};

// ---- Reservation (Create Reservation 201), as the mock creates it for an available start ----
export const RESERVATION_ID = hex(60);
export const NEW_BOOKING_ID = hex(61);
export const NEW_CUSTOMER_ID = hex(62);
export const reservation = {
  id: RESERVATION_ID,
  resource_id: RES_SAM,
  service_id: SVC_HAIRCUT,
  resources: [{ id: RES_SAM }],
  start: "2026-10-05T09:30:00.000Z",
  start_buffer: "2026-10-05T09:30:00.000Z",
  end: "2026-10-05T10:00:00.000Z",
  end_buffer: "2026-10-05T10:00:00.000Z",
  parts: [{ start: "2026-10-05T09:30:00.000Z", end: "2026-10-05T10:00:00.000Z" }],
  expiry: "2026-09-28T12:20:00.000Z",
  max_spaces: 1,
  reserved_spaces: 1,
  allow_additional_spaces: false,
  created: "2026-09-28T12:00:00.000Z",
  updated: "2026-09-28T12:00:00.000Z",
};

// Create Booking 201, built by the mock from the reservation and the customers posted.
export const createdBooking = (slot, body, seed = 600) => ({
  id: NEW_BOOKING_ID,
  service_id: slot.service_id,
  resource_id: slot.resource_id,
  allow_external_customers: true,
  customers: (body.data?.customers ?? []).map((c, i) => ({
    id: hex(seed + i),
    customer_id: hex(seed + i),
    customer_booking_id: hex(seed + 50 + i),
    spaces: c.total_spaces ?? 1,
    booking_source: c.booking_source ?? "api",
    timezone: c.timezone ?? body.timezone ?? "UTC",
    paid: false,
    locale: c.locale ?? "en",
    created: "2026-09-28T12:01:00.000+00:00",
    added: "2026-09-28T12:01:00.000+00:00",
    status: c.status ?? "No Status",
    questions: c.questions ?? [],
    total_spaces: c.total_spaces ?? 1,
    total_price: 25,
    price_points: [{ quantity: 1, price_per_quantity: 25, spaces_per_quantity: 1 }],
    reschedule_url: RESCHEDULE_URL(NEW_BOOKING_ID, hex(seed + 50 + i)),
  })),
  created_source: body.data?.created_source ?? "api",
  created: "2026-09-28T12:01:00.000Z",
  updated: "2026-09-28T12:01:00.000Z",
  location: null,
  start: slot.start,
  start_buffer: slot.start_buffer,
  end: slot.end,
  end_buffer: slot.end_buffer,
  buffers: { before: "0", after: "0" },
  parts: slot.parts.map((p) => ({ ...p, label: null })),
  status: "confirmed",
  price: 25,
  total_spaces: slot.max_spaces,
  resources: [{ _id: slot.resource_id }],
});

// Create Customer 201 / Update Customer 200, built by the mock from the posted profile.
export const createdCustomer = (body) => ({
  id: NEW_CUSTOMER_ID,
  tags: body.data?.tags ?? [],
  profile: { ...body.data.profile },
  created: "2026-09-28T12:02:00.000Z",
  updated: "2026-09-28T12:02:00.000Z",
});
export const updatedCustomer = (existing, body) => ({
  id: existing.id,
  created: existing.created,
  updated: "2026-09-28T12:03:00.000Z",
  tags: body.data?.tags ?? existing.tags,
  profile: { ...existing.profile, ...(body.data?.profile ?? {}) },
});

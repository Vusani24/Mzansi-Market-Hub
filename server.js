const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = "Khanya0901@2";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "database");
const DB_FILE = path.join(DATA_DIR, "db.json");
const sessions = new Set();

const defaultDB = {
  listings: { pending: [], approved: [], rejected: [], flagged: [], taken: [], changedMind: [] },
  orders: [],
  appointments: [],
  activities: [],
  analytics: { events: [] },
  settings: { platformName: "Mzansi Market Place", phase: "Phase 1 WhatsApp MVP" }
};

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) writeDB(defaultDB);
}

function migrateDB(db) {
  const migrated = {
    ...defaultDB,
    ...(db || {}),
    listings: {
      ...defaultDB.listings,
      ...((db || {}).listings || {})
    },
    orders: Array.isArray(db?.orders) ? db.orders : [],
    appointments: Array.isArray(db?.appointments) ? db.appointments : [],
    activities: Array.isArray(db?.activities) ? db.activities : [],
    analytics: {
      events: Array.isArray(db?.analytics?.events) ? db.analytics.events : []
    },
    settings: {
      ...defaultDB.settings,
      ...((db || {}).settings || {})
    }
  };

  if (!db?.listings && db?.rooms) {
    migrated.listings.pending = (db.rooms.pending || []).map(roomToListing);
    migrated.listings.approved = (db.rooms.approved || []).map(roomToListing);
    migrated.listings.rejected = [
      ...(db.rooms.declined || []),
      ...(db.rooms.removed || [])
    ].map(roomToListing);
  }

  return migrated;
}

function cleanAnalyticsEvent(body, req) {
  const allowedTypes = ["page_view", "whatsapp_click", "phone_click", "listing_view", "service_view", "enquiry"];
  const type = allowedTypes.includes(body.type) ? body.type : "page_view";
  const referrer = cleanText(body.referrer || req.headers.referer || "", 300);
  return {
    id: "event-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    type,
    page: cleanText(body.page, 120),
    listingId: cleanText(body.listingId, 100),
    listingType: body.listingType === "service" ? "service" : body.listingType === "item" ? "item" : "",
    category: cleanText(body.category, 80),
    area: cleanText(body.area || "Other Areas", 80),
    source: cleanText(body.source || trafficSource(referrer), 40),
    referrer,
    visitorId: cleanText(body.visitorId, 120),
    createdAt: new Date().toISOString()
  };
}

function trafficSource(referrer) {
  const value = String(referrer || "").toLowerCase();
  if (value.includes("facebook")) return "Facebook";
  if (value.includes("whatsapp") || value.includes("wa.me")) return "WhatsApp";
  if (value.includes("google")) return "Google";
  if (value) return "Referral";
  return "Direct";
}

function readDB() {
  ensureDB();
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  return migrateDB(parsed);
}

function writeDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function send(res, status, body, type = "application/json", cacheControl = "no-store") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": cacheControl,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 90 * 1024 * 1024) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function cleanText(value, max = 600) {
  return String(value || "").trim().slice(0, max);
}

function cleanMoney(value) {
  const amount = Number(String(value || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.min(250000, amount));
}

function cleanImages(images) {
  return Array.isArray(images)
    ? images.filter((src) => typeof src === "string" && /^(data:image\/|https?:\/\/)/i.test(src)).slice(0, 6)
    : [];
}

function cleanVideo(video) {
  return typeof video === "string" && /^(data:video\/|https?:\/\/)/i.test(video) ? video : "";
}

function cleanAttachment(file) {
  return cleanUpload(file, /^(data:image\/|data:video\/|data:application\/pdf|data:text\/|https?:\/\/)/i);
}

function cleanUpload(file, allowedData) {
  if (!file || typeof file !== "object") return null;
  const data = typeof file.data === "string" && allowedData.test(file.data) ? file.data : "";
  if (!data) return null;
  return {
    name: cleanText(file.name || "uploaded-file", 120),
    type: cleanText(file.type || "", 80),
    data
  };
}

function cleanVerification(verification) {
  const typeOptions = ["RSA ID", "Passport"];
  return {
    required: Boolean(verification?.required),
    type: typeOptions.includes(verification?.type) ? verification.type : "",
    document: cleanUpload(verification?.document, /^(data:image\/|data:application\/pdf|https?:\/\/)/i),
    selfie: cleanUpload(verification?.selfie, /^(data:image\/|https?:\/\/)/i)
  };
}

function cleanArray(values, allowed) {
  const list = Array.isArray(values) ? values : [];
  return list.filter((value) => allowed.includes(value)).slice(0, allowed.length);
}

function safePublicListing(listing) {
  const { sellerEmail, verification, ...publicListing } = listing;
  return publicListing;
}

function requireAdmin(req, res) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !sessions.has(token)) {
    send(res, 401, { error: "Admin login required" });
    return false;
  }
  return true;
}

function roomToListing(room) {
  return {
    id: room.id || "migrated-" + Date.now(),
    listingType: "item",
    title: cleanText(room.title || room.address || "Marketplace listing", 100),
    price: cleanMoney(room.amount),
    category: "Home & Furniture",
    condition: "Good Used",
    description: cleanText(room.notes || room.bath || "Migrated listing from the previous room marketplace.", 1200),
    serviceDuration: "",
    images: cleanImages(room.images),
    video: cleanVideo(room.video),
    attachment: null,
    delivery: ["Hand Meetup"],
    meetupHub: cleanText(room.location || room.address || "Public meetup hub", 150),
    sellerName: cleanText(room.posterName || "Seller", 100),
    sellerPhone: cleanText(room.posterContact || "0685353186", 40),
    sellerEmail: "",
    verification: { required: false, type: "", document: null, selfie: null },
    isFeatured: false,
    isUrgent: false,
    approvalStatus: room.status === "approved" ? "approved" : "pending",
    createdAt: room.createdAt || new Date().toISOString(),
    updatedAt: room.updatedAt || new Date().toISOString()
  };
}

function cleanListing(body) {
  const deliveryOptions = ["Hand Meetup", "Paxi Shipping", "Pudo Locker", "Private Courier"];
  const conditionOptions = ["Brand New", "Like New", "Good Used", "Fair Condition"];
  const listingType = body.listingType === "service" ? "service" : "item";
  const title = listingType === "service" ? body.serviceName || body.title : body.title;
  const sellerName = listingType === "service" ? body.providerName || body.sellerName : body.sellerName;
  const sellerPhone = listingType === "service" ? body.providerPhone || body.sellerPhone : body.sellerPhone;
  const serviceDuration = cleanText(body.serviceDuration, 120);
  return {
    id: "listing-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    listingType,
    title: cleanText(title, 100),
    price: cleanMoney(body.price),
    category: cleanText(body.category, 50),
    condition: listingType === "service" ? "Service" : conditionOptions.includes(body.condition) ? body.condition : "Good Used",
    description: listingType === "service" ? cleanText(body.description || `${title || "Service"} from ${sellerName || "service provider"}`, 1800) : cleanText(body.description, 1800),
    serviceDuration,
    images: listingType === "service" ? cleanImages(body.images) : cleanImages(body.images),
    video: listingType === "service" ? cleanVideo(body.video) : cleanVideo(body.video),
    attachment: listingType === "service" ? null : cleanAttachment(body.attachment),
    delivery: listingType === "service" ? [] : cleanArray(body.delivery, deliveryOptions),
    meetupHub: cleanText(body.meetupHub, 150),
    sellerName: cleanText(sellerName, 100),
    sellerPhone: cleanText(sellerPhone, 40),
    sellerEmail: cleanText(body.sellerEmail, 255),
    verification: cleanVerification(body.verification),
    isFeatured: Boolean(body.isFeatured),
    isUrgent: Boolean(body.isUrgent),
    approvalStatus: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function cleanReceipt(body, listing) {
  const status = body.deliveryStatus === "cancelled_on_way" ? "cancelled_on_way" : "delivered";
  const paymentOptions = ["Cash on Delivery", "EFT on Delivery", "Cash Send on Delivery"];
  const paymentMethod = paymentOptions.includes(body.paymentMethod) ? body.paymentMethod : "Cash on Delivery";
  const saleAmount = status === "delivered" ? cleanMoney(body.saleAmount || listing?.price) : 0;
  const serviceCharge = status === "delivered" ? Number((saleAmount * 0.15).toFixed(2)) : 0;
  const cancellationFee = status === "cancelled_on_way" ? 30 : 0;
  return {
    id: "receipt-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    receiptNumber: "MM-" + Date.now(),
    listingId: cleanText(body.listingId, 100),
    listingType: listing?.listingType === "service" ? "service" : "item",
    listingCategory: cleanText(listing?.category || body.listingCategory || "", 80),
    listingTitle: cleanText(listing?.title || body.listingTitle || "Marketplace item", 150),
    listingCondition: cleanText(listing?.condition || body.listingCondition || "Not stated", 40),
    serviceDuration: cleanText(listing?.serviceDuration || body.serviceDuration || "", 120),
    sellerName: cleanText(listing?.sellerName || body.sellerName, 100),
    sellerPhone: cleanText(listing?.sellerPhone || body.sellerPhone, 40),
    buyerName: cleanText(body.buyerName, 100),
    buyerPhone: cleanText(body.buyerPhone, 40),
    saleAmount,
    serviceCharge,
    cancellationFee,
    totalDue: Number((saleAmount + serviceCharge + cancellationFee).toFixed(2)),
    paymentMethod,
    deliveryStatus: status,
    notes: cleanText(body.notes, 500),
    createdAt: new Date().toISOString()
  };
}

function cleanAppointment(body, listing) {
  return {
    id: "appointment-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    listingId: cleanText(body.listingId, 100),
    listingTitle: cleanText(listing?.title || body.listingTitle || "Marketplace item", 150),
    listingCategory: cleanText(listing?.category || "", 80),
    listingCondition: cleanText(listing?.condition || "", 60),
    listingPrice: cleanMoney(listing?.price || body.listingPrice),
    sellerName: cleanText(listing?.sellerName || "", 100),
    sellerPhone: cleanText(listing?.sellerPhone || "", 40),
    sellerEmail: cleanText(listing?.sellerEmail || "", 255),
    sellerLocation: cleanText(listing?.meetupHub || "", 150),
    buyerName: cleanText(body.buyerName, 100),
    buyerPhone: cleanText(body.buyerPhone, 40),
    buyerEmail: cleanText(body.buyerEmail, 255),
    deliveryAddress: cleanText(body.deliveryAddress, 500),
    meetupDate: cleanText(body.meetupDate, 30),
    meetupTime: cleanText(body.meetupTime, 30),
    meetupLocation: cleanText(body.meetupLocation || listing?.meetupHub || "", 180),
    status: "booked",
    createdAt: new Date().toISOString()
  };
}

function pdfEscape(value) {
  return String(value ?? "").replace(/[\\()]/g, "\\$&").replace(/[\r\n]+/g, " ");
}

function pdfMoney(value) {
  const amount = Number(String(value || "").replace(/[^\d.]/g, ""));
  return (Number.isFinite(amount) ? amount : 0).toLocaleString("en-ZA", { style: "currency", currency: "ZAR" });
}

function shortReceiptDate(value) {
  return new Date(value || Date.now()).toLocaleDateString("en-ZA");
}

function makeReceiptPDF(receipt) {
  const width = 298;
  const height = 420;
  const delivered = receipt.deliveryStatus === "delivered";
  const serviceReceipt = receipt.listingType === "service";
  const lines = [
    ["Mzansi Market Place", 18, 390, 16],
    [`Receipt: ${receipt.receiptNumber}`, 18, 368, 10],
    [`Date: ${shortReceiptDate(receipt.createdAt)}`, 18, 354, 10],
    [`Payment: ${receipt.paymentMethod || "Cash on Delivery"}`, 18, 340, 10],
    [`Customer: ${receipt.buyerName}`, 18, 315, 10],
    [`Contact: ${receipt.buyerPhone}`, 18, 301, 10],
    [`${serviceReceipt ? "Service" : "Item"}: ${receipt.listingTitle}`, 18, 276, 10],
    [`Category: ${receipt.listingCategory || receipt.listingCondition || "Not stated"}`, 18, 262, 10],
    [`${serviceReceipt ? "Provider" : "Seller"}: ${receipt.sellerName || ""}`, 18, 248, 10],
    [`Result: ${delivered ? (serviceReceipt ? "Service completed" : "Delivered") : "Changed mind during delivery"}`, 18, 224, 10],
    [`Amount: ${pdfMoney(receipt.saleAmount)}`, 18, 204, 11],
    [`15% charge: ${pdfMoney(receipt.serviceCharge)}`, 18, 188, 11],
    [`Change-mind fee: ${pdfMoney(receipt.cancellationFee)}`, 18, 172, 11],
    [`Total due: ${pdfMoney(receipt.totalDue)}`, 18, 150, 14],
    ["Policy: Cash on delivery. No delivery, no payment,", 18, 112, 8],
    ["except change of mind while delivery is on the way.", 18, 101, 8],
    ["Mzansi Market Place company stamp", 82, 20, 8]
  ];
  const text = lines.map(([value, x, y, size]) => `BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`).join("\n");
  const stampDate = shortReceiptDate(receipt.createdAt);
  const stampX = 149;
  const stampY = 65;
  const radius = 42;
  const c = 0.5522847498 * radius;
  const stamp = [
    "q",
    "1 0.239 0.553 RG",
    "2 w",
    `${stampX + radius} ${stampY} m`,
    `${stampX + radius} ${stampY + c} ${stampX + c} ${stampY + radius} ${stampX} ${stampY + radius} c`,
    `${stampX - c} ${stampY + radius} ${stampX - radius} ${stampY + c} ${stampX - radius} ${stampY} c`,
    `${stampX - radius} ${stampY - c} ${stampX - c} ${stampY - radius} ${stampX} ${stampY - radius} c`,
    `${stampX + c} ${stampY - radius} ${stampX + radius} ${stampY - c} ${stampX + radius} ${stampY} c`,
    "S",
    "Q",
    `BT /F1 9 Tf ${stampX - 42} ${stampY + 12} Td (MZANSI MARKET) Tj ET`,
    `BT /F1 9 Tf ${stampX - 28} ${stampY - 2} Td (PLACE) Tj ET`,
    `BT /F1 10 Tf ${stampX - 25} ${stampY - 18} Td (${pdfEscape(stampDate)}) Tj ET`
  ].join("\n");
  const content = `${text}\n${stamp}`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function addActivity(db, type, message, details = {}) {
  db.activities = Array.isArray(db.activities) ? db.activities : [];
  db.activities.unshift({
    id: "activity-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex"),
    type,
    message: cleanText(message, 220),
    details,
    createdAt: new Date().toISOString()
  });
  db.activities = db.activities.slice(0, 500);
}

function validateListing(listing) {
  if (!listing.title) return listing.listingType === "service" ? "Service name is required" : "Listing title is required";
  if (listing.price < 1 || listing.price > 250000) return "Price must be between R1 and R250,000";
  if (!listing.category) return "Category is required";
  if (/(\+?\d[\d\s-]{7,}|@|bank|account number)/i.test(listing.description || "")) return "Public description cannot include contact or payment details";
  if (listing.listingType === "service" && String(listing.sellerName || "").trim().split(/\s+/).filter(Boolean).length < 2) return "Service provider name and surname are required";
  if (listing.listingType === "service" && !listing.serviceDuration) return "Service duration is required";
  if (listing.listingType === "service" && (!listing.verification?.type || !listing.verification?.document || !listing.verification?.selfie)) {
    return "Service providers must upload an ID or passport picture plus a selfie";
  }
  if (listing.listingType !== "service" && !listing.images.length && !listing.video && !listing.attachment) return "At least one image, video, or file is required";
  if (listing.listingType !== "service" && !listing.delivery.length) return "Choose at least one delivery path";
  if (!/^(\+27|0)[6-8][0-9]{8}$/.test(String(listing.sellerPhone || "").replace(/\s/g, ""))) return "Valid South African mobile number is required";
  if (listing.listingType !== "service" && listing.price > 2500 && (!listing.verification?.type || !listing.verification?.document || !listing.verification?.selfie)) {
    return "Items over R2,500 require ID or passport upload plus a selfie";
  }
  return "";
}

function moveListing(db, from, to, id, moderation = {}) {
  if (!db.listings[from] || !db.listings[to]) return false;
  const item = db.listings[from].find((entry) => entry.id === id);
  if (!item) return false;
  db.listings[from] = db.listings[from].filter((entry) => entry.id !== id);
  db.listings[to] = db.listings[to].filter((entry) => entry.id !== id);
  db.listings[to].unshift({
    ...item,
    approvalStatus: to,
    moderation: {
      ...(item.moderation || {}),
      reason: cleanText(moderation.reason, 160),
      notes: cleanText(moderation.notes, 500),
      action: cleanText(moderation.action || to, 40),
      updatedAt: new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  });
  return true;
}

function deleteListing(db, from, id) {
  if (!db.listings[from]) return false;
  const before = db.listings[from].length;
  db.listings[from] = db.listings[from].filter((entry) => entry.id !== id);
  return db.listings[from].length !== before;
}

function findListing(db, id) {
  for (const list of Object.values(db.listings)) {
    const item = list.find((entry) => entry.id === id);
    if (item) return item;
  }
  return null;
}

function findListingSection(db, id) {
  for (const [section, list] of Object.entries(db.listings)) {
    if (list.some((entry) => entry.id === id)) return section;
  }
  return "";
}

function completeListing(db, receipt) {
  const from = findListingSection(db, receipt.listingId);
  if (!from) return false;
  const target = receipt.deliveryStatus === "delivered" ? "taken" : "changedMind";
  const listing = db.listings[from].find((entry) => entry.id === receipt.listingId);
  db.listings[from] = db.listings[from].filter((entry) => entry.id !== receipt.listingId);
  db.listings[target] = db.listings[target].filter((entry) => entry.id !== receipt.listingId);
  db.listings[target].unshift({
    ...listing,
    approvalStatus: target,
    receiptId: receipt.id,
    completedAt: receipt.createdAt,
    updatedAt: new Date().toISOString()
  });
  return true;
}

async function api(req, res, url) {
  const db = readDB();

  if (req.method === "GET" && url.pathname === "/api/public") {
    send(res, 200, {
      listings: db.listings.approved.map(safePublicListing),
      settings: db.settings
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/listings") {
    const listing = cleanListing(await readBody(req));
    const error = validateListing(listing);
    if (error) return send(res, 400, { error });
    db.listings.pending.unshift(listing);
    addActivity(db, "posted", `New listing posted: ${listing.title}`, {
      listingId: listing.id,
      price: listing.price,
      sellerName: listing.sellerName
    });
    writeDB(db);
    send(res, 201, { ok: true, id: listing.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/track") {
    const event = cleanAnalyticsEvent(await readBody(req), req);
    db.analytics = db.analytics && typeof db.analytics === "object" ? db.analytics : { events: [] };
    db.analytics.events = Array.isArray(db.analytics.events) ? db.analytics.events : [];
    db.analytics.events.unshift(event);
    db.analytics.events = db.analytics.events.slice(0, 10000);
    writeDB(db);
    send(res, 201, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/appointments") {
    const body = await readBody(req);
    const listingIds = Array.isArray(body.listingIds) ? body.listingIds.map((id) => cleanText(id, 100)).filter(Boolean) : [];
    if (!listingIds.length) return send(res, 400, { error: "Basket is empty" });
    if (!cleanText(body.buyerName, 100)) return send(res, 400, { error: "Buyer name is required" });
    if (!/^(\+27|0)[6-8][0-9]{8}$/.test(String(body.buyerPhone || "").replace(/\s/g, ""))) return send(res, 400, { error: "Valid buyer cellphone number is required" });
    if (!cleanText(body.deliveryAddress, 500)) return send(res, 400, { error: "Delivery address is required" });
    if (!cleanText(body.meetupDate, 30) || !cleanText(body.meetupTime, 30)) return send(res, 400, { error: "Meetup date and time are required" });
    const approved = db.listings.approved || [];
    const appointments = listingIds.map((id) => {
      const listing = approved.find((item) => item.id === id && item.listingType !== "service");
      return listing ? cleanAppointment(body, listing) : null;
    }).filter(Boolean);
    if (!appointments.length) return send(res, 400, { error: "No approved basket items found" });
    db.appointments = Array.isArray(db.appointments) ? db.appointments : [];
    db.appointments.unshift(...appointments);
    appointments.forEach((appointment) => addActivity(db, "appointment_booked", `Appointment booked: ${appointment.listingTitle}`, {
      appointmentId: appointment.id,
      listingId: appointment.listingId,
      buyerName: appointment.buyerName,
      meetupDate: appointment.meetupDate,
      meetupTime: appointment.meetupTime
    }));
    writeDB(db);
    send(res, 201, { ok: true, appointments });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readBody(req);
    if (body.password !== ADMIN_PASSWORD) return send(res, 401, { error: "Incorrect password" });
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    send(res, 200, { token });
    return;
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!requireAdmin(req, res)) return;

    if (req.method === "GET" && url.pathname === "/api/admin/data") {
      send(res, 200, db);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/receipt/pdf") {
      const receiptId = cleanText(url.searchParams.get("id"), 100);
      const receipt = (db.orders || []).find((item) => item.id === receiptId);
      if (!receipt) return send(res, 404, { error: "Receipt not found" });
      const pdf = makeReceiptPDF(receipt);
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${receipt.receiptNumber || "mzansi-receipt"}.pdf"`,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      res.end(pdf);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/action") {
      const body = await readBody(req);
      let ok = false;
      if (body.action === "move") {
        const from = cleanText(body.from, 30);
        const to = cleanText(body.to, 30);
        const id = cleanText(body.id, 80);
        ok = moveListing(db, from, to, id, {
          reason: body.reason,
          notes: body.notes,
          action: body.moderationAction || to
        });
        if (ok) addActivity(db, "moderated", `Listing moved from ${from} to ${to}`, { listingId: id, from, to, reason: cleanText(body.reason, 160) });
      }
      if (body.action === "delete") {
        const from = cleanText(body.from, 30);
        const id = cleanText(body.id, 80);
        ok = deleteListing(db, from, id);
        if (ok) addActivity(db, "deleted", `Listing deleted from ${from}`, { listingId: id, from });
      }
      if (!ok) return send(res, 400, { error: "Action could not be completed" });
      writeDB(db);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/receipt") {
      const body = await readBody(req);
      const listing = findListing(db, cleanText(body.listingId, 100));
      if (!listing) return send(res, 400, { error: "Approved listing is required for a receipt" });
      const receipt = cleanReceipt(body, listing);
      if (!receipt.buyerName) return send(res, 400, { error: "Buyer name is required" });
      if (!receipt.buyerPhone) return send(res, 400, { error: "Buyer contact is required" });
      if (receipt.deliveryStatus === "delivered" && receipt.saleAmount < 1) return send(res, 400, { error: "Sale amount is required" });
      db.orders.unshift(receipt);
      completeListing(db, receipt);
      addActivity(
        db,
        receipt.deliveryStatus === "delivered" ? "taken" : "changed_mind",
        receipt.deliveryStatus === "delivered"
          ? `Item taken: ${receipt.listingTitle}`
          : `Buyer changed mind during delivery: ${receipt.listingTitle}`,
        {
          listingId: receipt.listingId,
          receiptId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          totalDue: receipt.totalDue,
          paymentMethod: receipt.paymentMethod
        }
      );
      writeDB(db);
      send(res, 201, { ok: true, receipt });
      return;
    }
  }

  send(res, 404, { error: "Not found" });
}

function serveFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".zip": "application/zip"
  }[ext] || "application/octet-stream";
  const cache = ext === ".html" ? "no-cache" : "public, max-age=3600";
  send(res, 200, fs.readFileSync(file), type, cache);
}

ensureDB();
http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    serveFile(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
}).listen(PORT, () => console.log(`Mzansi Market Place running at http://localhost:${PORT}`));

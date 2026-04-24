require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pdf = require("pdfkit");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const supabase = require("./supabaseClient");

const app = express();
const PORT = Number(process.env.SUPABASE_PORT || 5000);
const isProduction = process.env.NODE_ENV === "production";
const AUTH_COOKIE_NAME = "dhanam.sid";
const AUTH_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24;
const authCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  maxAge: AUTH_COOKIE_MAX_AGE_MS,
  path: "/",
};

const configuredOrigins = String(process.env.CORS_ORIGIN || process.env.APP_BASE_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOriginSet = new Set(configuredOrigins);

function requestOriginAllowed(origin) {
  if (isProduction && allowedOriginSet.size === 0) {
    return true;
  }

  if (!origin) {
    return !isProduction;
  }

  if (!isProduction) {
    return true;
  }

  return allowedOriginSet.has(origin);
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (requestOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json({
  limit: "8mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

if (isProduction) {
  app.set("trust proxy", 1);
}

function getAuthSecret() {
  return process.env.SESSION_SECRET || "change-me-in-production";
}

function parseCookieHeader(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }

      const key = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();
      if (key) {
        cookies[key] = value;
      }

      return cookies;
    }, {});
}

function base64UrlEncode(text) {
  return Buffer.from(String(text), "utf8").toString("base64url");
}

function base64UrlDecode(text) {
  return Buffer.from(String(text), "base64url").toString("utf8");
}

function signAuthPayload(payload) {
  return crypto.createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
}

function createAuthToken(user) {
  const payload = base64UrlEncode(JSON.stringify({
    id: user.id,
    fullname: user.fullname,
    email: user.email,
    mobile: user.mobile,
    role: user.role,
    issuedAt: Date.now(),
  }));
  const signature = signAuthPayload(payload);
  return `${payload}.${signature}`;
}

function readAuthToken(token) {
  const rawToken = String(token || "").trim();
  if (!rawToken) {
    return null;
  }

  const [payload, signature] = rawToken.split(".");
  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = signAuthPayload(payload);
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }

  try {
    const user = JSON.parse(base64UrlDecode(payload));
    if (!user || !user.id || !user.mobile || !user.role) {
      return null;
    }

    return {
      id: user.id,
      fullname: user.fullname,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
    };
  } catch (_error) {
    return null;
  }
}

function attachAuthContext(req, _res, next) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const user = readAuthToken(cookies[AUTH_COOKIE_NAME]);
  req.authUser = user;
  req.session = { user };
  next();
}

function setAuthCookie(res, user) {
  const token = createAuthToken(user);
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions);
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { ...authCookieOptions, maxAge: undefined });
}

app.use(attachAuthContext);

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  return next();
}

function requireAuthenticatedUser(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ message: "Authentication required" });
  }

  return next();
}

function normalizeMobile(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function isRequesterAdmin(req) {
  return String(req.session?.user?.role || "").toLowerCase() === "admin";
}

function canAccessMobile(req, targetMobile) {
  if (!req.session?.user) {
    return false;
  }

  if (isRequesterAdmin(req)) {
    return true;
  }

  return normalizeMobile(req.session.user.mobile) === normalizeMobile(targetMobile);
}

function requireOwnerOrAdminForMobileParam(paramName = "mobile") {
  return (req, res, next) => {
    const targetMobile = String(req.params?.[paramName] || "").trim();
    if (!targetMobile) {
      return res.status(400).json({ message: "Mobile is required" });
    }

    if (!canAccessMobile(req, targetMobile)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return next();
  };
}

function enforceBodyMobileOwnership(req, res, mobileFieldName = "mobile") {
  if (isRequesterAdmin(req)) {
    return true;
  }

  const bodyMobile = String(req.body?.[mobileFieldName] || "").trim();
  if (!bodyMobile || normalizeMobile(bodyMobile) !== normalizeMobile(req.session?.user?.mobile)) {
    res.status(403).json({ message: "Forbidden: mobile ownership mismatch" });
    return false;
  }

  return true;
}

async function requireAdminFlexible(req, res, next) {
  return requireAdmin(req, res, next);
}

const csrfExemptRoutes = new Set([
  "/login",
  "/Login",
  "/api/login",
  "/api/Login",
  "/register",
  "/api/register",
  "/api/Register",
  "/logout",
  "/api/logout",
  "/api/Logout",
  "/api/cashfree/webhook",
]);

app.use((req, res, next) => {
  const method = String(req.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return next();
  }

  if (csrfExemptRoutes.has(req.path)) {
    return next();
  }

  if (!isProduction) {
    return next();
  }

  const origin = String(req.headers.origin || "").trim();
  if (allowedOriginSet.size === 0) {
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    if (!origin || origin === expectedOrigin) {
      return next();
    }

    return res.status(403).json({ message: "CSRF validation failed: origin not allowed" });
  }

  if (!origin) {
    return res.status(403).json({ message: "CSRF validation failed: missing origin" });
  }

  if (!allowedOriginSet.has(origin)) {
    return res.status(403).json({ message: "CSRF validation failed: origin not allowed" });
  }

  return next();
});

const paymentWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many payment write requests. Please try again shortly." },
});

const paymentAdminActionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many admin payment actions. Please retry in a few minutes." },
});

const cashfreeOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many Cashfree order attempts. Please try again later." },
});

const cashfreeConfirmLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many payment verification attempts. Please try again later." },
});

const cashfreeWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Webhook rate limit exceeded." },
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const CASHFREE_MODE = String(process.env.CASHFREE_ENV || "sandbox").trim().toLowerCase() === "production"
  ? "production"
  : "sandbox";
const CASHFREE_BASE_URL = CASHFREE_MODE === "production"
  ? "https://api.cashfree.com"
  : "https://sandbox.cashfree.com";
const CASHFREE_WEBHOOK_SECRET = String(
  process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY || ""
).trim();

function getCashfreeWebhookSignature(req) {
  return String(
    req.headers["x-webhook-signature"]
      || req.headers["x-cf-signature"]
      || req.headers["x-cashfree-signature"]
      || ""
  ).trim();
}

function safeSignatureMatch(provided, expected) {
  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function verifyCashfreeWebhookSignature(req) {
  if (!CASHFREE_WEBHOOK_SECRET) {
    return false;
  }

  const signatureHeader = getCashfreeWebhookSignature(req);
  if (!signatureHeader) {
    return false;
  }

  const signature = signatureHeader.replace(/^sha256=/i, "").trim();
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const timestamp = String(req.headers["x-webhook-timestamp"] || req.headers["x-cf-timestamp"] || "").trim();

  const candidates = [
    crypto.createHmac("sha256", CASHFREE_WEBHOOK_SECRET).update(rawBody).digest("hex"),
    crypto.createHmac("sha256", CASHFREE_WEBHOOK_SECRET).update(rawBody).digest("base64"),
  ];

  if (timestamp) {
    candidates.push(crypto.createHmac("sha256", CASHFREE_WEBHOOK_SECRET).update(`${timestamp}${rawBody}`).digest("hex"));
    candidates.push(crypto.createHmac("sha256", CASHFREE_WEBHOOK_SECRET).update(`${timestamp}${rawBody}`).digest("base64"));
  }

  return candidates.some((expected) => safeSignatureMatch(signature, expected));
}

function getCashfreeHeaders() {
  const appId = String(process.env.CASHFREE_APP_ID || "").trim();
  const secretKey = String(process.env.CASHFREE_SECRET_KEY || "").trim();

  if (!appId || !secretKey) {
    throw new Error("Cashfree credentials are missing. Configure CASHFREE_APP_ID and CASHFREE_SECRET_KEY.");
  }

  return {
    "x-client-id": appId,
    "x-client-secret": secretKey,
    "x-api-version": "2023-08-01",
    "content-type": "application/json",
  };
}
// Service charge calculation endpoint (moved below app initialization)
app.post('/api/cashfree/service-charge', (req, res) => {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Invalid amount.' });
    }
    // 1.8% service charge
    const serviceCharge = Math.round((amount * 0.018) * 100) / 100;
    const total = Math.round((amount + serviceCharge) * 100) / 100;
    res.json({ serviceCharge, total });
});

function buildCashfreeOrderId(mobile) {
  const normalizedMobile = String(mobile || "").replace(/\D/g, "").slice(-10) || "guest";
  return `CHIT_${Date.now()}_${normalizedMobile}_${crypto.randomBytes(2).toString("hex")}`;
}

async function incrementApprovedChitTotalPaid({ mobile, chitPlan }) {
  const normalizedMobile = String(mobile || "").trim();
  const normalizedChitPlan = String(chitPlan || "").trim();
  const modeLikePlan = normalizedChitPlan.toUpperCase();

  if (!normalizedMobile || !normalizedChitPlan) {
    return;
  }

  // Skip non-chit mode labels.
  if (modeLikePlan === "BORROW PAYMENT" || modeLikePlan === "CHIT ID") {
    return;
  }

  let approvedChit = null;

  const { data: matchedChits, error: chitLookupError } = await supabase
    .from("chit_ids")
    .select("id, chit_id")
    .eq("mobile", normalizedMobile)
    .eq("chit_id", normalizedChitPlan)
    .eq("status", "Approved")
    .order("created_at", { ascending: false })
    .limit(1);

  if (chitLookupError) {
    console.error("approved chit lookup error", chitLookupError);
  } else if (Array.isArray(matchedChits) && matchedChits.length > 0) {
    approvedChit = matchedChits[0];
  }

  if (!approvedChit) {
    const { data: fallbackChits, error: fallbackLookupError } = await supabase
      .from("chit_ids")
      .select("id, chit_id")
      .eq("mobile", normalizedMobile)
      .eq("status", "Approved")
      .order("created_at", { ascending: false })
      .limit(1);

    if (fallbackLookupError) {
      console.error("approved chit fallback lookup error", fallbackLookupError);
    } else if (Array.isArray(fallbackChits) && fallbackChits.length > 0) {
      approvedChit = fallbackChits[0];
    }
  }

  if (!approvedChit) {
    console.error("No approved chit found for payment update", {
      mobile: normalizedMobile,
      chitPlan: normalizedChitPlan,
    });
    return;
  }

  const { data: approvedPayments, error: approvedPaymentsError } = await supabase
    .from("payments")
    .select("amount, chits_plan, type")
    .eq("mobile", normalizedMobile)
    .eq("status", "Approved");

  if (approvedPaymentsError) {
    console.error("approved payments lookup error", approvedPaymentsError);
    return;
  }

  const targetChit = String(approvedChit.chit_id || normalizedChitPlan).trim().toLowerCase();
  const updatedTotalPaid = (Array.isArray(approvedPayments) ? approvedPayments : [])
    .filter((payment) => {
      const paymentPlan = String(payment?.chits_plan || "").trim().toLowerCase();
      const paymentType = String(payment?.type || "").trim().toLowerCase();

      if (paymentPlan === "borrow payment" || paymentType.includes("borrow")) {
        return false;
      }

      return paymentPlan === targetChit || paymentPlan === "chit id";
    })
    .reduce((sum, payment) => sum + (Number(payment?.amount) || 0), 0);

  const { error: chitUpdateError } = await supabase
    .from("chit_ids")
    .update({ total_paid: updatedTotalPaid })
    .eq("id", approvedChit.id);

  if (chitUpdateError) {
    console.error("chit paid total update error", chitUpdateError);
  }
}

function findSuccessfulCashfreePayment(paymentsPayload, preferredPaymentId = "") {
  const preferredId = String(preferredPaymentId || "").trim();
  const rows = Array.isArray(paymentsPayload)
    ? paymentsPayload
    : Array.isArray(paymentsPayload?.data)
      ? paymentsPayload.data
      : [];

  const successRows = rows.filter((item) => String(item?.payment_status || "").toUpperCase() === "SUCCESS");
  if (successRows.length === 0) {
    return null;
  }

  if (preferredId) {
    const exact = successRows.find((item) => String(item?.cf_payment_id || "").trim() === preferredId);
    if (exact) {
      return exact;
    }
  }

  return successRows[0];
}

async function saveCashfreePaidOrder({ orderData, successfulPayment, paymentData = {}, status = "Approved" }) {
  const normalizedMobile = String(paymentData?.mobile || orderData?.customer_details?.customer_phone || "").trim();
  const normalizedName = String(paymentData?.name || orderData?.customer_details?.customer_name || "Cashfree User").trim();
  const normalizedEmail = String(paymentData?.email || orderData?.customer_details?.customer_email || "").trim();
  const normalizedChitPlan = String(
    paymentData?.chitsPlan || orderData?.order_tags?.chits_plan || orderData?.order_tags?.chit_plan || ""
  ).trim();
  const paymentAmount = Number(orderData?.order_amount || paymentData?.amount || successfulPayment?.payment_amount || 0);
  const type = String(paymentData?.type || orderData?.order_tags?.payment_type || "Cashfree Gateway").trim();
  const orderId = String(orderData?.order_id || paymentData?.orderId || "").trim();
  const utrNumber = String(successfulPayment?.cf_payment_id || orderId).trim();

  if (!normalizedMobile || !paymentAmount || paymentAmount <= 0 || !utrNumber) {
    throw new Error("Missing payment details required to save transaction.");
  }

  const { data: existing } = await supabase
    .from("payments")
    .select("*")
    .eq("utr_number", utrNumber)
    .maybeSingle();

  if (existing) {
    return {
      payment: mapPaymentRow(existing),
      created: false,
      utrNumber,
      cfPaymentId: successfulPayment?.cf_payment_id,
    };
  }

  const { data, error } = await supabase
    .from("payments")
    .insert({
      name: normalizedName,
      mobile: normalizedMobile,
      amount: paymentAmount,
      utr_number: utrNumber,
      email: normalizedEmail,
      type,
      chits_plan: normalizedChitPlan,
      status,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  await incrementApprovedChitTotalPaid({
    mobile: normalizedMobile,
    chitPlan: normalizedChitPlan,
    amount: paymentAmount,
  });

  return {
    payment: mapPaymentRow(data),
    created: true,
    utrNumber,
    cfPaymentId: successfulPayment?.cf_payment_id,
  };
}

function mapPaymentRow(row) {
  const screenshotPath = getPaymentScreenshotPath(row.id, row.utr_number);
  const screenshotUrl = screenshotPath
    ? (String(screenshotPath).startsWith("http") ? String(screenshotPath) : `/${screenshotPath}`)
    : null;
  const reminderPayload = parseReminderPayload(row.reminder_note);
  const reminderStatus = String(reminderPayload?.reminderStatus || "").toLowerCase();
  return {
    _id: row.id,
    id: row.id,
    paymentId: row.id,
    name: row.name,
    mobile: row.mobile,
    amount: row.amount,
    utrNumber: row.utr_number,
    email: row.email,
    type: row.type,
    chitsPlan: row.chits_plan,
    status: reminderStatus === "paid" ? "paid-reminder" : row.status,
    reminderNote: reminderPayload?.note || row.reminder_note || "",
    reminderBorrowDate: reminderPayload?.borrowDate || null,
    reminderRepaymentDate: reminderPayload?.repaymentDate || null,
    reminderAmount: reminderPayload?.reminderAmount ?? null,
    reminderInterest: reminderPayload?.reminderInterest ?? null,
    reminderStatus: reminderPayload?.reminderStatus || null,
    reminderPaidAt: reminderPayload?.paidAt || null,
    screenshotUrl,
    created_at: row.created_at,
  };
}

const REMINDER_PAYLOAD_PREFIX = "__REMINDER__:";

function normalizeReminderNumber(value, { snapNearInteger = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  if (!snapNearInteger) {
    return rounded;
  }

  const nearestInteger = Math.round(rounded);
  return Math.abs(rounded - nearestInteger) <= 0.01 ? nearestInteger : rounded;
}

function buildReminderPayload({ note = "", borrowDate = null, repaymentDate = null, reminderAmount = null, reminderInterest = null, name = null, reminderStatus = null, paidAt = null }) {
  return {
    note: String(note || "").trim(),
    borrowDate: borrowDate || null,
    repaymentDate: repaymentDate || null,
    reminderAmount: normalizeReminderNumber(reminderAmount, { snapNearInteger: true }),
    reminderInterest: normalizeReminderNumber(reminderInterest),
    name: String(name || "").trim() || null,
    reminderStatus: String(reminderStatus || "manual").trim() || "manual",
    paidAt: paidAt || null,
  };
}

function encodeReminderPayload(payload) {
  return `${REMINDER_PAYLOAD_PREFIX}${JSON.stringify(payload)}`;
}

function parseReminderPayload(value) {
  const text = String(value || "").trim();
  if (!text.startsWith(REMINDER_PAYLOAD_PREFIX)) {
    return null;
  }

  try {
    const payload = JSON.parse(text.slice(REMINDER_PAYLOAD_PREFIX.length));
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return {
      note: String(payload.note || "").trim(),
      borrowDate: String(payload.borrowDate || "").trim() || null,
      repaymentDate: String(payload.repaymentDate || "").trim() || null,
      reminderAmount: payload.reminderAmount === null || payload.reminderAmount === undefined || payload.reminderAmount === ""
        ? null
        : Number(payload.reminderAmount),
      reminderInterest: payload.reminderInterest === null || payload.reminderInterest === undefined || payload.reminderInterest === ""
        ? null
        : Number(payload.reminderInterest),
      reminderStatus: String(payload.reminderStatus || "manual").trim() || "manual",
      paidAt: String(payload.paidAt || "").trim() || null,
    };
  } catch (_error) {
    return null;
  }
}

function normalizeReminderRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const reminderPayload = parseReminderPayload(row.reminder_note);
  const reminderStatus = String(row.reminder_status || reminderPayload?.reminderStatus || "manual").toLowerCase();
  return {
    id: row.id,
    _id: row.id,
    reminderId: row.id,
    paymentId: row.payment_id || null,
    name: row.payment_name || reminderPayload?.name || "Manual Reminder",
    mobile: row.payment_mobile || "",
    status: reminderStatus === "paid" ? "paid-reminder" : "manual-reminder",
    chitsPlan: "Manual",
    created_at: row.created_at || row.updated_at || null,
    reminderNote: row.reminder_note || reminderPayload?.note || "",
    reminderBorrowDate: row.reminder_borrow_date || reminderPayload?.borrowDate || null,
    reminderRepaymentDate: row.reminder_repayment_date || reminderPayload?.repaymentDate || null,
    reminderAmount: row.reminder_amount ?? reminderPayload?.reminderAmount ?? null,
    reminderInterest: row.reminder_interest ?? reminderPayload?.reminderInterest ?? null,
    reminderStatus: reminderStatus || "manual",
    reminderPaidAt: row.paid_at || reminderPayload?.paidAt || null,
  };
}

const paymentRemindersTable = "payment_reminders";

function mapBankDetailRow(row) {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    accountNumber: row.account_number,
    ifscCode: row.ifsc_code,
    upiId: row.upi_id,
    bankName: row.bank_name,
    mobile: row.mobile,
    created_at: row.created_at,
  };
}

function mapBorrowRow(row) {
  const fallbackDocs = getBorrowDocumentPaths(row.id);
  return {
    _id: row.id,
    id: row.id,
    fullname: row.fullname,
    email: row.email,
    mobile: row.mobile,
    amount: row.amount,
    aadhaarDocumentPath: row.aadhaar_document_path || fallbackDocs.aadhaarDocumentPath,
    panDocumentPath: row.pan_document_path || fallbackDocs.panDocumentPath,
    rcDocumentPath: row.rc_document_path || fallbackDocs.rcDocumentPath,
    status: row.status,
    date: row.created_at,
    created_at: row.created_at,
  };
}

function mapChitRow(row) {
  return {
    _id: row.id,
    id: row.id,
    chitId: row.chit_id,
    email: row.email,
    name: row.name,
    mobile: row.mobile,
    month: row.month,
    totalBalance: row.total_balance,
    totalPaid: row.total_paid,
    status: row.status,
    created_at: row.created_at,
  };
}

function mapAuctionChatRow(row) {
  const pollData = parsePollFromMessage(row.message);
  return {
    _id: row.id,
    id: row.id,
    mobile: row.mobile,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    message: pollData ? pollData.question : row.message,
    messageType: pollData ? "poll" : "text",
    poll: pollData,
    topic: row.topic,
    created_at: row.created_at,
  };
}

const POLL_PREFIX = "__POLL__:";

function parsePollFromMessage(message) {
  const text = String(message || "");
  if (!text.startsWith(POLL_PREFIX)) {
    return null;
  }

  try {
    const payload = JSON.parse(text.slice(POLL_PREFIX.length));
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return {
      pollId: String(payload.pollId || "").trim(),
      question: String(payload.question || "").trim(),
      options: Array.isArray(payload.options) ? payload.options : [],
      createdBy: String(payload.createdBy || "").trim(),
      createdAt: payload.createdAt || null,
    };
  } catch (_error) {
    return null;
  }
}

function encodePollMessage(pollPayload) {
  return `${POLL_PREFIX}${JSON.stringify(pollPayload)}`;
}

function createPollPayload({ question, options, createdBy }) {
  const normalizedQuestion = String(question || "").trim();
  const normalizedOptions = (Array.isArray(options) ? options : [])
    .map((opt) => String(opt || "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((label, index) => ({
      id: `opt-${index + 1}`,
      label,
      votes: [],
    }));

  return {
    pollId: crypto.randomUUID(),
    question: normalizedQuestion,
    options: normalizedOptions,
    createdBy: String(createdBy || "admin").trim(),
    createdAt: new Date().toISOString(),
  };
}

function reactToPollPayload(pollPayload, optionId, reactorMobile) {
  const normalizedOptionId = String(optionId || "").trim();
  const normalizedReactor = String(reactorMobile || "").trim();
  if (!normalizedOptionId || !normalizedReactor) {
    return null;
  }

  const options = (Array.isArray(pollPayload?.options) ? pollPayload.options : []).map((opt) => ({
    id: String(opt.id || "").trim(),
    label: String(opt.label || "").trim(),
    votes: Array.isArray(opt.votes) ? opt.votes.map((m) => String(m || "").trim()).filter(Boolean) : [],
  }));

  let matched = false;
  for (const option of options) {
    option.votes = option.votes.filter((m) => m !== normalizedReactor);
    if (option.id === normalizedOptionId) {
      matched = true;
      if (!option.votes.includes(normalizedReactor)) {
        option.votes.push(normalizedReactor);
      }
    }
  }

  if (!matched) {
    return null;
  }

  return {
    ...pollPayload,
    options,
  };
}

async function isAdminMobile(mobile) {
  const normalizedMobile = String(mobile || "").trim();
  if (!normalizedMobile) {
    return false;
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("role")
      .eq("mobile", normalizedMobile)
      .maybeSingle();

    if (error) {
      console.error("isAdminMobile lookup error", error);
      return false;
    }

    return String(data?.role || "").toLowerCase() === "admin";
  } catch (error) {
    console.error("isAdminMobile exception", error);
    return false;
  }
}

const storageBaseDir = process.env.VERCEL === "1" ? "/tmp" : __dirname;
const invoicesDir = path.join(storageBaseDir, "invoices");
const borrowDocsDir = path.join(storageBaseDir, "uploads", "borrow-docs");
const borrowDocsIndexPath = path.join(storageBaseDir, "uploads", "borrow-docs-index.json");
const paymentScreenshotsDir = path.join(storageBaseDir, "uploads", "payment-screenshots");
const paymentScreenshotsIndexPath = path.join(storageBaseDir, "uploads", "payment-screenshots-index.json");
const reminderPipelineStatePath = path.join(storageBaseDir, "uploads", "reminder-pipeline-state.json");
const lenderStatePath = path.join(storageBaseDir, "uploads", "lenders-state.json");
const paymentScreenshotBucket = String(process.env.PAYMENT_SCREENSHOT_BUCKET || "payment-screenshots").trim();
const auctionChatFallbackPath = path.join(storageBaseDir, "uploads", "auction-chat-fallback.json");
try {
  if (!fs.existsSync(invoicesDir)) {
    fs.mkdirSync(invoicesDir, { recursive: true });
  }
  if (!fs.existsSync(borrowDocsDir)) {
    fs.mkdirSync(borrowDocsDir, { recursive: true });
  }
  if (!fs.existsSync(paymentScreenshotsDir)) {
    fs.mkdirSync(paymentScreenshotsDir, { recursive: true });
  }
} catch (dirError) {
  console.error("Failed to prepare storage directory:", dirError);
}

app.use("/uploads", express.static(path.join(storageBaseDir, "uploads"), { index: false }));

function readBorrowDocsIndex() {
  try {
    if (!fs.existsSync(borrowDocsIndexPath)) {
      return {};
    }

    const raw = fs.readFileSync(borrowDocsIndexPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeBorrowDocsIndex(indexData) {
  try {
    fs.writeFileSync(borrowDocsIndexPath, JSON.stringify(indexData, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save borrow document index:", error);
  }
}

function setBorrowDocumentPaths(recordId, paths) {
  if (!recordId) {
    return;
  }

  const indexData = readBorrowDocsIndex();
  indexData[String(recordId)] = {
    aadhaarDocumentPath: paths.aadhaarDocumentPath || null,
    panDocumentPath: paths.panDocumentPath || null,
    rcDocumentPath: paths.rcDocumentPath || null,
  };
  writeBorrowDocsIndex(indexData);
}

function getBorrowDocumentPaths(recordId) {
  const blank = {
    aadhaarDocumentPath: null,
    panDocumentPath: null,
    rcDocumentPath: null,
  };

  if (!recordId) {
    return blank;
  }

  const indexData = readBorrowDocsIndex();
  const stored = indexData[String(recordId)];
  if (!stored || typeof stored !== "object") {
    return blank;
  }

  return {
    aadhaarDocumentPath: stored.aadhaarDocumentPath || null,
    panDocumentPath: stored.panDocumentPath || null,
    rcDocumentPath: stored.rcDocumentPath || null,
  };
}

function readPaymentScreenshotsIndex() {
  try {
    if (!fs.existsSync(paymentScreenshotsIndexPath)) {
      return {};
    }

    const raw = fs.readFileSync(paymentScreenshotsIndexPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writePaymentScreenshotsIndex(indexData) {
  try {
    fs.writeFileSync(paymentScreenshotsIndexPath, JSON.stringify(indexData, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save payment screenshot index:", error);
  }
}

function createReminderPipelineState() {
  return {
    jobs: [],
    notifications: [],
    audits: [],
    lastWorkerRunAt: null,
  };
}

function readReminderPipelineState() {
  try {
    if (!fs.existsSync(reminderPipelineStatePath)) {
      return createReminderPipelineState();
    }

    const raw = fs.readFileSync(reminderPipelineStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return createReminderPipelineState();
    }

    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
      audits: Array.isArray(parsed.audits) ? parsed.audits : [],
      lastWorkerRunAt: parsed.lastWorkerRunAt || null,
    };
  } catch (_error) {
    return createReminderPipelineState();
  }
}

function writeReminderPipelineState(state) {
  try {
    fs.writeFileSync(reminderPipelineStatePath, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save reminder pipeline state:", error);
  }
}

function appendReminderAudit(state, {
  actor = "System",
  role = "system",
  actionType = "pipeline",
  action = "Reminder event",
  details = "",
  status = "success",
  targetMobile = null,
  targetReminderId = null,
  jobId = null,
  meta = null,
}) {
  state.audits.unshift({
    id: crypto.randomUUID(),
    actor: String(actor || "System"),
    role: String(role || "system"),
    actionType: String(actionType || "pipeline"),
    action: String(action || "Reminder event"),
    details: String(details || ""),
    status: String(status || "success"),
    targetMobile: targetMobile ? String(targetMobile) : null,
    targetReminderId: targetReminderId ? String(targetReminderId) : null,
    jobId: jobId ? String(jobId) : null,
    createdAt: new Date().toISOString(),
    meta: meta && typeof meta === "object" ? meta : null,
  });
  state.audits = state.audits.slice(0, 1000);
}

function appendReminderNotification(state, {
  title,
  message,
  severity = "info",
  type = "system",
  action = null,
  jobId = null,
  targetMobile = null,
  targetReminderId = null,
}) {
  state.notifications.unshift({
    id: crypto.randomUUID(),
    type: String(type || "system"),
    title: String(title || "Reminder update"),
    message: String(message || ""),
    severity: String(severity || "info"),
    action: action && typeof action === "object" ? action : null,
    jobId: jobId ? String(jobId) : null,
    targetMobile: targetMobile ? String(targetMobile) : null,
    targetReminderId: targetReminderId ? String(targetReminderId) : null,
    status: "open",
    createdAt: new Date().toISOString(),
  });
  state.notifications = state.notifications.slice(0, 500);
}

function reminderDateDiffDays(repaymentDate) {
  if (!repaymentDate) {
    return null;
  }

  const target = new Date(repaymentDate);
  if (Number.isNaN(target.getTime())) {
    return null;
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function buildReminderDeliveryMessage(reminder) {
  const lines = [];
  lines.push(`Hello ${reminder.name || "Customer"}, this is a payment reminder.`);
  if (reminder.reminderRepaymentDate) {
    lines.push(`Repayment date: ${reminder.reminderRepaymentDate}`);
  }
  if (reminder.reminderAmount !== null && reminder.reminderAmount !== undefined) {
    lines.push(`Principal: ${reminder.reminderAmount}`);
  }
  if (reminder.reminderInterest !== null && reminder.reminderInterest !== undefined) {
    lines.push(`Interest: ${reminder.reminderInterest}%`);
  }
  if (reminder.reminderNote) {
    lines.push(`Note: ${reminder.reminderNote}`);
  }
  lines.push("Please complete your payment on time.");
  return lines.join("\n");
}

function simulateReminderDelivery(job) {
  const mobile = normalizeMobile(job.mobile);
  const message = String(job.message || "").trim();
  if (!mobile || mobile.length !== 10) {
    return { ok: false, error: "Invalid mobile number" };
  }
  if (!message) {
    return { ok: false, error: "Reminder message is empty" };
  }

  const hashSeed = `${mobile}:${job.id}:${job.attempts + 1}`;
  const score = hashSeed.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const shouldFail = score % 11 === 0;
  if (shouldFail) {
    return { ok: false, error: "Gateway timeout while delivering reminder" };
  }

  return { ok: true };
}

function processReminderJob(state, job) {
  const nowIso = new Date().toISOString();
  job.attempts = Number(job.attempts || 0) + 1;
  job.lastAttemptAt = nowIso;
  const delivery = simulateReminderDelivery(job);

  if (delivery.ok) {
    job.status = "sent";
    job.lastError = null;
    job.updatedAt = nowIso;
    appendReminderAudit(state, {
      actor: "Scheduler",
      role: "system",
      actionType: "send",
      action: "Reminder delivered",
      details: `Delivered reminder to ${job.mobile}`,
      status: "success",
      targetMobile: job.mobile,
      targetReminderId: job.reminderId,
      jobId: job.id,
    });
    return;
  }

  const maxAttempts = Number(job.maxAttempts || 3);
  job.lastError = delivery.error;
  if (job.attempts < maxAttempts) {
    const nextRetryAt = Date.now() + 5 * 60 * 1000;
    job.status = "retry_pending";
    job.scheduledFor = new Date(nextRetryAt).toISOString();
  } else {
    job.status = "failed";
  }

  job.updatedAt = nowIso;
  appendReminderAudit(state, {
    actor: "Scheduler",
    role: "system",
    actionType: "send",
    action: "Reminder delivery failed",
    details: `${delivery.error} for ${job.mobile}`,
    status: "failed",
    targetMobile: job.mobile,
    targetReminderId: job.reminderId,
    jobId: job.id,
  });

  appendReminderNotification(state, {
    type: "delivery",
    severity: "error",
    title: "Reminder delivery failed",
    message: `Could not deliver reminder to ${job.name || job.mobile}. ${delivery.error}`,
    jobId: job.id,
    targetMobile: job.mobile,
    targetReminderId: job.reminderId,
    action: {
      type: "retry-now",
      label: "Retry now",
      jobId: job.id,
    },
  });
}

function processDueReminderJobs() {
  const state = readReminderPipelineState();
  const now = Date.now();
  const dueJobs = state.jobs.filter((job) => {
    const status = String(job.status || "").toLowerCase();
    if (!["queued", "scheduled", "retry_pending"].includes(status)) {
      return false;
    }

    if (!job.scheduledFor) {
      return true;
    }

    const dueAt = new Date(job.scheduledFor).getTime();
    return Number.isFinite(dueAt) && dueAt <= now;
  });

  dueJobs.forEach((job) => processReminderJob(state, job));
  state.lastWorkerRunAt = new Date().toISOString();
  writeReminderPipelineState(state);
  return state;
}

let reminderPipelineWorker = null;

function startReminderPipelineWorker() {
  if (reminderPipelineWorker || process.env.VERCEL === "1") {
    return;
  }

  reminderPipelineWorker = setInterval(() => {
    try {
      processDueReminderJobs();
    } catch (error) {
      console.error("Reminder pipeline worker error", error);
    }
  }, 15000);
}

function createLenderState() {
  return {
    lenders: [],
    audits: [],
    jobs: [],
    notifications: [],
    lastAutoSchedulerRunAt: null,
    lastWorkerRunAt: null,
  };
}

function readLenderState() {
  try {
    if (!fs.existsSync(lenderStatePath)) {
      return createLenderState();
    }

    const parsed = JSON.parse(fs.readFileSync(lenderStatePath, "utf8"));
    return {
      lenders: Array.isArray(parsed?.lenders) ? parsed.lenders : [],
      audits: Array.isArray(parsed?.audits) ? parsed.audits : [],
      jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
      notifications: Array.isArray(parsed?.notifications) ? parsed.notifications : [],
      lastAutoSchedulerRunAt: parsed?.lastAutoSchedulerRunAt || null,
      lastWorkerRunAt: parsed?.lastWorkerRunAt || null,
    };
  } catch (_error) {
    return createLenderState();
  }
}

function writeLenderState(state) {
  try {
    fs.writeFileSync(lenderStatePath, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to save lender state:", error);
  }
}

function appendLenderAudit(state, {
  actor = "System",
  role = "system",
  actionType = "lender",
  action = "Lender event",
  details = "",
  status = "success",
  lenderId = null,
  targetMobile = null,
  jobId = null,
  meta = null,
}) {
  state.audits.unshift({
    id: crypto.randomUUID(),
    actor: String(actor || "System"),
    role: String(role || "system"),
    actionType: String(actionType || "lender"),
    action: String(action || "Lender event"),
    details: String(details || ""),
    status: String(status || "success"),
    lenderId: lenderId ? String(lenderId) : null,
    targetMobile: targetMobile ? String(targetMobile) : null,
    jobId: jobId ? String(jobId) : null,
    createdAt: new Date().toISOString(),
    meta: meta && typeof meta === "object" ? meta : null,
  });
  state.audits = state.audits.slice(0, 1500);
}

function appendLenderNotification(state, {
  title,
  message,
  severity = "info",
  type = "lender",
  action = null,
  lenderId = null,
  targetMobile = null,
  jobId = null,
}) {
  state.notifications.unshift({
    id: crypto.randomUUID(),
    type: String(type || "lender"),
    title: String(title || "Lender update"),
    message: String(message || ""),
    severity: String(severity || "info"),
    action: action && typeof action === "object" ? action : null,
    lenderId: lenderId ? String(lenderId) : null,
    targetMobile: targetMobile ? String(targetMobile) : null,
    jobId: jobId ? String(jobId) : null,
    status: "open",
    createdAt: new Date().toISOString(),
  });
  state.notifications = state.notifications.slice(0, 600);
}

function lenderActorFromReq(req) {
  const fallbackName = String(req.session?.user?.fullname || req.session?.user?.email || "Admin User").trim() || "Admin User";
  const fallbackRole = String(req.session?.user?.role || "admin").trim().toLowerCase() || "admin";
  return {
    actor: String(req.headers["x-user-name"] || req.headers["x-actor-name"] || fallbackName).trim() || fallbackName,
    role: String(req.headers["x-user-role"] || req.headers["x-actor-role"] || fallbackRole).trim().toLowerCase() || fallbackRole,
  };
}

function sanitizeLenderPayload(payload = {}) {
  const principal = normalizeReminderNumber(payload.principal, { snapNearInteger: true });
  const interestRate = normalizeReminderNumber(payload.interestRate) ?? 0;
  const lendDate = String(payload.lendDate || "").trim();
  const dueDate = String(payload.dueDate || "").trim();

  if (!String(payload.name || "").trim()) {
    return { error: "Lender name is required" };
  }

  const mobile = normalizeMobile(payload.mobile || "");
  if (!mobile || mobile.length !== 10) {
    return { error: "Valid 10-digit mobile is required" };
  }

  if (!Number.isFinite(principal) || principal <= 0) {
    return { error: "Principal must be greater than 0" };
  }

  if (!Number.isFinite(interestRate) || interestRate < 0) {
    return { error: "Interest rate must be 0 or higher" };
  }

  if (lendDate && Number.isNaN(Date.parse(lendDate))) {
    return { error: "Invalid lend date" };
  }

  if (dueDate && Number.isNaN(Date.parse(dueDate))) {
    return { error: "Invalid due date" };
  }

  if (lendDate && dueDate && dueDate < lendDate) {
    return { error: "Due date cannot be before lend date" };
  }

  return {
    data: {
      name: String(payload.name || "").trim(),
      mobile,
      principal,
      interestRate,
      lendDate: lendDate || "",
      dueDate: dueDate || "",
      repaymentCycle: String(payload.repaymentCycle || "monthly").trim().toLowerCase() || "monthly",
      status: String(payload.status || "active").trim().toLowerCase() === "closed" ? "closed" : "active",
      notes: String(payload.notes || "").trim().slice(0, 500),
    }
  };
}

function normalizeLenderTemplateType(value) {
  const normalized = String(value || "standard").trim().toLowerCase();
  return ["standard", "urgent", "appointment", "order", "verification"].includes(normalized)
    ? normalized
    : "standard";
}

function normalizeLenderTemplateVariables(variables) {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return {};
  }

  return Object.entries(variables).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) {
      return acc;
    }
    if (!/^\d+$/.test(normalizedKey)) {
      return acc;
    }
    acc[normalizedKey] = normalizedValue;
    return acc;
  }, {});
}

function getTwilioContentSidForTemplate(templateType) {
  const normalized = normalizeLenderTemplateType(templateType);
  const map = {
    standard: process.env.TWILIO_CONTENT_SID_STANDARD,
    urgent: process.env.TWILIO_CONTENT_SID_URGENT,
    appointment: process.env.TWILIO_CONTENT_SID_APPOINTMENT,
    order: process.env.TWILIO_CONTENT_SID_ORDER,
    verification: process.env.TWILIO_CONTENT_SID_VERIFICATION,
  };
  return String(map[normalized] || process.env.TWILIO_CONTENT_SID_DEFAULT || "").trim();
}

function buildLenderReminderMessage(lender, template = "standard", templateVariables = {}) {
  const templateType = normalizeLenderTemplateType(template);
  const vars = normalizeLenderTemplateVariables(templateVariables);
  const principal = Number(lender?.principal || 0);
  const rate = Number(lender?.interestRate || 0);
  const interest = Math.round((((principal * rate) / 100) + Number.EPSILON) * 100) / 100;
  const total = Math.round(((principal + interest) + Number.EPSILON) * 100) / 100;

  if (templateType === "appointment") {
    const appointmentDate = vars["1"] || lender?.dueDate || "Not set";
    const appointmentTime = vars["2"] || "Not set";
    return [
      `Dear ${lender?.name || "Customer"},`,
      "",
      `Your appointment is coming up on ${appointmentDate} at ${appointmentTime}.`,
      "If you need to change it, please reply back and let us know.",
    ].join("\n");
  }

  if (templateType === "order") {
    const orderId = vars["1"] || lender?.id || "-";
    const orderStatus = vars["2"] || "Processing";
    return [
      `Dear ${lender?.name || "Customer"},`,
      "",
      `Order update for ${orderId}: ${orderStatus}.`,
      `Outstanding amount: Rs. ${total}.`,
      "Thank you.",
    ].join("\n");
  }

  if (templateType === "verification") {
    const code = vars["1"] || "000000";
    return [
      `Dear ${lender?.name || "Customer"},`,
      "",
      `Your verification code is ${code}.`,
      "Do not share this code with anyone.",
    ].join("\n");
  }

  if (templateType === "urgent") {
    return [
      `Dear ${lender?.name || "Lender"},`,
      "",
      "Urgent reminder: payment is pending.",
      `Principal: Rs. ${principal}`,
      `Interest: ${rate}% (Rs. ${interest})`,
      `Total payable: Rs. ${total}`,
      `Due date: ${lender?.dueDate || "Not set"}`,
      "",
      "Please settle immediately.",
    ].join("\n");
  }

  return [
    `Dear ${lender?.name || "Lender"},`,
    "",
    "This is your scheduled payment reminder.",
    `Principal: Rs. ${principal}`,
    `Interest: ${rate}% (Rs. ${interest})`,
    `Total payable: Rs. ${total}`,
    `Due date: ${lender?.dueDate || "Not set"}`,
    "",
    "Thank you.",
  ].join("\n");
}

function parseLenderScheduleDateTime(scheduleDate, scheduleTime) {
  const rawDate = String(scheduleDate || "").trim();
  const rawTime = String(scheduleTime || "").trim();
  if (!rawDate) {
    return new Date().toISOString();
  }

  const composed = rawTime ? `${rawDate}T${rawTime}:00` : `${rawDate}T09:00:00`;
  const parsed = new Date(composed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function lenderDaysUntilDue(dueDate) {
  if (!dueDate) {
    return null;
  }
  const date = new Date(dueDate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function lenderMobileWithCountryCode(mobile) {
  const digits = normalizeMobile(mobile || "");
  if (!digits) {
    return "";
  }
  return digits.length === 10 ? `91${digits}` : digits;
}

function getWhatsAppProviderOrder() {
  const rawOrder = String(process.env.WHATSAPP_PROVIDER_ORDER || process.env.WHATSAPP_PROVIDER_SEQUENCE || "").trim().toLowerCase();
  const parsedOrder = rawOrder
    ? rawOrder.split(/[,\s|]+/).map((item) => item.trim()).filter((item) => ["meta", "twilio"].includes(item))
    : [];

  if (parsedOrder.length) {
    return [...new Set(parsedOrder)];
  }

  const provider = String(process.env.WHATSAPP_PROVIDER || "").trim().toLowerCase();
  if (provider === "meta" || provider === "twilio") {
    return [provider];
  }

  return ["meta", "twilio"];
}

async function sendLenderWhatsAppViaMeta({ normalizedMobile, message, waLink }) {
  const phoneNumberId = String(process.env.WHATSAPP_META_PHONE_NUMBER_ID || "").trim();
  const accessToken = String(process.env.WHATSAPP_META_ACCESS_TOKEN || "").trim();
  if (!phoneNumberId || !accessToken) {
    return { ok: false, error: "Meta WhatsApp credentials missing", shareUrl: waLink };
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: normalizedMobile,
        type: "text",
        text: { body: String(message || "") },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    const messageId = response?.data?.messages?.[0]?.id || null;
    return { ok: true, provider: "meta", messageId, shareUrl: waLink };
  } catch (error) {
    const errorText = error?.response?.data?.error?.message || error.message || "Meta send failed";
    return { ok: false, error: errorText, shareUrl: waLink };
  }
}

async function sendLenderWhatsAppViaTwilio({ normalizedMobile, message, waLink, templateType = "standard", templateVariables = {} }) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const from = String(process.env.TWILIO_WHATSAPP_FROM || "").trim();
  if (!sid || !token || !from) {
    return { ok: false, error: "Twilio WhatsApp credentials missing", shareUrl: waLink };
  }

  const payload = new URLSearchParams();
  payload.append("To", `whatsapp:+${normalizedMobile}`);
  payload.append("From", `whatsapp:${from.startsWith("+") ? from : `+${from}`}`);
  const contentSid = getTwilioContentSidForTemplate(templateType);
  const normalizedVariables = normalizeLenderTemplateVariables(templateVariables);
  if (contentSid) {
    payload.append("ContentSid", contentSid);
    payload.append("ContentVariables", JSON.stringify(normalizedVariables));
  } else {
    payload.append("Body", String(message || ""));
  }

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      payload.toString(),
      {
        auth: { username: sid, password: token },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      }
    );
    return {
      ok: true,
      provider: "twilio",
      messageId: response?.data?.sid || null,
      shareUrl: waLink,
      contentSid: contentSid || null,
    };
  } catch (error) {
    const errorText = error?.response?.data?.message || error.message || "Twilio send failed";
    return { ok: false, error: errorText, shareUrl: waLink };
  }
}

async function sendLenderWhatsAppReminder({ mobile, message, templateType = "standard", templateVariables = {} }) {
  const normalizedMobile = lenderMobileWithCountryCode(mobile);
  if (!normalizedMobile || normalizedMobile.length < 12) {
    return { ok: false, error: "Invalid mobile number" };
  }

  const waLink = `https://wa.me/${normalizedMobile}?text=${encodeURIComponent(String(message || ""))}`;

  const providerOrder = getWhatsAppProviderOrder();
  const attempts = [];

  for (const provider of providerOrder) {
    const delivery = provider === "meta"
      ? await sendLenderWhatsAppViaMeta({ normalizedMobile, message, waLink })
      : await sendLenderWhatsAppViaTwilio({ normalizedMobile, message, waLink, templateType, templateVariables });

    if (delivery.ok) {
      return delivery;
    }

    attempts.push(`${provider}: ${delivery.error || "failed"}`);
  }

  return {
    ok: false,
    error: attempts.length
      ? `WhatsApp delivery failed (${attempts.join(" | ")})`
      : "WhatsApp provider not configured. Set WHATSAPP_PROVIDER=meta|twilio or WHATSAPP_PROVIDER_ORDER=meta,twilio",
    shareUrl: waLink,
  };
}

function runDailyLenderAutoScheduler(state) {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (String(state.lastAutoSchedulerRunAt || "") === todayKey) {
    return 0;
  }

  let created = 0;
  state.lenders.forEach((lender) => {
    if (String(lender.status || "").toLowerCase() === "closed") {
      return;
    }

    const days = lenderDaysUntilDue(lender.dueDate);
    if (days !== 2) {
      return;
    }

    const autoRuleKey = `${lender.id}:${lender.dueDate}:d-2`;
    const alreadyQueued = state.jobs.some((job) => {
      const sameRule = String(job?.meta?.autoRuleKey || "") === autoRuleKey;
      const status = String(job.status || "").toLowerCase();
      return sameRule && ["queued", "scheduled", "retry_pending", "sent"].includes(status);
    });

    if (alreadyQueued) {
      return;
    }

    state.jobs.unshift({
      id: crypto.randomUUID(),
      lenderId: lender.id,
      name: lender.name,
      mobile: lender.mobile,
      message: buildLenderReminderMessage(lender, "standard"),
      template: "standard",
      status: "queued",
      type: "auto-due-minus-2",
      attempts: 0,
      maxAttempts: 3,
      scheduledFor: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actor: "Auto Scheduler",
      meta: { autoRuleKey, daysBeforeDue: 2, dueDate: lender.dueDate },
    });
    created += 1;
  });

  state.lastAutoSchedulerRunAt = todayKey;
  if (created > 0) {
    appendLenderAudit(state, {
      actor: "Auto Scheduler",
      role: "system",
      actionType: "auto-schedule",
      action: "Daily auto scheduler queued reminders",
      details: `${created} reminders queued for lenders due in 2 days`,
      status: "success",
      meta: { daysBeforeDue: 2, count: created },
    });
  }

  return created;
}

async function processDueLenderJobs() {
  const state = readLenderState();
  runDailyLenderAutoScheduler(state);
  const now = Date.now();
  const dueJobs = state.jobs.filter((job) => {
    const status = String(job.status || "").toLowerCase();
    if (!["queued", "scheduled", "retry_pending"].includes(status)) {
      return false;
    }
    const dueAt = new Date(job.scheduledFor || 0).getTime();
    return Number.isFinite(dueAt) && dueAt <= now;
  });

  for (const job of dueJobs) {
    const nowIso = new Date().toISOString();
    job.attempts = Number(job.attempts || 0) + 1;
    job.lastAttemptAt = nowIso;

    const delivery = await sendLenderWhatsAppReminder({
      mobile: job.mobile,
      message: job.message,
      templateType: job.templateType || job.template || "standard",
      templateVariables: job.templateVariables || {},
    });
    if (delivery.ok) {
      job.status = "sent";
      job.lastError = null;
      job.provider = delivery.provider || null;
      job.providerMessageId = delivery.messageId || null;
      job.contentSid = delivery.contentSid || null;
      job.shareUrl = delivery.shareUrl || null;
      job.updatedAt = nowIso;
      appendLenderAudit(state, {
        actor: "Scheduler",
        role: "system",
        actionType: "schedule",
        action: "Scheduled lender reminder sent",
        details: `Reminder sent via ${delivery.provider || "provider"} for ${job.mobile}`,
        status: "success",
        lenderId: job.lenderId,
        targetMobile: job.mobile,
        jobId: job.id,
        meta: { provider: delivery.provider || null, providerMessageId: delivery.messageId || null },
      });
      continue;
    }

    job.lastError = delivery.error || "Provider delivery failed";
    job.shareUrl = delivery.shareUrl || null;
    if (job.attempts < Number(job.maxAttempts || 3)) {
      job.status = "retry_pending";
      job.scheduledFor = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    } else {
      job.status = "failed";
    }
    job.updatedAt = nowIso;
    appendLenderAudit(state, {
      actor: "Scheduler",
      role: "system",
      actionType: "schedule",
      action: "Scheduled lender reminder failed",
      details: `${job.lastError} for ${job.mobile}`,
      status: "failed",
      lenderId: job.lenderId,
      targetMobile: job.mobile,
      jobId: job.id,
    });
    appendLenderNotification(state, {
      type: "delivery",
      severity: "error",
      title: "Lender reminder failed",
      message: `Could not process lender reminder for ${job.name || job.mobile}`,
      action: { type: "retry", jobId: job.id, label: "Retry now" },
      lenderId: job.lenderId,
      targetMobile: job.mobile,
      jobId: job.id,
    });
  }

  state.lastWorkerRunAt = new Date().toISOString();
  writeLenderState(state);
  return state;
}

let lenderPipelineWorker = null;

function startLenderPipelineWorker() {
  if (lenderPipelineWorker || process.env.VERCEL === "1") {
    return;
  }

  lenderPipelineWorker = setInterval(() => {
    processDueLenderJobs().catch((error) => {
      console.error("Lender pipeline worker error", error);
    });
  }, 20000);
}

async function upsertPaymentReminderRow({ paymentId = null, mobile, name = null, reminderData }) {
  const reminderRow = {
    payment_id: paymentId || null,
    payment_mobile: normalizeMobile(mobile || ""),
    payment_name: String(name || "").trim() || null,
    reminder_note: reminderData?.note || "",
    reminder_borrow_date: reminderData?.borrowDate || null,
    reminder_repayment_date: reminderData?.repaymentDate || null,
    reminder_amount: reminderData?.reminderAmount ?? null,
    reminder_interest: reminderData?.reminderInterest ?? null,
    reminder_status: reminderData?.reminderStatus || "manual",
    paid_at: reminderData?.paidAt || null,
  };

  const { data, error } = await supabase
    .from(paymentRemindersTable)
    .insert(reminderRow)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function clearPaymentReminderRows({ paymentId = null, mobile = null, reminderId = null }) {
  let query = supabase.from(paymentRemindersTable).delete();

  if (reminderId) {
    query = query.eq("id", reminderId);
  }

  if (paymentId) {
    query = query.eq("payment_id", paymentId);
  }

  if (mobile) {
    query = query.eq("payment_mobile", normalizeMobile(mobile));
  }

  const { error } = await query;
  if (error) {
    throw error;
  }
}

async function syncReminderColumnsOnPayment(paymentId, reminderData, nextStatus = null) {
  if (!paymentId) {
    return null;
  }

  const basePayload = reminderData
    ? {
        reminder_note: encodeReminderPayload(reminderData),
        reminder_borrow_date: reminderData.borrowDate || null,
        reminder_repayment_date: reminderData.repaymentDate || null,
        reminder_amount: reminderData.reminderAmount ?? null,
        reminder_interest: reminderData.reminderInterest ?? null,
      }
    : {
        reminder_note: null,
        reminder_borrow_date: null,
        reminder_repayment_date: null,
        reminder_amount: null,
        reminder_interest: null,
      };

  const updatePayload = { ...basePayload };

  if (nextStatus) {
    updatePayload.status = nextStatus;
  }

  while (true) {
    const { data, error } = await supabase
      .from("payments")
      .update(updatePayload)
      .eq("id", paymentId)
      .select("*")
      .maybeSingle();

    if (!error) {
      return data;
    }

    const message = String(error.message || "");
    const missingColumnMatch = message.match(/'([^']+)' column of 'payments'/i);
    const missingColumn = missingColumnMatch?.[1];

    if (String(error.code || "") === "PGRST204" && missingColumn && Object.prototype.hasOwnProperty.call(updatePayload, missingColumn)) {
      delete updatePayload[missingColumn];
      continue;
    }

    throw error;
  }
}

function setPaymentScreenshotPath(recordId, utrNumber, screenshotPath) {
  const normalizedRecordId = String(recordId || "").trim();
  const normalizedUtr = String(utrNumber || "").trim();
  const normalizedPath = String(screenshotPath || "").trim();
  if (!normalizedPath) {
    return;
  }

  const indexData = readPaymentScreenshotsIndex();
  if (normalizedRecordId) {
    indexData[`id:${normalizedRecordId}`] = normalizedPath;
  }
  if (normalizedUtr) {
    indexData[`utr:${normalizedUtr}`] = normalizedPath;
  }
  writePaymentScreenshotsIndex(indexData);
}

function getPaymentScreenshotPath(recordId, utrNumber) {
  const normalizedRecordId = String(recordId || "").trim();
  const normalizedUtr = String(utrNumber || "").trim();
  const indexData = readPaymentScreenshotsIndex();

  if (normalizedRecordId && indexData[`id:${normalizedRecordId}`]) {
    return indexData[`id:${normalizedRecordId}`];
  }

  if (normalizedUtr && indexData[`utr:${normalizedUtr}`]) {
    return indexData[`utr:${normalizedUtr}`];
  }

  return null;
}

function savePaymentScreenshotFromBase64({ mobile, utrNumber, screenshotBase64, screenshotName }) {
  const rawData = String(screenshotBase64 || "").trim();
  if (!rawData) {
    return null;
  }

  const match = rawData.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error("Invalid screenshot format. Upload a PNG, JPG, JPEG, or WEBP image.");
  }

  const subtype = String(match[2] || "png").toLowerCase();
  const extension = subtype === "jpeg" ? "jpg" : subtype;
  const base64Content = match[3];
  const buffer = Buffer.from(base64Content, "base64");
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded screenshot is empty.");
  }

  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error("Screenshot must be 5MB or smaller.");
  }

  const normalizedMobile = String(mobile || "").replace(/\D/g, "").slice(-10) || "unknown";
  const safeUtr = String(utrNumber || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "utr";
  const safeOriginal = String(screenshotName || "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  const originalBase = safeOriginal ? safeOriginal.replace(/\.[^.]+$/, "") : `${normalizedMobile}-${safeUtr}`;
  const fileName = `${originalBase}-${Date.now()}.${extension}`;
  const absolutePath = path.join(paymentScreenshotsDir, fileName);

  fs.writeFileSync(absolutePath, buffer);
  return path.posix.join("uploads", "payment-screenshots", fileName);
}

function normalizeUtrForPath(utrNumber) {
  return String(utrNumber || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
}

function buildSupabasePaymentScreenshotPath(utrNumber) {
  const safeUtr = normalizeUtrForPath(utrNumber);
  if (!safeUtr) {
    return null;
  }
  return `manual/${safeUtr}`;
}

async function uploadPaymentScreenshotToSupabase({ utrNumber, screenshotBase64 }) {
  const rawData = String(screenshotBase64 || "").trim();
  if (!rawData) {
    return null;
  }

  const objectPath = buildSupabasePaymentScreenshotPath(utrNumber);
  if (!objectPath) {
    return null;
  }

  await ensurePaymentScreenshotBucket();

  const match = rawData.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!match) {
    throw new Error("Invalid screenshot format. Upload a PNG, JPG, JPEG, or WEBP image.");
  }

  const mimeType = String(match[1] || "image/png").toLowerCase();
  const base64Content = match[3];
  const buffer = Buffer.from(base64Content, "base64");
  if (!buffer || buffer.length === 0) {
    throw new Error("Uploaded screenshot is empty.");
  }

  if (buffer.length > 5 * 1024 * 1024) {
    throw new Error("Screenshot must be 5MB or smaller.");
  }

  const { error: uploadError } = await supabase.storage
    .from(paymentScreenshotBucket)
    .upload(objectPath, buffer, {
      upsert: true,
      contentType: mimeType,
      cacheControl: "3600",
    });

  if (uploadError) {
    console.error("supabase screenshot upload error", uploadError);
    throw new Error("Failed to upload payment screenshot.");
  }

  const { data } = supabase.storage.from(paymentScreenshotBucket).getPublicUrl(objectPath);
  return data?.publicUrl || null;
}

async function resolveSupabaseScreenshotUrlByUtr(utrNumber) {
  const objectPath = buildSupabasePaymentScreenshotPath(utrNumber);
  if (!objectPath) {
    return null;
  }

  await ensurePaymentScreenshotBucket();

  const { data, error } = await supabase.storage
    .from(paymentScreenshotBucket)
    .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

let paymentScreenshotBucketReady = null;

async function ensurePaymentScreenshotBucket() {
  if (paymentScreenshotBucketReady) {
    return paymentScreenshotBucketReady;
  }

  paymentScreenshotBucketReady = (async () => {
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      if (listError) {
        throw listError;
      }

      const existing = Array.isArray(buckets)
        ? buckets.find((bucket) => String(bucket.name || "").trim() === paymentScreenshotBucket)
        : null;

      if (!existing) {
        const { error: createError } = await supabase.storage.createBucket(paymentScreenshotBucket, {
          public: false,
          allowedMimeTypes: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
          fileSizeLimit: 5 * 1024 * 1024,
        });

        if (createError) {
          console.warn("payment screenshot bucket create skipped", createError.message || createError);
        }
      }
    } catch (error) {
      console.warn("payment screenshot bucket ensure skipped", error?.message || error);
    }
  })();

  return paymentScreenshotBucketReady;
}

function isAuctionChatTableMissing(error) {
  if (!error) {
    return false;
  }

  const code = String(error.code || "").trim();
  const message = String(error.message || "");
  return code === "PGRST205" || message.includes("auction_chat_messages");
}

function readAuctionChatFallback() {
  try {
    if (!fs.existsSync(auctionChatFallbackPath)) {
      return [];
    }

    const raw = fs.readFileSync(auctionChatFallbackPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeAuctionChatFallback(rows) {
  try {
    fs.writeFileSync(auctionChatFallbackPath, JSON.stringify(rows, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to write auction chat fallback:", error);
  }
}

function listAuctionChatMessagesFallback(mobile) {
  const normalizedMobile = String(mobile || "").trim();
  return readAuctionChatFallback()
    .filter((row) => String(row.mobile || "").trim() === normalizedMobile)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function listAuctionChatThreadsFallback() {
  const rows = readAuctionChatFallback().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const seen = new Set();
  const threads = [];

  for (const row of rows) {
    const mobile = String(row.mobile || "").trim();
    if (!mobile || seen.has(mobile)) {
      continue;
    }

    seen.add(mobile);
    threads.push({
      mobile,
      lastSenderName: row.sender_name || "",
      lastMessageAt: row.created_at,
    });
  }

  return threads;
}

function insertAuctionChatFallback({ mobile, senderRole, senderName, message, topic }) {
  const rows = readAuctionChatFallback();
  const row = {
    id: crypto.randomUUID(),
    mobile,
    sender_role: senderRole,
    sender_name: senderName,
    message,
    topic,
    created_at: new Date().toISOString(),
  };
  rows.push(row);
  writeAuctionChatFallback(rows);
  return row;
}

function deleteAuctionChatMessageFallback(messageId) {
  const normalizedId = String(messageId || "").trim();
  if (!normalizedId) {
    return null;
  }

  const rows = readAuctionChatFallback();
  const idx = rows.findIndex((row) => String(row.id || "").trim() === normalizedId);
  if (idx < 0) {
    return null;
  }

  const [removed] = rows.splice(idx, 1);
  writeAuctionChatFallback(rows);
  return removed;
}

function updateAuctionChatMessageFallback(messageId, updater) {
  const normalizedId = String(messageId || "").trim();
  if (!normalizedId || typeof updater !== "function") {
    return null;
  }

  const rows = readAuctionChatFallback();
  const idx = rows.findIndex((row) => String(row.id || "").trim() === normalizedId);
  if (idx < 0) {
    return null;
  }

  const updated = updater({ ...rows[idx] });
  if (!updated) {
    return null;
  }

  rows[idx] = updated;
  writeAuctionChatFallback(rows);
  return updated;
}

const borrowDocsUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, borrowDocsDir),
    filename: (req, file, cb) => {
      const mobile = String(req.body?.mobile || "unknown").replace(/\D/g, "").slice(-10) || "unknown";
      const safeDocType = String(file.fieldname || "doc").replace(/[^a-zA-Z0-9_-]/g, "");
      const extension = path.extname(file.originalname || "").toLowerCase();
      cb(null, `${mobile}-${safeDocType}-${Date.now()}${extension}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (!allowedTypes.has(extension)) {
      return cb(new Error("Only PDF, JPG, JPEG, PNG, or WEBP files are allowed"));
    }
    return cb(null, true);
  },
}).fields([
  { name: "aadhaarDocument", maxCount: 1 },
  { name: "panDocument", maxCount: 1 },
  { name: "rcDocument", maxCount: 1 },
]);

function runBorrowDocsUpload(req, res, next) {
  borrowDocsUpload(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Each file must be 5MB or smaller" });
    }

    return res.status(400).json({ error: error.message || "Invalid file upload" });
  });
}

function getBorrowUploadedPath(files, fieldName) {
  const uploadedFile = files?.[fieldName]?.[0];
  if (!uploadedFile?.filename) {
    return null;
  }
  return path.posix.join("uploads", "borrow-docs", uploadedFile.filename);
}

function cleanupBorrowUploads(files) {
  if (!files || typeof files !== "object") {
    return;
  }

  Object.values(files)
    .flat()
    .forEach((file) => {
      if (file?.path) {
        fs.unlink(file.path, () => {});
      }
    });
}

function isBorrowDocColumnMissing(error) {
  if (!error) {
    return false;
  }

  const code = String(error.code || "").trim();
  const message = String(error.message || "");
  return code === "42703" || code === "PGRST204" || message.includes("aadhaar_document_path");
}

function createMailTransporter() {
  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
  const mailPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD;

  if (!mailUser || !mailPass) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: mailUser,
      pass: mailPass,
    },
  });
}

function createResetToken({ userId, email, expiresAt, otp }) {
  const secret = process.env.RESET_TOKEN_SECRET || process.env.SESSION_SECRET || "change-me-in-production";
  const payload = Buffer.from(JSON.stringify({ userId, email, expiresAt }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(`${payload}.${otp}`).digest("hex");
  return `${payload}.${signature}`;
}

function verifyResetToken(token, otp) {
  const secret = process.env.RESET_TOKEN_SECRET || process.env.SESSION_SECRET || "change-me-in-production";
  try {
    const tokenValue = String(token || "").trim();
    const separatorIndex = tokenValue.lastIndexOf(".");
    if (separatorIndex <= 0 || separatorIndex >= tokenValue.length - 1 || !otp) {
      return null;
    }

    const payload = tokenValue.slice(0, separatorIndex);
    const signature = tokenValue.slice(separatorIndex + 1);
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const userId = String(parsed?.userId || "").trim();
    const email = String(parsed?.email || "").trim();
    const expiresAt = Number(parsed?.expiresAt);

    if (!userId || !email || !expiresAt || !signature) {
      return null;
    }

    if (Date.now() > expiresAt) {
      return null;
    }

    const expected = crypto.createHmac("sha256", secret).update(`${payload}.${otp}`).digest("hex");
    if (expected.length !== signature.length) {
      return null;
    }

    const isValid = crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
    if (!isValid) {
      return null;
    }

    return { userId, email, expiresAt };
  } catch (_error) {
    return null;
  }
}

function generateStatementPdf(payment) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(invoicesDir, `${payment.id}-statement.pdf`);
    const doc = new pdf();
    const writeStream = fs.createWriteStream(filePath);

    writeStream.on("finish", () => resolve(filePath));
    writeStream.on("error", reject);

    doc.pipe(writeStream);

    doc.rect(0, 0, doc.page.width, 50).fill("#003366");
    doc.fillColor("#000000").fontSize(20).text("Dhanam Chits Pvt. Ltd", 0, 15, { align: "center" });
    doc.fillColor("#000000").fontSize(12).text("1234 Chits Street, Business City, Country", 0, 35, { align: "center" });
    doc.fillColor("#000000").fontSize(12).text("Phone: +123 456 7890 | Email: info@dhanamchits.com", 0, 50, {
      align: "center",
    });
    doc.moveDown(2);

    doc.fillColor("#003366").fontSize(16).text("Statement", { align: "center" });
    doc.moveDown();

    doc.fillColor("#000000").fontSize(14).text(`Statement ID: ${payment.id}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();
    doc.fillColor("#000000").fontSize(14).text(`Name: ${payment.name || "N/A"}`);
    doc.text(`Mobile: ${payment.mobile || "N/A"}`);
    doc.text(`Email: ${payment.email || "N/A"}`);
    doc.text(`Chit Plan: ${payment.chits_plan || "N/A"}`);
    doc.moveDown();
    doc.fillColor("#000000").fontSize(14).text("Payment Details:");
    doc.text(`Amount: ${payment.amount || 0}`);
    doc.text(`UTR Number: ${payment.utr_number || "N/A"}`);
    doc.text(`Payment Type: ${payment.type || "N/A"}`);

    doc.end();
  });
}

async function sendStatementEmail(payment) {
  if (!payment.email) {
    throw new Error("Payment has no email address");
  }

  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
  const transporter = createMailTransporter();
  if (!transporter) {
    throw new Error("Email config missing. Set SMTP_USER/SMTP_PASS (or EMAIL_USER/EMAIL_PASS) in .env");
  }

  const statementPath = await generateStatementPdf(payment);

  await transporter.sendMail({
    from: mailUser,
    to: payment.email,
    subject: "Payment Statement",
    text: `Dear ${payment.name || "Customer"}, please find attached your payment statement.`,
    attachments: [
      {
        filename: "statement.pdf",
        path: statementPath,
      },
    ],
  });
}

async function sendPasswordChangeAlertEmail({ email, fullname, reason }) {
  const toEmail = String(email || "").trim();
  if (!toEmail) {
    return;
  }

  const transporter = createMailTransporter();
  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
  if (!transporter || !mailUser) {
    return;
  }

  const displayName = String(fullname || "User").trim() || "User";
  const reasonLine = reason ? `Reason: ${reason}.` : "";

  await transporter.sendMail({
    from: mailUser,
    to: toEmail,
    subject: "Dhanam Chits - Password Changed",
    text: `Dear ${displayName}, your account password was changed successfully. ${reasonLine} If this was not you, please contact support immediately.`,
  });
}

async function sendLoginAlertEmail({ email, fullname, mobile, ipAddress, userAgent }) {
  const toEmail = String(email || "").trim();
  if (!toEmail) {
    return;
  }

  const transporter = createMailTransporter();
  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
  if (!transporter || !mailUser) {
    return;
  }

  const displayName = String(fullname || "User").trim() || "User";
  const loginTime = new Date().toISOString();

  await transporter.sendMail({
    from: mailUser,
    to: toEmail,
    subject: "Dhanam Chits - Login Alert",
    text: `Dear ${displayName}, your account was logged in successfully.\n\nMobile: ${mobile || "N/A"}\nTime: ${loginTime}\nIP Address: ${ipAddress || "Unknown"}\nDevice: ${userAgent || "Unknown"}\n\nIf this was not you, please reset your password immediately.`,
  });
}

const registerHandler = async (req, res) => {
  try {
    const { fullname, email, mobile, password, confirmPassword, role } = req.body;

    if (!fullname || !email || !mobile || !password || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required." });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    const { data: existingByEmail } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    const { data: existingByMobile } = await supabase
      .from("users")
      .select("id")
      .eq("mobile", mobile)
      .maybeSingle();

    if (existingByEmail || existingByMobile) {
      return res.status(400).json({ message: "Mobile or email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const { error } = await supabase.from("users").insert({
      fullname,
      email,
      mobile,
      password_hash: hashedPassword,
      role: role === "admin" ? "admin" : "user",
    });

    if (error) {
      console.error("register insert error", error);
      return res.status(500).json({ message: "Failed to register user." });
    }

    return res.status(201).json({ message: "User registered successfully!" });
  } catch (error) {
    console.error("register error", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

app.post("/register", registerHandler);

app.post("/api/register", registerHandler);

app.post("/api/Register", registerHandler);

const loginHandler = async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password) {
      return res.status(400).json({ message: "Mobile number and password are required." });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, fullname, email, mobile, role, password_hash")
      .eq("mobile", mobile)
      .maybeSingle();

    if (error) {
      console.error("login select error", error);
      return res.status(500).json({ message: "Internal Server Error" });
    }

    if (!user) {
      return res.status(401).json({ message: "Invalid mobile number or password." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid mobile number or password." });
    }

    req.session.user = {
      id: user.id,
      fullname: user.fullname,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
    };
    setAuthCookie(res, req.session.user);

    const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ipAddress = forwardedFor || req.socket?.remoteAddress || "Unknown";
    const userAgent = req.get("user-agent") || "Unknown";

    sendLoginAlertEmail({
      email: user.email,
      fullname: user.fullname,
      mobile: user.mobile,
      ipAddress,
      userAgent,
    }).catch((mailError) => {
      console.error("login alert mail error", mailError);
    });

    return res.status(200).json({ message: "Login successful!", user: req.session.user });
  } catch (error) {
    console.error("login error", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

app.post("/login", loginHandler);

app.post("/Login", loginHandler);

app.post("/api/login", loginHandler);

app.post("/api/Login", loginHandler);

const logoutHandler = (req, res) => {
  req.session = { user: null };
  clearAuthCookie(res);
  return res.status(200).json({ message: "Logout successful." });
};

app.post("/logout", logoutHandler);

app.post("/api/logout", logoutHandler);

app.post("/api/Logout", logoutHandler);

app.get("/api/users", requireAdminFlexible, async (req, res) => {
  const { data, error } = await supabase
    .from("users")
    .select("id, fullname, email, mobile, role, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("users error", error);
    return res.status(500).json({ message: "Failed to fetch users" });
  }

  return res.json(
    data.map((user) => ({
      _id: user.id,
      id: user.id,
      fullname: user.fullname,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
      created_at: user.created_at,
    }))
  );
});

app.put("/api/users/:id/password", requireAdminFlexible, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "Password is required" });
  }

  const { data: targetUser, error: lookupError } = await supabase
    .from("users")
    .select("id, email, fullname")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    console.error("change password lookup error", lookupError);
    return res.status(500).json({ message: "Failed to change password" });
  }

  if (!targetUser) {
    return res.status(404).json({ message: "User not found" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from("users").update({ password_hash }).eq("id", id);

  if (error) {
    console.error("change password error", error);
    return res.status(500).json({ message: "Failed to change password" });
  }

  try {
    await sendPasswordChangeAlertEmail({
      email: targetUser.email,
      fullname: targetUser.fullname,
      reason: "Changed by admin",
    });
  } catch (mailError) {
    console.error("change password alert mail error", mailError);
  }

  return res.json({ message: "Password changed successfully" });
});

app.delete("/api/users/:id", requireAdminFlexible, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("users").delete().eq("id", id);

  if (error) {
    console.error("delete user error", error);
    return res.status(500).json({ message: "Failed to delete user" });
  }

  return res.json({ message: "User deleted successfully" });
});

app.get("/api/profile", async (req, res) => {
  const { mobile } = req.query;
  if (!mobile) {
    return res.status(400).json({ message: "Mobile is required" });
  }

  const { data, error } = await supabase
    .from("users")
    .select("fullname, email, mobile")
    .eq("mobile", String(mobile))
    .maybeSingle();

  if (error) {
    console.error("profile error", error);
    return res.status(500).json({ error: "Failed to fetch profile information" });
  }

  if (!data) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.json(data);
});

app.post("/api/profile/change-password", async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const sessionMobile = req.session?.user?.mobile;
  const mobile = String(sessionMobile || req.body?.mobile || "").trim();

  if (!mobile) {
    return res.status(400).json({ message: "Mobile is required" });
  }

  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: "All password fields are required" });
  }

  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters" });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: "New password and confirm password do not match" });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ message: "New password must be different from current password" });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, password_hash, email, fullname")
    .eq("mobile", mobile)
    .maybeSingle();

  if (userError) {
    console.error("profile change password lookup error", userError);
    return res.status(500).json({ message: "Failed to update password" });
  }

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const isCurrentValid = await bcrypt.compare(currentPassword, user.password_hash || "");
  if (!isCurrentValid) {
    return res.status(401).json({ message: "Current password is incorrect" });
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  const { error: updateError } = await supabase.from("users").update({ password_hash }).eq("id", user.id);

  if (updateError) {
    console.error("profile change password update error", updateError);
    return res.status(500).json({ message: "Failed to update password" });
  }

  try {
    await sendPasswordChangeAlertEmail({
      email: user.email,
      fullname: user.fullname,
      reason: "Changed from profile page",
    });
  } catch (mailError) {
    console.error("profile change password alert mail error", mailError);
  }

  return res.status(200).json({ message: "Password updated successfully" });
});

app.post("/api/reset-password/request", async (req, res) => {
  const { mobile, email } = req.body || {};
  const mobileValue = String(mobile || "").trim();
  const emailValue = String(email || "").trim().toLowerCase();

  if (!mobileValue || !emailValue) {
    return res.status(400).json({ message: "Mobile number and email are required" });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, fullname, email, mobile")
    .eq("mobile", mobileValue)
    .eq("email", emailValue)
    .maybeSingle();

  if (userError) {
    console.error("reset request lookup error", userError);
    return res.status(500).json({ message: "Failed to process reset request" });
  }

  if (!user) {
    return res.status(404).json({ message: "No account found for the provided mobile and email" });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const resetToken = createResetToken({ userId: user.id, email: emailValue, expiresAt, otp });

  const mailUser = process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER;
  const transporter = createMailTransporter();
  if (!transporter) {
    return res.status(500).json({ message: "Email config missing. Set SMTP_USER/SMTP_PASS in environment." });
  }

  try {
    await transporter.sendMail({
      from: mailUser,
      to: user.email,
      subject: "Dhanam Chits Password Reset OTP",
      text: `Dear ${user.fullname || "User"}, your password reset OTP is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({
      message: "OTP sent to your registered email.",
      resetToken,
    });
  } catch (mailError) {
    console.error("reset request mail error", mailError);
    return res.status(500).json({ message: "Failed to send OTP email" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  const { resetToken, otp, newPassword, confirmPassword } = req.body || {};

  if (!resetToken || !otp) {
    return res.status(400).json({ message: "Reset token and OTP are required" });
  }

  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ message: "New password and confirm password are required" });
  }

  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: "New password must be at least 6 characters" });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: "New password and confirm password do not match" });
  }

  const verified = verifyResetToken(resetToken, String(otp).trim());
  if (!verified) {
    return res.status(401).json({ message: "Invalid or expired OTP" });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, email, fullname")
    .eq("id", verified.userId)
    .maybeSingle();

  if (userError) {
    console.error("reset verify lookup error", userError);
    return res.status(500).json({ message: "Failed to reset password" });
  }

  if (!user || String(user.email || "").toLowerCase() !== String(verified.email || "").toLowerCase()) {
    return res.status(401).json({ message: "Invalid reset request" });
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  const { error: updateError } = await supabase.from("users").update({ password_hash }).eq("id", user.id);

  if (updateError) {
    console.error("reset password update error", updateError);
    return res.status(500).json({ message: "Failed to reset password" });
  }

  try {
    await sendPasswordChangeAlertEmail({
      email: user.email,
      fullname: user.fullname,
      reason: "Changed using forgot password OTP",
    });
  } catch (mailError) {
    console.error("reset password alert mail error", mailError);
  }

  return res.status(200).json({ message: "Password reset successful. Please login." });
});

function mapSubmissionRow(row) {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    chitsPlan: row.chits_plan,
    amount: row.amount,
    utrNumber: row.utr_number,
    created_at: row.created_at,
  };
}

app.get("/submissions", async (_req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("submissions list error", error);
    return res.status(500).json({ error: "Failed to fetch submissions" });
  }

  return res.json(data.map(mapSubmissionRow));
});

app.get("/api/submissions", async (_req, res) => {
  const { data, error } = await supabase
    .from("submissions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("submissions list error", error);
    return res.status(500).json({ error: "Failed to fetch submissions" });
  }

  return res.json(data.map(mapSubmissionRow));
});

app.post("/submissions", async (req, res) => {
  const { name, phone, email, chitsPlan, amount, utrNumber } = req.body;

  const { data: existing, error: existingError } = await supabase
    .from("submissions")
    .select("id")
    .eq("utr_number", utrNumber)
    .maybeSingle();

  if (existingError) {
    console.error("submissions duplicate check error", existingError);
    return res.status(500).json({ error: "Failed to create submission" });
  }

  if (existing) {
    return res.status(400).json({ error: "UTR number already exists. Please use a unique UTR number." });
  }

  const { data, error } = await supabase
    .from("submissions")
    .insert({
      name,
      phone,
      email,
      chits_plan: chitsPlan,
      amount,
      utr_number: utrNumber,
    })
    .select("*")
    .single();

  if (error) {
    console.error("submission create error", error);
    return res.status(400).json({ error: "Failed to create submission" });
  }

  return res.status(201).json(mapSubmissionRow(data));
});

app.post("/api/submissions", async (req, res) => {
  const { name, phone, email, chitsPlan, amount, utrNumber } = req.body;

  const { data: existing, error: existingError } = await supabase
    .from("submissions")
    .select("id")
    .eq("utr_number", utrNumber)
    .maybeSingle();

  if (existingError) {
    console.error("submissions duplicate check error", existingError);
    return res.status(500).json({ error: "Failed to create submission" });
  }

  if (existing) {
    return res.status(400).json({ error: "UTR number already exists. Please use a unique UTR number." });
  }

  const { data, error } = await supabase
    .from("submissions")
    .insert({
      name,
      phone,
      email,
      chits_plan: chitsPlan,
      amount,
      utr_number: utrNumber,
    })
    .select("*")
    .single();

  if (error) {
    console.error("submission create error", error);
    return res.status(400).json({ error: "Failed to create submission" });
  }

  return res.status(201).json(mapSubmissionRow(data));
});

app.delete("/submissions/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("submissions").delete().eq("id", id);

  if (error) {
    console.error("submission delete error", error);
    return res.status(500).json({ error: "Failed to delete submission" });
  }

  return res.json({ message: "Submission deleted successfully" });
});

app.delete("/api/submissions/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("submissions").delete().eq("id", id);

  if (error) {
    console.error("submission delete error", error);
    return res.status(500).json({ error: "Failed to delete submission" });
  }

  return res.json({ message: "Submission deleted successfully" });
});

app.post("/api/contact", async (req, res) => {
  const { name, email, mobile, message } = req.body;

  if (!name || !email || !mobile || !message) {
    return res.status(400).json({ message: "All fields are required." });
  }

  const { error } = await supabase.from("contacts").insert({ name, email, mobile, message });

  if (error) {
    console.error("contact insert error", error);
    return res.status(500).json({ message: "Failed to save contact." });
  }

  return res.status(201).json({ message: "Contact saved successfully." });
});

app.get("/api/contacts", async (req, res) => {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("contacts error", error);
    return res.status(500).json({ message: "Failed to fetch contacts" });
  }

  return res.json(
    data.map((contact) => ({
      _id: contact.id,
      id: contact.id,
      name: contact.name,
      email: contact.email,
      mobile: contact.mobile,
      message: contact.message,
      date: contact.created_at,
      created_at: contact.created_at,
    }))
  );
});

app.post("/api/feedback", async (req, res) => {
  const { name, email, message, rating } = req.body;

  if (!name || !email || !message || !rating) {
    return res.status(400).json({ message: "All fields are required." });
  }

  const { error } = await supabase.from("feedback").insert({
    name,
    email,
    message,
    rating,
  });

  if (error) {
    console.error("feedback insert error", error);
    return res.status(500).json({ message: "Failed to save feedback" });
  }

  return res.status(201).json({ message: "Feedback submitted successfully!" });
});

app.delete("/api/contacts/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("contacts").delete().eq("id", id);

  if (error) {
    console.error("delete contact error", error);
    return res.status(500).json({ message: "Failed to delete contact submission" });
  }

  return res.json({ message: "Contact submission deleted successfully" });
});

app.get("/api/feedback", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("feedback")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("feedback list error", error);
      return res.status(500).json({ message: "Failed to fetch feedback" });
    }

    return res.json(
      data.map((feedback) => ({
        _id: feedback.id,
        id: feedback.id,
        name: feedback.name,
        email: feedback.email,
        message: feedback.message,
        rating: feedback.rating,
        date: feedback.created_at,
        created_at: feedback.created_at,
      }))
    );
  } catch (error) {
    console.error("feedback list error", error);
    if (String(error?.name || error?.message || "").includes("AbortError")) {
      return res.status(200).json([]);
    }

    return res.status(500).json({ message: "Failed to fetch feedback" });
  }
});

// Compatibility route: historically this returned payments.
app.get("/api/bank-details", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list bank-details(payments) error", error);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }

  const rows = Array.isArray(data) ? data : [];
  const mapped = await Promise.all(
    rows.map(async (row) => {
      const payment = mapPaymentRow(row);
      if (payment.screenshotUrl) {
        return payment;
      }

      const supabaseUrl = await resolveSupabaseScreenshotUrlByUtr(row.utr_number);
      if (supabaseUrl) {
        payment.screenshotUrl = supabaseUrl;
      }

      return payment;
    })
  );

  return res.json(mapped);
});

app.post("/api/bank-details", requireAuthenticatedUser, paymentWriteLimiter, async (req, res) => {
  const { name, mobile, amount, utrNumber, email, type, chitsPlan, screenshotBase64, screenshotName } = req.body;

  try {
    if (!enforceBodyMobileOwnership(req, res, "mobile")) {
      return;
    }

    const normalizedMobile = String(mobile || "").trim();
    const normalizedChitPlan = String(chitsPlan || "").trim();
    const paymentAmount = Number(amount);

    if (!name || !normalizedMobile || !paymentAmount || paymentAmount <= 0 || !utrNumber) {
      return res.status(400).json({ message: "Name, mobile, amount and UTR number are required." });
    }

    const { data: existing } = await supabase
      .from("payments")
      .select("id")
      .eq("utr_number", utrNumber)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ message: "UTR number already exists. Please enter a unique UTR number." });
    }

    const screenshotPath = savePaymentScreenshotFromBase64({
      mobile: normalizedMobile,
      utrNumber,
      screenshotBase64,
      screenshotName,
    });

    let supabaseScreenshotUrl = null;
    let screenshotWarning = null;
    try {
      supabaseScreenshotUrl = await uploadPaymentScreenshotToSupabase({
        utrNumber,
        screenshotBase64,
      });
    } catch (uploadError) {
      console.warn("payment screenshot upload skipped", uploadError?.message || uploadError);
      screenshotWarning = uploadError?.message || "Screenshot upload failed";
    }

    const { data, error } = await supabase
      .from("payments")
      .insert({
        name,
        mobile: normalizedMobile,
        amount: paymentAmount,
        utr_number: utrNumber,
        email,
        type,
        chits_plan: normalizedChitPlan,
      })
      .select("*")
      .single();

    if (error) {
      console.error("create payment error", error);
      return res.status(500).json({ message: "Error saving payment details.", error });
    }

    if (screenshotPath || supabaseScreenshotUrl) {
      setPaymentScreenshotPath(data.id, utrNumber, supabaseScreenshotUrl || screenshotPath);
    }

    return res.status(200).json({
      message: "Payment details submitted successfully!",
      payment: mapPaymentRow(data),
      screenshotWarning,
    });
  } catch (error) {
    console.error("create payment exception", error);
    return res.status(500).json({ message: "Error saving payment details.", error });
  }
});

app.post("/api/cashfree/create-order", requireAuthenticatedUser, cashfreeOrderLimiter, async (req, res) => {
  try {
    const { name, email, mobile, amount, chitsPlan, type } = req.body;

    if (!enforceBodyMobileOwnership(req, res, "mobile")) {
      return;
    }

    const normalizedName = String(name || "").trim();
    const normalizedEmail = String(email || "").trim();
    const normalizedMobile = String(mobile || "").replace(/\D/g, "").slice(-10);
    const normalizedChitPlan = String(chitsPlan || "").trim();
    const normalizedType = String(type || "Chit Payment (Cashfree)").trim();
    const orderAmount = Number(amount);

    if (!normalizedName || !normalizedEmail || !normalizedMobile || !orderAmount || orderAmount <= 0) {
      return res.status(400).json({ message: "Name, email, mobile, and amount are required." });
    }

    const orderId = buildCashfreeOrderId(normalizedMobile);
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const requestProto = forwardedProto || String(req.protocol || "").trim() || "https";
    const safeProto = requestProto === "http" ? "https" : requestProto;
    const returnUrl = String(process.env.CASHFREE_RETURN_URL || "").trim()
      || `${safeProto}://${req.get("host")}/chitpayment.html?order_id={order_id}`;
    const notifyUrl = String(process.env.CASHFREE_NOTIFY_URL || "").trim();

    const orderPayload = {
      order_id: orderId,
      order_amount: orderAmount,
      order_currency: "INR",
      customer_details: {
        customer_id: normalizedMobile,
        customer_name: normalizedName,
        customer_email: normalizedEmail,
        customer_phone: normalizedMobile,
      },
      order_meta: {
        return_url: returnUrl,
      },
      order_tags: {
        chits_plan: normalizedChitPlan,
        payment_type: normalizedType,
      },
    };

    if (notifyUrl) {
      orderPayload.order_meta.notify_url = notifyUrl;
    }

    const response = await axios.post(`${CASHFREE_BASE_URL}/pg/orders`, orderPayload, {
      headers: getCashfreeHeaders(),
    });

    return res.json({
      orderId: response.data.order_id,
      paymentSessionId: response.data.payment_session_id,
      cashfreeMode: CASHFREE_MODE,
      amount: response.data.order_amount,
      currency: response.data.order_currency,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || null;
    console.error("cashfree create order error", details || error.message || error);
    return res.status(status).json({
      message: details?.message || "Failed to create Cashfree order",
      error: details,
    });
  }
});

app.post("/api/cashfree/confirm-order", requireAuthenticatedUser, cashfreeConfirmLimiter, async (req, res) => {
  try {
    const { orderId, paymentData } = req.body;
    const normalizedOrderId = String(orderId || "").trim();

    if (!isRequesterAdmin(req)) {
      const paymentMobile = String(paymentData?.mobile || "").trim();
      if (!paymentMobile || normalizeMobile(paymentMobile) !== normalizeMobile(req.session?.user?.mobile)) {
        return res.status(403).json({ message: "Forbidden: mobile ownership mismatch" });
      }
    }

    if (!normalizedOrderId) {
      return res.status(400).json({ message: "orderId is required" });
    }

    const orderRes = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(normalizedOrderId)}`, {
      headers: getCashfreeHeaders(),
    });

    const paymentsRes = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(normalizedOrderId)}/payments`, {
      headers: getCashfreeHeaders(),
    });

    const successfulPayment = findSuccessfulCashfreePayment(paymentsRes.data);

    if (!successfulPayment || String(orderRes.data?.order_status || "").toUpperCase() !== "PAID") {
      return res.status(409).json({
        message: "Payment is not completed yet. Please finish payment and try again.",
        orderStatus: orderRes.data?.order_status,
      });
    }

    let saved;
    try {
      saved = await saveCashfreePaidOrder({
        orderData: orderRes.data,
        successfulPayment,
        paymentData,
        status: "Approved",
      });
    } catch (saveError) {
      console.error("cashfree payment save error", saveError);
      return res.status(500).json({ message: "Payment succeeded but failed to save locally.", error: saveError });
    }

    return res.json({
      message: saved.created ? "Payment successful and saved." : "Payment already recorded",
      payment: saved.payment,
      orderStatus: orderRes.data?.order_status,
      cfPaymentId: saved.cfPaymentId || successfulPayment.cf_payment_id,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || null;
    console.error("cashfree confirm order error", details || error.message || error);
    return res.status(status).json({
      message: details?.message || "Failed to verify Cashfree payment",
      error: details,
    });
  }
});

app.post("/api/cashfree/webhook", cashfreeWebhookLimiter, async (req, res) => {
  try {
    if (!CASHFREE_WEBHOOK_SECRET) {
      return res.status(500).json({ message: "Webhook secret is not configured." });
    }

    if (!verifyCashfreeWebhookSignature(req)) {
      return res.status(401).json({ message: "Invalid webhook signature." });
    }

    const payload = req.body || {};
    const eventType = String(payload?.type || payload?.event || "").toUpperCase();
    const orderId = String(payload?.data?.order?.order_id || payload?.order?.order_id || payload?.order_id || "").trim();
    const paymentStatus = String(payload?.data?.payment?.payment_status || payload?.payment?.payment_status || "").toUpperCase();
    const webhookPaymentId = String(payload?.data?.payment?.cf_payment_id || payload?.payment?.cf_payment_id || "").trim();

    if (!orderId) {
      return res.status(400).json({ message: "order_id missing in webhook payload." });
    }

    if (!eventType.includes("SUCCESS") && paymentStatus !== "SUCCESS") {
      return res.status(200).json({ message: "Webhook received. Event ignored.", eventType, paymentStatus });
    }

    const orderRes = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(orderId)}`, {
      headers: getCashfreeHeaders(),
    });

    const paymentsRes = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: getCashfreeHeaders(),
    });

    const successfulPayment = findSuccessfulCashfreePayment(paymentsRes.data, webhookPaymentId);
    if (!successfulPayment || String(orderRes.data?.order_status || "").toUpperCase() !== "PAID") {
      return res.status(202).json({ message: "Payment not in PAID state yet." });
    }

    const saved = await saveCashfreePaidOrder({
      orderData: orderRes.data,
      successfulPayment,
      paymentData: {},
      status: "Approved",
    });

    return res.status(200).json({
      message: saved.created ? "Webhook payment saved." : "Webhook payment already recorded.",
      orderId,
      utrNumber: saved.utrNumber,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const details = error.response?.data || null;
    console.error("cashfree webhook error", details || error.message || error);
    return res.status(status).json({
      message: details?.message || "Failed to process Cashfree webhook",
      error: details,
    });
  }
});

app.put("/api/bank-details/:id/status", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;
  const rawStatus = String(req.body?.status || "").trim();
  const normalizedStatus = rawStatus.toLowerCase() === "completed" ? "Approved" : rawStatus;

  if (!["Pending", "Approved", "Rejected"].includes(normalizedStatus)) {
    return res.status(400).json({
      message: "Invalid payment status. Use Pending, Approved, or Rejected.",
    });
  }

  const { data: existingPayment, error: existingError } = await supabase
    .from("payments")
    .select("id, status, mobile, chits_plan, amount")
    .eq("id", id)
    .maybeSingle();

  if (existingError) {
    console.error("load payment before status update error", existingError);
    return res.status(500).json({ message: "Failed to update payment status" });
  }

  if (!existingPayment) {
    return res.status(404).json({ message: "Payment not found" });
  }

  const { data, error } = await supabase
    .from("payments")
    .update({ status: normalizedStatus })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("update payment status error", error);
    return res.status(500).json({ message: "Failed to update payment status" });
  }

  if (!data) {
    return res.status(404).json({ message: "Payment not found" });
  }

  if (String(existingPayment.status || "") !== normalizedStatus) {
    await incrementApprovedChitTotalPaid({
      mobile: existingPayment.mobile,
      chitPlan: existingPayment.chits_plan,
    });
  }

  return res.json({ message: "Payment status updated successfully" });
});

app.get("/api/payments", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list payments error", error);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }

  const mappedPayments = data.map(mapPaymentRow);

  const { data: reminderRows, error: reminderError } = await supabase
    .from(paymentRemindersTable)
    .select("*")
    .is("payment_id", null)
    .order("created_at", { ascending: false });

  if (reminderError) {
    console.error("list manual reminders error", reminderError);
    return res.status(500).json({ error: "Failed to fetch reminder records" });
  }

  const manualOnlyReminders = (reminderRows || [])
    .map(normalizeReminderRow)
    .filter(Boolean);

  return res.json([...mappedPayments, ...manualOnlyReminders]);
});

app.get("/api/payment-reminders", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from(paymentRemindersTable)
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list payment reminders error", error);
    return res.status(500).json({ error: "Failed to fetch payment reminders" });
  }

  const reminders = (data || [])
    .map(normalizeReminderRow)
    .filter(Boolean);

  return res.json(reminders);
});

app.get("/api/payment-reminder/pipeline/overview", requireAdmin, async (_req, res) => {
  const state = processDueReminderJobs();
  const jobs = state.jobs || [];
  const notifications = state.notifications || [];

  const counts = {
    queued: jobs.filter((job) => String(job.status || "") === "queued").length,
    scheduled: jobs.filter((job) => String(job.status || "") === "scheduled").length,
    retryPending: jobs.filter((job) => String(job.status || "") === "retry_pending").length,
    sent: jobs.filter((job) => String(job.status || "") === "sent").length,
    failed: jobs.filter((job) => String(job.status || "") === "failed").length,
  };

  return res.json({
    counts,
    notificationsOpen: notifications.filter((item) => item.status === "open").length,
    lastWorkerRunAt: state.lastWorkerRunAt || null,
    recentJobs: jobs.slice(0, 50),
  });
});

app.get("/api/payment-reminder/pipeline/notifications", requireAdmin, (_req, res) => {
  const state = processDueReminderJobs();
  const onlyOpen = String(_req.query?.status || "open").toLowerCase() === "open";
  const data = onlyOpen
    ? state.notifications.filter((item) => String(item.status || "") === "open")
    : state.notifications;

  return res.json(data.slice(0, 100));
});

app.post("/api/payment-reminder/pipeline/notifications/:id/resolve", requireAdmin, (req, res) => {
  const notificationId = String(req.params?.id || "").trim();
  if (!notificationId) {
    return res.status(400).json({ message: "Notification id is required" });
  }

  const state = readReminderPipelineState();
  const notification = state.notifications.find((item) => String(item.id) === notificationId);
  if (!notification) {
    return res.status(404).json({ message: "Notification not found" });
  }

  notification.status = "resolved";
  notification.resolvedAt = new Date().toISOString();
  notification.resolvedBy = req.session?.user?.fullname || req.session?.user?.mobile || "Admin";

  appendReminderAudit(state, {
    actor: req.session?.user?.fullname || req.session?.user?.mobile || "Admin",
    role: req.session?.user?.role || "admin",
    actionType: "notification",
    action: "Notification resolved",
    details: notification.title || "Notification closed",
    status: "success",
    targetMobile: notification.targetMobile,
    targetReminderId: notification.targetReminderId,
    jobId: notification.jobId,
  });

  writeReminderPipelineState(state);
  return res.json({ message: "Notification resolved" });
});

app.post("/api/payment-reminder/pipeline/retry/:jobId", requireAdmin, (req, res) => {
  const jobId = String(req.params?.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ message: "Job id is required" });
  }

  const state = readReminderPipelineState();
  const job = state.jobs.find((item) => String(item.id) === jobId);
  if (!job) {
    return res.status(404).json({ message: "Job not found" });
  }

  job.status = "queued";
  job.scheduledFor = new Date().toISOString();
  job.updatedAt = new Date().toISOString();

  appendReminderAudit(state, {
    actor: req.session?.user?.fullname || req.session?.user?.mobile || "Admin",
    role: req.session?.user?.role || "admin",
    actionType: "retry",
    action: "Retry queued",
    details: `Manual retry queued for ${job.mobile}`,
    status: "success",
    targetMobile: job.mobile,
    targetReminderId: job.reminderId,
    jobId: job.id,
  });

  writeReminderPipelineState(state);
  processDueReminderJobs();
  return res.json({ message: "Retry queued" });
});

app.post("/api/payment-reminder/pipeline/bulk-send", requireAdmin, async (req, res) => {
  const groups = req.body?.groups && typeof req.body.groups === "object"
    ? req.body.groups
    : {};
  const includeAll = Boolean(groups.all);
  const includeDueSoon = Boolean(groups.dueSoon);
  const includePending = Boolean(groups.pending);

  if (!includeAll && !includeDueSoon && !includePending) {
    return res.status(400).json({ message: "Select at least one recipient group" });
  }

  let scheduledFor = new Date().toISOString();
  const rawScheduleDate = String(req.body?.scheduleDate || "").trim();
  const rawScheduleTime = String(req.body?.scheduleTime || "").trim();
  if (rawScheduleDate) {
    const composed = rawScheduleTime
      ? `${rawScheduleDate}T${rawScheduleTime}:00`
      : `${rawScheduleDate}T09:00:00`;
    const parsed = new Date(composed);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ message: "Invalid schedule date/time" });
    }
    scheduledFor = parsed.toISOString();
  }

  const now = new Date();
  const scheduleIsFuture = new Date(scheduledFor).getTime() > now.getTime();

  const { data, error } = await supabase
    .from(paymentRemindersTable)
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("bulk reminder list error", error);
    return res.status(500).json({ message: "Failed to load reminders" });
  }

  const reminders = (data || []).map(normalizeReminderRow).filter(Boolean);
  const selected = reminders.filter((item) => {
    if (String(item.reminderStatus || "").toLowerCase() === "paid") {
      return false;
    }

    const days = reminderDateDiffDays(item.reminderRepaymentDate);
    const isOverdue = days !== null && days < 0;
    const isDueSoon = days !== null && days >= 0 && days <= 7;

    if (includeAll && isOverdue) {
      return true;
    }
    if (includeDueSoon && isDueSoon) {
      return true;
    }
    if (includePending) {
      return true;
    }
    return false;
  });

  if (!selected.length) {
    return res.status(404).json({ message: "No reminders match selected groups" });
  }

  const state = readReminderPipelineState();
  const actor = req.session?.user?.fullname || req.session?.user?.mobile || "Admin";
  const role = req.session?.user?.role || "admin";

  const jobs = selected.map((item) => ({
    id: crypto.randomUUID(),
    reminderId: item.reminderId || item.id || null,
    paymentId: item.id || null,
    mobile: normalizeMobile(item.mobile || ""),
    name: item.name || "Customer",
    message: buildReminderDeliveryMessage(item),
    status: scheduleIsFuture ? "scheduled" : "queued",
    type: scheduleIsFuture ? "scheduled" : "immediate",
    attempts: 0,
    maxAttempts: 3,
    scheduledFor,
    lastAttemptAt: null,
    lastError: null,
    actor,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  state.jobs.unshift(...jobs);
  state.jobs = state.jobs.slice(0, 5000);

  appendReminderAudit(state, {
    actor,
    role,
    actionType: scheduleIsFuture ? "schedule" : "bulk-send",
    action: scheduleIsFuture ? "Bulk reminders scheduled" : "Bulk reminders queued",
    details: `${jobs.length} reminders prepared (${scheduleIsFuture ? "scheduled" : "queued"})`,
    status: "success",
    meta: {
      groups: { all: includeAll, dueSoon: includeDueSoon, pending: includePending },
      scheduledFor,
      jobCount: jobs.length,
    },
  });

  appendReminderNotification(state, {
    type: scheduleIsFuture ? "schedule" : "queue",
    severity: "info",
    title: scheduleIsFuture ? "Reminders scheduled" : "Bulk reminders queued",
    message: `${jobs.length} reminder jobs ${scheduleIsFuture ? "scheduled" : "queued for delivery"}.`,
  });

  const overdueCount = selected.filter((item) => {
    const days = reminderDateDiffDays(item.reminderRepaymentDate);
    return days !== null && days < 0;
  }).length;

  if (overdueCount > 0) {
    appendReminderNotification(state, {
      type: "overdue",
      severity: "warning",
      title: "Overdue escalation",
      message: `${overdueCount} overdue reminders are in pipeline and need close tracking.`,
    });
  }

  writeReminderPipelineState(state);
  if (!scheduleIsFuture) {
    processDueReminderJobs();
  }

  return res.json({
    message: scheduleIsFuture ? "Reminders scheduled successfully" : "Bulk reminders queued successfully",
    queued: jobs.length,
    scheduledFor,
    mode: scheduleIsFuture ? "scheduled" : "immediate",
  });
});

app.get("/api/payment-reminder/pipeline/audit", requireAdmin, (req, res) => {
  const state = readReminderPipelineState();
  const actor = String(req.query?.actor || "").trim().toLowerCase();
  const actionType = String(req.query?.actionType || "").trim().toLowerCase();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const from = String(req.query?.from || "").trim();
  const to = String(req.query?.to || "").trim();

  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  const filtered = state.audits.filter((entry) => {
    const entryActor = String(entry.actor || "").toLowerCase();
    const entryActionType = String(entry.actionType || "").toLowerCase();
    const entryStatus = String(entry.status || "").toLowerCase();
    const entryTime = new Date(entry.createdAt || 0).getTime();

    if (actor && !entryActor.includes(actor)) {
      return false;
    }
    if (actionType && entryActionType !== actionType) {
      return false;
    }
    if (status && entryStatus !== status) {
      return false;
    }
    if (Number.isFinite(fromTime) && entryTime < fromTime) {
      return false;
    }
    if (Number.isFinite(toTime) && entryTime > toTime) {
      return false;
    }

    return true;
  });

  return res.json({
    total: filtered.length,
    data: filtered.slice(0, 1000),
  });
});

app.get("/api/payment-reminder/pipeline/audit/export", requireAdmin, (req, res) => {
  const state = readReminderPipelineState();
  const actor = String(req.query?.actor || "").trim().toLowerCase();
  const actionType = String(req.query?.actionType || "").trim().toLowerCase();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const from = String(req.query?.from || "").trim();
  const to = String(req.query?.to || "").trim();

  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  const filtered = state.audits.filter((entry) => {
    const entryActor = String(entry.actor || "").toLowerCase();
    const entryActionType = String(entry.actionType || "").toLowerCase();
    const entryStatus = String(entry.status || "").toLowerCase();
    const entryTime = new Date(entry.createdAt || 0).getTime();

    if (actor && !entryActor.includes(actor)) {
      return false;
    }
    if (actionType && entryActionType !== actionType) {
      return false;
    }
    if (status && entryStatus !== status) {
      return false;
    }
    if (Number.isFinite(fromTime) && entryTime < fromTime) {
      return false;
    }
    if (Number.isFinite(toTime) && entryTime > toTime) {
      return false;
    }

    return true;
  });

  const header = ["Timestamp", "Actor", "Role", "Action Type", "Action", "Details", "Status", "Target Mobile", "Reminder Id", "Job Id"];
  const rows = filtered.map((entry) => [
    entry.createdAt || "",
    entry.actor || "",
    entry.role || "",
    entry.actionType || "",
    entry.action || "",
    entry.details || "",
    entry.status || "",
    entry.targetMobile || "",
    entry.targetReminderId || "",
    entry.jobId || "",
  ]);

  const toCsvValue = (value) => {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  };

  const csv = [header, ...rows].map((row) => row.map(toCsvValue).join(",")).join("\n");
  const fileName = `reminder-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  return res.send(csv);
});

app.get("/api/lenders", requireAdmin, (_req, res) => {
  const state = readLenderState();
  const items = [...state.lenders].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const pendingJobs = state.jobs.filter((job) => ["queued", "scheduled", "retry_pending"].includes(String(job.status || "").toLowerCase())).length;
  return res.json({
    data: items,
    live: {
      total: items.length,
      queuedJobs: pendingJobs,
      workerLastRunAt: state.lastWorkerRunAt || null,
    },
  });
});

app.get("/api/lenders/audit", requireAdmin, (req, res) => {
  const state = readLenderState();
  const actionType = String(req.query?.actionType || "").trim().toLowerCase();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const actor = String(req.query?.actor || "").trim().toLowerCase();
  const filtered = state.audits.filter((entry) => {
    if (actionType && String(entry.actionType || "").toLowerCase() !== actionType) return false;
    if (status && String(entry.status || "").toLowerCase() !== status) return false;
    if (actor && !String(entry.actor || "").toLowerCase().includes(actor)) return false;
    return true;
  });
  return res.json({ total: filtered.length, data: filtered.slice(0, 1000) });
});

app.get("/api/lenders/reminders/jobs", requireAdmin, (req, res) => {
  const state = readLenderState();
  const status = String(req.query?.status || "").trim().toLowerCase();
  const jobs = status
    ? state.jobs.filter((job) => String(job.status || "").toLowerCase() === status)
    : state.jobs;
  return res.json({ total: jobs.length, data: jobs.slice(0, 1000) });
});

app.post("/api/lenders", requireAdmin, (req, res) => {
  const parsed = sanitizeLenderPayload(req.body || {});
  if (parsed.error) {
    return res.status(400).json({ message: parsed.error });
  }

  const state = readLenderState();
  const { actor, role } = lenderActorFromReq(req);
  const nowIso = new Date().toISOString();
  const lender = {
    id: crypto.randomUUID(),
    ...parsed.data,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  state.lenders.unshift(lender);
  appendLenderAudit(state, {
    actor,
    role,
    actionType: "create",
    action: "Lender created",
    details: `Created lender ${lender.name}`,
    status: "success",
    lenderId: lender.id,
    targetMobile: lender.mobile,
  });
  writeLenderState(state);
  return res.status(201).json({ message: "Lender created", lender });
});

app.put("/api/lenders/:id", requireAdmin, (req, res) => {
  const parsed = sanitizeLenderPayload(req.body || {});
  if (parsed.error) {
    return res.status(400).json({ message: parsed.error });
  }

  const state = readLenderState();
  const idx = state.lenders.findIndex((item) => String(item.id) === String(req.params.id));
  if (idx < 0) {
    return res.status(404).json({ message: "Lender not found" });
  }

  const { actor, role } = lenderActorFromReq(req);
  const updated = {
    ...state.lenders[idx],
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  };
  state.lenders[idx] = updated;
  appendLenderAudit(state, {
    actor,
    role,
    actionType: "update",
    action: "Lender updated",
    details: `Updated lender ${updated.name}`,
    status: "success",
    lenderId: updated.id,
    targetMobile: updated.mobile,
  });
  writeLenderState(state);
  return res.json({ message: "Lender updated", lender: updated });
});

app.delete("/api/lenders/:id", requireAdmin, (req, res) => {
  const state = readLenderState();
  const idx = state.lenders.findIndex((item) => String(item.id) === String(req.params.id));
  if (idx < 0) {
    return res.status(404).json({ message: "Lender not found" });
  }

  const { actor, role } = lenderActorFromReq(req);
  const removed = state.lenders[idx];
  state.lenders.splice(idx, 1);
  state.jobs = state.jobs.filter((job) => String(job.lenderId) !== String(removed.id));
  appendLenderAudit(state, {
    actor,
    role,
    actionType: "delete",
    action: "Lender deleted",
    details: `Deleted lender ${removed.name}`,
    status: "success",
    lenderId: removed.id,
    targetMobile: removed.mobile,
  });
  writeLenderState(state);
  return res.json({ message: "Lender deleted" });
});

app.post("/api/lenders/:id/reminders/schedule", requireAdmin, async (req, res) => {
  const state = readLenderState();
  const lender = state.lenders.find((item) => String(item.id) === String(req.params.id));
  if (!lender) {
    return res.status(404).json({ message: "Lender not found" });
  }

  const { actor, role } = lenderActorFromReq(req);
  const scheduleDate = String(req.body?.scheduleDate || "").trim();
  const scheduleTime = String(req.body?.scheduleTime || "").trim();
  const templateType = normalizeLenderTemplateType(req.body?.templateType || req.body?.template || "standard");
  const templateVariables = normalizeLenderTemplateVariables(req.body?.templateVariables);
  const scheduledFor = parseLenderScheduleDateTime(scheduleDate, scheduleTime);
  if (!scheduledFor) {
    return res.status(400).json({ message: "Invalid schedule date/time" });
  }

  const isFuture = new Date(scheduledFor).getTime() > Date.now();
  const message = buildLenderReminderMessage(lender, templateType, templateVariables);
  const job = {
    id: crypto.randomUUID(),
    lenderId: lender.id,
    name: lender.name,
    mobile: lender.mobile,
    message,
    template: templateType,
    templateType,
    templateVariables,
    status: isFuture ? "scheduled" : "queued",
    type: isFuture ? "scheduled" : "immediate",
    attempts: 0,
    maxAttempts: 3,
    scheduledFor,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actor,
  };

  state.jobs.unshift(job);
  appendLenderAudit(state, {
    actor,
    role,
    actionType: isFuture ? "schedule" : "queue",
    action: isFuture ? "Lender reminder scheduled" : "Lender reminder queued",
    details: `${lender.name} reminder ${isFuture ? "scheduled" : "queued"} for ${scheduledFor}`,
    status: "success",
    lenderId: lender.id,
    targetMobile: lender.mobile,
    jobId: job.id,
    meta: { template: job.template, templateVariables: job.templateVariables, scheduledFor },
  });
  writeLenderState(state);

  if (!isFuture) {
    await processDueLenderJobs();
  }

  return res.json({
    message: isFuture ? "Lender reminder scheduled" : "Lender reminder queued",
    job,
  });
});

app.post("/api/lenders/reminders/:jobId/retry", requireAdmin, async (req, res) => {
  const state = readLenderState();
  const job = state.jobs.find((item) => String(item.id) === String(req.params.jobId));
  if (!job) {
    return res.status(404).json({ message: "Reminder job not found" });
  }

  const { actor, role } = lenderActorFromReq(req);
  job.status = "queued";
  job.lastError = null;
  job.scheduledFor = new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  appendLenderAudit(state, {
    actor,
    role,
    actionType: "retry",
    action: "Lender reminder retry queued",
    details: `Retry requested for job ${job.id}`,
    status: "success",
    lenderId: job.lenderId,
    targetMobile: job.mobile,
    jobId: job.id,
  });
  writeLenderState(state);
  await processDueLenderJobs();
  return res.json({ message: "Retry queued", job });
});

app.get("/api/payments/:mobile", requireAuthenticatedUser, requireOwnerOrAdminForMobileParam("mobile"), async (req, res) => {
  const { mobile } = req.params;

  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .eq("mobile", mobile)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list payments by mobile error", error);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }

  return res.json(data.map(mapPaymentRow));
});

app.put("/api/payments/:id/reminder", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;
  const rawReminder = String(req.body?.reminderNote || "").trim();
  const rawBorrowDate = String(req.body?.borrowDate || "").trim();
  const rawRepaymentDate = String(req.body?.repaymentDate || "").trim();
  const rawMobile = String(req.body?.mobile || "").trim();
  const rawName = String(req.body?.name || "").trim();
  const rawReminderStatus = String(req.body?.reminderStatus || "").trim().toLowerCase();
  const rawPaidAt = String(req.body?.paidAt || "").trim();
  const rawAmount = req.body?.reminderAmount;
  const rawInterest = req.body?.reminderInterest;

  if (rawReminder.length > 500) {
    return res.status(400).json({ message: "Reminder note should be 500 characters or less." });
  }

  const borrowDate = rawBorrowDate || null;
  const repaymentDate = rawRepaymentDate || null;

  if (borrowDate && Number.isNaN(Date.parse(borrowDate))) {
    return res.status(400).json({ message: "Invalid borrow date." });
  }

  if (repaymentDate && Number.isNaN(Date.parse(repaymentDate))) {
    return res.status(400).json({ message: "Invalid repayment date." });
  }

  if (borrowDate && repaymentDate && repaymentDate < borrowDate) {
    return res.status(400).json({ message: "Repayment date cannot be before borrow date." });
  }

  const reminderAmount = normalizeReminderNumber(rawAmount, { snapNearInteger: true });
  const reminderInterest = normalizeReminderNumber(rawInterest);

  if (reminderAmount !== null && (!Number.isFinite(reminderAmount) || reminderAmount < 0)) {
    return res.status(400).json({ message: "Reminder amount must be a valid number." });
  }

  if (reminderInterest !== null && (!Number.isFinite(reminderInterest) || reminderInterest < 0)) {
    return res.status(400).json({ message: "Interest must be a valid number." });
  }

  // Try to find existing payment record
  const paymentQuery = supabase
    .from("payments")
    .select("*");

  const record = String(id || "").trim().length === 36
    ? await paymentQuery.eq("id", id).maybeSingle()
    : await paymentQuery.eq("mobile", normalizeMobile(rawMobile || id)).order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (record.error) {
    console.error("resolve payment reminder target error", record.error);
    return res.status(500).json({ message: "Failed to load payment record" });
  }

  // If payment exists, use it; otherwise allow manual-only reminder
  const paymentRecord = record.data;
  const targetMobile = normalizeMobile(rawMobile || paymentRecord?.mobile || "");
  const targetId = paymentRecord?.id || null;

  if (!targetMobile) {
    return res.status(400).json({ message: "Mobile number is required for manual reminders." });
  }

  const reminderNote = rawReminder || [
    borrowDate ? `Borrow Date: ${borrowDate}` : "",
    repaymentDate ? `Repayment Date: ${repaymentDate}` : "",
    reminderAmount !== null ? `Amount: ${reminderAmount}` : "",
    reminderInterest !== null ? `Interest: ${reminderInterest}%` : "",
  ].filter(Boolean).join(", ");

  const reminderData = reminderNote
    ? buildReminderPayload({
        note: reminderNote,
        borrowDate,
        repaymentDate,
        reminderAmount,
        reminderInterest,
        name: rawName,
        reminderStatus: rawReminderStatus === "paid" ? "paid" : "manual",
        paidAt: rawReminderStatus === "paid" ? (rawPaidAt || new Date().toISOString()) : null,
      })
    : null;

  const nextPaymentStatus = !reminderData
    ? "Approved"
    : String(reminderData.reminderStatus || "").toLowerCase() === "paid"
      ? "paid-reminder"
      : "manual-reminder";

  try {
    if (paymentRecord) {
      const updatedPayment = await syncReminderColumnsOnPayment(targetId, reminderData, nextPaymentStatus);

      if (reminderData) {
        if (String(reminderData.reminderStatus || "").toLowerCase() === "paid") {
          await clearPaymentReminderRows({ mobile: targetMobile });
        } else {
          await clearPaymentReminderRows({ paymentId: targetId, mobile: targetMobile });
        }

        await upsertPaymentReminderRow({
          paymentId: targetId,
          mobile: targetMobile,
          name: rawName || paymentRecord.name,
          reminderData,
        });
      } else {
        await clearPaymentReminderRows({ paymentId: targetId, mobile: targetMobile });
      }

      return res.json({
        message: reminderData ? "Reminder note saved successfully" : "Reminder note cleared successfully",
        payment: mapPaymentRow(updatedPayment || paymentRecord),
      });
    }

    if (!reminderData) {
      const manualReminderId = String(id || "").trim().length === 36 ? String(id).trim() : null;
      await clearPaymentReminderRows({ reminderId: manualReminderId, mobile: targetMobile });
      return res.json({
        message: "Reminder cleared successfully",
        payment: {
          id: `manual-${targetMobile}`,
          name: rawName,
          mobile: targetMobile,
          status: "manual-reminder",
          chitsPlan: "N/A",
          reminderNote: "",
          reminderBorrowDate: null,
          reminderRepaymentDate: null,
          reminderAmount: null,
          reminderInterest: null,
          reminderStatus: "manual",
          reminderPaidAt: null,
        },
      });
    }

    const manualReminderRow = await upsertPaymentReminderRow({
      paymentId: null,
      mobile: targetMobile,
      name: rawName,
      reminderData,
    });

    return res.json({
      message: "Reminder saved successfully",
      payment: normalizeReminderRow(manualReminderRow),
    });
  } catch (error) {
    console.error("save reminder error", error);
    return res.status(500).json({ message: "Failed to save reminder" });
  }
});

app.delete("/api/payments/:id", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("payments").delete().eq("id", id);

  if (error) {
    console.error("delete payment error", error);
    return res.status(500).json({ message: "Failed to delete payment" });
  }

  return res.json({ message: "Payment deleted successfully" });
});

app.post("/api/bank-details/:id/send-statement", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;

  const { data: payment, error } = await supabase
    .from("payments")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("send statement query error", error);
    return res.status(500).json({ message: "Failed to load payment" });
  }

  if (!payment) {
    return res.status(404).json({ message: "Payment not found" });
  }

  try {
    await sendStatementEmail(payment);
    return res.json({ message: "Statement sent successfully" });
  } catch (sendError) {
    console.error("send statement error", sendError);
    const message = sendError.message || "Failed to send statement";
    const statusCode = /Email config missing|not configured/i.test(message) ? 400 : 500;
    return res.status(statusCode).json({ message });
  }
});

app.post("/api/payments/send-statements/:mobile", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { mobile } = req.params;
  const { data: payments, error } = await supabase.from("payments").select("*").eq("mobile", mobile);

  if (error) {
    console.error("send statements query error", error);
    return res.status(500).json({ message: "Failed to load payments" });
  }

  if (!payments || payments.length === 0) {
    return res.status(404).json({ message: "No payments found for this mobile" });
  }

  try {
    for (const payment of payments) {
      await sendStatementEmail(payment);
    }

    return res.json({ message: "All statements sent successfully" });
  } catch (sendError) {
    console.error("send all statements error", sendError);
    const message = sendError.message || "Failed to send statements";
    const statusCode = /Email config missing|not configured/i.test(message) ? 400 : 500;
    return res.status(statusCode).json({ message });
  }
});

app.post("/api/bank-detail", requireAuthenticatedUser, paymentWriteLimiter, async (req, res) => {
  const { name, accountNumber, ifscCode, upiId, bankName, mobile } = req.body;

  try {
    if (!enforceBodyMobileOwnership(req, res, "mobile")) {
      return;
    }

    const payload = {
      name,
      account_number: accountNumber,
      ifsc_code: ifscCode,
      upi_id: upiId,
      bank_name: bankName,
      mobile,
    };

    const { error } = await supabase.from("bank_details").upsert(payload, { onConflict: "mobile" });
    if (error) {
      console.error("upsert bank detail error", error);
      return res.status(500).json({ message: "Error saving bank details.", error });
    }

    return res.json({ message: "Bank details submitted successfully!" });
  } catch (error) {
    console.error("upsert bank detail exception", error);
    return res.status(500).json({ message: "Error saving bank details.", error });
  }
});

app.get("/api/bank-details/:mobile", requireAuthenticatedUser, requireOwnerOrAdminForMobileParam("mobile"), async (req, res) => {
  const { mobile } = req.params;

  const { data, error } = await supabase
    .from("bank_details")
    .select("*")
    .eq("mobile", mobile)
    .limit(1);

  if (error) {
    console.error("get bank details by mobile error", error);
    return res.status(500).json({ error: "Failed to fetch bank details" });
  }

  if (!data || data.length === 0) {
    return res.json([]);
  }

  return res.json([mapBankDetailRow(data[0])]);
});

app.get("/api/bankdetails", requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from("bank_details")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list bank details error", error);
    return res.status(500).json({ error: "Failed to fetch bank details" });
  }

  return res.json(data.map(mapBankDetailRow));
});

app.put("/api/bank-details/:id", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;
  const { name, accountNumber, ifscCode, upiId, bankName, mobile } = req.body;

  const { data, error } = await supabase
    .from("bank_details")
    .update({
      name,
      account_number: accountNumber,
      ifsc_code: ifscCode,
      upi_id: upiId,
      bank_name: bankName,
      mobile,
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("update bank detail error", error);
    return res.status(500).json({ message: "Failed to update bank detail", error });
  }

  if (!data) {
    return res.status(404).json({ message: "Bank detail not found" });
  }

  return res.json({ message: "Bank details updated successfully", bankDetail: mapBankDetailRow(data) });
});

app.delete("/api/bank-details/:id", requireAdmin, paymentAdminActionLimiter, async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("bank_details")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("delete bank detail error", error);
    return res.status(500).json({ message: "Failed to delete bank detail", error });
  }

  if (!data) {
    return res.status(404).json({ message: "Bank detail not found" });
  }

  return res.json({ message: "Bank detail deleted successfully" });
});

app.post("/api/borrow", runBorrowDocsUpload, async (req, res) => {
  const { fullname, email, mobile, amount, status } = req.body;
  const uploadedPaths = {
    aadhaarDocumentPath: getBorrowUploadedPath(req.files, "aadhaarDocument"),
    panDocumentPath: getBorrowUploadedPath(req.files, "panDocument"),
    rcDocumentPath: getBorrowUploadedPath(req.files, "rcDocument"),
  };

  const borrowPayload = {
    fullname,
    email,
    mobile,
    amount,
    status: status || "Pending",
    aadhaar_document_path: uploadedPaths.aadhaarDocumentPath,
    pan_document_path: uploadedPaths.panDocumentPath,
    rc_document_path: uploadedPaths.rcDocumentPath,
  };

  let insertData = null;
  let insertError = null;
  ({ data: insertData, error: insertError } = await supabase
    .from("borrows")
    .insert(borrowPayload)
    .select("id")
    .maybeSingle());

  let usedFallbackInsert = false;
  if (isBorrowDocColumnMissing(insertError)) {
    usedFallbackInsert = true;
    const fallbackPayload = {
      fullname,
      email,
      mobile,
      amount,
      status: status || "Pending",
    };
    ({ data: insertData, error: insertError } = await supabase
      .from("borrows")
      .insert(fallbackPayload)
      .select("id")
      .maybeSingle());
  }

  if (insertError) {
    cleanupBorrowUploads(req.files);
    console.error("create borrow error", insertError);
    return res.status(500).json({ error: "Failed to submit borrow request" });
  }

  if (usedFallbackInsert) {
    setBorrowDocumentPaths(insertData?.id, uploadedPaths);
  }

  return res.status(201).json({ message: "Borrow request submitted successfully!" });
});

app.get("/api/borrows", async (_req, res) => {
  const { data, error } = await supabase
    .from("borrows")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list borrows error", error);
    return res.status(500).json({ error: "Failed to fetch borrows" });
  }

  return res.json(data.map(mapBorrowRow));
});

app.get("/api/borrow-history/:mobile", async (req, res) => {
  const { mobile } = req.params;

  const { data, error } = await supabase
    .from("borrows")
    .select("*")
    .eq("mobile", mobile)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("borrow history error", error);
    return res.status(500).json({ error: "Failed to fetch borrow history" });
  }

  return res.json(data.map(mapBorrowRow));
});

app.put("/api/borrow/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { data, error } = await supabase
    .from("borrows")
    .update({ status })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("update borrow status error", error);
    return res.status(500).json({ message: "Failed to update borrow status" });
  }

  if (!data) {
    return res.status(404).json({ message: "Borrow entry not found" });
  }

  return res.json({ message: "Borrow status updated successfully" });
});

app.delete("/api/borrow/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("borrows")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("delete borrow error", error);
    return res.status(500).send("Internal Server Error");
  }

  if (!data) {
    return res.status(404).send("Borrow entry not found");
  }

  return res.status(200).send("Borrow entry deleted successfully");
});

app.get("/api/chit-ids", async (_req, res) => {
  const { data, error } = await supabase
    .from("chit_ids")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list chit ids error", error);
    return res.status(500).json({ message: "Failed to fetch Chit ID details" });
  }

  return res.status(200).json(data.map(mapChitRow));
});

app.get("/api/chit-ids/mobile/:mobile", async (req, res) => {
  const { mobile } = req.params;

  const { data, error } = await supabase
    .from("chit_ids")
    .select("*")
    .eq("mobile", mobile)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("chit ids by mobile error", error);
    return res.status(500).json({ message: "Failed to fetch Chit ID details" });
  }

  if (!data || data.length === 0) {
    return res.status(404).json({ message: "No Chit IDs found for this mobile number" });
  }

  return res.status(200).json(data.map(mapChitRow));
});

app.get("/api/chit-ids/:chitId", async (req, res) => {
  const { chitId } = req.params;

  const { data, error } = await supabase
    .from("chit_ids")
    .select("*")
    .eq("chit_id", chitId)
    .maybeSingle();

  if (error) {
    console.error("chit by id error", error);
    return res.status(500).json({ message: "Failed to fetch Chit ID details" });
  }

  if (!data) {
    return res.status(404).json({ message: "Chit ID not found" });
  }

  return res.status(200).json(mapChitRow(data));
});

app.post("/api/chit-ids", async (req, res) => {
  const { chitId, email, name, mobile, month } = req.body;

  const { data, error } = await supabase
    .from("chit_ids")
    .insert({
      chit_id: chitId,
      email,
      name,
      mobile,
      month,
    })
    .select("*")
    .single();

  if (error) {
    console.error("create chit id error", error);
    return res.status(500).json({ message: "Failed to submit Chit ID" });
  }

  return res.status(201).json({ message: "Chit ID submitted successfully", chit: mapChitRow(data) });
});

app.post("/api/chit-ids/approve", async (req, res) => {
  const { chitId, totalBalance, totalPaid } = req.body;

  const { data, error } = await supabase
    .from("chit_ids")
    .update({
      status: "Approved",
      total_balance: totalBalance,
      total_paid: totalPaid,
    })
    .eq("chit_id", chitId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("approve chit id error", error);
    return res.status(500).json({ message: "Failed to approve Chit ID" });
  }

  if (!data) {
    return res.status(404).json({ message: "Chit ID not found" });
  }

  return res.status(200).json({ message: "Chit ID approved successfully" });
});

app.put("/api/chit-ids/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, totalBalance, totalPaid } = req.body;

  const { data, error } = await supabase
    .from("chit_ids")
    .update({
      status,
      total_balance: totalBalance,
      total_paid: totalPaid,
    })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("update chit status error", error);
    return res.status(500).json({ message: "Failed to update Chit ID status" });
  }

  if (!data) {
    return res.status(404).json({ message: "Chit ID not found" });
  }

  return res.status(200).json({ message: "Chit ID status updated successfully" });
});

app.delete("/api/chit-ids/:id", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("chit_ids")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("delete chit id error", error);
    return res.status(500).json({ message: "Failed to delete Chit ID" });
  }

  if (!data) {
    return res.status(404).json({ message: "Chit ID not found" });
  }

  return res.status(200).json({ message: "Chit ID deleted successfully" });
});

app.get("/api/chat/threads", async (req, res) => {
  const requesterMobile = String(req.query.requesterMobile || "").trim();
  const requesterIsAdmin = await isAdminMobile(requesterMobile);

  if (!requesterIsAdmin) {
    return res.status(403).json({ message: "Only admins can view chat threads" });
  }

  const { data, error } = await supabase
    .from("auction_chat_messages")
    .select("mobile, sender_name, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      return res.json(listAuctionChatThreadsFallback());
    }

    console.error("chat threads error", error);
    return res.status(500).json({ message: "Failed to fetch chat threads" });
  }

  const seen = new Set();
  const threads = [];
  for (const row of data || []) {
    const mobile = String(row.mobile || "").trim();
    if (!mobile || seen.has(mobile)) {
      continue;
    }

    seen.add(mobile);
    threads.push({
      mobile,
      lastSenderName: row.sender_name || "",
      lastMessageAt: row.created_at,
    });
  }

  return res.json(threads);
});

app.get("/api/chat/messages/:mobile", async (req, res) => {
  const targetMobile = String(req.params.mobile || "").trim();
  const requesterMobile = String(req.query.requesterMobile || "").trim();
  const requesterIsAdmin = await isAdminMobile(requesterMobile);

  if (!targetMobile) {
    return res.status(400).json({ message: "Mobile is required" });
  }

  if (!requesterIsAdmin && requesterMobile !== targetMobile) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("auction_chat_messages")
    .select("*")
    .eq("mobile", targetMobile)
    .order("created_at", { ascending: true });

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      return res.json(listAuctionChatMessagesFallback(targetMobile).map(mapAuctionChatRow));
    }

    console.error("chat messages error", error);
    return res.status(500).json({ message: "Failed to fetch chat messages" });
  }

  return res.json((data || []).map(mapAuctionChatRow));
});

app.post("/api/chat/messages", async (req, res) => {
  const { mobile, senderName, message, requesterMobile, topic } = req.body;
  const normalizedMobile = String(mobile || "").trim();
  const normalizedSenderName = String(senderName || "").trim();
  const normalizedMessage = String(message || "").trim();
  const normalizedRequesterMobile = String(requesterMobile || "").trim();
  const normalizedTopic = String(topic || "Chit Auction Lift").trim();

  if (!normalizedMobile || !normalizedMessage || !normalizedRequesterMobile) {
    return res.status(400).json({ message: "Mobile, requesterMobile, and message are required" });
  }

  const requesterIsAdmin = await isAdminMobile(normalizedRequesterMobile);
  if (!requesterIsAdmin && normalizedRequesterMobile !== normalizedMobile) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const senderRole = requesterIsAdmin ? "admin" : "user";

  const { data, error } = await supabase
    .from("auction_chat_messages")
    .insert({
      mobile: normalizedMobile,
      sender_role: senderRole,
      sender_name: normalizedSenderName || (senderRole === "admin" ? "Admin" : "Member"),
      message: normalizedMessage,
      topic: normalizedTopic,
    })
    .select("*")
    .single();

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      const fallbackRow = insertAuctionChatFallback({
        mobile: normalizedMobile,
        senderRole,
        senderName: normalizedSenderName || (senderRole === "admin" ? "Admin" : "Member"),
        message: normalizedMessage,
        topic: normalizedTopic,
      });
      return res.status(201).json(mapAuctionChatRow(fallbackRow));
    }

    console.error("create chat message error", error);
    return res.status(500).json({ message: "Failed to send message" });
  }

  return res.status(201).json(mapAuctionChatRow(data));
});

app.delete("/api/chat/messages/:id", async (req, res) => {
  const messageId = String(req.params.id || "").trim();
  const requesterMobile = String(req.query.requesterMobile || "").trim();
  const requesterIsAdmin = await isAdminMobile(requesterMobile);

  if (!requesterIsAdmin) {
    return res.status(403).json({ message: "Only admins can delete messages" });
  }

  if (!messageId) {
    return res.status(400).json({ message: "Message id is required" });
  }

  const { data, error } = await supabase
    .from("auction_chat_messages")
    .delete()
    .eq("id", messageId)
    .select("*")
    .maybeSingle();

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      const fallbackDeleted = deleteAuctionChatMessageFallback(messageId);
      if (!fallbackDeleted) {
        return res.status(404).json({ message: "Message not found" });
      }
      return res.json({ message: "Message deleted successfully" });
    }

    console.error("delete chat message error", error);
    return res.status(500).json({ message: "Failed to delete message" });
  }

  if (!data) {
    return res.status(404).json({ message: "Message not found" });
  }

  return res.json({ message: "Message deleted successfully" });
});

app.post("/api/chat/polls", async (req, res) => {
  const { mobile, requesterMobile, senderName, question, options, topic } = req.body;
  const normalizedMobile = String(mobile || "").trim();
  const normalizedRequesterMobile = String(requesterMobile || "").trim();
  const normalizedSenderName = String(senderName || "Admin").trim();
  const normalizedTopic = String(topic || "Chit Auction Lift").trim();
  const requesterIsAdmin = await isAdminMobile(normalizedRequesterMobile);

  if (!requesterIsAdmin) {
    return res.status(403).json({ message: "Only admins can create polls" });
  }

  if (!normalizedMobile) {
    return res.status(400).json({ message: "Target mobile is required" });
  }

  const pollPayload = createPollPayload({ question, options, createdBy: normalizedSenderName || "Admin" });
  if (!pollPayload.question || pollPayload.options.length < 2) {
    return res.status(400).json({ message: "Poll question and at least 2 options are required" });
  }

  const encodedPoll = encodePollMessage(pollPayload);
  const { data, error } = await supabase
    .from("auction_chat_messages")
    .insert({
      mobile: normalizedMobile,
      sender_role: "admin",
      sender_name: normalizedSenderName || "Admin",
      message: encodedPoll,
      topic: normalizedTopic,
    })
    .select("*")
    .single();

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      const fallbackRow = insertAuctionChatFallback({
        mobile: normalizedMobile,
        senderRole: "admin",
        senderName: normalizedSenderName || "Admin",
        message: encodedPoll,
        topic: normalizedTopic,
      });
      return res.status(201).json(mapAuctionChatRow(fallbackRow));
    }

    console.error("create poll error", error);
    return res.status(500).json({ message: "Failed to create poll" });
  }

  return res.status(201).json(mapAuctionChatRow(data));
});

app.post("/api/chat/polls/:pollId/react", async (req, res) => {
  const pollId = String(req.params.pollId || "").trim();
  const { mobile, requesterMobile, optionId } = req.body;
  const normalizedMobile = String(mobile || "").trim();
  const normalizedRequesterMobile = String(requesterMobile || "").trim();
  const normalizedOptionId = String(optionId || "").trim();

  if (!pollId || !normalizedMobile || !normalizedRequesterMobile || !normalizedOptionId) {
    return res.status(400).json({ message: "pollId, mobile, requesterMobile and optionId are required" });
  }

  const requesterIsAdmin = await isAdminMobile(normalizedRequesterMobile);
  if (!requesterIsAdmin && normalizedRequesterMobile !== normalizedMobile) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { data, error } = await supabase
    .from("auction_chat_messages")
    .select("*")
    .eq("mobile", normalizedMobile)
    .order("created_at", { ascending: true });

  if (error) {
    if (isAuctionChatTableMissing(error)) {
      const fallbackMessages = listAuctionChatMessagesFallback(normalizedMobile);
      const targetFallback = fallbackMessages.find((row) => parsePollFromMessage(row.message)?.pollId === pollId);
      if (!targetFallback) {
        return res.status(404).json({ message: "Poll not found" });
      }

      const updatedFallbackRow = updateAuctionChatMessageFallback(targetFallback.id, (row) => {
        const parsed = parsePollFromMessage(row.message);
        if (!parsed || parsed.pollId !== pollId) {
          return null;
        }

        const updatedPoll = reactToPollPayload(parsed, normalizedOptionId, normalizedRequesterMobile);
        if (!updatedPoll) {
          return null;
        }

        return {
          ...row,
          message: encodePollMessage(updatedPoll),
        };
      });

      if (!updatedFallbackRow) {
        return res.status(400).json({ message: "Invalid poll option" });
      }

      return res.json(mapAuctionChatRow(updatedFallbackRow));
    }

    console.error("poll reaction query error", error);
    return res.status(500).json({ message: "Failed to react to poll" });
  }

  const targetRow = (data || []).find((row) => parsePollFromMessage(row.message)?.pollId === pollId);
  if (!targetRow) {
    return res.status(404).json({ message: "Poll not found" });
  }

  const parsedPoll = parsePollFromMessage(targetRow.message);
  const updatedPoll = reactToPollPayload(parsedPoll, normalizedOptionId, normalizedRequesterMobile);
  if (!updatedPoll) {
    return res.status(400).json({ message: "Invalid poll option" });
  }

  const { data: updatedData, error: updateError } = await supabase
    .from("auction_chat_messages")
    .update({ message: encodePollMessage(updatedPoll) })
    .eq("id", targetRow.id)
    .select("*")
    .single();

  if (updateError) {
    console.error("poll reaction update error", updateError);
    return res.status(500).json({ message: "Failed to react to poll" });
  }

  return res.json(mapAuctionChatRow(updatedData));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, backend: "supabase" });
});

if (process.env.VERCEL !== "1") {
  startReminderPipelineWorker();
  startLenderPipelineWorker();
  app.listen(PORT, () => {
    console.log(`Supabase backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

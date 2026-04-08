require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pdf = require("pdfkit");
const multer = require("multer");
const supabase = require("./supabaseClient");

const app = express();
const PORT = Number(process.env.SUPABASE_PORT || 5000);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  return next();
}

async function requireAdminFlexible(req, res, next) {
  if (req.session.user && req.session.user.role === "admin") {
    return next();
  }

  const mobileFromHeader = req.headers["x-user-mobile"];
  const mobileFromQuery = req.query?.mobile;
  const mobileFromBody = req.body?.mobile;
  const mobile = String(mobileFromHeader || mobileFromQuery || mobileFromBody || "").trim();

  if (!mobile) {
    return res.status(403).json({ message: "Forbidden" });
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, role")
      .eq("mobile", mobile)
      .maybeSingle();

    if (error) {
      console.error("admin auth lookup error", error);
      return res.status(500).json({ message: "Failed to authorize admin user" });
    }

    if (!data || data.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }

    return next();
  } catch (error) {
    console.error("admin auth error", error);
    return res.status(500).json({ message: "Failed to authorize admin user" });
  }
}

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

async function incrementApprovedChitTotalPaid({ mobile, chitPlan, amount }) {
  const normalizedMobile = String(mobile || "").trim();
  const normalizedChitPlan = String(chitPlan || "").trim();
  const paymentAmount = Number(amount);

  if (!normalizedMobile || !normalizedChitPlan || !paymentAmount || paymentAmount <= 0) {
    return;
  }

  let approvedChit = null;

  const { data: matchedChits, error: chitLookupError } = await supabase
    .from("chit_ids")
    .select("id, total_paid")
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
      .select("id, total_paid")
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

  const currentPaid = Number(approvedChit.total_paid) || 0;
  const updatedTotalPaid = currentPaid + paymentAmount;

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
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    mobile: row.mobile,
    amount: row.amount,
    utrNumber: row.utr_number,
    email: row.email,
    type: row.type,
    chitsPlan: row.chits_plan,
    status: row.status,
    created_at: row.created_at,
  };
}

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
const auctionChatFallbackPath = path.join(storageBaseDir, "uploads", "auction-chat-fallback.json");
try {
  if (!fs.existsSync(invoicesDir)) {
    fs.mkdirSync(invoicesDir, { recursive: true });
  }
  if (!fs.existsSync(borrowDocsDir)) {
    fs.mkdirSync(borrowDocsDir, { recursive: true });
  }
} catch (dirError) {
  console.error("Failed to prepare invoices directory:", dirError);
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
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "Logout failed. Try again." });
    }
    res.clearCookie("connect.sid");
    return res.status(200).json({ message: "Logout successful." });
  });
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
});

// Compatibility route: historically this returned payments.
app.get("/api/bank-details", async (_req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list bank-details(payments) error", error);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }

  return res.json(data.map(mapPaymentRow));
});

app.post("/api/bank-details", async (req, res) => {
  const { name, mobile, amount, utrNumber, email, type, chitsPlan } = req.body;

  try {
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

    await incrementApprovedChitTotalPaid({
      mobile: normalizedMobile,
      chitPlan: normalizedChitPlan,
      amount: paymentAmount,
    });

    return res.status(200).json({
      message: "Payment details submitted successfully!",
      payment: mapPaymentRow(data),
    });
  } catch (error) {
    console.error("create payment exception", error);
    return res.status(500).json({ message: "Error saving payment details.", error });
  }
});

app.post("/api/cashfree/create-order", async (req, res) => {
  try {
    const { name, email, mobile, amount, chitsPlan, type } = req.body;
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

app.post("/api/cashfree/confirm-order", async (req, res) => {
  try {
    const { orderId, paymentData } = req.body;
    const normalizedOrderId = String(orderId || "").trim();

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

app.post("/api/cashfree/webhook", async (req, res) => {
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

app.put("/api/bank-details/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { data, error } = await supabase
    .from("payments")
    .update({ status })
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

  return res.json({ message: "Payment status updated successfully" });
});

app.get("/api/payments", async (_req, res) => {
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("list payments error", error);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }

  return res.json(data.map(mapPaymentRow));
});

app.get("/api/payments/:mobile", async (req, res) => {
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

app.delete("/api/payments/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("payments").delete().eq("id", id);

  if (error) {
    console.error("delete payment error", error);
    return res.status(500).json({ message: "Failed to delete payment" });
  }

  return res.json({ message: "Payment deleted successfully" });
});

app.post("/api/bank-details/:id/send-statement", async (req, res) => {
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

app.post("/api/payments/send-statements/:mobile", async (req, res) => {
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

app.post("/api/bank-detail", async (req, res) => {
  const { name, accountNumber, ifscCode, upiId, bankName, mobile } = req.body;

  try {
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

app.get("/api/bank-details/:mobile", async (req, res) => {
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

app.get("/api/bankdetails", async (_req, res) => {
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

app.put("/api/bank-details/:id", async (req, res) => {
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
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("update bank detail error", error);
    return res.status(500).json({ message: "Failed to update bank detail" });
  }

  if (!data) {
    return res.status(404).json({ message: "Bank detail not found" });
  }

  return res.json({ message: "Bank detail updated successfully" });
});

app.delete("/api/bank-details/:id", async (req, res) => {
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
  app.listen(PORT, () => {
    console.log(`Supabase backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

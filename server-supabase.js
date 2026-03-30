require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const pdf = require("pdfkit");
const supabase = require("./supabaseClient");

const app = express();
const PORT = Number(process.env.SUPABASE_PORT || 5000);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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
  return {
    _id: row.id,
    id: row.id,
    fullname: row.fullname,
    email: row.email,
    mobile: row.mobile,
    amount: row.amount,
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

const invoicesDir = path.join(__dirname, "invoices");
if (!fs.existsSync(invoicesDir)) {
  fs.mkdirSync(invoicesDir, { recursive: true });
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

app.post("/register", async (req, res) => {
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
});

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

    return res.status(200).json({ message: "Login successful!", user: req.session.user });
  } catch (error) {
    console.error("login error", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

app.post("/login", loginHandler);

app.post("/Login", loginHandler);

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ message: "Logout failed. Try again." });
    }
    res.clearCookie("connect.sid");
    return res.status(200).json({ message: "Logout successful." });
  });
});

app.get("/api/users", requireAdmin, async (req, res) => {
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

app.put("/api/users/:id/password", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "Password is required" });
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from("users").update({ password_hash }).eq("id", id);

  if (error) {
    console.error("change password error", error);
    return res.status(500).json({ message: "Failed to change password" });
  }

  return res.json({ message: "Password changed successfully" });
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
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

app.delete("/submissions/:id", async (req, res) => {
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
    if (!name || !mobile || !amount || !utrNumber) {
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
        mobile,
        amount,
        utr_number: utrNumber,
        email,
        type,
        chits_plan: chitsPlan,
      })
      .select("*")
      .single();

    if (error) {
      console.error("create payment error", error);
      return res.status(500).json({ message: "Error saving payment details.", error });
    }

    return res.status(200).json({
      message: "Payment details submitted successfully!",
      payment: mapPaymentRow(data),
    });
  } catch (error) {
    console.error("create payment exception", error);
    return res.status(500).json({ message: "Error saving payment details.", error });
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

app.post("/api/borrow", async (req, res) => {
  const { fullname, email, mobile, amount, status } = req.body;
  const { error } = await supabase.from("borrows").insert({
    fullname,
    email,
    mobile,
    amount,
    status: status || "Pending",
  });

  if (error) {
    console.error("create borrow error", error);
    return res.status(500).json({ error: "Failed to submit borrow request" });
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, backend: "supabase" });
});

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Supabase backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

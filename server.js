require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const connectDB = require('./db');
const nodemailer = require('nodemailer');
const fs = require('fs');
const pdf = require('pdfkit');


const app = express();
// Middleware
app.use(cors());
app.use(bodyParser.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
}));

const PORT = process.env.PORT || 5001;
const CASHFREE_MODE = String(process.env.CASHFREE_ENV || 'sandbox').trim().toLowerCase() === 'production'
    ? 'production'
    : 'sandbox';
const CASHFREE_BASE_URL = CASHFREE_MODE === 'production'
    ? 'https://api.cashfree.com'
    : 'https://sandbox.cashfree.com';
const CASHFREE_WEBHOOK_SECRET = String(
    process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY || ''
).trim();

// Service charge calculation endpoint (moved below app initialization)
app.post('/api/cashfree/service-charge', (req, res) => {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Invalid amount.' });
    }
    // 0.25% service charge
    const serviceCharge = Math.round((amount * 0.0050) * 100) / 100;
    const total = Math.round((amount + serviceCharge) * 100) / 100;
    res.json({ serviceCharge, total });
});

const getCashfreeHeaders = () => {
    const appId = String(process.env.CASHFREE_APP_ID || '').trim();
    const secretKey = String(process.env.CASHFREE_SECRET_KEY || '').trim();

    if (!appId || !secretKey) {
        throw new Error('Cashfree credentials are missing. Configure CASHFREE_APP_ID and CASHFREE_SECRET_KEY.');
    }

    return {
        'x-client-id': appId,
        'x-client-secret': secretKey,
        'x-api-version': '2023-08-01',
        'content-type': 'application/json'
    };
};

const buildCashfreeOrderId = (mobile) => {
    const normalizedMobile = String(mobile || '').replace(/\D/g, '').slice(-10) || 'guest';
    return `CHIT_${Date.now()}_${normalizedMobile}_${Math.random().toString(16).slice(2, 6)}`;
};

const getCashfreeWebhookSignature = (req) => String(
    req.headers['x-webhook-signature']
    || req.headers['x-cf-signature']
    || req.headers['x-cashfree-signature']
    || ''
).trim();

const safeSignatureMatch = (provided, expected) => {
    if (!provided || !expected) {
        return false;
    }

    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

const verifyCashfreeWebhookSignature = (req) => {
    if (!CASHFREE_WEBHOOK_SECRET) {
        return false;
    }

    const signatureHeader = getCashfreeWebhookSignature(req);
    if (!signatureHeader) {
        return false;
    }

    const signature = signatureHeader.replace(/^sha256=/i, '').trim();
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const timestamp = String(req.headers['x-webhook-timestamp'] || req.headers['x-cf-timestamp'] || '').trim();

    const candidates = [
        crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(rawBody).digest('hex'),
        crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(rawBody).digest('base64'),
    ];

    if (timestamp) {
        candidates.push(crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(`${timestamp}${rawBody}`).digest('hex'));
        candidates.push(crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET).update(`${timestamp}${rawBody}`).digest('base64'));
    }

    return candidates.some((expected) => safeSignatureMatch(signature, expected));
};

const findSuccessfulCashfreePayment = (paymentsPayload, preferredPaymentId = '') => {
    const preferredId = String(preferredPaymentId || '').trim();
    const rows = Array.isArray(paymentsPayload)
        ? paymentsPayload
        : Array.isArray(paymentsPayload?.data)
            ? paymentsPayload.data
            : [];

    const successRows = rows.filter((item) => String(item?.payment_status || '').toUpperCase() === 'SUCCESS');
    if (successRows.length === 0) {
        return null;
    }

    if (preferredId) {
        const exact = successRows.find((item) => String(item?.cf_payment_id || '').trim() === preferredId);
        if (exact) {
            return exact;
        }
    }

    return successRows[0];
};

// Middleware
app.use(cors());
app.use(bodyParser.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
    }
}));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
connectDB();

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'shekarchandra99311@gmail.com',
        pass: 'xyxq owea zryq xfyt'
    }
});

// Function to send email
const sendEmail = (to, subject, text) => {
    const mailOptions = {
        from: 'shekarchandra99311@gmail.com',
        to,
        subject,
        text
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Error sending email:', error);
        } else {
            console.log('Email sent:', info.response);
        }
    });
};

// Function to send payment confirmation email to user and admin
const sendPaymentConfirmation = (userEmail, userName, mobile, amount, utrNumber, type, chitsPlan, invoicePath) => {
    const userSubject = 'Payment Confirmation';
    const userText = `Dear ${userName}, your payment of ${amount} has been received. UTR Number: ${utrNumber}. Payment Type: ${type}. Chit ID: ${chitsPlan}`;
    const userMailOptions = {
        from: 'shekarchandra99311@gmail.com',
        to: userEmail,
        subject: userSubject,
        text: userText,
        attachments: [
            {
                filename: 'invoice.pdf',
                path: invoicePath
            }
        ]
    };

    transporter.sendMail(userMailOptions, (error, info) => {
        if (error) {
            console.error('Error sending email to user:', error);
        } else {
            console.log('Email sent to user:', info.response);
        }
    });

    const adminSubject = 'New Payment Received';
    const adminText = `Name: ${userName}\nEmail: ${userEmail}\nMobile: ${mobile}\nAmount: ${amount}\nUTR Number: ${utrNumber}\nPayment Type: ${type}\nChit ID: ${chitsPlan}`;
    sendEmail('shekarchandra99311@gmail.com', adminSubject, adminText);
};

// Ensure the invoices directory exists
const invoicesDir = path.join(__dirname, 'invoices');
if (!fs.existsSync(invoicesDir)) {
    fs.mkdirSync(invoicesDir, { recursive: true });
}

// Function to generate invoice PDF
const generateInvoice = (payment) => {
    const doc = new pdf();
    const filePath = path.join(invoicesDir, `${payment._id}.pdf`);
    const writeStream = fs.createWriteStream(filePath);

    writeStream.on('error', (err) => {
        console.error('Error writing invoice:', err);
    });

    doc.pipe(writeStream);

    // Add company name and details with black color
    doc.rect(0, 0, doc.page.width, 50).fill('#003366'); // Dark blue header background
    doc.fillColor('#000000').fontSize(20).text('Dhanam Chits Pvt. Ltd', 0, 15, { align: 'center' }); // Black color for company name
    doc.fillColor('#000000').fontSize(12).text('1234 Chits Street, Business City, Country', 0, 35, { align: 'center' }); // Black color for address
    doc.fillColor('#000000').fontSize(12).text('Phone: +123 456 7890 | Email: info@dhanamchits.com', 0, 50, { align: 'center' }); // Black color for contact details
    doc.moveDown(2);

    doc.fillColor('#003366').fontSize(16).text('Invoice', { align: 'center' });
    doc.moveDown();

    // Add payment details with colors
    doc.fillColor('#000000').fontSize(14).text(`Invoice ID: ${payment._id}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();
    doc.fillColor('#000000').fontSize(14).text(`Name: ${payment.name}`);
    doc.text(`Mobile: ${payment.mobile}`);
    doc.text(`Email: ${payment.email}`);
    doc.text(`Chit Plan: ${payment.chitsPlan}`);
    doc.moveDown();
    doc.fillColor('#000000').fontSize(14).text('Payment Details:');
    doc.text(`Amount: ${payment.amount}`);
    doc.text(`UTR Number: ${payment.utrNumber}`);
    doc.text(`Payment Type: ${payment.type}`);
    doc.end();

    console.log(`Invoice generated at: ${filePath}`);
    return filePath;
};

// Function to generate and send statement
const sendStatement = async (paymentId) => {
    try {
        const payment = await Payment.findById(paymentId);
        if (!payment) {
            throw new Error('Payment not found');
        }

        const doc = new pdf();
        const filePath = path.join(invoicesDir, `${payment._id}-statement.pdf`);
        const writeStream = fs.createWriteStream(filePath);

        writeStream.on('error', (err) => {
            console.error('Error writing statement:', err);
        });

        doc.pipe(writeStream);

        // Add company name and details with black color
        doc.rect(0, 0, doc.page.width, 50).fill('#003366'); // Dark blue header background
        doc.fillColor('#000000').fontSize(20).text('Dhanam Chits Pvt. Ltd', 0, 15, { align: 'center' }); // Black color for company name
        doc.fillColor('#000000').fontSize(12).text('1234 Chits Street, Business City, Country', 0, 35, { align: 'center' }); // Black color for address
        doc.fillColor('#000000').fontSize(12).text('Phone: +123 456 7890 | Email: info@dhanamchits.com', 0, 50, { align: 'center' }); // Black color for contact details
        doc.moveDown(2);

        doc.fillColor('#003366').fontSize(16).text('Statement', { align: 'center' });
        doc.moveDown();

        // Add payment details with colors
        doc.fillColor('#000000').fontSize(14).text(`Statement ID: ${payment._id}`);
        doc.text(`Date: ${new Date().toLocaleDateString()}`);
        doc.moveDown();
        doc.fillColor('#000000').fontSize(14).text(`Name: ${payment.name}`);
        doc.text(`Mobile: ${payment.mobile}`);
        doc.text(`Email: ${payment.email}`);
        doc.text(`Chit Plan: ${payment.chitsPlan}`);
        doc.moveDown();
        doc.fillColor('#000000').fontSize(14).text('Payment Details:');
        doc.text(`Amount: ${payment.amount}`);
        doc.text(`UTR Number: ${payment.utrNumber}`);
        doc.text(`Payment Type: ${payment.type}`);
        doc.end();

        console.log(`Statement generated at: ${filePath}`);

        // Send statement via email
        const userSubject = 'Payment Statement';
        const userText = `Dear ${payment.name}, please find attached your payment statement.`;
        const userMailOptions = {
            from: 'shekarchandra99311@gmail.com',
            to: payment.email,
            subject: userSubject,
            text: userText,
            attachments: [
                {
                    filename: 'statement.pdf',
                    path: filePath
                }
            ]
        };

        transporter.sendMail(userMailOptions, (error, info) => {
            if (error) {
                console.error('Error sending statement to user:', error);
            } else {
                console.log('Statement sent to user:', info.response);
            }
        });
    } catch (error) {
        console.error('Error generating or sending statement:', error);
    }
};

// Define a Submission schema
const submissionSchema = new mongoose.Schema({
    name: String,
    phone: String,
    email: String,
    chitsPlan: String,
    amount: Number,
    utrNumber: String,
});

// Create a Submission model
const Submission = mongoose.model('Submission', submissionSchema);

// Get all submissions
app.get('/submissions', async (req, res) => {
    try {
        const submissions = await Submission.find();
        res.json(submissions);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch submissions' });
    }
});

// Add a new submission
app.post('/submissions', async (req, res) => {
    const { utrNumber } = req.body;

    try {
        // Check if UTR number is unique
        const existingSubmission = await Submission.findOne({ utrNumber });
        if (existingSubmission) {
            return res.status(400).json({ error: 'UTR number already exists. Please use a unique UTR number.' });
        }

        const newSubmission = new Submission(req.body);
        await newSubmission.save();
        res.status(201).json(newSubmission);
    } catch (err) {
        res.status(400).json({ error: 'Failed to create submission' });
    }
});

// Define a Payment schema
const paymentSchema = new mongoose.Schema({
    name: String,
    mobile: String,
    amount: Number,
    utrNumber: String,
    email: String,
    type: String,
    chitsPlan: String,
    status: { type: String, default: 'Pending' },
    reminderNote: { type: String, default: '' },
    reminderBorrowDate: { type: String, default: null },
    reminderRepaymentDate: { type: String, default: null },
    reminderAmount: { type: Number, default: null },
    reminderInterest: { type: Number, default: null },
    reminderTotalAmount: { type: Number, default: null },
    reminderStatus: { type: String, default: null },
    reminderPaidAt: { type: String, default: null }
});

// Create a Payment model
const Payment = mongoose.model('Payment', paymentSchema);

const uploadsDir = path.join(__dirname, 'uploads');
const reminderPipelineStatePath = path.join(uploadsDir, 'reminder-pipeline-state.json');
const lenderStatePath = path.join(uploadsDir, 'lenders-state.json');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const normalizeMobile = (value) => String(value || '').replace(/\D/g, '').slice(-10);

const toNumberOrNull = (value, { snapNearInteger = false } = {}) => {
    if (value === '' || value === null || value === undefined) {
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
};

const getRoleFromRequest = (req) => String(
    req.headers['x-user-role']
    || req.headers['x-actor-role']
    || req.body?.actorRole
    || ''
).trim().toLowerCase();

const getActorNameFromRequest = (req) => String(
    req.headers['x-user-name']
    || req.headers['x-actor-name']
    || req.body?.actor
    || 'Admin User'
).trim() || 'Admin User';

const requireAdminRole = (req, res, next) => {
    const role = getRoleFromRequest(req);
    if (role !== 'admin') {
        return res.status(403).json({ message: 'Admin access required' });
    }
    return next();
};

const defaultLenderState = () => ({
    lenders: [],
    audits: [],
    jobs: [],
    notifications: [],
    lastAutoSchedulerRunAt: null,
    lastWorkerRunAt: null,
});

const readLenderState = () => {
    try {
        if (!fs.existsSync(lenderStatePath)) {
            return defaultLenderState();
        }
        const parsed = JSON.parse(fs.readFileSync(lenderStatePath, 'utf8'));
        return {
            lenders: Array.isArray(parsed?.lenders) ? parsed.lenders : [],
            audits: Array.isArray(parsed?.audits) ? parsed.audits : [],
            jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
            notifications: Array.isArray(parsed?.notifications) ? parsed.notifications : [],
            lastAutoSchedulerRunAt: parsed?.lastAutoSchedulerRunAt || null,
            lastWorkerRunAt: parsed?.lastWorkerRunAt || null,
        };
    } catch (_error) {
        return defaultLenderState();
    }
};

const writeLenderState = (state) => {
    try {
        fs.writeFileSync(lenderStatePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('Failed to write lender state:', error);
    }
};

const pushLenderAudit = (state, {
    actor = 'System',
    role = 'system',
    actionType = 'lender',
    action = 'Lender event',
    details = '',
    status = 'success',
    lenderId = null,
    targetMobile = null,
    jobId = null,
    meta = null,
}) => {
    state.audits.unshift({
        id: crypto.randomUUID(),
        actor,
        role,
        actionType,
        action,
        details,
        status,
        lenderId,
        targetMobile,
        jobId,
        createdAt: new Date().toISOString(),
        meta: meta && typeof meta === 'object' ? meta : null,
    });
    state.audits = state.audits.slice(0, 1500);
};

const pushLenderNotification = (state, {
    type = 'lender',
    title = 'Lender update',
    message = '',
    severity = 'info',
    action = null,
    lenderId = null,
    targetMobile = null,
    jobId = null,
}) => {
    state.notifications.unshift({
        id: crypto.randomUUID(),
        type,
        title,
        message,
        severity,
        action: action && typeof action === 'object' ? action : null,
        lenderId,
        targetMobile,
        jobId,
        status: 'open',
        createdAt: new Date().toISOString(),
    });
    state.notifications = state.notifications.slice(0, 600);
};

const sanitizeLenderPayload = (payload = {}) => {
    const principal = toNumberOrNull(payload.principal, { snapNearInteger: true });
    const interestRate = toNumberOrNull(payload.interestRate) ?? 0;
    const dueDate = String(payload.dueDate || '').trim();
    const lendDate = String(payload.lendDate || '').trim();

    if (!String(payload.name || '').trim()) {
        return { error: 'Lender name is required' };
    }
    const mobile = normalizeMobile(payload.mobile || '');
    if (!mobile || mobile.length !== 10) {
        return { error: 'Valid 10-digit mobile is required' };
    }
    if (!Number.isFinite(principal) || principal <= 0) {
        return { error: 'Principal must be greater than 0' };
    }
    if (!Number.isFinite(interestRate) || interestRate < 0) {
        return { error: 'Interest rate must be 0 or higher' };
    }
    if (lendDate && Number.isNaN(Date.parse(lendDate))) {
        return { error: 'Invalid lend date' };
    }
    if (dueDate && Number.isNaN(Date.parse(dueDate))) {
        return { error: 'Invalid due date' };
    }
    if (lendDate && dueDate && dueDate < lendDate) {
        return { error: 'Due date cannot be before lend date' };
    }

    const repaymentCycle = String(payload.repaymentCycle || 'monthly').trim().toLowerCase() || 'monthly';
    const status = String(payload.status || 'active').trim().toLowerCase() === 'closed' ? 'closed' : 'active';

    return {
        data: {
            name: String(payload.name || '').trim(),
            mobile,
            principal,
            interestRate,
            lendDate: lendDate || '',
            dueDate: dueDate || '',
            repaymentCycle,
            status,
            notes: String(payload.notes || '').trim().slice(0, 500),
        }
    };
};

const normalizeLenderTemplateType = (value) => {
    const normalized = String(value || 'standard').trim().toLowerCase();
    return ['standard', 'urgent', 'appointment', 'order', 'verification'].includes(normalized)
        ? normalized
        : 'standard';
};

const normalizeLenderTemplateVariables = (variables) => {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
        return {};
    }

    return Object.entries(variables).reduce((acc, [key, value]) => {
        const normalizedKey = String(key || '').trim();
        const normalizedValue = String(value || '').trim();
        if (!normalizedKey || !normalizedValue) {
            return acc;
        }
        if (!/^\d+$/.test(normalizedKey)) {
            return acc;
        }
        acc[normalizedKey] = normalizedValue;
        return acc;
    }, {});
};

const getTwilioContentSidForTemplate = (templateType) => {
    const normalized = normalizeLenderTemplateType(templateType);
    const map = {
        standard: process.env.TWILIO_CONTENT_SID_STANDARD,
        urgent: process.env.TWILIO_CONTENT_SID_URGENT,
        appointment: process.env.TWILIO_CONTENT_SID_APPOINTMENT,
        order: process.env.TWILIO_CONTENT_SID_ORDER,
        verification: process.env.TWILIO_CONTENT_SID_VERIFICATION,
    };
    return String(map[normalized] || process.env.TWILIO_CONTENT_SID_DEFAULT || '').trim();
};

const buildCashfreePaymentLink = (amount, customerId, description = '') => {
    const orderId = buildCashfreeOrderId(customerId);
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const returnUrl = String(process.env.CASHFREE_RETURN_URL || '').trim() || `${protocol}://localhost:5001/chitpayment.html?order_id={order_id}`;
    const safeReturnUrl = returnUrl.replace('{order_id}', encodeURIComponent(orderId));
    return {
        orderId,
        paymentUrl: `${CASHFREE_BASE_URL}/pg/orders`,
        returnUrl: safeReturnUrl,
        displayLink: `💳 Pay via Cashfree: ${safeReturnUrl.split('?')[0]}?order_id=${orderId}`
    };
};

const buildLenderReminderMessage = (lender, template = 'standard', templateVariables = {}) => {
    const templateType = normalizeLenderTemplateType(template);
    const vars = normalizeLenderTemplateVariables(templateVariables);
    const principal = Number(lender?.principal || 0);
    const interestRate = Number(lender?.interestRate || 0);
    const interestAmount = Math.round((((principal * interestRate) / 100) + Number.EPSILON) * 100) / 100;
    const totalAmount = Math.round(((principal + interestAmount) + Number.EPSILON) * 100) / 100;

    if (templateType === 'appointment') {
        const appointmentDate = vars['1'] || lender?.dueDate || 'Not set';
        const appointmentTime = vars['2'] || 'Not set';
        return [
            `Dear ${lender?.name || 'Customer'},`,
            '',
            `Your appointment is coming up on ${appointmentDate} at ${appointmentTime}.`,
            'If you need to change it, please reply back and let us know.'
        ].join('\n');
    }

    if (templateType === 'order') {
        const orderId = vars['1'] || lender?.id || '-';
        const orderStatus = vars['2'] || 'Processing';
        return [
            `Dear ${lender?.name || 'Customer'},`,
            '',
            `Order update for ${orderId}: ${orderStatus}.`,
            `Outstanding amount: Rs. ${totalAmount}.`,
            'Thank you.'
        ].join('\n');
    }

    if (templateType === 'verification') {
        const code = vars['1'] || '000000';
        return [
            `Dear ${lender?.name || 'Customer'},`,
            '',
            `Your verification code is ${code}.`,
            'Do not share this code with anyone.'
        ].join('\n');
    }

    if (templateType === 'urgent') {
        const paymentLink = buildCashfreePaymentLink(totalAmount, lender?.mobile || lender?.id || '', `Urgent payment for ${lender?.name}`);
        return [
            `Dear ${lender?.name || 'Lender'},`,
            '',
            'Urgent reminder: payment is pending.',
            `Principal: Rs. ${principal}`,
            `Interest: ${interestRate}% (Rs. ${interestAmount})`,
            `Total payable: Rs. ${totalAmount}`,
            `Due date: ${lender?.dueDate || 'Not set'}`,
            '',
            paymentLink.displayLink,
            '',
            'Please settle immediately.'
        ].join('\n');
    }

    const paymentLink = buildCashfreePaymentLink(totalAmount, lender?.mobile || lender?.id || '', `Payment for ${lender?.name}`);
    return [
        `Dear ${lender?.name || 'Lender'},`,
        '',
        'This is your scheduled payment reminder.',
        `Principal: Rs. ${principal}`,
        `Interest: ${interestRate}% (Rs. ${interestAmount})`,
        `Total payable: Rs. ${totalAmount}`,
        `Due date: ${lender?.dueDate || 'Not set'}`,
        '',
        paymentLink.displayLink,
        '',
        'Thank you.'
    ].join('\n');
};

const parseScheduleDateTime = (scheduleDate, scheduleTime) => {
    const rawDate = String(scheduleDate || '').trim();
    const rawTime = String(scheduleTime || '').trim();
    if (!rawDate) {
        return new Date().toISOString();
    }
    const composed = rawTime ? `${rawDate}T${rawTime}:00` : `${rawDate}T09:00:00`;
    const parsed = new Date(composed);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }
    return parsed.toISOString();
};

const lenderDaysUntilDue = (dueDate) => {
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
};

const withCountryCode = (mobile) => {
    const digits = normalizeMobile(mobile);
    if (!digits) {
        return '';
    }
    return digits.length === 10 ? `91${digits}` : digits;
};

const getWhatsAppProviderOrder = () => {
    const rawOrder = String(process.env.WHATSAPP_PROVIDER_ORDER || process.env.WHATSAPP_PROVIDER_SEQUENCE || '').trim().toLowerCase();
    const parsedOrder = rawOrder
        ? rawOrder.split(/[,\s|]+/).map((item) => item.trim()).filter((item) => ['meta', 'twilio'].includes(item))
        : [];
    if (parsedOrder.length) {
        return [...new Set(parsedOrder)];
    }

    const provider = String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
    if (provider === 'meta' || provider === 'twilio') {
        return [provider];
    }

    return ['meta', 'twilio'];
};

const sendLenderWhatsAppViaMeta = async ({ normalizedMobile, message, waLink }) => {
    const phoneNumberId = String(process.env.WHATSAPP_META_PHONE_NUMBER_ID || '').trim();
    const accessToken = String(process.env.WHATSAPP_META_ACCESS_TOKEN || '').trim();
    if (!phoneNumberId || !accessToken) {
        return { ok: false, error: 'Meta WhatsApp credentials missing', shareUrl: waLink };
    }

    try {
        const response = await axios.post(
            `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: normalizedMobile,
                type: 'text',
                text: { body: String(message || '') },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            }
        );
        const messageId = response?.data?.messages?.[0]?.id || null;
        return { ok: true, provider: 'meta', messageId, shareUrl: waLink };
    } catch (error) {
        const errorText = error?.response?.data?.error?.message || error.message || 'Meta send failed';
        return { ok: false, error: errorText, shareUrl: waLink };
    }
};

const sendLenderWhatsAppViaTwilio = async ({ normalizedMobile, message, waLink, templateType = 'standard', templateVariables = {} }) => {
    const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
    const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
    const from = String(process.env.TWILIO_WHATSAPP_FROM || '').trim();
    if (!sid || !token || !from) {
        return { ok: false, error: 'Twilio WhatsApp credentials missing', shareUrl: waLink };
    }

    const payload = new URLSearchParams();
    payload.append('To', `whatsapp:+${normalizedMobile}`);
    payload.append('From', `whatsapp:${from.startsWith('+') ? from : `+${from}`}`);
    const contentSid = getTwilioContentSidForTemplate(templateType);
    const normalizedVariables = normalizeLenderTemplateVariables(templateVariables);
    if (contentSid) {
        payload.append('ContentSid', contentSid);
        payload.append('ContentVariables', JSON.stringify(normalizedVariables));
    } else {
        payload.append('Body', String(message || ''));
    }

    try {
        const response = await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
            payload.toString(),
            {
                auth: { username: sid, password: token },
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000,
            }
        );
        return {
            ok: true,
            provider: 'twilio',
            messageId: response?.data?.sid || null,
            shareUrl: waLink,
            contentSid: contentSid || null,
        };
    } catch (error) {
        const errorText = error?.response?.data?.message || error.message || 'Twilio send failed';
        return { ok: false, error: errorText, shareUrl: waLink };
    }
};

const sendLenderWhatsAppReminder = async ({ mobile, message, templateType = 'standard', templateVariables = {} }) => {
    const normalizedMobile = withCountryCode(mobile);
    if (!normalizedMobile || normalizedMobile.length < 12) {
        return { ok: false, error: 'Invalid mobile number' };
    }

    const waLink = `https://wa.me/${normalizedMobile}?text=${encodeURIComponent(String(message || ''))}`;

    const providerOrder = getWhatsAppProviderOrder();
    const attempts = [];

    for (const provider of providerOrder) {
        const delivery = provider === 'meta'
            ? await sendLenderWhatsAppViaMeta({ normalizedMobile, message, waLink })
            : await sendLenderWhatsAppViaTwilio({ normalizedMobile, message, waLink, templateType, templateVariables });

        if (delivery.ok) {
            return delivery;
        }

        attempts.push(`${provider}: ${delivery.error || 'failed'}`);
    }

    return {
        ok: false,
        error: attempts.length
            ? `WhatsApp delivery failed (${attempts.join(' | ')})`
            : 'WhatsApp provider not configured. Set WHATSAPP_PROVIDER=meta|twilio or WHATSAPP_PROVIDER_ORDER=meta,twilio',
        shareUrl: waLink,
    };
};

const runDailyLenderAutoScheduler = (state) => {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (String(state.lastAutoSchedulerRunAt || '') === todayKey) {
        return 0;
    }

    let created = 0;
    state.lenders.forEach((lender) => {
        if (String(lender.status || '').toLowerCase() === 'closed') {
            return;
        }
        const days = lenderDaysUntilDue(lender.dueDate);
        if (days !== 2) {
            return;
        }

        const autoRuleKey = `${lender.id}:${lender.dueDate}:d-2`;
        const alreadyQueued = state.jobs.some((job) => {
            const sameRule = String(job?.meta?.autoRuleKey || '') === autoRuleKey;
            const status = String(job.status || '').toLowerCase();
            return sameRule && ['queued', 'scheduled', 'retry_pending', 'sent'].includes(status);
        });
        if (alreadyQueued) {
            return;
        }

        state.jobs.unshift({
            id: crypto.randomUUID(),
            lenderId: lender.id,
            name: lender.name,
            mobile: lender.mobile,
            message: buildLenderReminderMessage(lender, 'standard'),
            template: 'standard',
            status: 'queued',
            type: 'auto-due-minus-2',
            attempts: 0,
            maxAttempts: 3,
            scheduledFor: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            actor: 'Auto Scheduler',
            meta: { autoRuleKey, daysBeforeDue: 2, dueDate: lender.dueDate },
        });
        created += 1;
    });

    state.lastAutoSchedulerRunAt = todayKey;
    if (created > 0) {
        pushLenderAudit(state, {
            actor: 'Auto Scheduler',
            role: 'system',
            actionType: 'auto-schedule',
            action: 'Daily auto scheduler queued reminders',
            details: `${created} reminders queued for lenders due in 2 days`,
            status: 'success',
            meta: { daysBeforeDue: 2, count: created },
        });
    }
    return created;
};

const processLenderReminderJobs = async () => {
    const state = readLenderState();
    runDailyLenderAutoScheduler(state);
    const now = Date.now();
    const dueJobs = state.jobs.filter((job) => {
        const status = String(job.status || '').toLowerCase();
        if (!['queued', 'scheduled', 'retry_pending'].includes(status)) {
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
            templateType: job.templateType || job.template || 'standard',
            templateVariables: job.templateVariables || {},
        });

        if (delivery.ok) {
            job.status = 'sent';
            job.lastError = null;
            job.provider = delivery.provider || null;
            job.providerMessageId = delivery.messageId || null;
            job.contentSid = delivery.contentSid || null;
            job.shareUrl = delivery.shareUrl || null;
            job.updatedAt = nowIso;
            pushLenderAudit(state, {
                actor: 'Scheduler',
                role: 'system',
                actionType: 'schedule',
                action: 'Scheduled lender reminder sent',
                details: `Reminder sent via ${delivery.provider || 'provider'} for ${job.mobile}`,
                status: 'success',
                lenderId: job.lenderId,
                targetMobile: job.mobile,
                jobId: job.id,
                meta: { provider: delivery.provider || null, providerMessageId: delivery.messageId || null },
            });
            continue;
        }

        job.lastError = delivery.error || 'Provider delivery failed';
        job.shareUrl = delivery.shareUrl || null;
        if (job.attempts < Number(job.maxAttempts || 3)) {
            job.status = 'retry_pending';
            job.scheduledFor = new Date(Date.now() + (5 * 60 * 1000)).toISOString();
        } else {
            job.status = 'failed';
        }
        job.updatedAt = nowIso;

        pushLenderAudit(state, {
            actor: 'Scheduler',
            role: 'system',
            actionType: 'schedule',
            action: 'Scheduled lender reminder failed',
            details: `${job.lastError} for ${job.mobile}`,
            status: 'failed',
            lenderId: job.lenderId,
            targetMobile: job.mobile,
            jobId: job.id,
        });
        pushLenderNotification(state, {
            type: 'delivery',
            severity: 'error',
            title: 'Lender reminder failed',
            message: `Could not process lender reminder for ${job.name || job.mobile}`,
            action: { type: 'retry', jobId: job.id, label: 'Retry now' },
            lenderId: job.lenderId,
            targetMobile: job.mobile,
            jobId: job.id,
        });
    }

    state.lastWorkerRunAt = new Date().toISOString();
    writeLenderState(state);
    return state;
};

let lenderReminderWorker = null;
const startLenderReminderWorker = () => {
    if (lenderReminderWorker) {
        return;
    }
    lenderReminderWorker = setInterval(() => {
        processLenderReminderJobs().catch((error) => {
            console.error('Lender reminder worker error:', error);
        });
    }, 20000);
};

const defaultReminderPipelineState = () => ({
    manualReminders: [],
    jobs: [],
    notifications: [],
    audits: [],
    lastWorkerRunAt: null,
});

const readReminderPipelineState = () => {
    try {
        if (!fs.existsSync(reminderPipelineStatePath)) {
            return defaultReminderPipelineState();
        }
        const parsed = JSON.parse(fs.readFileSync(reminderPipelineStatePath, 'utf8'));
        return {
            manualReminders: Array.isArray(parsed?.manualReminders) ? parsed.manualReminders : [],
            jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
            notifications: Array.isArray(parsed?.notifications) ? parsed.notifications : [],
            audits: Array.isArray(parsed?.audits) ? parsed.audits : [],
            lastWorkerRunAt: parsed?.lastWorkerRunAt || null,
        };
    } catch (_error) {
        return defaultReminderPipelineState();
    }
};

const writeReminderPipelineState = (state) => {
    try {
        fs.writeFileSync(reminderPipelineStatePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('Failed to write reminder pipeline state:', error);
    }
};

const pushReminderAudit = (state, {
    actor = 'System',
    role = 'admin',
    actionType = 'pipeline',
    action = 'Reminder event',
    details = '',
    status = 'success',
    targetMobile = null,
    targetReminderId = null,
    jobId = null,
    meta = null,
}) => {
    state.audits.unshift({
        id: crypto.randomUUID(),
        actor,
        role,
        actionType,
        action,
        details,
        status,
        targetMobile,
        targetReminderId,
        jobId,
        createdAt: new Date().toISOString(),
        meta: meta && typeof meta === 'object' ? meta : null,
    });
    state.audits = state.audits.slice(0, 1000);
};

const pushReminderNotification = (state, {
    type = 'system',
    title = 'Reminder update',
    message = '',
    severity = 'info',
    action = null,
    jobId = null,
    targetMobile = null,
    targetReminderId = null,
}) => {
    state.notifications.unshift({
        id: crypto.randomUUID(),
        type,
        title,
        message,
        severity,
        action: action && typeof action === 'object' ? action : null,
        jobId,
        targetMobile,
        targetReminderId,
        status: 'open',
        createdAt: new Date().toISOString(),
    });
    state.notifications = state.notifications.slice(0, 500);
};

const reminderDaysDiff = (repaymentDate) => {
    if (!repaymentDate) {
        return null;
    }
    const date = new Date(repaymentDate);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    date.setHours(0, 0, 0, 0);
    return Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
};

const buildReminderMessage = (item) => {
    const lines = [`Hello ${item.name || 'Customer'}, this is a payment reminder.`];
    if (item.reminderRepaymentDate) {
        lines.push(`Repayment date: ${item.reminderRepaymentDate}`);
    }
    if (item.reminderAmount !== null && item.reminderAmount !== undefined && item.reminderAmount !== '') {
        lines.push(`Principal: ${item.reminderAmount}`);
    }
    if (item.reminderInterest !== null && item.reminderInterest !== undefined && item.reminderInterest !== '') {
        lines.push(`Interest: ${item.reminderInterest}%`);
    }
    if (item.reminderNote) {
        lines.push(`Note: ${item.reminderNote}`);
    }
    lines.push('Please complete your payment on time.');
    return lines.join('\n');
};

const simulateReminderDelivery = (job) => {
    const mobile = normalizeMobile(job.mobile);
    if (!mobile || mobile.length !== 10) {
        return { ok: false, error: 'Invalid mobile number' };
    }

    const message = String(job.message || '').trim();
    if (!message) {
        return { ok: false, error: 'Reminder message is empty' };
    }

    const seed = `${job.id}:${mobile}:${job.attempts + 1}`;
    const score = seed.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    if (score % 11 === 0) {
        return { ok: false, error: 'Gateway timeout while delivering reminder' };
    }

    return { ok: true };
};

const processReminderPipelineJobs = () => {
    const state = readReminderPipelineState();
    const now = Date.now();
    const dueJobs = state.jobs.filter((job) => {
        const status = String(job.status || '').toLowerCase();
        if (!['queued', 'scheduled', 'retry_pending'].includes(status)) {
            return false;
        }
        if (!job.scheduledFor) {
            return true;
        }
        const dueAt = new Date(job.scheduledFor).getTime();
        return Number.isFinite(dueAt) && dueAt <= now;
    });

    dueJobs.forEach((job) => {
        const nowIso = new Date().toISOString();
        job.attempts = Number(job.attempts || 0) + 1;
        job.lastAttemptAt = nowIso;
        const delivered = simulateReminderDelivery(job);

        if (delivered.ok) {
            job.status = 'sent';
            job.lastError = null;
            job.updatedAt = nowIso;
            pushReminderAudit(state, {
                actor: 'Scheduler',
                role: 'system',
                actionType: 'send',
                action: 'Reminder delivered',
                details: `Delivered reminder to ${job.mobile}`,
                status: 'success',
                targetMobile: job.mobile,
                targetReminderId: job.reminderId || null,
                jobId: job.id,
            });
            return;
        }

        job.lastError = delivered.error;
        const maxAttempts = Number(job.maxAttempts || 3);
        if (job.attempts < maxAttempts) {
            job.status = 'retry_pending';
            job.scheduledFor = new Date(Date.now() + (5 * 60 * 1000)).toISOString();
        } else {
            job.status = 'failed';
        }
        job.updatedAt = nowIso;

        pushReminderAudit(state, {
            actor: 'Scheduler',
            role: 'system',
            actionType: 'send',
            action: 'Reminder delivery failed',
            details: `${delivered.error} for ${job.mobile}`,
            status: 'failed',
            targetMobile: job.mobile,
            targetReminderId: job.reminderId || null,
            jobId: job.id,
        });
        pushReminderNotification(state, {
            type: 'delivery',
            severity: 'error',
            title: 'Reminder delivery failed',
            message: `Could not deliver reminder to ${job.name || job.mobile}. ${delivered.error}`,
            action: { type: 'retry-now', label: 'Retry now', jobId: job.id },
            targetMobile: job.mobile,
            targetReminderId: job.reminderId || null,
            jobId: job.id,
        });
    });

    state.lastWorkerRunAt = new Date().toISOString();
    writeReminderPipelineState(state);
    return state;
};

let reminderPipelineWorker = null;
const startReminderPipelineWorker = () => {
    if (reminderPipelineWorker) {
        return;
    }
    reminderPipelineWorker = setInterval(() => {
        try {
            processReminderPipelineJobs();
        } catch (error) {
            console.error('Reminder pipeline worker error:', error);
        }
    }, 15000);
};

const toReminderPaymentRow = (paymentDoc) => {
    const payload = paymentDoc?.toObject ? paymentDoc.toObject() : paymentDoc;
    return {
        ...payload,
        paymentId: String(payload?._id || payload?.id || ''),
        reminderId: String(payload?._id || payload?.id || ''),
        status: String(payload?.reminderStatus || '').toLowerCase() === 'paid' || String(payload?.status || '').toLowerCase() === 'paid-reminder'
            ? 'paid-reminder'
            : (payload?.status || 'manual-reminder'),
        reminderStatus: payload?.reminderStatus || null,
        reminderNote: payload?.reminderNote || '',
        reminderBorrowDate: payload?.reminderBorrowDate || null,
        reminderRepaymentDate: payload?.reminderRepaymentDate || null,
        reminderAmount: payload?.reminderAmount ?? null,
        reminderInterest: payload?.reminderInterest ?? null,
        totalAmount: payload?.reminderTotalAmount ?? payload?.totalAmount ?? null,
        reminderPaidAt: payload?.reminderPaidAt || null,
    };
};

const toManualReminderRow = (entry) => ({
    id: entry.id,
    reminderId: entry.id,
    paymentId: null,
    name: entry.name || 'Manual Reminder',
    mobile: entry.mobile,
    status: String(entry.reminderStatus || '').toLowerCase() === 'paid' ? 'paid-reminder' : 'manual-reminder',
    reminderStatus: entry.reminderStatus || 'manual',
    reminderNote: entry.reminderNote || '',
    reminderBorrowDate: entry.reminderBorrowDate || null,
    reminderRepaymentDate: entry.reminderRepaymentDate || null,
    reminderAmount: entry.reminderAmount ?? null,
    reminderInterest: entry.reminderInterest ?? null,
    totalAmount: entry.reminderTotalAmount ?? entry.totalAmount ?? null,
    reminderPaidAt: entry.reminderPaidAt || null,
    created_at: entry.createdAt || null,
    updated_at: entry.updatedAt || null,
};

const saveCashfreePaidOrder = async ({ orderData, successfulPayment, paymentData = {}, status = 'Approved' }) => {
    const normalizedMobile = String(paymentData?.mobile || orderData?.customer_details?.customer_phone || '').trim();
    const normalizedName = String(paymentData?.name || orderData?.customer_details?.customer_name || 'Cashfree User').trim();
    const normalizedEmail = String(paymentData?.email || orderData?.customer_details?.customer_email || '').trim();
    const normalizedChitPlan = String(
        paymentData?.chitsPlan || orderData?.order_tags?.chits_plan || orderData?.order_tags?.chit_plan || ''
    ).trim();
    const paymentAmount = Number(orderData?.order_amount || paymentData?.amount || successfulPayment?.payment_amount || 0);
    const paymentType = String(paymentData?.type || orderData?.order_tags?.payment_type || 'Cashfree Gateway').trim();
    const orderId = String(orderData?.order_id || paymentData?.orderId || '').trim();
    const utrNumber = String(successfulPayment?.cf_payment_id || orderId).trim();

    if (!normalizedMobile || !paymentAmount || paymentAmount <= 0 || !utrNumber) {
        throw new Error('Missing payment details required to save transaction.');
    }

    const existingPayment = await Payment.findOne({ utrNumber });
    if (existingPayment) {
        return {
            payment: existingPayment,
            created: false,
            utrNumber,
            cfPaymentId: successfulPayment?.cf_payment_id,
        };
    }

    const payment = new Payment({
        name: normalizedName,
        mobile: normalizedMobile,
        amount: paymentAmount,
        utrNumber,
        email: normalizedEmail,
        type: paymentType,
        chitsPlan: normalizedChitPlan,
        status,
    });
    await payment.save();

    const invoicePath = generateInvoice(payment);
    if (normalizedEmail && fs.existsSync(invoicePath)) {
        sendPaymentConfirmation(
            normalizedEmail,
            normalizedName,
            normalizedMobile,
            paymentAmount,
            utrNumber,
            paymentType,
            normalizedChitPlan,
            invoicePath
        );
    }

    return {
        payment,
        created: true,
        utrNumber,
        cfPaymentId: successfulPayment?.cf_payment_id,
    };
};

// Get all payments
app.get('/api/bank-details', async (req, res) => {
    try {
        const payments = await Payment.find();
        console.log('Fetched payments from database:', payments);
        res.json(payments);
    } catch (err) {
        console.error('Failed to fetch payments:', err);
        res.status(500).json({ error: 'Failed to fetch payments' });
    }
});

// Get payments by mobile number
app.get('/api/payments/:mobile', async (req, res) => {
    const { mobile } = req.params;
    console.log(`Received request to fetch payments for mobile: ${mobile}`);
    try {
        const payments = await Payment.find({ mobile });
        console.log(`Payments found: ${payments.length}`);
        res.json(payments);
    } catch (err) {
        console.error('Failed to fetch payments:', err);
        res.status(500).json({ error: 'Failed to fetch payments' });
    }
});

// Add a new payment and generate invoice
app.post('/api/bank-details', async (req, res) => {
    const { name, mobile, amount, utrNumber, email, type, chitsPlan } = req.body;

    try {
        const existingPayment = await Payment.findOne({ utrNumber });
        if (existingPayment) {
            return res.status(400).json({ message: 'UTR number already exists. Please enter a unique UTR number.' });
        }

        const payment = new Payment({ name, mobile, amount, utrNumber, email, type, chitsPlan });
        await payment.save();

        // Generate invoice
        const invoicePath = generateInvoice(payment);

        // Add a delay before checking if the invoice file exists
        setTimeout(() => {
            if (!fs.existsSync(invoicePath)) {
                console.error(`Invoice file not found at: ${invoicePath}`);
                return res.status(500).json({ message: 'Failed to generate invoice.' });
            }

            // Send confirmation email to user and admin
            sendPaymentConfirmation(email, name, mobile, amount, utrNumber, type, chitsPlan, invoicePath);

            res.status(200).json({ message: 'Payment details submitted successfully!', invoiceUrl: `/invoices/${payment._id}.pdf` });
        }, 1000); // 1 second delay
    } catch (error) {
        console.error('Error saving payment details:', error);
        res.status(500).json({ message: 'Error saving payment details.', error });
    }
});

app.post('/api/cashfree/create-order', async (req, res) => {
    try {
        const { name, email, mobile, amount, chitsPlan, type } = req.body;
        const normalizedName = String(name || '').trim();
        const normalizedEmail = String(email || '').trim();
        const normalizedMobile = String(mobile || '').replace(/\D/g, '').slice(-10);
        const normalizedChitPlan = String(chitsPlan || '').trim();
        const normalizedType = String(type || 'Chit Payment (Cashfree)').trim();
        const orderAmount = Number(amount);

        if (!normalizedName || !normalizedEmail || !normalizedMobile || !orderAmount || orderAmount <= 0) {
            return res.status(400).json({ message: 'Name, email, mobile, and amount are required.' });
        }

        const orderId = buildCashfreeOrderId(normalizedMobile);
        const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const requestProto = forwardedProto || String(req.protocol || '').trim() || 'https';
        const safeProto = requestProto === 'http' ? 'https' : requestProto;
        const returnUrl = String(process.env.CASHFREE_RETURN_URL || '').trim() || `${safeProto}://${req.get('host')}/chitpayment.html?order_id={order_id}`;
        const notifyUrl = String(process.env.CASHFREE_NOTIFY_URL || '').trim();

        const orderPayload = {
            order_id: orderId,
            order_amount: orderAmount,
            order_currency: 'INR',
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
            }
        };

        if (notifyUrl) {
            orderPayload.order_meta.notify_url = notifyUrl;
        }

        const response = await axios.post(`${CASHFREE_BASE_URL}/pg/orders`, orderPayload, {
            headers: getCashfreeHeaders()
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
        console.error('cashfree create order error', details || error.message || error);
        return res.status(status).json({
            message: details?.message || 'Failed to create Cashfree order',
            error: details,
        });
    }
});

app.post('/api/cashfree/confirm-order', async (req, res) => {
    try {
        const { orderId, paymentData } = req.body;
        const normalizedOrderId = String(orderId || '').trim();

        if (!normalizedOrderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }

        const orderResponse = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(normalizedOrderId)}`, {
            headers: getCashfreeHeaders()
        });

        const paymentsResponse = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(normalizedOrderId)}/payments`, {
            headers: getCashfreeHeaders()
        });

        const successfulPayment = findSuccessfulCashfreePayment(paymentsResponse.data);

        if (!successfulPayment || String(orderResponse.data?.order_status || '').toUpperCase() !== 'PAID') {
            return res.status(409).json({
                message: 'Payment is not completed yet. Please finish payment and try again.',
                orderStatus: orderResponse.data?.order_status,
            });
        }

        let saved;
        try {
            saved = await saveCashfreePaidOrder({
                orderData: orderResponse.data,
                successfulPayment,
                paymentData,
                status: 'Approved',
            });
        } catch (saveError) {
            console.error('cashfree payment save error', saveError);
            return res.status(500).json({ message: 'Payment succeeded but failed to save locally.', error: saveError });
        }

        return res.json({
            message: saved.created ? 'Payment successful and saved.' : 'Payment already recorded',
            payment: saved.payment,
            orderStatus: orderResponse.data?.order_status,
            cfPaymentId: saved.cfPaymentId || successfulPayment.cf_payment_id,
        });
    } catch (error) {
        const status = error.response?.status || 500;
        const details = error.response?.data || null;
        console.error('cashfree confirm order error', details || error.message || error);
        return res.status(status).json({
            message: details?.message || 'Failed to verify Cashfree payment',
            error: details,
        });
    }
});

app.post('/api/cashfree/webhook', async (req, res) => {
    try {
        if (!CASHFREE_WEBHOOK_SECRET) {
            return res.status(500).json({ message: 'Webhook secret is not configured.' });
        }

        if (!verifyCashfreeWebhookSignature(req)) {
            return res.status(401).json({ message: 'Invalid webhook signature.' });
        }

        const payload = req.body || {};
        const eventType = String(payload?.type || payload?.event || '').toUpperCase();
        const orderId = String(payload?.data?.order?.order_id || payload?.order?.order_id || payload?.order_id || '').trim();
        const paymentStatus = String(payload?.data?.payment?.payment_status || payload?.payment?.payment_status || '').toUpperCase();
        const webhookPaymentId = String(payload?.data?.payment?.cf_payment_id || payload?.payment?.cf_payment_id || '').trim();

        if (!orderId) {
            return res.status(400).json({ message: 'order_id missing in webhook payload.' });
        }

        if (!eventType.includes('SUCCESS') && paymentStatus !== 'SUCCESS') {
            return res.status(200).json({ message: 'Webhook received. Event ignored.', eventType, paymentStatus });
        }

        const orderResponse = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(orderId)}`, {
            headers: getCashfreeHeaders()
        });

        const paymentsResponse = await axios.get(`${CASHFREE_BASE_URL}/pg/orders/${encodeURIComponent(orderId)}/payments`, {
            headers: getCashfreeHeaders()
        });

        const successfulPayment = findSuccessfulCashfreePayment(paymentsResponse.data, webhookPaymentId);
        if (!successfulPayment || String(orderResponse.data?.order_status || '').toUpperCase() !== 'PAID') {
            return res.status(202).json({ message: 'Payment not in PAID state yet.' });
        }

        const saved = await saveCashfreePaidOrder({
            orderData: orderResponse.data,
            successfulPayment,
            paymentData: {},
            status: 'Approved',
        });

        return res.status(200).json({
            message: saved.created ? 'Webhook payment saved.' : 'Webhook payment already recorded.',
            orderId,
            utrNumber: saved.utrNumber,
        });
    } catch (error) {
        const status = error.response?.status || 500;
        const details = error.response?.data || null;
        console.error('cashfree webhook error', details || error.message || error);
        return res.status(status).json({
            message: details?.message || 'Failed to process Cashfree webhook',
            error: details,
        });
    }
});

// Serve invoice files
app.use('/invoices', express.static(invoicesDir));

// Update payment status by ID
app.put('/api/bank-details/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const payment = await Payment.findById(id);
        if (!payment) {
            return res.status(404).json({ message: 'Payment not found' });
        }

        payment.status = status;
        await payment.save();

        console.log('Updated payment status:', payment);
        res.status(200).json({ message: 'Payment status updated successfully' });
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ message: 'Failed to update payment status' });
    }
});

// Delete payment by ID
app.delete('/api/bank-details/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await Payment.findByIdAndDelete(id);
        console.log('Deleted payment with ID:', id);
        res.status(200).json({ message: 'Payment deleted successfully' });
    } catch (error) {
        console.error('Error deleting payment:', error);
        res.status(500).json({ message: 'Failed to delete payment' });
    }
});

// Define the BankDetails schema and model
const bankDetailsSchema = new mongoose.Schema({
    name: String,
    accountNumber: String,
    ifscCode: String,
    upiId: String,
    bankName: String,
    mobile: String
});

const BankDetails = mongoose.model('BankDetails', bankDetailsSchema);

// Add or update bank details
app.post('/api/bank-detail', async (req, res) => {
    const { name, accountNumber, ifscCode, upiId, bankName, mobile } = req.body;

    try {
        let bankDetails = await BankDetails.findOne({ mobile });
        if (bankDetails) {
            // Update existing bank details
            bankDetails.name = name;
            bankDetails.accountNumber = accountNumber;
            bankDetails.ifscCode = ifscCode;
            bankDetails.upiId = upiId;
            bankDetails.bankName = bankName;
        } else {
            // Create new bank details
            bankDetails = new BankDetails({ name, accountNumber, ifscCode, upiId, bankName, mobile });
        }
        await bankDetails.save();

        res.status(200).json({ message: 'Bank details submitted successfully!' });
    } catch (error) {
        console.error('Error saving bank details:', error);
        res.status(500).json({ message: 'Error saving bank details.', error });
    }
});

// Get bank details by mobile number
app.get('/api/bank-details/:mobile', async (req, res) => {
    const { mobile } = req.params;
    try {
        const bankDetails = await BankDetails.findOne({ mobile });
        res.json(bankDetails ? [bankDetails] : []);
    } catch (err) {
        console.error('Failed to fetch bank details:', err);
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

// Get all bank details
app.get('/api/bankdetails', async (req, res) => {
    try {
        const bankDetails = await BankDetails.find();
        console.log('Fetched bank details from database:', bankDetails);
        res.json(bankDetails);
    } catch (err) {
        console.error('Failed to fetch bank details:', err);
        res.status(500).json({ error: 'Failed to fetch bank details' });
    }
});

// Edit bank detail by ID
app.put('/api/bank-details/:id', async (req, res) => {
    const { id } = req.params;
    const { name, accountNumber, ifscCode, upiId, bankName, mobile } = req.body;

    try {
        const bankDetail = await BankDetails.findById(id);
        if (!bankDetail) {
            return res.status(404).json({ message: 'Bank detail not found' });
        }

        bankDetail.name = name;
        bankDetail.accountNumber = accountNumber;
        bankDetail.ifscCode = ifscCode;
        bankDetail.upiId = upiId;
        bankDetail.bankName = bankName;
        bankDetail.mobile = mobile;

        await bankDetail.save();

        res.status(200).json({ message: 'Bank detail updated successfully' });
    } catch (error) {
        console.error('Error updating bank detail:', error);
        res.status(500).json({ message: 'Failed to update bank detail' });
    }
});

// Delete bank detail by ID
app.delete('/api/bank-details/:id', async (req, res) => {
    const { id } = req.params;
    try {
        console.log(`Attempting to delete bank detail with ID: ${id}`);
        const bankDetail = await BankDetails.findById(id);
        if (!bankDetail) {
            console.error(`Bank detail with ID: ${id} not found`);
            return res.status(404).json({ message: 'Bank detail not found' });
        }
        await bankDetail.remove();
        console.log(`Deleted bank detail with ID: ${id}`);
        res.status(200).json({ message: 'Bank detail deleted successfully', bankDetail });
    } catch (error) {
        console.error('Error deleting bank detail:', error);
        res.status(500).json({ message: 'Failed to delete bank detail', error });
    }
});

// Define the User schema and model
const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    mobile: String,
    password: String
});

const User = mongoose.model('User', userSchema);

// Get user profile by mobile number
app.get('/api/profile', async (req, res) => {
    const { mobile } = req.query;

    try {
        const user = await User.findOne({ mobile });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(user);
    } catch (err) {
        console.error('Failed to fetch profile information:', err);
        res.status(500).json({ error: 'Failed to fetch profile information' });
    }
});

// Get all users
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find();
        res.json(users);
    } catch (err) {
        console.error('Failed to fetch users:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Define a Borrow schema
const borrowSchema = new mongoose.Schema({
    fullname: String,
    email: String,
    mobile: String,
    amount: Number,
    status: { type: String, default: 'Pending' },
    date: { type: Date, default: Date.now }
});

// Create a Borrow model
const Borrow = mongoose.model('Borrow', borrowSchema);
app.post('/api/borrow', async (req, res) => {
    try {
        const borrowRequest = new Borrow(req.body);
        await borrowRequest.save();
        res.status(201).json({ message: 'Borrow request submitted successfully!' });
    } catch (error) {
        console.error('Error submitting borrow request:', error);
        res.status(500).json({ error: 'Failed to submit borrow request' });
    }
});

// Get all borrow data
app.get('/api/borrows', async (req, res) => {
    try {
        const borrows = await Borrow.find();
        res.json(borrows);
    } catch (err) {
        console.error('Failed to fetch borrows:', err);
        res.status(500).json({ error: 'Failed to fetch borrows' });
    }
});

// Get borrow history
app.get('/api/borrow-history/:mobile', async (req, res) => {
    const { mobile } = req.params;
    try {
        const borrowHistory = await Borrow.find({ mobile });
        res.json(borrowHistory);
    } catch (err) {
        console.error('Failed to fetch borrow history:', err);
        res.status(500).json({ error: 'Failed to fetch borrow history' });
    }
});

// Update borrow status by ID
app.put('/api/borrow/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const borrow = await Borrow.findById(id);
        if (!borrow) {
            return res.status(404).json({ message: 'Borrow entry not found' });
        }

        borrow.status = status;
        await borrow.save();

        res.status(200).json({ message: 'Borrow status updated successfully' });
    } catch (error) {
        console.error('Error updating borrow status:', error);
        res.status(500).json({ message: 'Failed to update borrow status' });
    }
});

// DELETE endpoint to delete a borrow entry
app.delete('/api/borrow/:id', async (req, res) => {
    try {
        const borrow = await Borrow.findByIdAndDelete(req.params.id);
        if (!borrow) {
            return res.status(404).send('Borrow entry not found');
        }
        res.status(200).send('Borrow entry deleted successfully');
    } catch (error) {
        console.error('Error deleting borrow entry:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Get all payments
app.get('/api/payments', async (req, res) => {
    try {
        const payments = await Payment.find();
        res.json(payments);
    } catch (err) {
        console.error('Failed to fetch payments:', err);
        res.status(500).json({ error: 'Failed to fetch payments' });
    }
});

app.get('/api/payment-reminders', async (_req, res) => {
    try {
        const payments = await Payment.find();
        const state = readReminderPipelineState();
        const manualRows = (state.manualReminders || []).map(toManualReminderRow);
        const paymentRows = payments.map(toReminderPaymentRow);
        return res.json([...paymentRows, ...manualRows]);
    } catch (error) {
        console.error('Failed to fetch payment reminders:', error);
        return res.status(500).json({ message: 'Failed to fetch payment reminders' });
    }
});

app.put('/api/payments/:id/reminder', async (req, res) => {
    try {
        const rawId = String(req.params.id || '').trim();
        const rawReminderId = String(req.body?.reminderId || '').trim();
        const mobile = normalizeMobile(req.body?.mobile || rawId);
        const name = String(req.body?.name || '').trim();
        const reminderNote = String(req.body?.reminderNote || '').trim();
        const reminderBorrowDate = String(req.body?.borrowDate || '').trim() || null;
        const reminderRepaymentDate = String(req.body?.repaymentDate || '').trim() || null;
        const reminderAmount = toNumberOrNull(req.body?.reminderAmount, { snapNearInteger: true });
        const reminderInterest = toNumberOrNull(req.body?.reminderInterest);
        const reminderTotalAmount = toNumberOrNull(req.body?.totalAmount, { snapNearInteger: true });
        const reminderStatus = String(req.body?.reminderStatus || 'manual').trim().toLowerCase() === 'paid' ? 'paid' : 'manual';
        const reminderPaidAt = reminderStatus === 'paid'
            ? (String(req.body?.paidAt || '').trim() || new Date().toISOString())
            : null;

        if (!mobile) {
            return res.status(400).json({ message: 'Mobile number is required for reminders.' });
        }

        const updatePayload = {
            name,
            mobile,
            reminderNote,
            reminderBorrowDate,
            reminderRepaymentDate,
            reminderAmount,
            reminderInterest,
            reminderTotalAmount,
            reminderStatus,
            reminderPaidAt,
        };

        let payment = null;
        if (mongoose.Types.ObjectId.isValid(rawId)) {
            payment = await Payment.findById(rawId);
        }
        if (!payment) {
            payment = await Payment.findOne({ mobile });
        }

        if (payment) {
            payment.name = name || payment.name;
            payment.mobile = mobile || payment.mobile;
            payment.reminderNote = reminderNote;
            payment.reminderBorrowDate = reminderBorrowDate;
            payment.reminderRepaymentDate = reminderRepaymentDate;
            payment.reminderAmount = reminderAmount;
            payment.reminderInterest = reminderInterest;
            payment.reminderTotalAmount = reminderTotalAmount;
            payment.reminderStatus = reminderStatus;
            payment.reminderPaidAt = reminderPaidAt;
            payment.status = reminderStatus === 'paid' ? 'paid-reminder' : 'manual-reminder';
            await payment.save();

            const state = readReminderPipelineState();
            state.manualReminders = (state.manualReminders || []).filter((item) => normalizeMobile(item.mobile) !== mobile && String(item.id) !== rawReminderId);
            writeReminderPipelineState(state);

            return res.json({
                message: reminderNote ? 'Reminder note saved successfully' : 'Reminder note cleared successfully',
                payment: toReminderPaymentRow(payment),
            });
        }

        const state = readReminderPipelineState();
        let manual = null;
        if (rawReminderId) {
            manual = (state.manualReminders || []).find((item) => String(item.id) === rawReminderId);
        }
        if (!manual) {
            manual = (state.manualReminders || []).find((item) => normalizeMobile(item.mobile) === mobile);
        }

        if (!reminderNote && !reminderBorrowDate && !reminderRepaymentDate && reminderAmount === null && reminderInterest === null && reminderTotalAmount === null) {
            state.manualReminders = (state.manualReminders || []).filter((item) => String(item.id) !== String(manual?.id || '') && normalizeMobile(item.mobile) !== mobile);
            writeReminderPipelineState(state);
            return res.json({
                message: 'Reminder cleared successfully',
                payment: {
                    id: rawReminderId || `manual-${mobile}`,
                    reminderId: rawReminderId || `manual-${mobile}`,
                    paymentId: null,
                    name,
                    mobile,
                    status: 'manual-reminder',
                    reminderStatus: 'manual',
                    reminderNote: '',
                    reminderBorrowDate: null,
                    reminderRepaymentDate: null,
                    reminderAmount: null,
                    reminderInterest: null,
                    totalAmount: null,
                    reminderPaidAt: null,
                },
            });
        }

        if (!manual) {
            manual = {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
            };
            state.manualReminders.unshift(manual);
        }

        manual.name = name || manual.name || 'Manual Reminder';
        manual.mobile = mobile;
        manual.reminderNote = reminderNote;
        manual.reminderBorrowDate = reminderBorrowDate;
        manual.reminderRepaymentDate = reminderRepaymentDate;
        manual.reminderAmount = reminderAmount;
        manual.reminderInterest = reminderInterest;
        manual.reminderTotalAmount = reminderTotalAmount;
        manual.reminderStatus = reminderStatus;
        manual.reminderPaidAt = reminderPaidAt;
        manual.updatedAt = new Date().toISOString();

        state.manualReminders = state.manualReminders.slice(0, 3000);
        writeReminderPipelineState(state);

        return res.json({
            message: 'Reminder saved successfully',
            payment: toManualReminderRow(manual),
        });
    } catch (error) {
        console.error('Error saving reminder:', error);
        return res.status(500).json({ message: 'Failed to save reminder' });
    }
});

app.get('/api/payment-reminder/pipeline/overview', async (_req, res) => {
    const state = processReminderPipelineJobs();
    const jobs = state.jobs || [];
    return res.json({
        counts: {
            queued: jobs.filter((job) => String(job.status || '') === 'queued').length,
            scheduled: jobs.filter((job) => String(job.status || '') === 'scheduled').length,
            retryPending: jobs.filter((job) => String(job.status || '') === 'retry_pending').length,
            sent: jobs.filter((job) => String(job.status || '') === 'sent').length,
            failed: jobs.filter((job) => String(job.status || '') === 'failed').length,
        },
        notificationsOpen: (state.notifications || []).filter((item) => item.status === 'open').length,
        lastWorkerRunAt: state.lastWorkerRunAt || null,
        recentJobs: jobs.slice(0, 50),
    });
});

app.get('/api/payment-reminder/pipeline/notifications', async (req, res) => {
    const state = processReminderPipelineJobs();
    const status = String(req.query?.status || 'open').toLowerCase();
    const list = status === 'open'
        ? (state.notifications || []).filter((item) => String(item.status || '') === 'open')
        : (state.notifications || []);
    return res.json(list.slice(0, 100));
});

app.post('/api/payment-reminder/pipeline/notifications/:id/resolve', async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
        return res.status(400).json({ message: 'Notification id is required' });
    }

    const state = readReminderPipelineState();
    const notification = (state.notifications || []).find((item) => String(item.id) === id);
    if (!notification) {
        return res.status(404).json({ message: 'Notification not found' });
    }

    notification.status = 'resolved';
    notification.resolvedAt = new Date().toISOString();
    notification.resolvedBy = 'Admin';

    pushReminderAudit(state, {
        actor: 'Admin',
        role: 'admin',
        actionType: 'notification',
        action: 'Notification resolved',
        details: notification.title || 'Notification closed',
        status: 'success',
        targetMobile: notification.targetMobile || null,
        targetReminderId: notification.targetReminderId || null,
        jobId: notification.jobId || null,
    });

    writeReminderPipelineState(state);
    return res.json({ message: 'Notification resolved' });
});

app.post('/api/payment-reminder/pipeline/retry/:jobId', async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) {
        return res.status(400).json({ message: 'Job id is required' });
    }

    const state = readReminderPipelineState();
    const job = (state.jobs || []).find((item) => String(item.id) === jobId);
    if (!job) {
        return res.status(404).json({ message: 'Job not found' });
    }

    job.status = 'queued';
    job.scheduledFor = new Date().toISOString();
    job.updatedAt = new Date().toISOString();

    pushReminderAudit(state, {
        actor: 'Admin',
        role: 'admin',
        actionType: 'retry',
        action: 'Retry queued',
        details: `Manual retry queued for ${job.mobile}`,
        status: 'success',
        targetMobile: job.mobile,
        targetReminderId: job.reminderId || null,
        jobId: job.id,
    });

    writeReminderPipelineState(state);
    processReminderPipelineJobs();
    return res.json({ message: 'Retry queued' });
});

app.post('/api/payment-reminder/pipeline/bulk-send', async (req, res) => {
    try {
        const groups = req.body?.groups && typeof req.body.groups === 'object' ? req.body.groups : {};
        const includeAll = Boolean(groups.all);
        const includeDueSoon = Boolean(groups.dueSoon);
        const includePending = Boolean(groups.pending);

        if (!includeAll && !includeDueSoon && !includePending) {
            return res.status(400).json({ message: 'Select at least one recipient group' });
        }

        let scheduledFor = new Date().toISOString();
        const scheduleDate = String(req.body?.scheduleDate || '').trim();
        const scheduleTime = String(req.body?.scheduleTime || '').trim();
        if (scheduleDate) {
            const composed = scheduleTime ? `${scheduleDate}T${scheduleTime}:00` : `${scheduleDate}T09:00:00`;
            const parsed = new Date(composed);
            if (Number.isNaN(parsed.getTime())) {
                return res.status(400).json({ message: 'Invalid schedule date/time' });
            }
            scheduledFor = parsed.toISOString();
        }

        const scheduleIsFuture = new Date(scheduledFor).getTime() > Date.now();

        const payments = await Payment.find();
        const state = readReminderPipelineState();
        const candidates = [
            ...payments.map(toReminderPaymentRow),
            ...(state.manualReminders || []).map(toManualReminderRow),
        ].filter((item) => String(item.reminderStatus || '').toLowerCase() !== 'paid');

        const selected = candidates.filter((item) => {
            const days = reminderDaysDiff(item.reminderRepaymentDate);
            const isOverdue = days !== null && days < 0;
            const isDueSoon = days !== null && days >= 0 && days <= 7;
            if (includeAll && isOverdue) return true;
            if (includeDueSoon && isDueSoon) return true;
            if (includePending) return true;
            return false;
        });

        if (!selected.length) {
            return res.status(404).json({ message: 'No reminders match selected groups' });
        }

        const jobs = selected.map((item) => ({
            id: crypto.randomUUID(),
            reminderId: item.reminderId || item.id || null,
            paymentId: item.paymentId || item.id || null,
            mobile: normalizeMobile(item.mobile),
            name: item.name || 'Customer',
            message: buildReminderMessage(item),
            status: scheduleIsFuture ? 'scheduled' : 'queued',
            type: scheduleIsFuture ? 'scheduled' : 'immediate',
            attempts: 0,
            maxAttempts: 3,
            scheduledFor,
            lastAttemptAt: null,
            lastError: null,
            actor: 'Admin',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }));

        state.jobs.unshift(...jobs);
        state.jobs = state.jobs.slice(0, 5000);

        pushReminderAudit(state, {
            actor: 'Admin',
            role: 'admin',
            actionType: scheduleIsFuture ? 'schedule' : 'bulk-send',
            action: scheduleIsFuture ? 'Bulk reminders scheduled' : 'Bulk reminders queued',
            details: `${jobs.length} reminders prepared (${scheduleIsFuture ? 'scheduled' : 'queued'})`,
            status: 'success',
            meta: {
                groups: { all: includeAll, dueSoon: includeDueSoon, pending: includePending },
                scheduledFor,
                jobCount: jobs.length,
            },
        });

        pushReminderNotification(state, {
            type: scheduleIsFuture ? 'schedule' : 'queue',
            severity: 'info',
            title: scheduleIsFuture ? 'Reminders scheduled' : 'Bulk reminders queued',
            message: `${jobs.length} reminder jobs ${scheduleIsFuture ? 'scheduled' : 'queued for delivery'}.`,
        });

        const overdueCount = selected.filter((item) => {
            const days = reminderDaysDiff(item.reminderRepaymentDate);
            return days !== null && days < 0;
        }).length;

        if (overdueCount > 0) {
            pushReminderNotification(state, {
                type: 'overdue',
                severity: 'warning',
                title: 'Overdue escalation',
                message: `${overdueCount} overdue reminders are in pipeline and need close tracking.`,
            });
        }

        writeReminderPipelineState(state);
        if (!scheduleIsFuture) {
            processReminderPipelineJobs();
        }

        return res.json({
            message: scheduleIsFuture ? 'Reminders scheduled successfully' : 'Bulk reminders queued successfully',
            queued: jobs.length,
            scheduledFor,
            mode: scheduleIsFuture ? 'scheduled' : 'immediate',
        });
    } catch (error) {
        console.error('Failed to queue bulk reminders:', error);
        return res.status(500).json({ message: 'Failed to queue bulk reminders' });
    }
});

app.get('/api/payment-reminder/pipeline/audit', async (req, res) => {
    const state = readReminderPipelineState();
    const actor = String(req.query?.actor || '').trim().toLowerCase();
    const actionType = String(req.query?.actionType || '').trim().toLowerCase();
    const status = String(req.query?.status || '').trim().toLowerCase();
    const from = String(req.query?.from || '').trim();
    const to = String(req.query?.to || '').trim();
    const fromTime = from ? new Date(from).getTime() : null;
    const toTime = to ? new Date(to).getTime() : null;

    const filtered = (state.audits || []).filter((entry) => {
        const entryActor = String(entry.actor || '').toLowerCase();
        const entryActionType = String(entry.actionType || '').toLowerCase();
        const entryStatus = String(entry.status || '').toLowerCase();
        const entryTime = new Date(entry.createdAt || 0).getTime();

        if (actor && !entryActor.includes(actor)) return false;
        if (actionType && entryActionType !== actionType) return false;
        if (status && entryStatus !== status) return false;
        if (Number.isFinite(fromTime) && entryTime < fromTime) return false;
        if (Number.isFinite(toTime) && entryTime > toTime) return false;
        return true;
    });

    return res.json({ total: filtered.length, data: filtered.slice(0, 1000) });
});

app.get('/api/payment-reminder/pipeline/audit/export', async (req, res) => {
    const state = readReminderPipelineState();
    const actor = String(req.query?.actor || '').trim().toLowerCase();
    const actionType = String(req.query?.actionType || '').trim().toLowerCase();
    const status = String(req.query?.status || '').trim().toLowerCase();
    const from = String(req.query?.from || '').trim();
    const to = String(req.query?.to || '').trim();
    const fromTime = from ? new Date(from).getTime() : null;
    const toTime = to ? new Date(to).getTime() : null;

    const filtered = (state.audits || []).filter((entry) => {
        const entryActor = String(entry.actor || '').toLowerCase();
        const entryActionType = String(entry.actionType || '').toLowerCase();
        const entryStatus = String(entry.status || '').toLowerCase();
        const entryTime = new Date(entry.createdAt || 0).getTime();

        if (actor && !entryActor.includes(actor)) return false;
        if (actionType && entryActionType !== actionType) return false;
        if (status && entryStatus !== status) return false;
        if (Number.isFinite(fromTime) && entryTime < fromTime) return false;
        if (Number.isFinite(toTime) && entryTime > toTime) return false;
        return true;
    });

    const header = ['Timestamp', 'Actor', 'Role', 'Action Type', 'Action', 'Details', 'Status', 'Target Mobile', 'Reminder Id', 'Job Id'];
    const rows = filtered.map((entry) => [
        entry.createdAt || '',
        entry.actor || '',
        entry.role || '',
        entry.actionType || '',
        entry.action || '',
        entry.details || '',
        entry.status || '',
        entry.targetMobile || '',
        entry.targetReminderId || '',
        entry.jobId || '',
    ]);

    const toCsvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map((row) => row.map(toCsvValue).join(',')).join('\n');
    const fileName = `reminder-audit-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(csv);
});

app.get('/api/lenders', requireAdminRole, async (_req, res) => {
    const state = readLenderState();
    const items = [...state.lenders].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const pendingJobs = state.jobs.filter((job) => ['queued', 'scheduled', 'retry_pending'].includes(String(job.status || '').toLowerCase())).length;
    return res.json({
        data: items,
        live: {
            total: items.length,
            queuedJobs: pendingJobs,
            workerLastRunAt: state.lastWorkerRunAt || null,
        }
    });
});

app.get('/api/lenders/audit', requireAdminRole, async (req, res) => {
    const state = readLenderState();
    const actionType = String(req.query?.actionType || '').trim().toLowerCase();
    const status = String(req.query?.status || '').trim().toLowerCase();
    const actor = String(req.query?.actor || '').trim().toLowerCase();
    const filtered = state.audits.filter((entry) => {
        if (actionType && String(entry.actionType || '').toLowerCase() !== actionType) return false;
        if (status && String(entry.status || '').toLowerCase() !== status) return false;
        if (actor && !String(entry.actor || '').toLowerCase().includes(actor)) return false;
        return true;
    });
    return res.json({ total: filtered.length, data: filtered.slice(0, 1000) });
});

app.get('/api/lenders/reminders/jobs', requireAdminRole, async (req, res) => {
    const state = readLenderState();
    const status = String(req.query?.status || '').trim().toLowerCase();
    const jobs = status
        ? state.jobs.filter((job) => String(job.status || '').toLowerCase() === status)
        : state.jobs;
    return res.json({ total: jobs.length, data: jobs.slice(0, 1000) });
});

app.post('/api/lenders', requireAdminRole, async (req, res) => {
    const parsed = sanitizeLenderPayload(req.body || {});
    if (parsed.error) {
        return res.status(400).json({ message: parsed.error });
    }

    const state = readLenderState();
    const actor = getActorNameFromRequest(req);
    const role = getRoleFromRequest(req) || 'admin';
    const nowIso = new Date().toISOString();
    const lender = {
        id: crypto.randomUUID(),
        ...parsed.data,
        createdAt: nowIso,
        updatedAt: nowIso,
    };

    state.lenders.unshift(lender);
    pushLenderAudit(state, {
        actor,
        role,
        actionType: 'create',
        action: 'Lender created',
        details: `Created lender ${lender.name}`,
        status: 'success',
        lenderId: lender.id,
        targetMobile: lender.mobile,
    });
    writeLenderState(state);
    return res.status(201).json({ message: 'Lender created', lender });
});

app.put('/api/lenders/:id', requireAdminRole, async (req, res) => {
    const parsed = sanitizeLenderPayload(req.body || {});
    if (parsed.error) {
        return res.status(400).json({ message: parsed.error });
    }

    const state = readLenderState();
    const idx = state.lenders.findIndex((item) => String(item.id) === String(req.params.id));
    if (idx < 0) {
        return res.status(404).json({ message: 'Lender not found' });
    }

    const actor = getActorNameFromRequest(req);
    const role = getRoleFromRequest(req) || 'admin';
    const updated = {
        ...state.lenders[idx],
        ...parsed.data,
        updatedAt: new Date().toISOString(),
    };
    state.lenders[idx] = updated;
    pushLenderAudit(state, {
        actor,
        role,
        actionType: 'update',
        action: 'Lender updated',
        details: `Updated lender ${updated.name}`,
        status: 'success',
        lenderId: updated.id,
        targetMobile: updated.mobile,
    });
    writeLenderState(state);
    return res.json({ message: 'Lender updated', lender: updated });
});

app.delete('/api/lenders/:id', requireAdminRole, async (req, res) => {
    const state = readLenderState();
    const idx = state.lenders.findIndex((item) => String(item.id) === String(req.params.id));
    if (idx < 0) {
        return res.status(404).json({ message: 'Lender not found' });
    }

    const actor = getActorNameFromRequest(req);
    const role = getRoleFromRequest(req) || 'admin';
    const removed = state.lenders[idx];
    state.lenders.splice(idx, 1);
    state.jobs = state.jobs.filter((job) => String(job.lenderId) !== String(removed.id));
    pushLenderAudit(state, {
        actor,
        role,
        actionType: 'delete',
        action: 'Lender deleted',
        details: `Deleted lender ${removed.name}`,
        status: 'success',
        lenderId: removed.id,
        targetMobile: removed.mobile,
    });
    writeLenderState(state);
    return res.json({ message: 'Lender deleted' });
});

app.post('/api/lenders/:id/reminders/schedule', requireAdminRole, async (req, res) => {
    const state = readLenderState();
    const lender = state.lenders.find((item) => String(item.id) === String(req.params.id));
    if (!lender) {
        return res.status(404).json({ message: 'Lender not found' });
    }

    const actor = getActorNameFromRequest(req);
    const role = getRoleFromRequest(req) || 'admin';
    const scheduleDate = String(req.body?.scheduleDate || '').trim();
    const scheduleTime = String(req.body?.scheduleTime || '').trim();
    const templateType = normalizeLenderTemplateType(req.body?.templateType || req.body?.template || 'standard');
    const templateVariables = normalizeLenderTemplateVariables(req.body?.templateVariables);
    const scheduledFor = parseScheduleDateTime(scheduleDate, scheduleTime);

    if (!scheduledFor) {
        return res.status(400).json({ message: 'Invalid schedule date/time' });
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
        status: isFuture ? 'scheduled' : 'queued',
        type: isFuture ? 'scheduled' : 'immediate',
        attempts: 0,
        maxAttempts: 3,
        scheduledFor,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        actor,
    };

    state.jobs.unshift(job);
    pushLenderAudit(state, {
        actor,
        role,
        actionType: isFuture ? 'schedule' : 'queue',
        action: isFuture ? 'Lender reminder scheduled' : 'Lender reminder queued',
        details: `${lender.name} reminder ${isFuture ? 'scheduled' : 'queued'} for ${scheduledFor}`,
        status: 'success',
        lenderId: lender.id,
        targetMobile: lender.mobile,
        jobId: job.id,
        meta: { template: job.template, templateVariables: job.templateVariables, scheduledFor },
    });
    writeLenderState(state);

    if (!isFuture) {
        await processLenderReminderJobs();
    }

    return res.json({
        message: isFuture ? 'Lender reminder scheduled' : 'Lender reminder queued',
        job,
    });
});

app.post('/api/lenders/reminders/:jobId/retry', requireAdminRole, async (req, res) => {
    const state = readLenderState();
    const job = state.jobs.find((item) => String(item.id) === String(req.params.jobId));
    if (!job) {
        return res.status(404).json({ message: 'Reminder job not found' });
    }

    const actor = getActorNameFromRequest(req);
    const role = getRoleFromRequest(req) || 'admin';
    job.status = 'queued';
    job.lastError = null;
    job.scheduledFor = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    pushLenderAudit(state, {
        actor,
        role,
        actionType: 'retry',
        action: 'Lender reminder retry queued',
        details: `Retry requested for job ${job.id}`,
        status: 'success',
        lenderId: job.lenderId,
        targetMobile: job.mobile,
        jobId: job.id,
    });
    writeLenderState(state);
    await processLenderReminderJobs();
    return res.json({ message: 'Retry queued', job });
});

// Define a Chit ID schema
const chitIdSchema = new mongoose.Schema({
    chitId: String,
    email: String,
    name: String,
    mobile: String,
    month: String,
    totalBalance: Number,
    totalPaid: Number, // Add totalPaid field to the schema
    status: { type: String, default: 'Pending' }
});

// Create a Chit ID model
const ChitId = mongoose.model('ChitId', chitIdSchema);

// Endpoint to get all Chit IDs
app.get('/api/chit-ids', async (req, res) => {
    try {
        const chits = await ChitId.find();
        console.log('Chit IDs found:', chits); // Add logging
        res.status(200).json(chits);
    } catch (error) {
        console.error('Error fetching Chit ID details:', error);
        res.status(500).json({ message: 'Failed to fetch Chit ID details' });
    }
});

// Endpoint to get Chit ID details by chitId
app.get('/api/chit-ids/:chitId', async (req, res) => {
    const { chitId } = req.params;

    try {
        const chit = await ChitId.findOne({ chitId });
        if (!chit) {
            return res.status(404).json({ message: 'Chit ID not found' });
        }

        res.status(200).json(chit);
    } catch (error) {
        console.error('Error fetching Chit ID details:', error);
        res.status(500).json({ message: 'Failed to fetch Chit ID details' });
    }
});

// Endpoint to get Chit ID details by mobile number
app.get('/api/chit-ids/mobile/:mobile', async (req, res) => {
    const { mobile } = req.params;

    try {
        const chits = await ChitId.find({ mobile });
        if (!chits.length) {
            return res.status(404).json({ message: 'No Chit IDs found for this mobile number' });
        }

        res.status(200).json(chits);
    } catch (error) {
        console.error('Error fetching Chit ID details:', error);
        res.status(500).json({ message: 'Failed to fetch Chit ID details' });
    }
});

// Endpoint to submit Chit ID
app.post('/api/chit-ids', async (req, res) => {
    const { chitId, email, name, mobile, month } = req.body;

    try {
        const newChit = new ChitId({ chitId, email, name, mobile, month });
        await newChit.save();

        res.status(201).json({ message: 'Chit ID submitted successfully', chit: newChit });
    } catch (error) {
        console.error('Error submitting Chit ID:', error);
        res.status(500).json({ message: 'Failed to submit Chit ID' });
    }
});

// Endpoint to approve Chit ID and set total balance and total paid
app.post('/api/chit-ids/approve', async (req, res) => {
    const { chitId, totalBalance, totalPaid } = req.body;

    try {
        const chit = await ChitId.findOne({ chitId });
        if (!chit) {
            return res.status(404).json({ message: 'Chit ID not found' });
        }

        chit.status = 'Approved';
        chit.totalBalance = totalBalance;
        chit.totalPaid = totalPaid; // Ensure totalPaid is set
        await chit.save();

        res.status(200).json({ message: 'Chit ID approved successfully' });
    } catch (error) {
        console.error('Error approving Chit ID:', error);
        res.status(500).json({ message: 'Failed to approve Chit ID' });
    }
});

// Endpoint to update Chit ID status
app.put('/api/chit-ids/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, totalBalance, totalPaid } = req.body; // Include totalPaid in the request body

    try {
        const chit = await ChitId.findById(id);
        if (!chit) {
            return res.status(404).json({ message: 'Chit ID not found' });
        }

        chit.status = status;
        chit.totalBalance = totalBalance;
        chit.totalPaid = totalPaid; // Ensure totalPaid is updated
        await chit.save();

        res.status(200).json({ message: 'Chit ID status updated successfully' });
    } catch (error) {
        console.error('Error updating Chit ID status:', error);
        res.status(500).json({ message: 'Failed to update Chit ID status' });
    }
});

// Endpoint to delete Chit ID by ID
app.delete('/api/chit-ids/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const chit = await ChitId.findByIdAndDelete(id);
        if (!chit) {
            return res.status(404).json({ message: 'Chit ID not found' });
        }
        res.status(200).json({ message: 'Chit ID deleted successfully' });
    } catch (error) {
        console.error('Error deleting Chit ID:', error);
        res.status(500).json({ message: 'Failed to delete Chit ID' });
    }
});

// Start the server
startReminderPipelineWorker();
startLenderReminderWorker();
app.listen(PORT, () => {
    console.log(`🚀Server is running on http://localhost:${PORT}`);
});
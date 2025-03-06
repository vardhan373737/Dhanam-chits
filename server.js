const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./db');
const nodemailer = require('nodemailer');
const fs = require('fs');
const pdf = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(bodyParser.json());

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
    status: { type: String, default: 'Pending' }
});

// Create a Payment model
const Payment = mongoose.model('Payment', paymentSchema);

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
app.listen(PORT, () => {
    console.log(`🚀Server is running on http://localhost:${PORT}`);
});
const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const cors = require("cors");
const path = require("path");
const mongoose = require('mongoose'); // Add this line
const connectDB = require('./db'); // Import the shared MongoDB connection
const crypto = require('crypto'); // Add this line

// Initialize Express app
const app = express();
const PORT = 5005; // Change port number to 5005

// Middleware setup
app.use(bodyParser.json());
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true })); // Add this line

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: "shekarchandra99311@gmail.com", // Replace with your email
        pass: "zwfh owzr fbiw meuf" // Replace with your email password or app-specific password
    }
});

// Connect to MongoDB
connectDB();

// Define the contact schema
const contactSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    mobile: { type: String, required: true },
    message: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

// Create the contact model
const Contact = mongoose.model("Contact", contactSchema);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, "public")));

// Route: Home
app.get("/", (req, res) => {
    res.send("Contact server is running...");
});

// Function to send email to both user and admin
const sendEmail = (userEmail, userName, userMobile, userMessage) => {
    if (!userEmail || !userName || !userMobile || !userMessage) {
        console.error('Error: Missing email details');
        return;
    }

    const userMailOptions = {
        from: "shekarchandra99311@gmail.com", // Replace with your email
        to: userEmail,
        subject: "Thank you for contacting us",
        text: `Dear ${userName},\n\nThank you for reaching out to us. We have received your message and will get back to you shortly.\n\nBest regards,\nDhanam Chits Pvt. Ltd`
    };

    const adminMailOptions = {
        from: userEmail,
        to: "shekarchandra99311@gmail.com", // Replace with your email
        subject: "New Contact Form Submission",
        text: `Name: ${userName}\nEmail: ${userEmail}\nMobile: ${userMobile}\nMessage: ${userMessage}`
    };

    transporter.sendMail(userMailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email to user:", error);
        } else {
            console.log("Email sent to user:", info.response);
        }
    });

    transporter.sendMail(adminMailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email to admin:", error);
        } else {
            console.log("Email sent to admin:", info.response);
        }
    });
};

// Contact form submission endpoint
app.post("/api/contact", async (req, res) => {
    const { name, email, mobile, message } = req.body;

    // Validate input fields
    if (!name || !email || !mobile || !message) {
        return res.status(400).json({ message: "All fields are required." });
    }

    try {
        // Save contact form submission to MongoDB
        const newContact = new Contact({ name, email, mobile, message });
        await newContact.save();

        // Send email to both user and admin
        sendEmail(email, name, mobile, message);

        return res.status(200).json({ message: "Your message has been sent successfully! Our team will contact you soon." });
    } catch (error) {
        console.error("Error saving contact form submission:", error);
        return res.status(500).json({ message: "There was an error saving your message. Please try again later." });
    }
});

// Fetch all contact submissions
app.get('/api/contacts', async (req, res) => {
    try {
        const contacts = await Contact.find();
        res.json(contacts);
    } catch (error) {
        console.error('Error fetching contacts:', error);
        res.status(500).json({ message: 'Failed to fetch contacts' });
    }
});

// Delete a contact submission by ID
app.delete('/api/contacts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await Contact.findByIdAndDelete(id);
        res.status(200).json({ message: 'Contact submission deleted successfully' });
    } catch (error) {
        console.error('Error deleting contact submission:', error);
        res.status(500).json({ message: 'Failed to delete contact submission' });
    }
});

// Paytm callback endpoint
app.post('/api/paytm-callback', (req, res) => {
    const paytmChecksum = req.body.CHECKSUMHASH;
    delete req.body.CHECKSUMHASH;

    const isVerifySignature = verifySignature(req.body, 'YOUR_ACTUAL_PAYTM_MERCHANT_KEY', paytmChecksum);
    if (isVerifySignature) {
        console.log("Checksum Matched");
        // Process the payment response
        res.redirect('/payment-success.html');
    } else {
        console.log("Checksum Mismatched");
        res.redirect('/payment-failure.html');
    }
});

// Function to verify Paytm checksum
function verifySignature(params, key, checksum) {
    const data = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const hash = crypto.createHmac('sha256', key).update(data).digest('hex');
    return hash === checksum;
}

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Contact server is running on http://localhost:${PORT}`);
});

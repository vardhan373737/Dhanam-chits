const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

app.post('/api/feedback', async (req, res) => {
    const { name, email, message, rating } = req.body;

    // Configure Nodemailer
    const transporter = nodemailer.createTransport({
        service: 'gmail', // Use your email service
        auth: {
            user: 'your-email@gmail.com', // Replace with your email
            pass: 'your-email-password'  // Replace with your email password
        }
    });

    const mailOptions = {
        from: 'your-email@gmail.com',
        to: email,
        subject: 'Thank You for Your Feedback!',
        text: `Hi ${name},\n\nThank you for your feedback!\n\nYour Message: ${message}\nRating: ${rating}\n\nWe appreciate your input and will use it to improve our services.\n\nBest regards,\nDhanam Chits Pvt. Ltd`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent to:', email);
        res.status(200).send('Feedback submitted and email sent.');
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).send('Error submitting feedback.');
    }
});

const PORT = 5005;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

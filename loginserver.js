require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const session = require("express-session");
const cors = require("cors");
const path = require("path");
const MongoStore = require("connect-mongo");
const nodemailer = require("nodemailer"); // Import Nodemailer
const crypto = require('crypto'); // Import crypto module

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ CORS Middleware: Restrict origins for security
app.use(cors({
  origin: ["http://localhost:3000", "http://yourfrontend.com"], // Change as needed
  credentials: true
}));

// ✅ Middleware setup
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ✅ Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ✅ MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// ✅ Session Middleware
app.use(session({
  secret: process.env.SECRET_KEY,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day session expiry
  }
}));

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'shekarchandra99311@gmail.com', // Replace with your email
    pass: 'xyxq owea zryq xfyt'   // Replace with your email password or app-specific password
  }
});

// ✅ User Schema (with role handling)
const userSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  mobile: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' }, // Role field
  resetPasswordToken: String,
  resetPasswordExpires: Date
});

const User = mongoose.model("User", userSchema);

// ✅ Role-Based Access Middleware
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.status(403).json({ message: "Forbidden: You don't have access to this resource." });
};

// ✅ Register Endpoint
app.post("/register", async (req, res) => {
  try {
    console.log("Request received:", req.body);

    const { fullname, email, mobile, password, confirmPassword, role } = req.body;

    if (!fullname || !email || !mobile || !password || !confirmPassword) {
      return res.status(400).json({ message: "All fields are required." });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match." });
    }

    // Check for existing user
    const existingUser = await User.findOne({ $or: [{ mobile }, { email }] });
    if (existingUser) {
      return res.status(400).json({ message: "Mobile or email already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      fullname, email, mobile, password: hashedPassword, role // Include role
    });

    await newUser.save();
    res.status(201).json({ message: "User registered successfully!" });
  } catch (err) {
    console.error("Register error:", err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({ message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists.` });
    }
    res.status(500).json({ message: "Something went wrong. Please try again later." });
  }
});

// ✅ Login Endpoint
app.post("/Login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res.status(400).json({ message: "Mobile number and password are required." });
    }

    const user = await User.findOne({ mobile });
    if (!user) {
      return res.status(401).json({ message: "Invalid mobile number or password." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid mobile number or password." });
    }

    req.session.user = {
      id: user._id,
      fullname: user.fullname,
      email: user.email,
      mobile: user.mobile,
      role: user.role // Store user role
    };

    res.status(200).json({ message: "Login successful!", user: req.session.user });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// ✅ Logout Endpoint
app.post("/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ message: "Logout failed. Try again." });
    }
    res.clearCookie("connect.sid");
    res.status(200).json({ message: "Logout successful." });
  });
});

// Handle password reset request
app.post('/api/reset-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Generate a reset token
    const token = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send reset link via email
    const resetLink = `http://localhost:4000/newpassword.html?token=${token}`;
    const mailOptions = {
      to: user.email,
      from: 'shekarchandra99311@gmail.com',
      subject: 'Password Reset',
      text: `You are receiving this because you (or someone else) have requested the reset of the password for your account.\n\n
             Please click on the following link, or paste this into your browser to complete the process:\n\n
             ${resetLink}\n\n
             If you did not request this, please ignore this email and your password will remain unchanged.\n`
    };
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('Error sending email:', error);
        return res.status(500).json({ message: 'Error sending email' });
      }
      res.status(200).json({ message: 'Reset link sent to your email' });
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Handle setting a new password
app.post('/api/new-password', async (req, res) => {
  const { token, password } = req.body;
  try {
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) {
      return res.status(400).json({ message: 'Password reset token is invalid or has expired' });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update the user's password and clear the reset token and expiry
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    // Save the updated user to the database
    await user.save();

    res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// ✅ Endpoint to get all users (admin only)
app.get("/api/users", isAdmin, async (req, res) => {
  try {
    // Fetch all users except the admin
    const users = await User.find({ role: 'user' }).select('-password');  // Exclude password field
    res.status(200).json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Get all user details
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find();
    console.log('Fetched users from database:', users); // Add logging
    res.json(users);
  } catch (err) {
    console.error('Failed to fetch users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Delete user by ID
app.delete('/api/users/:id', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await User.findByIdAndDelete(id);
        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Failed to delete user' });
    }
});

// Change user password by ID
app.put('/api/users/:id/password', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;

    try {
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        user.password = hashedPassword;
        await user.save();

        res.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Error changing password:', error);
        res.status(500).json({ message: 'Failed to change password' });
    }
});

// ✅ Global Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("Error:", err.message || err);
  res.status(500).json({ message: "Internal Server Error" });
});

// ✅ Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

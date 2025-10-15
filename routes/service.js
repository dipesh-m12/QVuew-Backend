const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const redis = require("redis");
const nodemailer = require("nodemailer");
const SupportRequest = require("../models/SupportRequest");
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const axios = require("axios");
const bcrypt = require("bcrypt");
const User = require("../models/User");

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "",
    pass: process.env.EMAIL_PASS || "",
  },
});
const CODE_TTL = 15 * 60; // 15 minutes in seconds

//for customers - not for vendors
// Generate 4-digit code and store in Redis with email, then send email
router.post("/generate-code", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email is required", data: null });

  const user = await User.findOne({ email, isDeleted: false });
  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });

  const uuid = uuidv4();
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  await redisClient.setEx(
    `forgot:${uuid}`, // Use UUID as the Redis key
    CODE_TTL,
    JSON.stringify({ code, userId: user._id })
  );

  const mailOptions = {
    from: process.env.EMAIL_USER || "mavinash422@gmail.com",
    to: email,
    subject: "Password Reset Code",
    text: `Your password reset code is ${code}. It is valid for 15 minutes.`,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({
      success: true,
      message: "Password reset code sent",
      data: { uuid },
      token: null,
    });
  } catch (error) {
    console.error("Email error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send reset code",
      data: null,
    });
  }
});

// Verify 4-digit code
router.post("/verify-code", async (req, res) => {
  const { uuid, code } = req.body;
  if (!uuid || !code)
    return res.status(400).json({
      success: false,
      message: "UUID and code are required",
      data: null,
    });

  const storedData = await redisClient.get(`forgot:${uuid}`);
  if (!storedData)
    return res.status(404).json({
      success: false,
      message: "Code not found or expired",
      data: null,
    });

  const { code: storedCode, userId } = JSON.parse(storedData);
  if (storedCode !== code)
    return res
      .status(400)
      .json({ success: false, message: "Invalid code", data: null });

  // Do not delete the key here; keep it for reset-password
  res.json({
    success: true,
    message: "Code verified",
    data: { userId }, // Return userId for the next step
    token: null,
  });
});

// Reset Password
router.post("/reset-password", async (req, res) => {
  const { uuid, code, newPassword, userId } = req.body; // Expect userId from verify-code response
  if (!uuid || !code || !newPassword || !userId)
    return res
      .status(400)
      .json({ success: false, message: "All fields are required", data: null });

  const storedData = await redisClient.get(`forgot:${uuid}`);
  if (!storedData)
    return res
      .status(404)
      .json({ success: false, message: "Invalid or expired code", data: null });

  const { code: storedCode, userId: storedUserId } = JSON.parse(storedData);
  if (storedCode !== code || storedUserId !== userId)
    return res
      .status(400)
      .json({ success: false, message: "Invalid code or user", data: null });

  const user = await User.findById(userId);
  if (!user || user.isDeleted)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  await redisClient.del(`forgot:${uuid}`); // Delete the key after successful reset

  res.json({
    success: true,
    message: "Password reset successfully",
    data: null,
    token: null,
  });
});

// Contact Support API
router.post(
  "/contact-support",
  [
    verifyUser,
    body("subject").notEmpty().withMessage("Subject is required"),
    body("message").notEmpty().withMessage("Message is required"),
    body("email").optional(),
    body("accountType")
      .isIn(["vendor", "user"])
      .withMessage("Invalid account type"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { subject, message, email, accountType } = req.body;
    const createdBy = req.user.id; // Get user ID from verified token

    const supportRequest = new SupportRequest({
      subject,
      message,
      email,
      createdBy,
      accountType,
    });

    try {
      await supportRequest.save();
      res.json({
        success: true,
        message: "Support request submitted successfully",
        data: null,
        token: null,
      });
    } catch (error) {
      console.error("Error saving support request:", error);
      res.status(500).json({
        success: false,
        message: "Failed to submit support request",
        data: null,
      });
    }
  }
);

// Route to send bulk push notifications to Expo
router.post(
  "/send-push-notifications",
  [
    body("pushTokens")
      .isArray({ min: 1 })
      .withMessage("pushTokens must be a non-empty array"),
    body("pushTokens.*")
      .isString()
      .notEmpty()
      .withMessage("Each push token must be a non-empty string"),
    body("title").notEmpty().withMessage("Title is required"),
    body("message").notEmpty().withMessage("Message is required"),
  ],
  async (req, res) => {
    // Validate request body
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { pushTokens, title, message } = req.body;

    // Format messages for Expo Push API
    const messages = pushTokens.map((token) => ({
      to: token,
      sound: "default",
      title: title,
      body: message,
      data: { type: "notification" }, // Optional: Add custom data if needed
    }));

    try {
      // Send bulk push notification request to Expo
      const response = await axios.post(
        "https://exp.host/--/api/v2/push/send",
        messages,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      // Handle Expo API response
      const { data } = response;
      if (data.errors) {
        console.error("Expo API errors:", data.errors);
        return res.status(500).json({
          success: false,
          message: "Failed to send some notifications",
          data: data.errors,
        });
      }

      res.json({
        success: true,
        message: "Push notifications sent successfully",
        data: data.data, // Contains ticket IDs for each notification
      });
    } catch (error) {
      console.error(
        "Error sending push notifications:",
        error.response?.data || error.message
      );
      res.status(500).json({
        success: false,
        message: "Failed to send push notifications",
        data: error.response?.data || null,
      });
    }
  }
);

module.exports = router;

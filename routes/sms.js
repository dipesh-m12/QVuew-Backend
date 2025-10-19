const express = require("express");
const router = express.Router();
const redis = require("redis");
const { body, validationResult } = require("express-validator");
const twilio = require("twilio");
const { v4: uuidv4 } = require("uuid");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient
  .connect()
  .catch((err) => console.error("Redis connection error:", err));

// Twilio client setup
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const CODE_TTL = 15 * 60; // 15 minutes in seconds

// Generate SMS Code
router.post(
  "/generate-sms",
  [
    body("phone.dialCode")
      .notEmpty()
      .withMessage("Dial code is required")
      .matches(/^\+\d{1,4}$/)
      .withMessage("Invalid dial code format (e.g., +91)"),
    body("phone.number")
      .notEmpty()
      .withMessage("Phone number is required")
      .matches(/^\d{7,15}$/)
      .withMessage("Phone number must be 7-15 digits"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { phone } = req.body; // phone: { dialCode, number }
    const fullPhoneNumber = `${phone.dialCode}${phone.number}`; // e.g., +19784648972
    const uuid = uuidv4();
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    try {
      // Store phone and code in Redis
      await redisClient.setEx(
        `sms:${uuid}`,
        CODE_TTL,
        JSON.stringify({ phone, code })
      );

      // Send SMS via Twilio
      try {
        await twilioClient.messages.create({
          body: `Your Qveuw verification code is ${code}. It is valid for 15 minutes.`,
          from: process.env.TWILIO_PHONE_NUMBER, // e.g., +1234567890
          to: fullPhoneNumber, // e.g., +19784648972
        });
      } catch (twilioError) {
        console.error("Twilio SMS error:", twilioError.message);
        return res.status(500).json({
          success: false,
          message: "Failed to send SMS",
          data: null,
        });
      }

      res.json({
        success: true,
        message: "SMS code sent successfully",
        data: { uuid },
        token: null,
      });
    } catch (error) {
      console.error("Error generating SMS code:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate SMS code",
        data: null,
      });
    }
  }
);

// Verify SMS Code
router.post(
  "/verify-sms",
  [
    body("uuid").notEmpty().withMessage("UUID is required"),
    body("code")
      .notEmpty()
      .withMessage("Code is required")
      .matches(/^\d{4}$/)
      .withMessage("Code must be a 4-digit number"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { uuid, code } = req.body;

    try {
      const storedData = await redisClient.get(`sms:${uuid}`);
      if (!storedData) {
        return res.status(404).json({
          success: false,
          message: "Code not found or expired",
          data: null,
        });
      }

      const { phone, code: storedCode } = JSON.parse(storedData);
      if (storedCode !== code) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid code", data: null });
      }

      // Delete the code from Redis after successful verification
      await redisClient.del(`sms:${uuid}`);

      res.json({
        success: true,
        message: "SMS code verified successfully",
        data: { phone }, // Return phone object: { dialCode, number }
        token: null,
      });
    } catch (error) {
      console.error("Error verifying SMS code:", error);
      res.status(500).json({
        success: false,
        message: "Failed to verify SMS code",
        data: null,
      });
    }
  }
);

module.exports = router;

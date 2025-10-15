const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const redis = require("redis");
const nodemailer = require("nodemailer");
const Vendor = require("../models/Vendor");
const verifyUser = require("../middlewares/verifyUser");
const { body, validationResult } = require("express-validator");

// Redis client
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient
  .connect()
  .catch((err) => console.error("Redis connection error:", err));

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const SESSION_DURATION = "1d"; // 1 day session duration
const CODE_TTL = 900; // 15 minutes for 4-digit code

// Nodemailer setup
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER || "",
    pass: process.env.EMAIL_PASS || "",
  },
});

// Function to generate a unique joining code
const generateUniqueJoiningCode = async () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let joiningCode;
  let isUnique = false;

  while (!isUnique) {
    // Generate a 6-character code
    joiningCode = Array(6)
      .fill()
      .map(() =>
        characters.charAt(Math.floor(Math.random() * characters.length))
      )
      .join("");
    // Check if the code already exists
    const existingVendor = await Vendor.findOne({ joiningCode });
    if (!existingVendor) isUnique = true;
  }

  return joiningCode;
};

// Register Vendor
router.post(
  "/register",
  [
    body("accountType")
      .isIn(["owner", "helper"])
      .withMessage("Invalid account type"),
    body("fullName").notEmpty().withMessage("Full name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("phoneNumber.dialCode")
      .notEmpty()
      .withMessage("Dial code is required"),
    body("phoneNumber.number")
      .notEmpty()
      .withMessage("Phone number is required"),
    body("businessName").notEmpty().withMessage("Business name is required"),
    body("businessType").notEmpty().withMessage("Business type is required"),
    body("businessAddress")
      .notEmpty()
      .withMessage("Business address is required"),
    body("noOfSeats")
      .isInt({ min: 0 })
      .withMessage("Valid number of seats is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("pushToken")
      .optional()
      .isString()
      .withMessage("Push token must be a string"),
    body("inactivityReminder")
      .optional()
      .custom((value) => {
        if (value && typeof value !== "object")
          throw new Error("Inactivity reminder must be an object");
        if (value && (!("time" in value) || !("status" in value)))
          throw new Error("Inactivity reminder must include time and status");
        if (
          value &&
          (typeof value.time !== "number" || typeof value.status !== "boolean")
        )
          throw new Error(
            "Inactivity reminder time must be a number and status must be a boolean"
          );
        return true;
      })
      .withMessage("Invalid inactivity reminder format"),
    body("helperJointBusiness")
      .optional()
      .isString()
      .withMessage("Helper joint business must be a string (Vendor _id)"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });

    const {
      accountType,
      fullName,
      email,
      phoneNumber,
      businessName,
      businessType,
      businessAddress,
      noOfSeats,
      password,
      workingHours,
      receiveNotification,
      pushToken,
      inactivityReminder, // Added to destructuring
      helperJointBusiness, // Added to destructuring
    } = req.body;

    const existingVendor = await Vendor.findOne({ email });
    if (existingVendor) {
      if (existingVendor.isDeleted) {
        await Vendor.deleteOne({ _id: existingVendor._id }); // Hard delete previous deleted account
      } else {
        return res.status(400).json({
          success: false,
          message: "Email already in use",
          data: null,
        });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const joiningCode = await generateUniqueJoiningCode(); // Generate unique joining code
    const vendor = new Vendor({
      accountType,
      fullName,
      email,
      phoneNumber,
      businessName,
      businessType,
      businessAddress,
      noOfSeats,
      password: hashedPassword,
      workingHours,
      receiveNotification,
      pushToken,
      inactivityReminder, // Added to vendor object
      helperJointBusiness, // Added to vendor object
      joiningCode, // Add the unique joining code
    });
    await vendor.save();

    res.status(201).json({
      success: true,
      message: "Vendor registered successfully",
      data: { joiningCode }, // Return the joining code in the response
    });
  }
);

// Login Vendor
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const vendor = await Vendor.findOne({
    email,
    isDeleted: false,
    isSuspended: false,
  });
  if (!vendor || !(await bcrypt.compare(password, vendor.password)))
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials", data: null });

  const session = `vendor:${vendor._id}:${Date.now()}`;
  const token = jwt.sign(
    { id: vendor._id, type: "vendor", session },
    JWT_SECRET,
    {
      expiresIn: SESSION_DURATION,
    }
  );
  await redisClient.setEx(
    session,
    24 * 60 * 60,
    JSON.stringify({ id: vendor._id, type: "vendor" })
  );
  await redisClient.sAdd(`activeSessions:${vendor._id}`, session);

  res.json({
    success: true,
    message: "Login successful",
    data: null,
    token,
  });
});

// Auto Login
router.get("/autologin", verifyUser, async (req, res) => {
  const vendor = await Vendor.findById(req.user.id).select("-password");
  if (!vendor)
    return res
      .status(404)
      .json({ success: false, message: "Vendor not found", data: null });
  if (vendor.isDeleted)
    return res
      .status(403)
      .json({ success: false, message: "Account is deleted", data: null });
  if (vendor.isSuspended)
    return res
      .status(403)
      .json({ success: false, message: "Account is suspended", data: null });

  res.json({
    success: true,
    message: "Auto login successful",
    data: { vendor },
    token: req.headers["authorization"].split(" ")[1],
  });
});

// Forgot Password
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email is required", data: null });

  const vendor = await Vendor.findOne({ email, isDeleted: false });
  if (!vendor)
    return res
      .status(404)
      .json({ success: false, message: "Vendor not found", data: null });

  await redisClient.del(`forgot:${vendor._id}`); // Clear previous code if exists (optional cleanup)
  const uuid = require("uuid").v4();
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  await redisClient.setEx(
    `forgot:${uuid}`, // Use uuid as the key
    CODE_TTL,
    JSON.stringify({ code, vendorId: vendor._id }) // Store vendorId with the code
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

// Verify 4-Digit Code
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

  const { code: storedCode, vendorId } = JSON.parse(storedData);
  if (storedCode !== code)
    return res
      .status(400)
      .json({ success: false, message: "Invalid code", data: null });

  //   // Optionally verify vendor exists
  //   const vendor = await Vendor.findById(vendorId);
  //   if (!vendor || vendor.isDeleted)
  //     return res
  //       .status(404)
  //       .json({ success: false, message: "Vendor not found", data: null });

  res.json({
    success: true,
    message: "Code verified",
    data: { vendorId }, // Return vendorId for next step
    token: null,
  });
});

// Reset Password
router.post("/reset-password", async (req, res) => {
  const { uuid, code, newPassword } = req.body;
  if (!uuid || !code || !newPassword)
    return res
      .status(400)
      .json({ success: false, message: "All fields are required", data: null });

  const storedData = await redisClient.get(`forgot:${uuid}`);
  if (!storedData)
    return res
      .status(404)
      .json({ success: false, message: "Invalid or expired code", data: null });

  const { code: storedCode, vendorId } = JSON.parse(storedData);
  if (storedCode !== code)
    return res
      .status(400)
      .json({ success: false, message: "Invalid code", data: null });

  const vendor = await Vendor.findById(vendorId);
  if (!vendor || vendor.isDeleted)
    return res
      .status(404)
      .json({ success: false, message: "Vendor not found", data: null });

  vendor.password = await bcrypt.hash(newPassword, 10);
  await vendor.save();
  await redisClient.del(`forgot:${uuid}`); // Delete only after successful reset

  res.json({
    success: true,
    message: "Password reset successfully",
    data: null,
    token: null,
  });
});

// Change Password
router.post("/change-password", verifyUser, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const vendor = await Vendor.findById(req.user.id);
  if (!vendor || vendor.isDeleted || vendor.isSuspended)
    return res.status(404).json({
      success: false,
      message: "Vendor not found or inactive",
      data: null,
    });
  if (!(await bcrypt.compare(oldPassword, vendor.password)))
    return res
      .status(401)
      .json({ success: false, message: "Invalid old password", data: null });

  vendor.password = await bcrypt.hash(newPassword, 10);
  await vendor.save();
  res.json({
    success: true,
    message: "Password changed successfully",
    data: null,
  });
});

// Logout
router.post("/logout", verifyUser, async (req, res) => {
  const { session } = req.user;
  try {
    await redisClient.del(session);
    await redisClient.sRem(`activeSessions:${req.user.id}`, session);
    res.json({
      success: true,
      message: "Logged out from current session",
      data: null,
    });
  } catch (error) {
    console.error("Error logging out:", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error", data: null });
  }
});

// Logout from All Devices
router.post("/logout-all-devices", verifyUser, async (req, res) => {
  const { id: vendorId } = req.user;
  const vendor = await Vendor.findById(vendorId);
  if (!vendor || vendor.isDeleted || vendor.isSuspended)
    return res.status(404).json({
      success: false,
      message: "Vendor not found or inactive",
      data: null,
    });

  try {
    const sessions = await redisClient.sMembers(`activeSessions:${vendorId}`);
    if (sessions.length > 0) {
      await redisClient.del(sessions);
      await redisClient.del(`activeSessions:${vendorId}`);
    }
    res.json({
      success: true,
      message: "Logged out from all devices",
      data: null,
    });
  } catch (error) {
    console.error("Error logging out from all devices:", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error", data: null });
  }
});

// Update Vendor
router.put("/update", verifyUser, async (req, res) => {
  const {
    avatar,
    fullName,
    phoneNumber,
    businessName,
    businessType,
    businessAddress,
    noOfSeats,
    isDeleted,
    isSuspended,
    receiveNotification,
    workingHours,
    twoFA,
    privacyMode,
    inactivityReminder,
    active,
    helperJointBusiness,
    connectedHelpers,
    pushToken,
  } = req.body;

  const vendor = await Vendor.findById(req.user.id);
  if (!vendor)
    return res.status(404).json({
      success: false,
      message: "Vendor not found or inactive",
      data: null,
    });

  // Update only the provided fields, preserving unique/critical fields
  vendor.avatar = avatar || vendor.avatar;
  vendor.fullName = fullName || vendor.fullName;
  vendor.phoneNumber = phoneNumber || vendor.phoneNumber;
  vendor.businessName = businessName || vendor.businessName;
  vendor.businessType = businessType || vendor.businessType;
  vendor.businessAddress = businessAddress || vendor.businessAddress;
  vendor.noOfSeats = noOfSeats !== undefined ? noOfSeats : vendor.noOfSeats;
  vendor.isDeleted = isDeleted !== undefined ? isDeleted : vendor.isDeleted;
  vendor.isSuspended =
    isSuspended !== undefined ? isSuspended : vendor.isSuspended;
  vendor.receiveNotification =
    receiveNotification !== undefined
      ? receiveNotification
      : vendor.receiveNotification;
  vendor.workingHours = workingHours || vendor.workingHours;
  vendor.twoFA = twoFA !== undefined ? twoFA : vendor.twoFA;
  vendor.privacyMode =
    privacyMode !== undefined ? privacyMode : vendor.privacyMode;
  vendor.inactivityReminder = inactivityReminder || vendor.inactivityReminder;
  vendor.active = active !== undefined ? active : vendor.active;
  vendor.helperJointBusiness =
    helperJointBusiness || vendor.helperJointBusiness;
  vendor.connectedHelpers = connectedHelpers || vendor.connectedHelpers;
  vendor.pushToken = pushToken || vendor.pushToken;

  await vendor.save();
  res.json({
    success: true,
    message: "Vendor updated successfully",
    data: null,
  });
});

// Check Admin
router.get("/check-admin", verifyUser, async (req, res) => {
  const vendor = await Vendor.findById(req.user.id).select("-password");
  if (!vendor) {
    return res
      .status(404)
      .json({ success: false, message: "Vendor not found", data: null });
  }

  res.json({
    success: true,
    message: "Admin verified",
    data: { vendor },
    token: req.headers["authorization"].split(" ")[1],
  });
});

module.exports = router;

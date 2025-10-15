const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const redis = require("redis");
const User = require("../models/User");
const verifyUser = require("../middlewares/verifyUser");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const SESSION_DURATION = "1d"; // Login session duration

// Register
router.post("/register", async (req, res) => {
  const {
    firstName,
    lastName,
    phone,
    gender,
    dob,
    email,
    password,
    pushToken,
  } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    if (existingUser.isDeleted) {
      await User.deleteOne({ _id: existingUser._id }); // Hard delete previous deleted account
    } else {
      return res
        .status(400)
        .json({ success: false, message: "Email already in use", data: null });
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({
    firstName,
    lastName,
    phone,
    gender,
    dob,
    email,
    password: hashedPassword,
    pushToken,
  });
  await user.save();

  res
    .status(201)
    .json({ success: true, message: "Registration successful", data: null });
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({
    email,
    isDeleted: false,
    isSuspended: false,
  });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials", data: null });
  }

  const session = `user:${user._id}:${Date.now()}`;
  const token = jwt.sign({ id: user._id, type: "user", session }, JWT_SECRET, {
    expiresIn: SESSION_DURATION,
  });
  await redisClient.setEx(
    session,
    24 * 60 * 60,
    JSON.stringify({ id: user._id, type: "user" })
  );
  await redisClient.sAdd(`activeSessions:${user._id}`, session); // Add session to set

  res.json({
    success: true,
    message: "Login successful",
    data: null,
    token,
  });
});

// Auto Login
router.get("/autologin", verifyUser, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });
  if (user.isDeleted)
    return res
      .status(403)
      .json({ success: false, message: "Account is deleted", data: null });
  if (user.isSuspended)
    return res
      .status(403)
      .json({ success: false, message: "Account is suspended", data: null });

  res.json({
    success: true,
    message: "Auto login successful",
    data: { user },
    token: req.headers["authorization"].split(" ")[1],
  });
});

// Change Password
router.post("/change-password", verifyUser, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  const user = await User.findById(req.user.id);
  if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid old password", data: null });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({
    success: true,
    message: "Password changed successfully",
    data: null,
  });
});

// Update Account
router.put("/update", verifyUser, async (req, res) => {
  const {
    firstName,
    lastName,
    phone,
    gender,
    dob,
    pushToken,
    isSuspended,
    isDeleted,
    deleteReason,
    avatar,
    receiveNotifications,
    twoFA,
  } = req.body;
  const user = await User.findById(req.user.id);

  if (!user)
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });
  if (isDeleted && !deleteReason)
    return res
      .status(400)
      .json({ success: false, message: "Delete reason required", data: null });

  user.firstName = firstName || user.firstName;
  user.lastName = lastName || user.lastName;
  user.phone = phone || user.phone;
  user.gender = gender || user.gender;
  user.dob = dob || user.dob;
  user.pushToken = pushToken || user.pushToken;
  user.isSuspended = isSuspended !== undefined ? isSuspended : user.isSuspended;
  user.isDeleted = isDeleted !== undefined ? isDeleted : user.isDeleted;
  user.deleteReason = isDeleted ? deleteReason : user.deleteReason;
  user.avatar = avatar || user.avatar;
  user.receiveNotifications =
    receiveNotifications !== undefined
      ? receiveNotifications
      : user.receiveNotifications;
  user.twoFA = twoFA !== undefined ? twoFA : user.twoFA;

  await user.save();
  res.json({
    success: true,
    message: "Account updated successfully",
    data: null,
  });
});

// Logout from All Devices
router.post("/logout-all-devices", verifyUser, async (req, res) => {
  const { id: userId } = req.user;

  try {
    const sessions = await redisClient.sMembers(`activeSessions:${userId}`);
    if (sessions.length > 0) {
      await redisClient.del(sessions); // Delete all session keys
      await redisClient.del(`activeSessions:${userId}`); // Delete the set
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

// Logout Single Session
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

router.post("/get-user-data", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res
      .status(400)
      .json({ success: false, message: "Email is required", data: null });

  const user = await User.findOne({
    email,
    isDeleted: false,
    isSuspended: false,
  }).select("-password");
  if (!user)
    return res.status(404).json({
      success: false,
      message: "User not found or inactive",
      data: null,
    });

  const session = `user:${user._id}:${Date.now()}`;
  const token = jwt.sign({ id: user._id, type: "user", session }, JWT_SECRET, {
    expiresIn: SESSION_DURATION,
  });
  await redisClient.setEx(
    session,
    24 * 60 * 60,
    JSON.stringify({ id: user._id, type: "user" })
  );
  await redisClient.sAdd(`activeSessions:${user._id}`, session);

  res.json({
    success: true,
    message: "User data retrieved",
    data: { user },
    token,
  });
});

router.get("/check-user", verifyUser, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  if (!user) {
    return res
      .status(404)
      .json({ success: false, message: "User not found", data: null });
  }

  res.json({
    success: true,
    message: "User exists",
    data: { user },
    token: req.headers["authorization"].split(" ")[1],
  });
});

module.exports = router;

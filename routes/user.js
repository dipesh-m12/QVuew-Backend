const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const verifyUser = require("../middlewares/verifyUser");

// User Registration
router.post(
  "/register",
  [
    body("firstName").notEmpty().withMessage("First name is required"),
    body("lastName").notEmpty().withMessage("Last name is required"),
    body("phone.dialCode").notEmpty().withMessage("Dial code is required"),
    body("phone.number").notEmpty().withMessage("Phone number is required"),
    body("gender")
      .isIn(["male", "female", "other"])
      .withMessage("Invalid gender"),
    body("dob")
      .isISO8601()
      .toDate()
      .withMessage("Valid date of birth is required"),
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        data: errors.array(),
      });
    }

    const { firstName, lastName, phone, gender, dob, email, password } =
      req.body;

    try {
      // Check for existing email, including soft-deleted accounts
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        if (existingUser.isDeleted) {
          await User.deleteOne({ _id: existingUser._id });
        } else {
          return res.status(400).json({
            status: "error",
            message: "Email already exists",
            data: null,
          });
        }
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      const user = new User({
        _id: uuidv4(),
        firstName,
        lastName,
        phone,
        gender,
        dob,
        email,
        password: hashedPassword,
      });

      await user.save();

      req.session.userId = user._id;
      req.session.role = "user";

      res.status(201).json({
        status: "success",
        message: "User registered successfully",
        data: null,
      });
    } catch (err) {
      res.status(500).json({
        status: "error",
        message: "Server error",
        data: { error: err.message },
      });
    }
  }
);

// User Login
router.post(
  "/login",
  [
    body("email").trim().isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        data: errors.array(),
      });
    }

    const { email, password } = req.body;

    try {
      const user = await User.findOne({ email, isDeleted: false });
      if (!user) {
        return res.status(400).json({
          status: "error",
          message: "Invalid credentials",
          data: null,
        });
      }

      if (user.isSuspended) {
        return res.status(403).json({
          status: "error",
          message: "Account is suspended",
          data: null,
        });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(400).json({
          status: "error",
          message: "Invalid credentials",
          data: null,
        });
      }

      req.session.userId = user._id;
      req.session.role = "user";

      res
        .status(200)
        .json({ status: "success", message: "Login successful", data: user });
    } catch (err) {
      res.status(500).json({
        status: "error",
        message: "Server error",
        data: { error: err.message },
      });
    }
  }
);

// Change Password
router.post(
  "/change-password",
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 6 })
      .withMessage("New password must be at least 6 characters"),
  ],
  verifyUser,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        data: errors.array(),
      });
    }

    const { currentPassword, newPassword } = req.body;

    try {
      const user = await User.findById(req.session.userId);
      if (!user || user.isDeleted) {
        return res.status(401).json({
          status: "error",
          message: "Account deleted or not found",
          data: null,
        });
      }

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({
          status: "error",
          message: "Invalid current password",
          data: null,
        });
      }

      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(newPassword, salt);
      await user.save();

      res.status(200).json({
        status: "success",
        message: "Password changed successfully",
        data: null,
      });
    } catch (err) {
      res.status(500).json({
        status: "error",
        message: "Server error",
        data: { error: err.message },
      });
    }
  }
);

// Update Profile
router.put(
  "/update-profile",
  [
    body("firstName")
      .optional()
      .notEmpty()
      .withMessage("First name cannot be empty"),
    body("lastName")
      .optional()
      .notEmpty()
      .withMessage("Last name cannot be empty"),
    body("phone.dialCode")
      .optional()
      .notEmpty()
      .withMessage("Dial code cannot be empty"),
    body("phone.number")
      .optional()
      .notEmpty()
      .withMessage("Phone number cannot be empty"),
    body("gender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Invalid gender"),
    body("dob")
      .optional()
      .isISO8601()
      .toDate()
      .withMessage("Valid date of birth is required"),
    body("email")
      .optional()
      .trim()
      .isEmail()
      .withMessage("Valid email is required"),
    body("receiveNotifications")
      .optional()
      .isBoolean()
      .withMessage("Receive notifications must be a boolean"),
    body("twoFA").optional().isBoolean().withMessage("2FA must be a boolean"),
    body("avatar").optional().isString().withMessage("Avatar must be a string"),
    body("isSuspended")
      .optional()
      .isBoolean()
      .withMessage("Suspended status must be a boolean"),
    body("isDeleted")
      .optional()
      .isBoolean()
      .withMessage("Deleted status must be a boolean"),
    body("deleteReason")
      .optional()
      .isString()
      .withMessage("Delete reason must be a string"),
  ],
  verifyUser,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: "error",
        message: "Validation failed",
        data: errors.array(),
      });
    }

    const {
      firstName,
      lastName,
      phone,
      gender,
      dob,
      email,
      receiveNotifications,
      twoFA,
      avatar,
      isSuspended,
      isDeleted,
      deleteReason,
    } = req.body;

    try {
      const user = await User.findById(req.session.userId);
      if (!user || user.isDeleted) {
        return res.status(401).json({
          status: "error",
          message: "Account deleted or not found",
          data: null,
        });
      }

      // Only admins can toggle isSuspended or isDeleted
      //   if (
      //     (isSuspended !== undefined || isDeleted !== undefined) &&
      //     req.session.role !== "admin"
      //   ) {
      //     return res.status(403).json({
      //       status: "error",
      //       message: "Unauthorized to change suspension or deletion status",
      //       data: null,
      //     });
      //   }

      // Update allowed fields
      if (firstName) user.firstName = firstName;
      if (lastName) user.lastName = lastName;
      if (phone) user.phone = phone;
      if (gender) user.gender = gender;
      if (dob) user.dob = dob;
      if (email && email !== user.email) {
        const emailExists = await User.findOne({ email });
        if (emailExists) {
          if (emailExists.isDeleted) {
            await User.deleteOne({ _id: emailExists._id });
          } else {
            return res.status(400).json({
              status: "error",
              message: "Email already exists",
              data: null,
            });
          }
        }
        user.email = email;
      }
      if (receiveNotifications !== undefined)
        user.receiveNotifications = receiveNotifications;
      if (twoFA !== undefined) user.twoFA = twoFA;
      if (avatar) user.avatar = avatar;
      if (isSuspended !== undefined) user.isSuspended = isSuspended;
      if (isDeleted !== undefined) {
        user.isDeleted = isDeleted;
        if (isDeleted && deleteReason) user.deleteReason = deleteReason;
      }

      await user.save();

      // Destroy session if user is deleted
      if (isDeleted) {
        req.session.destroy((err) => {
          if (err) {
            return res.status(500).json({
              status: "error",
              message: "Failed to destroy session",
              data: { error: err.message },
            });
          }
        });
      }

      res.status(200).json({
        status: "success",
        message: "Profile updated successfully",
        data: null,
      });
    } catch (err) {
      res.status(500).json({
        status: "error",
        message: "Server error",
        data: { error: err.message },
      });
    }
  }
);

// Auto-login
router.get("/autologin", verifyUser, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select(
      "-password -deleteReason"
    );
    if (!user || user.isSuspended || user.isDeleted) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized, suspended, or deleted",
        data: null,
      });
    }
    res
      .status(200)
      .json({ status: "success", message: "Autologin successful", data: user });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Server error",
      data: { error: err.message },
    });
  }
});

module.exports = router;

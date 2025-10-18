const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const Vendor = require("../models/Vendor");

// Request to Join Business using joiningCode (only by helper account)
router.post(
  "/request-join-code",
  verifyUser,
  [body("joiningCode").notEmpty().withMessage("Joining code is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { joiningCode } = req.body;
    const helperId = req.user.id;

    // Verify helper account
    const helper = await Vendor.findById(helperId);
    if (
      !helper ||
      helper.isDeleted ||
      helper.isSuspended ||
      helper.accountType !== "helper"
    ) {
      return res.status(403).json({
        success: false,
        message: "Only active helpers can request to join",
        data: null,
      });
    }

    // Verify business exists by joiningCode
    const business = await Vendor.findOne({
      joiningCode,
      accountType: "owner",
      isDeleted: false,
      isSuspended: false,
    });
    if (!business) {
      return res.status(404).json({
        success: false,
        message: "Invalid joining code or business not found",
        data: null,
      });
    }

    // Check if already requested
    const existingRequest = business.connectedHelpers.find(
      (ch) => ch.helperId === helperId
    );
    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message: "Request already exists",
        data: null,
      });
    }

    // Add new helper request
    business.connectedHelpers.push({
      _id: uuidv4(),
      helperId: helperId,
      requestJoiningDate: new Date(),
    });

    await business.save();
    res.status(201).json({
      success: true,
      message: "Join request sent successfully",
      data: null,
    });
  }
);

// Get All Connected Helpers (all statuses, no authentication required)
router.get("/connected-helpers/:businessId", async (req, res) => {
  const { businessId } = req.params;

  try {
    const business = await Vendor.findById(businessId)
      .populate("connectedHelpers.helperId", "-workingHours -password")
      .select("connectedHelpers");
    if (!business || business.isDeleted) {
      return res
        .status(404)
        .json({ success: false, message: "Business not found", data: null });
    }

    res.json({
      success: true,
      message: "Connected helpers retrieved successfully",
      data: business.connectedHelpers,
    });
  } catch (error) {
    console.error("Error retrieving connected helpers:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve connected helpers",
      data: null,
    });
  }
});

// Get Vendor by _id or joiningCode (no authentication required)
router.get("/vendor", async (req, res) => {
  const { id, joiningCode } = req.query;

  try {
    let vendor;
    if (id) {
      vendor = await Vendor.findById(id).select("-password");
    } else if (joiningCode) {
      vendor = await Vendor.findOne({ joiningCode }).select("-password");
    } else {
      return res.status(400).json({
        success: false,
        message: "Either id or joiningCode is required",
        data: null,
      });
    }

    if (!vendor || vendor.isDeleted) {
      return res
        .status(404)
        .json({ success: false, message: "Vendor not found", data: null });
    }

    res.json({
      success: true,
      message: "Vendor retrieved successfully",
      data: vendor,
    });
  } catch (error) {
    console.error("Error retrieving vendor:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve vendor",
      data: null,
    });
  }
});

// Update Connected Helper (by business owner or helper themselves)
router.put(
  "/connected-helpers/:helperId",
  verifyUser,
  [
    body("active")
      .optional()
      .isBoolean()
      .withMessage("Active must be a boolean"),
    body("status")
      .optional()
      .isIn(["pending", "accepted", "rejected", "removed"])
      .withMessage("Invalid status"),
    body("joiningAcceptedDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format"),
    body("associatedServices")
      .optional()
      .isArray()
      .withMessage("Associated services must be an array"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { helperId } = req.params;
    const { active, status, joiningAcceptedDate, associatedServices } =
      req.body;
    const userId = req.user.id;

    try {
      const business = await Vendor.findOne({
        "connectedHelpers._id": helperId,
      });
      if (!business || business.isDeleted || business.isSuspended) {
        return res
          .status(404)
          .json({ success: false, message: "Business not found", data: null });
      }

      const helperConnection = business.connectedHelpers.find(
        (ch) => ch._id === helperId
      );
      if (!helperConnection) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Helper connection not found",
            data: null,
          });
      }

      // Check authorization: owner can update any, helper can only update their own
      if (
        business.accountType !== "owner" &&
        helperConnection.helperId !== userId
      ) {
        return res
          .status(403)
          .json({
            success: false,
            message:
              "Only owner or the helper themselves can update this connection",
            data: null,
          });
      }

      if (active !== undefined) helperConnection.active = active;
      if (status) helperConnection.status = status;
      if (joiningAcceptedDate)
        helperConnection.joiningAcceptedDate = new Date(joiningAcceptedDate);
      if (associatedServices)
        helperConnection.associatedServices = associatedServices;

      await business.save();
      res.json({
        success: true,
        message: "Helper connection updated successfully",
        data: helperConnection,
      });
    } catch (error) {
      console.error("Error updating helper connection:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update helper connection",
        data: null,
      });
    }
  }
);

module.exports = router;

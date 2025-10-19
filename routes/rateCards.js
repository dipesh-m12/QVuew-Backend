const express = require("express");
const router = express.Router();
const RateCard = require("../models/RateCard");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const Vendor = require("../models/Vendor");

// Create Rate Cards (List of objects, requires authentication)
router.post(
  "/rate-cards",
  verifyUser,
  [
    body("rateCards")
      .isArray({ min: 1 })
      .withMessage("Rate cards must be a non-empty array"),
    body("rateCards.*.name").notEmpty().withMessage("Service name is required"),
    body("rateCards.*.gender")
      .isArray({ min: 1 })
      .withMessage("Gender must be a non-empty array"),
    body("rateCards.*.gender.*")
      .isIn(["male", "female", "child"])
      .withMessage("Each gender must be one of: male, female, child"),
    body("rateCards.*.duration")
      .isInt({ min: 1 })
      .withMessage("Duration must be a positive integer"),
    body("rateCards.*.rate")
      .isFloat({ min: 0 })
      .withMessage("Rate must be a non-negative number"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { rateCards } = req.body;
    const vendorId = req.user.id;

    // Verify vendor exists
    const vendor = await Vendor.findById(vendorId);
    if (!vendor || vendor.isDeleted || vendor.isSuspended) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or inactive",
        data: null,
      });
    }

    try {
      const newRateCards = rateCards.map((card) => ({
        _id: uuidv4(),
        name: card.name,
        gender: card.gender, // Now an array
        duration: card.duration,
        rate: card.rate,
        createdBy: vendorId,
      }));

      const createdRateCards = await RateCard.insertMany(newRateCards);
      res.status(201).json({
        success: true,
        message: "Rate cards created successfully",
        data: createdRateCards,
      });
    } catch (error) {
      console.error("Error creating rate cards:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create rate cards",
        data: null,
      });
    }
  }
);

// Get Rate Cards (by vendor ID or list of service IDs, no authentication required)
router.get("/rate-cards", async (req, res) => {
  const { vendorId, serviceIds } = req.query;
  try {
    let rateCards;
    if (serviceIds) {
      const ids = Array.isArray(serviceIds)
        ? serviceIds
        : serviceIds.split(",");
      rateCards = await RateCard.find({ _id: { $in: ids }, isDeleted: false });
    } else if (vendorId) {
      rateCards = await RateCard.find({
        createdBy: vendorId,
        isDeleted: false,
      });
    } else {
      rateCards = await RateCard.find({ isDeleted: false });
    }

    res.json({
      success: true,
      message: "Rate cards retrieved successfully",
      data: rateCards,
    });
  } catch (error) {
    console.error("Error retrieving rate cards:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve rate cards",
      data: null,
    });
  }
});

// Edit Rate Card (by owner only, requires authentication)
router.put(
  "/rate-cards/:id",
  verifyUser,
  [
    body("name")
      .optional()
      .notEmpty()
      .withMessage("Service name cannot be empty"),
    body("gender")
      .optional()
      .isArray({ min: 1 })
      .withMessage("Gender must be a non-empty array"),
    body("gender.*")
      .optional()
      .isIn(["male", "female", "child"])
      .withMessage("Each gender must be one of: male, female, child"),
    body("duration")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Duration must be a positive integer"),
    body("rate")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Rate must be a non-negative number"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { id } = req.params;
    const { name, gender, duration, rate } = req.body;
    const vendorId = req.user.id;

    try {
      const rateCard = await RateCard.findById(id);
      if (!rateCard) {
        return res
          .status(404)
          .json({ success: false, message: "Rate card not found", data: null });
      }

      if (rateCard.createdBy !== vendorId) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to edit this rate card",
          data: null,
        });
      }

      rateCard.name = name || rateCard.name;
      rateCard.gender = gender || rateCard.gender; // Update to array
      rateCard.duration = duration || rateCard.duration;
      rateCard.rate = rate || rateCard.rate;

      await rateCard.save();
      res.json({
        success: true,
        message: "Rate card updated successfully",
        data: rateCard,
      });
    } catch (error) {
      console.error("Error updating rate card:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update rate card",
        data: null,
      });
    }
  }
);

// Delete Rate Card (by owner only, requires authentication)
router.delete("/rate-cards/:id", verifyUser, async (req, res) => {
  const { id } = req.params;
  const vendorId = req.user.id;

  try {
    const rateCard = await RateCard.findById(id);
    if (!rateCard) {
      return res
        .status(404)
        .json({ success: false, message: "Rate card not found", data: null });
    }

    if (rateCard.createdBy !== vendorId) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to delete this rate card",
        data: null,
      });
    }

    rateCard.isDeleted = true;
    await rateCard.save();
    res.json({
      success: true,
      message: "Rate card marked as deleted successfully",
      data: null,
    });
  } catch (error) {
    console.error("Error marking rate card as deleted:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark rate card as deleted",
      data: null,
    });
  }
});

module.exports = router;

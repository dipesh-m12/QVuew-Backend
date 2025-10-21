const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const DeviceLogin = require("../models/DeviceLogin");

// Store Device Login Data
router.post(
  "/",
  verifyUser,
  [
    body("deviceInfo.brand").notEmpty().withMessage("Device brand is required"),
    body("deviceInfo.modelName")
      .notEmpty()
      .withMessage("Device model name is required"),
    body("location.address").optional().isString(),
    body("location.coordinates.latitude")
      .optional()
      .isFloat({ min: -90, max: 90 }),
    body("location.coordinates.longitude")
      .optional()
      .isFloat({ min: -180, max: 180 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { deviceInfo, location } = req.body;
    const vendorId = req.user.id;

    try {
      const deviceLogin = new DeviceLogin({
        vendorId,
        deviceInfo,
        location,
      });
      await deviceLogin.save();

      res.json({
        success: true,
        message: "Device login recorded",
        data: { deviceLoginId: deviceLogin._id },
      });
    } catch (error) {
      console.error("Error recording device login:", error);
      res.status(500).json({
        success: false,
        message: "Failed to record device login",
        data: null,
      });
    }
  }
);

// Get Device Login History for Vendor
router.get("/", verifyUser, async (req, res) => {
  const vendorId = req.user.id;

  try {
    const deviceLogins = await DeviceLogin.find({ vendorId }).sort({
      loginTime: -1,
    });
    res.json({
      success: true,
      message: "Device login history retrieved",
      data: deviceLogins,
    });
  } catch (error) {
    console.error("Error retrieving device login history:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve device login history",
      data: null,
    });
  }
});

module.exports = router;

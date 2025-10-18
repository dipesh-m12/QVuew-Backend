const express = require("express");
const router = express.Router();
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const Vendor = require("../models/Vendor");
const PaymentPlan = require("../models/paymentModel");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Create Order (Monthly/Yearly subscription)
router.post(
  "/create-order",
  verifyUser,
  [
    body("planType")
      .isIn(["monthly", "yearly"])
      .withMessage("Plan type must be monthly or yearly"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { planType } = req.body;
    const vendorId = req.user.id;

    try {
      // Verify vendor is owner
      const vendor = await Vendor.findById(vendorId);
      if (
        !vendor ||
        vendor.isDeleted ||
        vendor.isSuspended ||
        vendor.accountType !== "owner"
      ) {
        return res.status(403).json({
          success: false,
          message: "Only active owners can create orders",
          data: null,
        });
      }

      // Check for active plan
      const now = new Date();
      now.setHours(now.getUTCHours() + 5 + 30); // Adjust to IST (02:11 PM IST on Oct 18, 2025)
      const activePlan = await PaymentPlan.findOne({
        vendorId,
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
      });
      if (activePlan) {
        return res.status(400).json({
          success: false,
          message: "Cannot create new order, an active plan exists",
          data: null,
        });
      }

      const amount = planType === "monthly" ? 84000 : 755000; // ₹840 = 84000 paise, ₹7550 = 755000 paise
      const orderId = `order_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      const startDate = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + (planType === "monthly" ? 1 : 12));

      const options = {
        amount: amount, // in paise
        currency: "INR",
        receipt: orderId,
        notes: {
          vendorId: vendorId,
          planType: planType,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      };

      const razorpayOrder = await razorpay.orders.create(options);

      // Create pending payment plan record
      const paymentPlan = new PaymentPlan({
        vendorId,
        planType,
        amount: amount / 100, // Store in rupees for record
        orderId: razorpayOrder.id,
        startDate,
        endDate,
      });
      await paymentPlan.save();

      res.json({
        success: true,
        message: "Order created successfully",
        data: {
          orderId: razorpayOrder.id,
          amount: amount / 100, // Return in rupees
          currency: "INR",
          key: process.env.RAZORPAY_KEY_ID,
          name: vendor.businessName || "Qveuw Premium",
        },
        token: null,
      });
    } catch (error) {
      console.error("Error creating order:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create order",
        data: null,
      });
    }
  }
);

// Verify Payment and Update Plan Status
router.post(
  "/verify-payment",
  [
    body("razorpay_order_id")
      .notEmpty()
      .withMessage("Razorpay order ID is required"),
    body("razorpay_payment_id")
      .notEmpty()
      .withMessage("Razorpay payment ID is required"),
    body("razorpay_signature")
      .notEmpty()
      .withMessage("Razorpay signature is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    try {
      // Verify payment signature
      const sign = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSign = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(sign.toString())
        .digest("hex");

      if (expectedSign !== razorpay_signature) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment signature",
          data: null,
        });
      }

      // Fetch and verify payment
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      if (payment.status !== "captured") {
        return res.status(400).json({
          success: false,
          message: "Payment not captured",
          data: null,
        });
      }

      // Find and update payment plan
      const paymentPlan = await PaymentPlan.findOne({
        orderId: razorpay_order_id,
      });
      if (!paymentPlan) {
        return res.status(404).json({
          success: false,
          message: "Payment plan not found",
          data: null,
        });
      }

      // Update payment plan
      paymentPlan.paymentId = razorpay_payment_id;
      paymentPlan.signature = razorpay_signature;
      paymentPlan.status = "paid";
      paymentPlan.isActive = true;
      await paymentPlan.save();

      // Deactivate any other active plans for this vendor
      await PaymentPlan.updateMany(
        { vendorId: paymentPlan.vendorId, _id: { $ne: paymentPlan._id } },
        { isActive: false }
      );

      res.json({
        success: true,
        message: "Payment verified successfully",
        data: {
          status: "paid",
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          amount: payment.amount / 100,
          currency: payment.currency,
        },
        token: null,
      });
    } catch (error) {
      console.error("Error verifying payment:", error);
      res.status(500).json({
        success: false,
        message: "Failed to verify payment",
        data: null,
      });
    }
  }
);

// Get Vendor Plans (recent or all) with active status check
router.get("/vendor-plans", verifyUser, async (req, res) => {
  const { allPlans } = req.query; // boolean as query param
  const vendorId = req.user.id;

  try {
    // Verify vendor exists
    const vendor = await Vendor.findById(vendorId);
    if (!vendor || vendor.isDeleted || vendor.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "Vendor not found or inactive",
        data: null,
      });
    }

    // Current date and time in Kolkata (IST, UTC+5:30)
    const now = new Date();
    now.setHours(now.getUTCHours() + 5 + 30); // Adjust to IST (02:11 PM IST on Oct 18, 2025)

    let query = { vendorId };
    if (allPlans === "false" || allPlans === "0") {
      // Get most recent active plan
      query = { ...query, startDate: { $lte: now }, endDate: { $gte: now } };
    } else {
      // Get all plans and filter active ones
      query = { ...query };
    }

    const plans = await PaymentPlan.find(query).sort({ createdAt: -1 });

    // Determine active status for each plan
    const plansWithActiveStatus = plans.map((plan) => ({
      ...plan.toObject(),
      isActive:
        plan.startDate <= now && plan.endDate >= now && plan.status === "paid",
    }));

    res.json({
      success: true,
      message: "Plans retrieved successfully",
      data:
        allPlans === "false" || allPlans === "0"
          ? plansWithActiveStatus[0] || null
          : plansWithActiveStatus,
    });
  } catch (error) {
    console.error("Error retrieving plans:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve plans",
      data: null,
    });
  }
});

module.exports = router;

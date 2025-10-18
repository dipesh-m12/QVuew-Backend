const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const paymentPlanSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    vendorId: { type: String, ref: "Vendor", required: true },
    planType: { type: String, enum: ["monthly", "yearly"], required: true },
    amount: { type: Number, required: true }, // Stored in rupees
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "cancelled"],
      default: "pending",
    },
    orderId: { type: String, required: true },
    paymentId: { type: String },
    signature: { type: String },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isActive: { type: Boolean, default: false },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true }
);

// Indexes
paymentPlanSchema.index({ vendorId: 1 });
paymentPlanSchema.index({ status: 1 });
paymentPlanSchema.index({ isActive: 1 });
paymentPlanSchema.index({ startDate: -1 });

module.exports = mongoose.model("PaymentPlan", paymentPlanSchema);

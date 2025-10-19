const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// RateCard Schema
const rateCardSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    name: { type: String, required: true },
    gender: {
      type: [{ type: String, enum: ["male", "female", "child"] }],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message:
          "Gender must be a non-empty array of valid values (male, female, child)",
      },
    },
    duration: { type: Number, required: true }, // in minutes
    rate: { type: Number, required: true },
    createdBy: { type: String, ref: "Vendor", required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes for common queries
rateCardSchema.index({ createdBy: 1 });
// Removed redundant _id index as MongoDB automatically creates it

const RateCard = mongoose.model("RateCard", rateCardSchema);

module.exports = RateCard;

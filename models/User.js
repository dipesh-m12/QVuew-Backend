const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const phoneSchema = new mongoose.Schema({
  dialCode: { type: String, required: true },
  number: { type: String, required: true },
});

// Create compound index for phone fields to optimize search by phone
phoneSchema.index({ dialCode: 1, number: 1 });

const userSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    phone: { type: phoneSchema, required: true },
    gender: { type: String, enum: ["male", "female", "other"], required: true },
    dob: { type: Date, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      index: { unique: true, partialFilterExpression: { isDeleted: false } },
    },
    password: { type: String, required: true }, // hashed
    receiveNotifications: { type: Boolean, default: true },
    twoFA: { type: Boolean, default: false },
    avatar: { type: String }, // URL
    joinedAt: { type: Date, default: Date.now },
    isDeleted: { type: Boolean, default: false },
    isSuspended: { type: Boolean, default: false },
    deleteReason: { type: String }, // Added to store deletion reason
  },
  { timestamps: true }
);

// Indexes for common query fields
userSchema.index({ isDeleted: 1 });
userSchema.index({ isSuspended: 1 });
userSchema.index({ joinedAt: -1 });
userSchema.index({ email: 1, isSuspended: 1 });

module.exports = mongoose.model("User", userSchema);

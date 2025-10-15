const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const phoneSchema = new mongoose.Schema({
  dialCode: { type: String, required: true },
  number: { type: String, required: true },
});

const workingHoursSchema = new mongoose.Schema({
  sun: { openTime: String, closeTime: String, isClosed: Boolean },
  mon: { openTime: String, closeTime: String, isClosed: Boolean },
  tue: { openTime: String, closeTime: String, isClosed: Boolean },
  wed: { openTime: String, closeTime: String, isClosed: Boolean },
  thu: { openTime: String, closeTime: String, isClosed: Boolean },
  fri: { openTime: String, closeTime: String, isClosed: Boolean },
  sat: { openTime: String, closeTime: String, isClosed: Boolean },
});

const vendorSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    avatar: { type: String }, // URL
    accountType: { type: String, enum: ["owner", "helper"], required: true },
    fullName: { type: String, required: true },
    email: {
      type: String,
      required: true,
      unique: true,
      index: { unique: true, partialFilterExpression: { isDeleted: false } },
    },
    phoneNumber: { type: phoneSchema, required: true },
    businessName: { type: String },
    businessType: { type: String },
    businessAddress: { type: String },
    noOfSeats: { type: Number },
    password: { type: String, required: true }, // hashed
    isDeleted: { type: Boolean, default: false },
    isSuspended: { type: Boolean, default: false },
    receiveNotification: { type: Boolean, default: true },
    workingHours: { type: workingHoursSchema },
    twoFA: { type: Boolean, default: false },
    privacyMode: { type: Boolean, default: false },
    inactivityReminder: {
      time: Number, // in minutes
      status: Boolean,
    },
    active: { type: Boolean, default: false },
    joiningCode: { type: String, unique: true }, // Add unique index for joiningCode
    helperJointBusiness: { type: String, ref: "Vendor" },
    connectedHelpers: [{ type: String, ref: "Vendor" }], // refs to other helpers' UUIDs
    pushToken: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Vendor", vendorSchema);

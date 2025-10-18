const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const RateCard = require("./RateCard");

const phoneSchema = new mongoose.Schema({
  dialCode: { type: String, required: true },
  number: { type: String, required: true },
});

const workingHoursSchema = new mongoose.Schema({
  sun: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: true },
  },
  mon: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: false },
  },
  tue: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: false },
  },
  wed: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: false },
  },
  thu: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: false },
  },
  fri: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: false },
  },
  sat: {
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "17:00" },
    isClosed: { type: Boolean, default: true },
  },
});

const connectedHelperSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  helperId: { type: String, ref: "Vendor", required: true },
  active: { type: Boolean, default: false },
  joiningAcceptedDate: { type: Date },
  requestJoiningDate: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ["pending", "accepted", "rejected", "removed"],
    default: "pending",
  },
  associatedServices: [{ type: String, ref: "RateCard", default: [] }],
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
    workingHours: { type: workingHoursSchema, default: () => ({}) },
    twoFA: { type: Boolean, default: false },
    privacyMode: { type: Boolean, default: false },
    inactivityReminder: {
      time: { type: Number, default: 0 }, // in minutes
      status: { type: Boolean, default: false },
    },
    active: { type: Boolean, default: false },
    joiningCode: { type: String, unique: true, required: true },
    helperJointBusiness: { type: String, ref: "Vendor" },
    connectedHelpers: [connectedHelperSchema], // Updated to array of objects
    pushToken: { type: String },
    location: {
      latitude: { type: Number },
      longitude: { type: Number },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Vendor", vendorSchema);

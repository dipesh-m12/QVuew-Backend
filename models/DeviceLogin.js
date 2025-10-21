const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const deviceLoginSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    vendorId: { type: String, ref: "Vendor", required: true },
    deviceInfo: {
      brand: { type: String, required: true }, // e.g., Apple, Samsung
      modelName: { type: String, required: true }, // e.g., iPhone 15 Pro
      manufacturer: { type: String },
      osName: { type: String }, // e.g., iOS, Android
      osVersion: { type: String },
      platformApiLevel: { type: Number }, // Android only
      deviceName: { type: String }, // User-assigned name
      totalMemory: { type: Number },
      freeMemory: { type: Number },
      isDevice: { type: Boolean, default: true },
    },
    loginTime: { type: Date, default: Date.now },
    location: {
      address: { type: String }, // e.g., "New York, NY"
      coordinates: {
        latitude: { type: Number },
        longitude: { type: Number },
      },
    },
  },
  { timestamps: true }
);

// Indexes
deviceLoginSchema.index({ vendorId: 1 });
deviceLoginSchema.index({ loginTime: -1 });

module.exports = mongoose.model("DeviceLogin", deviceLoginSchema);

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const supportRequestSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  subject: { type: String, required: true },
  message: { type: String, required: false },
  email: { type: String, required: true },
  createdBy: { type: String, required: true }, // User ID
  accountType: { type: String, enum: ["vendor", "user"], required: true },
  createdAt: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ["open", "in_progress", "closed"],
    default: "open",
  },
  attachments: [{ type: String }], // Array of file URLs or paths
});

// Indexes for common query fields
supportRequestSchema.index({ email: 1 });
supportRequestSchema.index({ createdBy: 1 });
supportRequestSchema.index({ createdAt: -1 }); // -1 for descending order (recent first)

const SupportRequest = mongoose.model("SupportRequest", supportRequestSchema);

module.exports = SupportRequest;

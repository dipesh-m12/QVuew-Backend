const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const Vendor = require("../models/Vendor");
const RateCard = require("../models/RateCard");
const User = require("../models/User");
const redis = require("redis");
const axios = require("axios");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient
  .connect()
  .catch((err) => console.error("Redis connection error:", err));

// Manual Customer Schema (for non-smartphone users)
const manualCustomerSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  vendorId: { type: String, ref: "Vendor", required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  gender: { type: String, enum: ["male", "female", "child"], required: true },
  createdAt: { type: Date, default: Date.now },
});
manualCustomerSchema.index({ vendorId: 1, phone: 1 });
const ManualCustomer = mongoose.model("ManualCustomer", manualCustomerSchema);

// Queue Schema
const queueSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  vendorId: { type: String, ref: "Vendor", required: true },
  helperId: { type: String, ref: "Vendor", required: true }, // Chair/Helper
  userId: { type: String, ref: "User", required: false }, // Optional for manual customers
  manualCustomerId: { type: String, ref: "ManualCustomer", required: false }, // For manual customers
  serviceId: { type: String, ref: "RateCard", required: true },
  position: { type: Number, required: true },
  joinTime: { type: Date, default: Date.now },
  estWaitTime: { type: Number, required: true }, // in minutes
  status: {
    type: String,
    enum: ["waiting", "hold", "skipped", "removed", "completed"],
    default: "waiting",
  },
  chairPreference: { type: String, enum: ["any", "specific"], required: true },
  history: [
    {
      action: { type: String, enum: ["skip", "hold", "remove"] },
      timestamp: { type: Date, default: Date.now },
      previousPosition: { type: Number },
    },
  ],
});
queueSchema.index({ vendorId: 1, helperId: 1, position: 1 });
queueSchema.index({ userId: 1 });
queueSchema.index({ manualCustomerId: 1 });
queueSchema.index({ status: 1 });
const Queue = mongoose.model("Queue", queueSchema);

// Break Schema
const breakSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  vendorId: { type: String, ref: "Vendor", required: true },
  helperId: { type: String, ref: "Vendor", required: true },
  reason: { type: String, required: true },
  duration: { type: Number, required: true }, // in minutes
  message: { type: String, required: true },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, required: true },
});
breakSchema.index({ vendorId: 1, helperId: 1 });
const Break = mongoose.model("Break", breakSchema);

// Chair Status Schema
const chairStatusSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  vendorId: { type: String, ref: "Vendor", required: true },
  helperId: { type: String, ref: "Vendor", required: true },
  status: {
    type: String,
    enum: ["active", "passive", "offline"],
    default: "passive",
  },
  lastPing: { type: Date },
});
chairStatusSchema.index({ vendorId: 1, helperId: 1 });
const ChairStatus = mongoose.model("ChairStatus", chairStatusSchema);

// Add User to Queue (via QR scan or manual add by vendor)
router.post(
  "/add-to-queue",
  verifyUser,
  [
    body("vendorId").notEmpty().withMessage("Vendor ID is required"),
    body("serviceId").notEmpty().withMessage("Service ID is required"),
    body("chairPreference")
      .isIn(["any", "specific"])
      .withMessage("Invalid chair preference"),
    body("helperId")
      .optional()
      .notEmpty()
      .withMessage("Helper ID is required for specific chair"),
    body("userId")
      .optional()
      .notEmpty()
      .withMessage("User ID is required for registered users"),
    body("manualCustomerId")
      .optional()
      .notEmpty()
      .withMessage("Manual customer ID is required for manual re-add"),
    body("name")
      .optional()
      .notEmpty()
      .withMessage("Name is required for manual add"),
    body("phone")
      .optional()
      .notEmpty()
      .withMessage("Phone number is required for manual add"),
    body("gender")
      .optional()
      .isIn(["male", "female", "child"])
      .withMessage("Gender must be one of: male, female, child"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const {
      vendorId,
      userId,
      serviceId,
      chairPreference,
      helperId,
      manualCustomerId,
      name,
      phone,
      gender,
    } = req.body;

    try {
      // Verify vendor and service
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Vendor not found or inactive",
            data: null,
          });
      }
      const service = await RateCard.findById(serviceId);
      if (!service || service.createdBy !== vendorId) {
        return res
          .status(404)
          .json({ success: false, message: "Service not found", data: null });
      }

      // Validate gender for manual customers
      if ((name || phone || gender) && (!name || !phone || !gender)) {
        return res.status(400).json({
          success: false,
          message: "Name, phone, and gender are required for manual add",
          data: null,
        });
      }
      if (gender && !service.gender.includes(gender)) {
        return res.status(400).json({
          success: false,
          message: `Service does not support gender: ${gender}`,
          data: null,
        });
      }

      let targetUserId = userId;
      let targetManualCustomerId = manualCustomerId;

      // Handle manual customer addition
      if (name && phone && gender && !userId && !manualCustomerId) {
        const manualCustomer = new ManualCustomer({
          vendorId,
          name,
          phone,
          gender,
        });
        await manualCustomer.save();
        targetManualCustomerId = manualCustomer._id;
      } else if (manualCustomerId) {
        const manualCustomer = await ManualCustomer.findById(manualCustomerId);
        if (!manualCustomer || manualCustomer.vendorId !== vendorId) {
          return res.status(404).json({
            success: false,
            message: "Manual customer not found or not associated with vendor",
            data: null,
          });
        }
        if (!service.gender.includes(manualCustomer.gender)) {
          return res.status(400).json({
            success: false,
            message: `Service does not support gender: ${manualCustomer.gender}`,
            data: null,
          });
        }
      } else if (userId) {
        const user = await User.findById(userId);
        if (!user || user.isDeleted || user.isSuspended) {
          return res
            .status(404)
            .json({
              success: false,
              message: "User not found or inactive",
              data: null,
            });
        }
        if (!service.gender.includes(user.gender)) {
          return res.status(400).json({
            success: false,
            message: `Service does not support gender: ${user.gender}`,
            data: null,
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          message:
            "Either userId or manual customer data (name, phone, gender) required",
          data: null,
        });
      }

      // Find active chairs
      const activeChairs = await ChairStatus.find({
        vendorId,
        status: "active",
      }).populate("helperId", "connectedHelpers.associatedServices");

      // Filter chairs that support the requested service
      const validChairs = activeChairs.filter((chair) =>
        chair.helperId.connectedHelpers.some(
          (ch) =>
            ch.status === "accepted" &&
            ch.associatedServices.includes(serviceId)
        )
      );

      if (!validChairs.length) {
        return res.status(400).json({
          success: false,
          message: "No active chairs support this service",
          data: null,
        });
      }

      let selectedHelperId;
      if (chairPreference === "specific" && helperId) {
        const chair = validChairs.find(
          (c) => c.helperId._id.toString() === helperId
        );
        if (!chair) {
          return res.status(400).json({
            success: false,
            message: "Selected helper not available",
            data: null,
          });
        }
        selectedHelperId = helperId;
      } else {
        // Find chair with least wait time
        let minWaitTime = Infinity;
        for (const chair of validChairs) {
          const queue = await Queue.find({
            vendorId,
            helperId: chair.helperId._id,
            status: "waiting",
          });
          const totalWaitTime = queue.reduce(
            (sum, q) => sum + q.estWaitTime,
            0
          );
          if (totalWaitTime < minWaitTime) {
            minWaitTime = totalWaitTime;
            selectedHelperId = chair.helperId._id;
          }
        }
      }

      // Calculate position and estimated wait time
      const queueCount = await Queue.countDocuments({
        vendorId,
        helperId: selectedHelperId,
        status: "waiting",
      });
      const estWaitTime = queueCount * service.duration;

      const queueEntry = new Queue({
        vendorId,
        helperId: selectedHelperId,
        userId: targetUserId,
        manualCustomerId: targetManualCustomerId,
        serviceId,
        position: queueCount + 1,
        estWaitTime,
        chairPreference,
      });
      await queueEntry.save();

      // Send push notification for registered users
      if (targetUserId) {
        const user = await User.findById(targetUserId);
        if (user && user.pushToken) {
          await axios.post(
            "https://exp.host/--/api/v2/push/send",
            [
              {
                to: user.pushToken,
                sound: "default",
                title: "Added to Queue",
                body: `You have been added to the queue for ${service.name}. Estimated wait: ${estWaitTime} minutes.`,
                data: { type: "queue_added" },
              },
            ],
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
            }
          );
        }
      }

      res.status(201).json({
        success: true,
        message: "Added to queue successfully",
        data: queueEntry,
      });
    } catch (error) {
      console.error("Error adding to queue:", error);
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to add to queue",
          data: null,
        });
    }
  }
);

// Search Manual Customers (for re-adding)
router.get("/manual-customers", verifyUser, async (req, res) => {
  const { vendorId, phone, name } = req.query;
  const userId = req.user.id;

  try {
    const vendor = await Vendor.findById(vendorId);
    if (!vendor || vendor.isDeleted || vendor.isSuspended) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found or inactive",
        data: null,
      });
    }
    if (
      vendor._id.toString() !== userId &&
      vendor.connectedHelpers.every((h) => h.helperId !== userId)
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to access this vendor's customers",
        data: null,
      });
    }

    let query = { vendorId };
    if (phone) query.phone = { $regex: phone, $options: "i" };
    if (name) query.name = { $regex: name, $options: "i" };

    const customers = await ManualCustomer.find(query);
    res.json({
      success: true,
      message: "Manual customers retrieved successfully",
      data: customers,
    });
  } catch (error) {
    console.error("Error retrieving manual customers:", error);
    res.status(500).json({
      success: false,
      message: "Failed to retrieve manual customers",
      data: null,
    });
  }
});

// Update Chair Status (Helper activates/deactivates chair)
router.put(
  "/chair-status/:helperId",
  verifyUser,
  [
    body("status")
      .isIn(["active", "passive", "offline"])
      .withMessage("Invalid status"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { helperId } = req.params;
    const { status } = req.body;
    const vendorId = req.user.id;

    try {
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Vendor not found or inactive",
            data: null,
          });
      }

      const chair = await ChairStatus.findOne({ vendorId, helperId });
      if (!chair) {
        return res
          .status(404)
          .json({ success: false, message: "Chair not found", data: null });
      }

      if (status === "offline") {
        await redistributeQueue(vendorId, helperId);
      } else if (status === "active") {
        await reassignAnyPreferenceUsers(vendorId, helperId);
      }

      chair.status = status;
      chair.lastPing = new Date();
      await chair.save();

      res.json({
        success: true,
        message: "Chair status updated successfully",
        data: chair,
      });
    } catch (error) {
      console.error("Error updating chair status:", error);
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to update chair status",
          data: null,
        });
    }
  }
);

// Take a Break (Helper initiates break)
router.post(
  "/take-break",
  verifyUser,
  [
    body("vendorId").notEmpty().withMessage("Vendor ID is required"),
    body("reason").notEmpty().withMessage("Reason is required"),
    body("duration")
      .isInt({ min: 1 })
      .withMessage("Duration must be a positive integer"),
    body("message").notEmpty().withMessage("Message is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId, reason, duration, message } = req.body;
    const helperId = req.user.id;

    try {
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Vendor not found or inactive",
            data: null,
          });
      }

      const endTime = new Date(Date.now() + duration * 60 * 1000);
      const breakEntry = new Break({
        vendorId,
        helperId,
        reason,
        duration,
        message,
        endTime,
      });
      await breakEntry.save();

      // Notify users in the queue
      const queue = await Queue.find({
        vendorId,
        helperId,
        status: "waiting",
      }).populate("userId", "pushToken");
      const pushTokens = queue.map((q) => q.userId?.pushToken).filter(Boolean);
      if (pushTokens.length) {
        await axios.post(
          "https://exp.host/--/api/v2/push/send",
          pushTokens.map((token) => ({
            to: token,
            sound: "default",
            title: "Helper on Break",
            body: message,
            data: { type: "break_notification" },
          })),
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
      }

      await redistributeQueue(vendorId, helperId);

      res.status(201).json({
        success: true,
        message: "Break initiated successfully",
        data: breakEntry,
      });
    } catch (error) {
      console.error("Error initiating break:", error);
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to initiate break",
          data: null,
        });
    }
  }
);

// Queue Actions (Skip, Hold, Remove, Complete)
router.post(
  "/queue-action",
  verifyUser,
  [
    body("queueId").notEmpty().withMessage("Queue ID is required"),
    body("action")
      .isIn(["skip", "hold", "remove", "complete"])
      .withMessage("Invalid action"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { queueId, action } = req.body;
    const helperId = req.user.id;

    try {
      const queueEntry = await Queue.findById(queueId)
        .populate("userId", "pushToken")
        .populate("serviceId");
      if (!queueEntry) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Queue entry not found",
            data: null,
          });
      }
      if (queueEntry.helperId.toString() !== helperId) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to modify this queue",
          data: null,
        });
      }

      const vendorId = queueEntry.vendorId;
      const currentPosition = queueEntry.position;

      if (action === "skip") {
        const nextEntry = await Queue.findOne({
          vendorId,
          helperId,
          position: currentPosition + 1,
          status: "waiting",
        });
        if (nextEntry) {
          queueEntry.position += 1;
          nextEntry.position -= 1;
          queueEntry.history.push({
            action: "skip",
            previousPosition: currentPosition,
          });
          await Promise.all([queueEntry.save(), nextEntry.save()]);
        }
      } else if (action === "hold") {
        const maxPosition = await Queue.countDocuments({
          vendorId,
          helperId,
          status: "waiting",
        });
        queueEntry.position = maxPosition + 1;
        queueEntry.status = "hold";
        queueEntry.history.push({
          action: "hold",
          previousPosition: currentPosition,
        });
        await queueEntry.save();
      } else if (action === "remove") {
        queueEntry.status = "removed";
        queueEntry.history.push({
          action: "remove",
          previousPosition: currentPosition,
        });
        await queueEntry.save();
      } else if (action === "complete") {
        queueEntry.status = "completed";
        await queueEntry.save();
        const nextEntry = await Queue.findOne({
          vendorId,
          helperId,
          position: currentPosition + 1,
          status: "waiting",
        }).populate("userId", "pushToken");
        if (nextEntry && nextEntry.userId?.pushToken) {
          await axios.post(
            "https://exp.host/--/api/v2/push/send",
            [
              {
                to: nextEntry.userId.pushToken,
                sound: "default",
                title: "Your Turn",
                body: `You are next in the queue for ${queueEntry.serviceId.name}!`,
                data: { type: "queue_next" },
              },
            ],
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
            }
          );
        }
      }

      await updateQueuePositions(vendorId, helperId);

      if (queueEntry.userId?.pushToken) {
        await axios.post(
          "https://exp.host/--/api/v2/push/send",
          [
            {
              to: queueEntry.userId.pushToken,
              sound: "default",
              title: `Queue ${
                action.charAt(0).toUpperCase() + action.slice(1)
              }`,
              body: `Your queue status has been ${action} for ${queueEntry.serviceId.name}.`,
              data: { type: `queue_${action}` },
            },
          ],
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
      }

      res.json({
        success: true,
        message: `Queue ${action} action performed successfully`,
        data: queueEntry,
      });
    } catch (error) {
      console.error(`Error performing ${action} action:`, error);
      res.status(500).json({
        success: false,
        message: `Failed to perform ${action} action`,
        data: null,
      });
    }
  }
);

// Undo Queue Action
router.post(
  "/undo-queue-action",
  verifyUser,
  [body("queueId").notEmpty().withMessage("Queue ID is required")],
  async (req, res) => {
    const { queueId } = req.body;
    const helperId = req.user.id;

    try {
      const queueEntry = await Queue.findById(queueId).populate(
        "userId",
        "pushToken"
      );
      if (!queueEntry) {
        return res
          .status(404)
          .json({
            success: false,
            message: "Queue entry not found",
            data: null,
          });
      }
      if (queueEntry.helperId.toString() !== helperId) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to undo this queue",
          data: null,
        });
      }

      const lastAction = queueEntry.history[queueEntry.history.length - 1];
      if (
        !lastAction ||
        !["skip", "hold", "remove"].includes(lastAction.action)
      ) {
        return res.status(400).json({
          success: false,
          message: "No valid action to undo",
          data: null,
        });
      }

      if (lastAction.action === "skip") {
        const prevEntry = await Queue.findOne({
          vendorId: queueEntry.vendorId,
          helperId,
          position: lastAction.previousPosition,
          status: "waiting",
        });
        if (prevEntry) {
          prevEntry.position += 1;
          queueEntry.position = lastAction.previousPosition;
          await Promise.all([queueEntry.save(), prevEntry.save()]);
        }
      } else if (lastAction.action === "hold") {
        queueEntry.status = "waiting";
        queueEntry.position = lastAction.previousPosition;
        await queueEntry.save();
      } else if (lastAction.action === "remove") {
        queueEntry.status = "waiting";
        queueEntry.position = lastAction.previousPosition;
        await queueEntry.save();
      }

      queueEntry.history.pop();
      await queueEntry.save();
      await updateQueuePositions(queueEntry.vendorId, helperId);

      if (queueEntry.userId?.pushToken) {
        await axios.post(
          "https://exp.host/--/api/v2/push/send",
          [
            {
              to: queueEntry.userId.pushToken,
              sound: "default",
              title: "Queue Action Undone",
              body: `The ${lastAction.action} action has been undone.`,
              data: { type: "queue_undo" },
            },
          ],
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
      }

      res.json({
        success: true,
        message: "Queue action undone successfully",
        data: queueEntry,
      });
    } catch (error) {
      console.error("Error undoing queue action:", error);
      res.status(500).json({
        success: false,
        message: "Failed to undo queue action",
        data: null,
      });
    }
  }
);

// Helper function to redistribute queue when a chair goes offline or on break
async function redistributeQueue(vendorId, helperId) {
  const queueEntries = await Queue.find({
    vendorId,
    helperId,
    status: "waiting",
  })
    .populate("serviceId")
    .populate("userId", "gender pushToken")
    .populate("manualCustomerId", "gender");

  const activeChairs = await ChairStatus.find({
    vendorId,
    status: "active",
  }).populate("helperId", "connectedHelpers.associatedServices");

  for (const entry of queueEntries) {
    let minWaitTime = Infinity;
    let newHelperId = null;
    const customerGender =
      entry.userId?.gender || entry.manualCustomerId?.gender;

    for (const chair of activeChairs) {
      if (chair.helperId._id.toString() === helperId) continue;
      const supportsService = chair.helperId.connectedHelpers.some(
        (ch) =>
          ch.status === "accepted" &&
          ch.associatedServices.includes(entry.serviceId._id) &&
          entry.serviceId.gender.includes(customerGender)
      );
      if (!supportsService) continue;

      const queue = await Queue.find({
        vendorId,
        helperId: chair.helperId._id,
        status: "waiting",
      });
      const totalWaitTime = queue.reduce((sum, q) => sum + q.estWaitTime, 0);
      if (totalWaitTime < minWaitTime) {
        minWaitTime = totalWaitTime;
        newHelperId = chair.helperId._id;
      }
    }

    if (newHelperId) {
      const queueCount = await Queue.countDocuments({
        vendorId,
        helperId: newHelperId,
        status: "waiting",
      });
      entry.helperId = newHelperId;
      entry.position = queueCount + 1;
      entry.estWaitTime = queueCount * entry.serviceId.duration;
      await entry.save();

      if (entry.userId?.pushToken) {
        await axios.post(
          "https://exp.host/--/api/v2/push/send",
          [
            {
              to: entry.userId.pushToken,
              sound: "default",
              title: "Queue Reassigned",
              body: `Your queue has been reassigned due to helper unavailability. New estimated wait: ${entry.estWaitTime} minutes.`,
              data: { type: "queue_reassigned" },
            },
          ],
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
      }
    }
  }
}

// Helper function to reassign "any" preference users to a newly active chair
async function reassignAnyPreferenceUsers(vendorId, helperId) {
  const newChair = await ChairStatus.findOne({
    vendorId,
    helperId,
    status: "active",
  }).populate("helperId", "connectedHelpers.associatedServices");
  if (!newChair) return;

  const queueEntries = await Queue.find({
    vendorId,
    chairPreference: "any",
    status: "waiting",
  })
    .populate("serviceId")
    .populate("userId", "gender pushToken")
    .populate("manualCustomerId", "gender");

  for (const entry of queueEntries) {
    const customerGender =
      entry.userId?.gender || entry.manualCustomerId?.gender;
    const supportsService = newChair.helperId.connectedHelpers.some(
      (ch) =>
        ch.status === "accepted" &&
        ch.associatedServices.includes(entry.serviceId._id) &&
        entry.serviceId.gender.includes(customerGender)
    );
    if (!supportsService) continue;

    const currentQueue = await Queue.find({
      vendorId,
      helperId: entry.helperId,
      status: "waiting",
    });
    const currentWaitTime = currentQueue.reduce(
      (sum, q) => sum + q.estWaitTime,
      0
    );
    const newQueue = await Queue.find({
      vendorId,
      helperId,
      status: "waiting",
    });
    const newWaitTime = newQueue.reduce((sum, q) => sum + q.estWaitTime, 0);

    if (newWaitTime < currentWaitTime) {
      const queueCount = newQueue.length + 1;
      entry.helperId = helperId;
      entry.position = queueCount;
      entry.estWaitTime = queueCount * entry.serviceId.duration;
      await entry.save();

      if (entry.userId?.pushToken) {
        await axios.post(
          "https://exp.host/--/api/v2/push/send",
          [
            {
              to: entry.userId.pushToken,
              sound: "default",
              title: "Queue Reassigned",
              body: `Your queue has been reassigned to a faster chair. New estimated wait: ${entry.estWaitTime} minutes.`,
              data: { type: "queue_reassigned" },
            },
          ],
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
      }
    }
  }
}

// Helper function to update queue positions after an action
async function updateQueuePositions(vendorId, helperId) {
  const queueEntries = await Queue.find({
    vendorId,
    helperId,
    status: "waiting",
  }).sort("position");
  let position = 1;
  for (const entry of queueEntries) {
    entry.position = position++;
    await entry.save();
  }
}

module.exports = router;

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const verifyUser = require("../middlewares/verifyUser");
const Vendor = require("../models/Vendor");
const RateCard = require("../models/RateCard");
// const ManualAddUsers = require("../models/ManualAddUsers");
const User = require("../models/User");
const axios = require("axios");

// Queue Schema
const updateHistorySchema = new mongoose.Schema({
  action: {
    type: String,
    enum: [
      "skip",
      "hold",
      "remove",
      "next",
      "add_time",
      "unhold",
      "edit",
      "undo",
    ],
    required: true,
  },
  source: { type: String, enum: ["user", "vendor"], required: true },
  timestamp: { type: Date, default: Date.now },
  previousPosition: { type: Number },
  newPosition: { type: Number },
  addedTime: { type: Number }, // in minutes, for add_time action
  estimatedWait: { type: Number }, // Track wait time changes
  serviceId: { type: String, ref: "RateCard" }, // for edit action
  businessId: { type: String, ref: "Vendor" }, // New field for business ID
  newlyAssignedHelperId: { type: String, ref: "Vendor" }, // New field for helper ID
});

const queueSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    userId: { type: String, ref: "User" }, // For normal registered users
    manualUserId: { type: String, ref: "ManualAddUsers" }, // For manual users
    vendorId: { type: String, ref: "Vendor", required: true },
    helperId: { type: String, ref: "Vendor" }, // Specific helper or null for ANY
    serviceId: { type: String, ref: "RateCard", required: true },
    userType: { type: String, enum: ["normal", "manual"], required: true }, // ✅ FIXED
    preference: { type: String, enum: ["ANY", "SPECIFIC"], default: "ANY" },
    gender: {
      type: String,
      enum: ["male", "female", "child"],
      required: true,
    },
    joiningPosition: { type: Number, required: true },
    currentPosition: { type: Number, required: true },
    joiningTime: { type: Date, default: Date.now },
    estimatedServiceStartTime: { type: Date, required: true },
    estimatedWait: { type: Number, required: true }, // in minutes
    status: {
      type: String,
      enum: ["in_queue", "hold", "completed", "skipped", "removed"],
      default: "in_queue",
    },
    updateHistory: [updateHistorySchema],
    total: { type: Number, required: true }, // Service cost
    rating: { type: Number, min: 0, max: 5 }, // Post-service rating
    notes: { type: String }, // Post-service comments
  },
  { timestamps: true }
);

queueSchema.index({ vendorId: 1, status: 1 });
queueSchema.index({ helperId: 1, status: 1 });
queueSchema.index({ serviceId: 1 });
queueSchema.index({ joiningTime: -1 });

const Queue = mongoose.model("Queue", queueSchema);

// ManualAddUsers Schema
const phoneSchema = new mongoose.Schema({
  dialCode: { type: String, required: true },
  number: { type: String, required: true },
});

const manualAddUsersSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    vendorId: { type: String, ref: "Vendor", required: true },
    name: { type: String, required: true },
    phone: { type: phoneSchema, required: true },
    gender: { type: String, enum: ["male", "female", "child"], required: true },
    notes: { type: String },
    isDeleted: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

manualAddUsersSchema.index({ vendorId: 1, isDeleted: 1 });
manualAddUsersSchema.index({ "phone.dialCode": 1, "phone.number": 1 });

const ManualAddUsers = mongoose.model("ManualAddUsers", manualAddUsersSchema);

// Enqueue Customer (Normal or Manual)
router.post(
  "/enqueue",
  verifyUser,
  [
    body("vendorId").isString().withMessage("Valid vendor ID is required"),
    body("services")
      .isArray({ min: 1 })
      .withMessage("Services must be a non-empty array"),
    body("services.*.serviceId").isString().withMessage("Invalid service ID"),
    body("services.*.gender")
      .isIn(["male", "female", "child"])
      .withMessage("Invalid gender"),
    body("services.*.preference")
      .isIn(["ANY", "SPECIFIC"])
      .withMessage("Preference must be ANY or SPECIFIC"),
    body("services.*.helperId")
      .optional()
      .isString()
      .withMessage("Invalid helper ID"),
    body("userType")
      .isIn(["normal", "manual"])
      .withMessage("Invalid user type"),
    body("manualUserId")
      .if(body("userType").equals("manual"))
      .isString()
      .withMessage("Valid manual user ID required for manual user type")
      .bail()
      .if(body("userType").equals("normal"))
      .isEmpty()
      .withMessage("manualUserId must not be provided for normal user type"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId, services, userType, manualUserId } = req.body;
    const userId = req.user.id;

    const session = await Queue.startSession();
    session.startTransaction();

    try {
      // Verify vendor
      const vendor = await Vendor.findOne({
        _id: vendorId,
        accountType: "owner",
        isDeleted: false,
        isSuspended: false,
        active: true,
      }).session(session);

      if (!vendor) {
        throw new Error("Vendor is not an active owner or not found");
      }

      // Verify user
      if (userType === "manual") {
        if (!manualUserId) {
          throw new Error("Manual user ID required for manual user type");
        }
        const manualUser = await ManualAddUsers.findOne({
          _id: manualUserId,
          isDeleted: false,
          vendorId,
        }).session(session);
        if (!manualUser) {
          throw new Error("Invalid or unauthorized manual user");
        }
      } else if (userType === "normal") {
        const user = await User.findOne({
          _id: userId,
          isDeleted: false,
          isSuspended: false,
        }).session(session);
        if (!user) {
          throw new Error("User is not active or not found");
        }
        if (manualUserId) {
          throw new Error(
            "manualUserId must not be provided for normal user type"
          );
        }
      }

      const queueEntries = [];
      for (const { serviceId, gender, preference, helperId } of services) {
        // Verify service
        const service = await RateCard.findOne({
          _id: serviceId,
          isDeleted: false,
          createdBy: vendorId,
        }).session(session);
        if (!service) {
          throw new Error(`Service ${serviceId} is invalid or not found`);
        }

        // Verify helper if SPECIFIC
        let selectedHelperId = helperId;
        if (preference === "SPECIFIC" && helperId) {
          const helper = await Vendor.findOne({
            _id: helperId,
            accountType: "helper",
            isDeleted: false,
            isSuspended: false,
          }).session(session);
          if (
            !helper ||
            !vendor.connectedHelpers.some(
              (ch) =>
                ch.helperId === helperId &&
                ch.status === "accepted" &&
                ch.active
            )
          ) {
            throw new Error(`Helper ${helperId} is not active or authorized`);
          }
        } else {
          // Find fastest helper for ANY preference
          const activeHelpers = vendor.connectedHelpers.filter(
            (ch) => ch.status === "accepted" && ch.active
          );
          let minWaitTime = Infinity;
          selectedHelperId = null;

          for (const helper of activeHelpers) {
            if (!helper.associatedServices.includes(serviceId)) continue;
            const queueLength = await Queue.countDocuments(
              {
                vendorId,
                helperId: helper.helperId,
                status: { $in: ["in_queue", "hold", "skipped"] },
              },
              { session }
            );
            const waitTime = queueLength * service.duration;
            if (waitTime < minWaitTime) {
              minWaitTime = waitTime;
              selectedHelperId = helper.helperId;
            }
          }
          if (!selectedHelperId) {
            throw new Error(
              `No active helpers available for service ${serviceId}`
            );
          }
        }

        // Calculate queue position (new customer joins at end)
        const queueLength = await Queue.countDocuments(
          {
            vendorId,
            helperId: selectedHelperId,
            status: { $in: ["in_queue", "hold", "skipped"] }, // Exclude completed, removed
          },
          { session }
        );
        const joiningPosition = queueLength + 1;
        const estimatedWait = queueLength * service.duration;
        const estimatedServiceStartTime = new Date(
          Date.now() + estimatedWait * 60 * 1000
        );

        const queueEntry = new Queue({
          _id: uuidv4(),
          userId: userType === "manual" ? null : userId,
          manualUserId: userType === "manual" ? manualUserId : null,
          vendorId,
          helperId: selectedHelperId,
          serviceId,
          userType,
          preference,
          gender,
          joiningPosition,
          currentPosition: joiningPosition,
          joiningTime: new Date(),
          estimatedWait,
          estimatedServiceStartTime,
          total: service.rate,
          status: "in_queue",
        });

        queueEntries.push(queueEntry);
      }

      await Queue.insertMany(queueEntries, { session });
      await session.commitTransaction();

      res.status(201).json({
        success: true,
        message: "Customer(s) enqueued successfully",
        data: queueEntries,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error enqueuing customer:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to enqueue customer",
        data: null,
      });
    } finally {
      session.endSession();
    }
  }
);

// Restructure Queue for Time Range - FCFS Balanced Distribution
router.post(
  "/restructure-queue",
  verifyUser,
  [
    body("vendorId").isString().withMessage("Valid vendor ID is required"),
    body("startTime").isISO8601().withMessage("Valid start time is required"),
    body("endTime").isISO8601().withMessage("Valid end time is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId, startTime, endTime } = req.body;

    const session = await Queue.startSession();
    session.startTransaction();

    try {
      // Verify vendor
      const vendor = await Vendor.findOne({
        _id: vendorId,
        accountType: "owner",
        isDeleted: false,
        isSuspended: false,
      }).session(session);

      if (!vendor) {
        throw new Error("Vendor is not an active owner or not found");
      }

      // Check if business is active
      if (!vendor.active) {
        await session.commitTransaction();
        return res.status(400).json({
          success: false,
          message: "Business is currently inactive",
          data: null,
        });
      }

      // Get all active helpers
      const activeHelpers = vendor.connectedHelpers.filter(
        (ch) => ch.status === "accepted" && ch.active
      );

      if (activeHelpers.length === 0) {
        await session.commitTransaction();
        return res.status(400).json({
          success: false,
          message: "No active helpers available",
          data: null,
        });
      }

      // Get all queue entries within time range
      const allQueues = await Queue.find({
        vendorId,
        status: { $in: ["in_queue", "hold"] }, // Only active queues
        createdAt: { $gte: new Date(startTime), $lte: new Date(endTime) },
      })
        .populate("serviceId", "name duration rate")
        .sort({ joiningTime: 1 })
        .session(session);

      if (allQueues.length === 0) {
        await session.commitTransaction();
        return res.json({
          success: true,
          message: "No queues to restructure",
          data: null,
        });
      }

      // Group queues by serviceId
      const queuesByService = {};
      allQueues.forEach((queue) => {
        const serviceId = queue.serviceId._id.toString();
        if (!queuesByService[serviceId]) {
          queuesByService[serviceId] = [];
        }
        queuesByService[serviceId].push(queue);
      });

      const notifications = [];
      let updatedCount = 0;

      // Process each service group
      for (const serviceId in queuesByService) {
        const serviceQueues = queuesByService[serviceId];
        const service = serviceQueues[0].serviceId;

        // Find capable helpers
        const capableHelpers = activeHelpers.filter((h) =>
          h.associatedServices.includes(serviceId)
        );

        if (capableHelpers.length === 0) {
          console.log(`No active helpers for service ${serviceId}`);
          continue;
        }

        // Initialize helper assignments
        const helperAssignments = {};
        capableHelpers.forEach((helper) => {
          helperAssignments[helper.helperId] = {
            inQueue: [],
            hold: [],
          };
        });

        // Separate queues by status
        const inQueueList = [];
        const holdList = [];

        for (const queue of serviceQueues) {
          if (queue.status === "hold") {
            holdList.push(queue);
          } else {
            // in_queue (includes skipped - they're treated as normal in_queue)
            inQueueList.push(queue);
          }
        }

        // Assign in_queue people first (FCFS, load balanced)
        inQueueList.sort((a, b) => a.joiningTime - b.joiningTime);

        for (const queue of inQueueList) {
          // Check if helper preference is valid
          if (queue.preference === "SPECIFIC") {
            const isHelperActive = capableHelpers.some(
              (h) => h.helperId === queue.helperId
            );
            if (isHelperActive) {
              helperAssignments[queue.helperId].inQueue.push(queue);
            } else {
              // Reassign to least loaded helper
              const sortedHelpers = capableHelpers.sort(
                (a, b) =>
                  helperAssignments[a.helperId].inQueue.length -
                  helperAssignments[b.helperId].inQueue.length
              );
              helperAssignments[sortedHelpers[0].helperId].inQueue.push(queue);
            }
          } else {
            // ANY preference - assign to least loaded helper
            const sortedHelpers = capableHelpers.sort(
              (a, b) =>
                helperAssignments[a.helperId].inQueue.length -
                helperAssignments[b.helperId].inQueue.length
            );
            helperAssignments[sortedHelpers[0].helperId].inQueue.push(queue);
          }
        }

        // Assign hold people to their current helper (they block their position)
        for (const queue of holdList) {
          const isHelperActive = capableHelpers.some(
            (h) => h.helperId === queue.helperId
          );
          if (isHelperActive) {
            helperAssignments[queue.helperId].hold.push(queue);
          } else {
            // Reassign to first available helper
            helperAssignments[capableHelpers[0].helperId].hold.push(queue);
          }
        }

        // Update positions and times for all queues
        for (const helperId in helperAssignments) {
          const assignment = helperAssignments[helperId];
          let currentPosition = 1;

          // Process in_queue people first - they take available positions
          for (const queue of assignment.inQueue) {
            const oldPosition = queue.currentPosition;
            const oldHelperId = queue.helperId;
            const oldEstimatedWait = queue.estimatedWait;

            // Skip positions blocked by hold people
            while (
              assignment.hold.some((h) => h.currentPosition === currentPosition)
            ) {
              currentPosition++;
            }

            const newPosition = currentPosition++;
            const newEstimatedWait = (newPosition - 1) * service.duration;
            const newEstimatedServiceStartTime = new Date(
              Date.now() + newEstimatedWait * 60 * 1000
            );

            // Check for changes
            const hasChanges =
              queue.currentPosition !== newPosition ||
              queue.helperId !== helperId ||
              Math.abs(queue.estimatedWait - newEstimatedWait) >= 1;

            if (hasChanges) {
              const queueDoc = await Queue.findOne({
                _id: queue._id,
              }).session(session);

              queueDoc.helperId = helperId;
              queueDoc.currentPosition = newPosition;
              queueDoc.estimatedWait = newEstimatedWait;
              queueDoc.estimatedServiceStartTime = newEstimatedServiceStartTime;

              queueDoc.updateHistory.push({
                action: "edit",
                source: "vendor",
                timestamp: new Date(),
                previousPosition: oldPosition,
                newPosition,
                estimatedWait: newEstimatedWait,
                serviceId,
                businessId: vendorId,
                newlyAssignedHelperId:
                  helperId !== oldHelperId ? helperId : undefined,
              });

              await queueDoc.save({ session });
              updatedCount++;

              // Track notification for normal users
              if (queue.userType === "normal" && queue.userId) {
                const positionChanged = oldPosition !== newPosition;
                const helperChanged = helperId !== oldHelperId;
                const waitTimeChanged =
                  Math.abs(oldEstimatedWait - newEstimatedWait) >= 5;

                if (positionChanged || helperChanged || waitTimeChanged) {
                  notifications.push({
                    userId: queue.userId,
                    oldPosition,
                    newPosition,
                    estimatedWait: newEstimatedWait,
                    status: queue.status,
                    helperChanged,
                  });
                }
              }
            }
          }

          // Process hold people - they stay at their current position
          for (const queue of assignment.hold) {
            const oldHelperId = queue.helperId;
            const oldEstimatedWait = queue.estimatedWait;

            // Hold people keep their position but may get new helper
            const newEstimatedWait =
              (queue.currentPosition - 1) * service.duration;
            const newEstimatedServiceStartTime = new Date(
              Date.now() + newEstimatedWait * 60 * 1000
            );

            const hasChanges =
              queue.helperId !== helperId ||
              Math.abs(queue.estimatedWait - newEstimatedWait) >= 1;

            if (hasChanges) {
              const queueDoc = await Queue.findOne({
                _id: queue._id,
              }).session(session);

              queueDoc.helperId = helperId;
              queueDoc.estimatedWait = newEstimatedWait;
              queueDoc.estimatedServiceStartTime = newEstimatedServiceStartTime;

              queueDoc.updateHistory.push({
                action: "edit",
                source: "vendor",
                timestamp: new Date(),
                previousPosition: queue.currentPosition,
                newPosition: queue.currentPosition,
                estimatedWait: newEstimatedWait,
                serviceId,
                businessId: vendorId,
                newlyAssignedHelperId:
                  helperId !== oldHelperId ? helperId : undefined,
              });

              await queueDoc.save({ session });
              updatedCount++;

              // Track notification for normal users
              if (queue.userType === "normal" && queue.userId) {
                const helperChanged = helperId !== oldHelperId;
                const waitTimeChanged =
                  Math.abs(oldEstimatedWait - newEstimatedWait) >= 5;

                if (helperChanged || waitTimeChanged) {
                  notifications.push({
                    userId: queue.userId,
                    oldPosition: queue.currentPosition,
                    newPosition: queue.currentPosition,
                    estimatedWait: newEstimatedWait,
                    status: queue.status,
                    helperChanged,
                  });
                }
              }
            }
          }
        }
      }

      await session.commitTransaction();

      // Send notifications after successful commit
      for (const notification of notifications) {
        try {
          const user = await User.findOne({
            _id: notification.userId,
          }).select("pushToken receiveNotifications");

          if (user?.receiveNotifications && user.pushToken) {
            let message;
            if (notification.status === "hold") {
              message = notification.helperChanged
                ? `Queue updated! You're on HOLD at position ${notification.newPosition}. Helper reassigned. ETA: ${notification.estimatedWait} mins`
                : `Queue updated! You're on HOLD at position ${notification.newPosition}. ETA: ${notification.estimatedWait} mins`;
            } else {
              message = notification.helperChanged
                ? `Queue updated! Position: ${notification.oldPosition} → ${notification.newPosition}. Helper reassigned. ETA: ${notification.estimatedWait} mins`
                : `Queue updated! Position: ${notification.oldPosition} → ${notification.newPosition}. ETA: ${notification.estimatedWait} mins`;
            }

            await axios.post(
              "https://exp.host/--/api/v2/push/send",
              [
                {
                  to: user.pushToken,
                  sound: "default",
                  title: "Queue Updated",
                  body: message,
                  data: {
                    type: "queue_updated",
                    newPosition: notification.newPosition,
                    estimatedWait: notification.estimatedWait,
                    helperChanged: notification.helperChanged,
                    status: notification.status,
                  },
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
        } catch (notifyError) {
          console.error(
            `Notification failed for user ${notification.userId}:`,
            notifyError
          );
        }
      }

      res.json({
        success: true,
        message: `Queue restructured successfully. ${updatedCount} entries updated.`,
        data: {
          updatedCount,
          notificationsSent: notifications.length,
          activeHelpers: activeHelpers.length,
          totalQueues: allQueues.length,
        },
      });
    } catch (error) {
      await session.abortTransaction();
      console.error("Error restructuring queue:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to restructure queue",
        data: null,
      });
    } finally {
      session.endSession();
    }
  }
);

// Get Helper's Queue with Time Range
router.post(
  "/helper-queue",
  verifyUser,
  [
    body("helperId").isString().withMessage("Valid helper ID is required"),
    body("startTime").isISO8601().withMessage("Valid start time is required"),
    body("endTime").isISO8601().withMessage("Valid end time is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { helperId, startTime, endTime } = req.body;
    const userId = req.user.id;

    try {
      // Verify helper
      const helper = await Vendor.findOne({
        _id: helperId,
        accountType: "helper",
        isDeleted: false,
        isSuspended: false,
      }).lean();
      if (!helper) {
        return res.status(403).json({
          success: false,
          message: "Helper not found or not active",
          data: null,
        });
      }

      // Authorize: Helper themselves or owner with accepted connection
      const isAuthorized =
        helper._id.toString() === userId ||
        (await Vendor.findOne({
          _id: userId,
          accountType: "owner",
          connectedHelpers: {
            $elemMatch: { helperId, status: "accepted", active: true },
          },
        }).lean());

      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized to access helper queue",
          data: null,
        });
      }

      const queues = await Queue.find({
        helperId,
        status: { $in: ["in_queue", "hold", "skipped"] }, // Exclude completed, removed
        createdAt: { $gte: new Date(startTime), $lte: new Date(endTime) },
      })
        .populate("serviceId", "name duration rate")
        .populate("userId", "firstName lastName phone")
        .populate("manualUserId", "name phone")
        .sort({ currentPosition: 1, joiningTime: 1 })
        .lean();

      const enrichedQueues = queues.map((queue) => ({
        ...queue,
        userInfo:
          queue.userType === "normal"
            ? queue.userId
            : queue.manualUserId || { name: "Unknown" },
        userType: queue.userType,
        serviceName: queue.serviceId?.name || "Unknown Service",
        status: queue.status,
        displayStatus:
          queue.status === "hold"
            ? "HOLD"
            : queue.status === "skipped"
            ? "SKIPPED"
            : "ACTIVE",
        positionType:
          queue.status === "hold"
            ? queue.currentPosition
            : queue.currentPosition,
        eta: queue.estimatedServiceStartTime,
      }));

      res.json({
        success: true,
        message: "Helper queue retrieved successfully",
        data: {
          helperId,
          totalInQueue: enrichedQueues.filter((q) => q.status === "in_queue")
            .length,
          totalHold: enrichedQueues.filter((q) => q.status === "hold").length,
          totalSkipped: enrichedQueues.filter((q) => q.status === "skipped")
            .length,
          queues: enrichedQueues,
        },
      });
    } catch (error) {
      console.error("Error retrieving helper queue:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve helper queue",
        data: null,
      });
    }
  }
);

// Get Estimated Wait Times for Helpers and Services
router.post(
  "/helper-wait-times",
  [body("vendorId").isString().withMessage("Valid vendor ID is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId } = req.body;

    try {
      // Verify vendor is owner
      const vendor = await Vendor.findOne({
        _id: vendorId,
        accountType: "owner",
        isDeleted: false,
        isSuspended: false,
        active: true,
      }).lean();

      if (!vendor) {
        return res.status(400).json({
          success: false,
          message: "Vendor is not an active owner or not found",
          data: null,
        });
      }

      // Get active helpers
      const activeHelpers = vendor.connectedHelpers.filter(
        (ch) => ch.status === "accepted" && ch.active
      );

      if (activeHelpers.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No active helpers available",
          data: null,
        });
      }

      // Fetch helper details and services
      const helperWaitTimes = [];
      for (const helper of activeHelpers) {
        const helperDetails = await Vendor.findOne({
          _id: helper.helperId,
          accountType: "helper",
          isDeleted: false,
          isSuspended: false,
        }).lean();

        if (!helperDetails) continue; // Skip deleted/suspended helpers

        const services = [];
        for (const serviceId of helper.associatedServices) {
          const service = await RateCard.findOne({
            _id: serviceId,
            isDeleted: false,
            createdBy: vendorId,
          }).lean();

          if (!service) continue; // Skip invalid services

          // Calculate queue length for this helper and service
          const queueLength = await Queue.countDocuments({
            vendorId,
            helperId: helper.helperId,
            serviceId,
            status: { $in: ["in_queue", "hold", "skipped"] }, // Exclude completed, removed
          });

          const estimatedWait = queueLength * service.duration;

          services.push({
            serviceId: service._id,
            serviceName: service.name,
            duration: service.duration,
            queueLength,
            estimatedWait,
          });
        }

        if (services.length > 0) {
          helperWaitTimes.push({
            helperId: helper.helperId,
            helperName: helperDetails.fullName || "Unknown",
            services,
          });
        }
      }

      if (helperWaitTimes.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No valid helpers or services found",
          data: null,
        });
      }

      res.json({
        success: true,
        message: "Helper wait times retrieved successfully",
        data: {
          vendorId,
          helpers: helperWaitTimes,
        },
      });
    } catch (error) {
      console.error("Error retrieving helper wait times:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve helper wait times",
        data: null,
      });
    }
  }
);

// ------------------------------------------------------------------------------
// Add Manual User (Vendor or Helper)
router.post(
  "/manual-user/add",
  verifyUser,
  [
    body("name").notEmpty().withMessage("Name is required"),
    body("phone.dialCode").notEmpty().withMessage("Dial code is required"),
    body("phone.number").notEmpty().withMessage("Phone number is required"),
    body("gender")
      .isIn(["male", "female", "child"])
      .withMessage("Invalid gender"),
    body("notes").optional().isString().withMessage("Notes must be a string"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { name, phone, gender, notes } = req.body;
    const userId = req.user.id;

    // Fetch the authenticated user (owner or helper)
    const user = await Vendor.findById(userId);
    if (!user || user.isDeleted || user.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "User is not active or not found",
        data: null,
      });
    }

    let vendorId;
    if (user.accountType === "owner") {
      vendorId = user._id.toString();
    } else if (user.accountType === "helper") {
      if (!user.helperJointBusiness) {
        return res.status(403).json({
          success: false,
          message: "Helper is not associated with any business",
          data: null,
        });
      }
      vendorId = user.helperJointBusiness;
    } else {
      return res.status(403).json({
        success: false,
        message:
          "Only active vendor owners or connected helpers can add manual users",
        data: null,
      });
    }

    // Verify vendor exists and is valid
    const vendor = await Vendor.findById(vendorId);
    if (
      !vendor ||
      vendor.isDeleted ||
      vendor.isSuspended ||
      vendor.accountType !== "owner"
    ) {
      return res.status(404).json({
        success: false,
        message: "Valid vendor not found",
        data: null,
      });
    }

    // Check if phone number exists
    const existingUser = await ManualAddUsers.findOne({
      "phone.dialCode": phone.dialCode,
      "phone.number": phone.number,
      vendorId,
      isDeleted: false,
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Phone number already exists for this vendor",
        data: null,
      });
    }

    const manualUser = new ManualAddUsers({
      vendorId,
      name,
      phone,
      gender,
      notes,
    });

    try {
      await manualUser.save();
      res.status(201).json({
        success: true,
        message: "Manual user added successfully",
        data: manualUser,
      });
    } catch (error) {
      console.error("Error adding manual user:", error);
      res.status(500).json({
        success: false,
        message: "Failed to add manual user",
        data: null,
      });
    }
  }
);

// Search Manual User by Phone (Vendor or Helper)
router.post(
  "/manual-user/search",
  verifyUser,
  [
    body("phone.dialCode").notEmpty().withMessage("Dial code is required"),
    body("phone.number").notEmpty().withMessage("Phone number is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { phone } = req.body;
    const userId = req.user.id;

    // Fetch the authenticated user (owner or helper)
    const user = await Vendor.findById(userId);
    if (!user || user.isDeleted || user.isSuspended) {
      return res.status(403).json({
        success: false,
        message: "User is not active or not found",
        data: null,
      });
    }

    let vendorId;
    if (user.accountType === "owner") {
      vendorId = user._id.toString();
    } else if (user.accountType === "helper") {
      if (!user.helperJointBusiness) {
        return res.status(403).json({
          success: false,
          message: "Helper is not associated with any business",
          data: null,
        });
      }
      vendorId = user.helperJointBusiness;
    } else {
      return res.status(403).json({
        success: false,
        message:
          "Only active vendor owners or connected helpers can search manual users",
        data: null,
      });
    }

    // Verify vendor exists and is valid
    const vendor = await Vendor.findById(vendorId);
    if (
      !vendor ||
      vendor.isDeleted ||
      vendor.isSuspended ||
      vendor.accountType !== "owner"
    ) {
      return res.status(404).json({
        success: false,
        message: "Valid vendor not found",
        data: null,
      });
    }

    try {
      // Search for manual users with partial phone number match using regex
      const manualUsers = await ManualAddUsers.find({
        "phone.dialCode": phone.dialCode,
        "phone.number": { $regex: phone.number, $options: "i" }, // Case-insensitive partial match
        vendorId,
        isDeleted: false,
      });

      if (!manualUsers || manualUsers.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No manual users found",
          data: null,
        });
      }

      res.json({
        success: true,
        message: "Manual users retrieved successfully",
        data: manualUsers,
      });
    } catch (error) {
      console.error("Error searching manual users:", error);
      res.status(500).json({
        success: false,
        message: "Failed to search manual users",
        data: null,
      });
    }
  }
);
// ------------------------------------------------------------------------------

// Update Rating and Comments
router.post(
  "/update-rating",
  verifyUser,
  [
    body("queueId").isString().withMessage("Valid queue ID is required"), // ✅ FIXED
    body("rating")
      .isInt({ min: 0, max: 5 })
      .withMessage("Rating must be between 0 and 5"),
    body("notes").optional().isString().withMessage("Notes must be a string"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { queueId, rating, notes } = req.body;
    const userId = req.user.id;

    const queue = await Queue.findById(queueId);
    if (!queue || queue.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Queue entry not found or not completed",
        data: null,
      });
    }

    // Verify user authorization
    if (
      queue.userId &&
      queue.userId.toString() !== userId &&
      queue.manualUserId &&
      !(await ManualAddUsers.findOne({
        _id: queue.manualUserId,
        vendorId: queue.vendorId,
      }))
    ) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to update rating for this queue entry",
        data: null,
      });
    }

    // Check if rating already exists
    if (queue.rating !== undefined) {
      return res.status(400).json({
        success: false,
        message: "Rating already submitted for this queue entry",
        data: null,
      });
    }

    try {
      queue.rating = rating;
      if (notes) queue.notes = notes;
      await queue.save();

      res.json({
        success: true,
        message: "Rating and comments updated successfully",
        data: queue,
      });
    } catch (error) {
      console.error("Error updating rating:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update rating",
        data: null,
      });
    }
  }
);

// Get User Queue History
router.post(
  "/user-queue-history",
  verifyUser,
  [
    body("startTime").isISO8601().withMessage("Valid start time is required"),
    body("endTime").isISO8601().withMessage("Valid end time is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { startTime, endTime } = req.body;
    const userId = req.user.id;

    try {
      // ✅ Only fetch queues for this normal user
      const queues = await Queue.find({
        userId, // Only their own queues
        createdAt: { $gte: new Date(startTime), $lte: new Date(endTime) },
      })
        .populate("serviceId", "name duration rate")
        .populate("vendorId", "businessName fullName")
        .populate("helperId", "fullName")
        .sort({ joiningTime: -1 })
        .lean();

      res.json({
        success: true,
        message: "User queue history retrieved successfully",
        data: queues,
      });
    } catch (error) {
      console.error("Error retrieving user queue history:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve user queue history",
        data: null,
      });
    }
  }
);

// Get Business Queue History
router.post(
  "/business-queue-history",
  verifyUser,
  [
    body("vendorId").isString().withMessage("Valid vendor ID is required"), // ✅ FIXED
    body("startTime").isISO8601().withMessage("Valid start time is required"),
    body("endTime").isISO8601().withMessage("Valid end time is required"),
    body("helperId").optional().isString().withMessage("Invalid helper ID"), // ✅ FIXED
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId, startTime, endTime, helperId } = req.body;
    const userId = req.user.id;

    try {
      // ✅ Verify authorization
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res.status(403).json({
          success: false,
          message: "Vendor not found or inactive",
          data: null,
        });
      }

      let authorized = false;

      // Owner accessing their own business
      if (vendor.accountType === "owner" && vendor._id === userId) {
        authorized = true;
      }
      // Helper accessing their assigned business
      else {
        const helper = await Vendor.findOne({
          _id: userId,
          accountType: "helper",
          helperJointBusiness: vendorId,
          isDeleted: false,
          isSuspended: false,
        });

        if (helper) {
          const isConnected = vendor.connectedHelpers.some(
            (ch) => ch.helperId === userId && ch.status === "accepted"
          );
          if (isConnected) {
            authorized = true;
          }
        }
      }

      if (!authorized) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized to access business queue history",
          data: null,
        });
      }

      // ✅ Build query - all statuses included
      const query = {
        vendorId,
        createdAt: { $gte: new Date(startTime), $lte: new Date(endTime) },
      };
      if (helperId) {
        query.helperId = helperId;
      }

      const queues = await Queue.find(query)
        .populate("serviceId", "name duration rate")
        .populate("userId", "firstName lastName phone")
        .populate("manualUserId", "name phone")
        .populate("helperId", "fullName")
        .sort({ joiningTime: -1 })
        .lean();

      res.json({
        success: true,
        message: "Business queue history retrieved successfully",
        data: queues,
      });
    } catch (error) {
      console.error("Error retrieving business queue history:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve business queue history",
        data: null,
      });
    }
  }
);

// Set Break (Owner or Helper)
router.post(
  "/set-break",
  verifyUser,
  [
    body("vendorId").isString().withMessage("Valid vendor ID is required"), // ✅ FIXED
    body("helperId").optional().isString().withMessage("Invalid helper ID"), // ✅ FIXED
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

    const { vendorId, helperId, reason, duration, message } = req.body;
    const userId = req.user.id;

    try {
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res.status(403).json({
          success: false,
          message: "Vendor not found or inactive",
          data: null,
        });
      }

      // Authorization check
      if (vendor.accountType === "owner" && vendor._id !== userId) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized",
          data: null,
        });
      }

      if (vendor.accountType === "helper") {
        return res.status(403).json({
          success: false,
          message: "Only owners can set breaks",
          data: null,
        });
      }

      // Handle owner break (business-wide)
      if (!helperId) {
        vendor.active = false; // ✅ Business goes inactive
        await vendor.save();

        // ✅ Notify all queued customers (including skipped)
        const queues = await Queue.find({
          vendorId,
          status: { $in: ["in_queue", "hold", "skipped"] }, // ✅ FIXED
        });

        const userIds = queues
          .filter((q) => q.userType === "normal" && q.userId)
          .map((q) => q.userId);

        if (userIds.length > 0) {
          const users = await User.find({
            _id: { $in: userIds },
            receiveNotifications: true,
          }).select("pushToken");

          const pushTokens = users.filter((u) => u.pushToken);
          if (pushTokens.length > 0) {
            await axios.post(
              "https://exp.host/--/api/v2/push/send",
              pushTokens.map((u) => ({
                to: u.pushToken,
                sound: "default",
                title: "Business on Break",
                body: `Business is on break: ${message}`,
                data: { type: "business_break", reason, duration },
              })),
              {
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
              }
            );
          }
        }

        return res.json({
          success: true,
          message: "Business break set successfully",
          data: null,
        });
      }

      // Handle helper break
      const helperConnection = vendor.connectedHelpers.find(
        (ch) => ch.helperId === helperId && ch.status === "accepted"
      );

      if (!helperConnection) {
        return res.status(400).json({
          success: false,
          message: "Helper not found or not authorized",
          data: null,
        });
      }

      helperConnection.active = false; // ✅ Helper goes inactive
      await vendor.save();

      // ✅ Notify affected customers (including skipped)
      const queues = await Queue.find({
        vendorId,
        helperId,
        status: { $in: ["in_queue", "hold", "skipped"] }, // ✅ FIXED
      });

      const userIds = queues
        .filter((q) => q.userType === "normal" && q.userId)
        .map((q) => q.userId);

      if (userIds.length > 0) {
        const users = await User.find({
          _id: { $in: userIds },
          receiveNotifications: true,
        }).select("pushToken");

        const pushTokens = users.filter((u) => u.pushToken);
        if (pushTokens.length > 0) {
          await axios.post(
            "https://exp.host/--/api/v2/push/send",
            pushTokens.map((u) => ({
              to: u.pushToken,
              sound: "default",
              title: "Helper on Break",
              body: `Your helper is on break: ${message}`,
              data: { type: "helper_break", reason, duration },
            })),
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
            }
          );
        }
      }

      // ✅ Trigger restructure
      await axios.post(
        `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
        {
          vendorId,
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        { headers: { Authorization: req.headers.authorization } }
      );

      res.json({
        success: true,
        message: "Helper break set successfully",
        data: null,
      });
    } catch (error) {
      console.error("Error setting break:", error);
      res.status(500).json({
        success: false,
        message: "Failed to set break",
        data: null,
      });
    }
  }
);

// Resume from Break (Owner or Helper)
router.post(
  "/resume-break",
  verifyUser,
  [
    body("vendorId").isString().withMessage("Valid vendor ID is required"), // ✅ FIXED
    body("helperId").optional().isString().withMessage("Invalid helper ID"), // ✅ FIXED
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { vendorId, helperId } = req.body;
    const userId = req.user.id;

    try {
      const vendor = await Vendor.findById(vendorId);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        return res.status(403).json({
          success: false,
          message: "Vendor not found or inactive",
          data: null,
        });
      }

      // Authorization check
      if (vendor.accountType === "owner" && vendor._id !== userId) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized",
          data: null,
        });
      }

      if (vendor.accountType === "helper") {
        return res.status(403).json({
          success: false,
          message: "Only owners can resume breaks",
          data: null,
        });
      }

      // Handle owner break resumption
      if (!helperId) {
        vendor.active = true; // ✅ Business resumes
        await vendor.save();

        // ✅ Notify all queued customers (including skipped)
        const queues = await Queue.find({
          vendorId,
          status: { $in: ["in_queue", "hold", "skipped"] }, // ✅ FIXED
        });

        const userIds = queues
          .filter((q) => q.userType === "normal" && q.userId)
          .map((q) => q.userId);

        if (userIds.length > 0) {
          const users = await User.find({
            _id: { $in: userIds },
            receiveNotifications: true,
          }).select("pushToken");

          const pushTokens = users.filter((u) => u.pushToken);
          if (pushTokens.length > 0) {
            await axios.post(
              "https://exp.host/--/api/v2/push/send",
              pushTokens.map((u) => ({
                to: u.pushToken,
                sound: "default",
                title: "Business Resumed",
                body: "The business has resumed operations.",
                data: { type: "business_resumed" },
              })),
              {
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
              }
            );
          }
        }

        return res.json({
          success: true,
          message: "Business resumed successfully",
          data: null,
        });
      }

      // Handle helper break resumption
      const helperConnection = vendor.connectedHelpers.find(
        (ch) => ch.helperId === helperId && ch.status === "accepted"
      );

      if (!helperConnection) {
        return res.status(400).json({
          success: false,
          message: "Helper not found or not authorized",
          data: null,
        });
      }

      helperConnection.active = true; // ✅ Helper resumes
      await vendor.save();

      // ✅ Notify affected customers (including skipped)
      const queues = await Queue.find({
        vendorId,
        helperId,
        status: { $in: ["in_queue", "hold", "skipped"] }, // ✅ FIXED
      });

      const userIds = queues
        .filter((q) => q.userType === "normal" && q.userId)
        .map((q) => q.userId);

      if (userIds.length > 0) {
        const users = await User.find({
          _id: { $in: userIds },
          receiveNotifications: true,
        }).select("pushToken");

        const pushTokens = users.filter((u) => u.pushToken);
        if (pushTokens.length > 0) {
          await axios.post(
            "https://exp.host/--/api/v2/push/send",
            pushTokens.map((u) => ({
              to: u.pushToken,
              sound: "default",
              title: "Helper Resumed",
              body: "Your helper has resumed work.",
              data: { type: "helper_resumed" },
            })),
            {
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
            }
          );
        }
      }

      // ✅ Trigger restructure
      await axios.post(
        `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
        {
          vendorId,
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        { headers: { Authorization: req.headers.authorization } }
      );

      res.json({
        success: true,
        message: "Helper resumed successfully",
        data: null,
      });
    } catch (error) {
      console.error("Error resuming break:", error);
      res.status(500).json({
        success: false,
        message: "Failed to resume break",
        data: null,
      });
    }
  }
);

router.post(
  "/queue-action",
  verifyUser,
  [
    body("queueId").isString().withMessage("Valid queue ID is required"),
    body("action")
      .isIn(["skip", "hold", "remove", "next", "add_time", "unhold", "undo"])
      .withMessage("Invalid action"),
    body("addedTime")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Added time must be a positive integer"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { queueId, action, addedTime } = req.body;
    const userId = req.user.id;

    const session = await Queue.startSession();
    session.startTransaction();

    try {
      const queue = await Queue.findById(queueId)
        .populate("serviceId")
        .session(session);

      if (!queue || queue.status === "removed") {
        throw new Error("Queue entry not found or already removed");
      }

      // Verify authorization
      const vendor = await Vendor.findById(queue.vendorId).session(session);
      if (!vendor || vendor.isDeleted || vendor.isSuspended) {
        throw new Error("Vendor not found or inactive");
      }

      let authorized = false;
      const isUser = queue.userId && queue.userId.toString() === userId;
      const isOwner = vendor.accountType === "owner" && vendor._id === userId;
      const isHelper =
        vendor.accountType === "owner" &&
        vendor.connectedHelpers.some(
          (h) => h.helperId === userId && h.status === "accepted" && h.active
        );

      // User can only remove themselves
      if (isUser && action === "remove") {
        authorized = true;
      }
      // Owner or helper can do all actions
      else if (isOwner || isHelper) {
        authorized = true;
      }

      if (!authorized) {
        throw new Error("Unauthorized to perform this action");
      }

      const source = isUser ? "user" : "vendor";

      // Send notification helper
      const sendNotification = async (title, body, dataType) => {
        if (queue.userId && queue.userType === "normal") {
          const user = await User.findById(queue.userId)
            .select("pushToken receiveNotifications")
            .session(session);
          if (user?.receiveNotifications && user.pushToken) {
            try {
              await axios.post(
                "https://exp.host/--/api/v2/push/send",
                [
                  {
                    to: user.pushToken,
                    sound: "default",
                    title,
                    body,
                    data: { type: dataType },
                  },
                ],
                {
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                  },
                }
              );
            } catch (err) {
              console.error("Notification failed:", err);
            }
          }
        }
      };

      // Action handlers
      if (action === "skip") {
        // Find next in_queue person to swap with
        const nextPerson = await Queue.findOne({
          vendorId: queue.vendorId,
          helperId: queue.helperId,
          currentPosition: { $gt: queue.currentPosition },
          status: "in_queue",
        })
          .sort({ currentPosition: 1 })
          .session(session);

        if (!nextPerson) {
          throw new Error("No in_queue person found to swap with");
        }

        // Swap positions
        const tempPosition = queue.currentPosition;
        queue.currentPosition = nextPerson.currentPosition;
        nextPerson.currentPosition = tempPosition;

        // Recalculate times
        const service = queue.serviceId;
        queue.estimatedWait = (queue.currentPosition - 1) * service.duration;
        queue.estimatedServiceStartTime = new Date(
          Date.now() + queue.estimatedWait * 60 * 1000
        );

        nextPerson.estimatedWait =
          (nextPerson.currentPosition - 1) * service.duration;
        nextPerson.estimatedServiceStartTime = new Date(
          Date.now() + nextPerson.estimatedWait * 60 * 1000
        );

        // Update histories
        queue.updateHistory.push({
          action: "skip",
          source,
          timestamp: new Date(),
          previousPosition: tempPosition,
          newPosition: queue.currentPosition,
          estimatedWait: queue.estimatedWait,
        });

        nextPerson.updateHistory.push({
          action: "skip",
          source,
          timestamp: new Date(),
          previousPosition: nextPerson.currentPosition,
          newPosition: tempPosition,
          estimatedWait: nextPerson.estimatedWait,
        });

        await nextPerson.save({ session });
        await queue.save({ session });

        await sendNotification(
          "Queue Updated",
          `Your position changed from ${tempPosition} to ${queue.currentPosition}`,
          "queue_skip"
        );
      } else if (action === "hold") {
        if (queue.status === "hold") {
          throw new Error("Queue entry is already on hold");
        }

        const previousPosition = queue.currentPosition;
        queue.status = "hold";

        queue.updateHistory.push({
          action: "hold",
          source,
          timestamp: new Date(),
          previousPosition,
          newPosition: queue.currentPosition,
          estimatedWait: queue.estimatedWait,
        });

        await queue.save({ session });
        await session.commitTransaction();

        await sendNotification(
          "Queue On Hold",
          "Your queue entry has been placed on hold",
          "queue_hold"
        );

        // Trigger restructure
        try {
          await axios.post(
            `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
            {
              vendorId: queue.vendorId,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            { headers: { Authorization: req.headers.authorization } }
          );
        } catch (err) {
          console.error("Restructure trigger failed:", err);
        }

        return res.json({
          success: true,
          message: "Queue entry placed on hold successfully",
          data: queue,
        });
      } else if (action === "unhold") {
        if (queue.status !== "hold") {
          throw new Error("Queue entry is not on hold");
        }

        const previousPosition = queue.currentPosition;
        queue.status = "in_queue";

        queue.updateHistory.push({
          action: "unhold",
          source,
          timestamp: new Date(),
          previousPosition,
          newPosition: queue.currentPosition,
          estimatedWait: queue.estimatedWait,
        });

        await queue.save({ session });
        await session.commitTransaction();

        await sendNotification(
          "Queue Resumed",
          "Your queue entry has been taken off hold",
          "queue_unhold"
        );

        // Trigger restructure
        try {
          await axios.post(
            `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
            {
              vendorId: queue.vendorId,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            { headers: { Authorization: req.headers.authorization } }
          );
        } catch (err) {
          console.error("Restructure trigger failed:", err);
        }

        return res.json({
          success: true,
          message: "Queue entry resumed successfully",
          data: queue,
        });
      } else if (action === "remove") {
        const previousPosition = queue.currentPosition;
        queue.status = "removed";

        queue.updateHistory.push({
          action: "remove",
          source,
          timestamp: new Date(),
          previousPosition,
          newPosition: queue.currentPosition,
          estimatedWait: queue.estimatedWait,
        });

        await queue.save({ session });
        await session.commitTransaction();

        await sendNotification(
          "Removed from Queue",
          "You have been removed from the queue",
          "queue_remove"
        );

        // Trigger restructure
        try {
          await axios.post(
            `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
            {
              vendorId: queue.vendorId,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            { headers: { Authorization: req.headers.authorization } }
          );
        } catch (err) {
          console.error("Restructure trigger failed:", err);
        }

        return res.json({
          success: true,
          message: "Queue entry removed successfully",
          data: queue,
        });
      } else if (action === "next") {
        // Only position 1 can be marked as completed
        if (queue.currentPosition !== 1) {
          throw new Error(
            "Only the first person in queue can be marked as next"
          );
        }

        if (queue.status === "completed") {
          throw new Error("Queue entry is already completed");
        }

        const previousPosition = queue.currentPosition;
        queue.status = "completed";

        queue.updateHistory.push({
          action: "next",
          source,
          timestamp: new Date(),
          previousPosition,
          newPosition: queue.currentPosition,
          estimatedWait: queue.estimatedWait,
        });

        await queue.save({ session });
        await session.commitTransaction();

        await sendNotification(
          "Service Completed",
          "Your service has been completed",
          "queue_next"
        );

        // Trigger restructure
        try {
          await axios.post(
            `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
            {
              vendorId: queue.vendorId,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            { headers: { Authorization: req.headers.authorization } }
          );
        } catch (err) {
          console.error("Restructure trigger failed:", err);
        }

        return res.json({
          success: true,
          message: "Service marked as completed successfully",
          data: queue,
        });
      } else if (action === "add_time") {
        if (!addedTime) {
          throw new Error("Added time is required for add_time action");
        }

        const previousWait = queue.estimatedWait;
        queue.estimatedWait += addedTime;
        queue.estimatedServiceStartTime = new Date(
          queue.estimatedServiceStartTime.getTime() + addedTime * 60 * 1000
        );

        queue.updateHistory.push({
          action: "add_time",
          source,
          timestamp: new Date(),
          previousPosition: queue.currentPosition,
          newPosition: queue.currentPosition,
          addedTime,
          estimatedWait: queue.estimatedWait,
        });

        await queue.save({ session });
        await session.commitTransaction();

        await sendNotification(
          "Wait Time Updated",
          `Your wait time increased by ${addedTime} minutes`,
          "queue_add_time"
        );

        // Trigger restructure to update all subsequent queues
        try {
          await axios.post(
            `${req.protocol}://${req.get("host")}/api/queue/restructure-queue`,
            {
              vendorId: queue.vendorId,
              startTime: new Date().toISOString(),
              endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            },
            { headers: { Authorization: req.headers.authorization } }
          );
        } catch (err) {
          console.error("Restructure trigger failed:", err);
        }

        return res.json({
          success: true,
          message: "Time added successfully",
          data: queue,
        });
      } else if (action === "undo") {
        // Only vendor actions can be undone
        if (source === "user") {
          throw new Error("User actions cannot be undone");
        }

        // Get last vendor action within 5 minutes
        const recentActions = queue.updateHistory.filter(
          (h) =>
            h.source === "vendor" &&
            h.timestamp > new Date(Date.now() - 5 * 60 * 1000)
        );

        if (recentActions.length === 0) {
          throw new Error("No recent vendor actions to undo");
        }

        const lastAction = recentActions[recentActions.length - 1];

        if (lastAction.action === "skip") {
          // Find the person we swapped with
          const swappedPerson = await Queue.findOne({
            vendorId: queue.vendorId,
            helperId: queue.helperId,
            currentPosition: lastAction.previousPosition,
            status: "in_queue",
          }).session(session);

          if (!swappedPerson) {
            throw new Error("Cannot undo skip - swapped person not found");
          }

          // Swap back
          const tempPosition = queue.currentPosition;
          queue.currentPosition = lastAction.previousPosition;
          swappedPerson.currentPosition = tempPosition;

          // Recalculate times
          const service = queue.serviceId;
          queue.estimatedWait = (queue.currentPosition - 1) * service.duration;
          queue.estimatedServiceStartTime = new Date(
            Date.now() + queue.estimatedWait * 60 * 1000
          );

          swappedPerson.estimatedWait =
            (swappedPerson.currentPosition - 1) * service.duration;
          swappedPerson.estimatedServiceStartTime = new Date(
            Date.now() + swappedPerson.estimatedWait * 60 * 1000
          );

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: tempPosition,
            newPosition: queue.currentPosition,
            estimatedWait: queue.estimatedWait,
          });

          swappedPerson.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: swappedPerson.currentPosition,
            newPosition: tempPosition,
            estimatedWait: swappedPerson.estimatedWait,
          });

          await swappedPerson.save({ session });
          await queue.save({ session });

          await sendNotification(
            "Queue Restored",
            `Your position restored to ${queue.currentPosition}`,
            "queue_undo"
          );
        } else if (lastAction.action === "hold") {
          queue.status = "in_queue";

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: queue.currentPosition,
            newPosition: queue.currentPosition,
            estimatedWait: queue.estimatedWait,
          });

          await queue.save({ session });
          await session.commitTransaction();

          await sendNotification(
            "Queue Restored",
            "Hold status has been undone",
            "queue_undo"
          );

          // Trigger restructure
          try {
            await axios.post(
              `${req.protocol}://${req.get(
                "host"
              )}/api/queue/restructure-queue`,
              {
                vendorId: queue.vendorId,
                startTime: new Date().toISOString(),
                endTime: new Date(
                  Date.now() + 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              { headers: { Authorization: req.headers.authorization } }
            );
          } catch (err) {
            console.error("Restructure trigger failed:", err);
          }

          return res.json({
            success: true,
            message: "Hold action undone successfully",
            data: queue,
          });
        } else if (lastAction.action === "unhold") {
          queue.status = "hold";

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: queue.currentPosition,
            newPosition: queue.currentPosition,
            estimatedWait: queue.estimatedWait,
          });

          await queue.save({ session });
          await session.commitTransaction();

          await sendNotification(
            "Queue Restored",
            "Unhold action has been undone",
            "queue_undo"
          );

          // Trigger restructure
          try {
            await axios.post(
              `${req.protocol}://${req.get(
                "host"
              )}/api/queue/restructure-queue`,
              {
                vendorId: queue.vendorId,
                startTime: new Date().toISOString(),
                endTime: new Date(
                  Date.now() + 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              { headers: { Authorization: req.headers.authorization } }
            );
          } catch (err) {
            console.error("Restructure trigger failed:", err);
          }

          return res.json({
            success: true,
            message: "Unhold action undone successfully",
            data: queue,
          });
        } else if (lastAction.action === "remove") {
          queue.status = "in_queue";

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: queue.currentPosition,
            newPosition: queue.currentPosition,
            estimatedWait: queue.estimatedWait,
          });

          await queue.save({ session });
          await session.commitTransaction();

          await sendNotification(
            "Queue Restored",
            "You have been added back to the queue",
            "queue_undo"
          );

          // Trigger restructure
          try {
            await axios.post(
              `${req.protocol}://${req.get(
                "host"
              )}/api/queue/restructure-queue`,
              {
                vendorId: queue.vendorId,
                startTime: new Date().toISOString(),
                endTime: new Date(
                  Date.now() + 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              { headers: { Authorization: req.headers.authorization } }
            );
          } catch (err) {
            console.error("Restructure trigger failed:", err);
          }

          return res.json({
            success: true,
            message: "Remove action undone successfully",
            data: queue,
          });
        } else if (lastAction.action === "next") {
          queue.status = "in_queue";

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: queue.currentPosition,
            newPosition: queue.currentPosition,
            estimatedWait: queue.estimatedWait,
          });

          await queue.save({ session });
          await session.commitTransaction();

          await sendNotification(
            "Queue Restored",
            "Completion has been undone",
            "queue_undo"
          );

          // Trigger restructure
          try {
            await axios.post(
              `${req.protocol}://${req.get(
                "host"
              )}/api/queue/restructure-queue`,
              {
                vendorId: queue.vendorId,
                startTime: new Date().toISOString(),
                endTime: new Date(
                  Date.now() + 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              { headers: { Authorization: req.headers.authorization } }
            );
          } catch (err) {
            console.error("Restructure trigger failed:", err);
          }

          return res.json({
            success: true,
            message: "Next action undone successfully",
            data: queue,
          });
        } else if (lastAction.action === "add_time") {
          queue.estimatedWait -= lastAction.addedTime;
          queue.estimatedServiceStartTime = new Date(
            queue.estimatedServiceStartTime.getTime() -
              lastAction.addedTime * 60 * 1000
          );

          queue.updateHistory.push({
            action: "undo",
            source,
            timestamp: new Date(),
            previousPosition: queue.currentPosition,
            newPosition: queue.currentPosition,
            addedTime: -lastAction.addedTime,
            estimatedWait: queue.estimatedWait,
          });

          await queue.save({ session });
          await session.commitTransaction();

          await sendNotification(
            "Wait Time Updated",
            `Your wait time decreased by ${lastAction.addedTime} minutes`,
            "queue_undo"
          );

          // Trigger restructure
          try {
            await axios.post(
              `${req.protocol}://${req.get(
                "host"
              )}/api/queue/restructure-queue`,
              {
                vendorId: queue.vendorId,
                startTime: new Date().toISOString(),
                endTime: new Date(
                  Date.now() + 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              { headers: { Authorization: req.headers.authorization } }
            );
          } catch (err) {
            console.error("Restructure trigger failed:", err);
          }

          return res.json({
            success: true,
            message: "Add time action undone successfully",
            data: queue,
          });
        } else {
          throw new Error(`Cannot undo action: ${lastAction.action}`);
        }
      }

      await session.commitTransaction();

      res.json({
        success: true,
        message: `Queue action ${action} performed successfully`,
        data: queue,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error(`Error performing queue action ${action}:`, error);
      res.status(500).json({
        success: false,
        message: error.message || `Failed to perform queue action ${action}`,
        data: null,
      });
    } finally {
      session.endSession();
    }
  }
);

router.post(
  "/helper-recent-actions",
  verifyUser,
  [
    body("helperId").isString().withMessage("Valid helper ID is required"),
    body("limit")
      .optional()
      .isInt({ min: 1, max: 10 })
      .withMessage("Limit must be between 1 and 10"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { helperId, limit = 3 } = req.body;
    const userId = req.user.id;

    try {
      // Verify helper authorization
      const helper = await Vendor.findOne({
        _id: helperId,
        accountType: "helper",
        isDeleted: false,
        isSuspended: false,
      }).lean();

      if (!helper) {
        return res.status(403).json({
          success: false,
          message: "Helper not found or inactive",
          data: null,
        });
      }

      // Only the helper themselves or their business owner can access
      const isHelper = helper._id === userId;
      const isOwner = await Vendor.findOne({
        _id: userId,
        accountType: "owner",
        connectedHelpers: {
          $elemMatch: { helperId, status: "accepted", active: true },
        },
      }).lean();

      if (!isHelper && !isOwner) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized to access helper actions",
          data: null,
        });
      }

      // Get all queue entries for this helper with recent vendor actions
      const queues = await Queue.find({
        helperId,
        status: { $in: ["in_queue", "hold"] },
        "updateHistory.source": "vendor",
        "updateHistory.timestamp": {
          $gte: new Date(Date.now() - 5 * 60 * 1000),
        }, // Last 5 minutes
      })
        .populate("serviceId", "name")
        .populate("userId", "firstName lastName")
        .populate("manualUserId", "name")
        .lean();

      // Extract and flatten recent vendor actions
      const recentActions = [];

      for (const queue of queues) {
        const vendorActions = queue.updateHistory
          .filter(
            (h) =>
              h.source === "vendor" &&
              h.timestamp > new Date(Date.now() - 5 * 60 * 1000) &&
              h.action !== "undo" // Exclude undo from list
          )
          .map((h) => ({
            queueId: queue._id,
            action: h.action,
            timestamp: h.timestamp,
            previousPosition: h.previousPosition,
            newPosition: h.newPosition,
            addedTime: h.addedTime,
            estimatedWait: h.estimatedWait,
            customerName:
              queue.userType === "normal"
                ? queue.userId
                  ? `${queue.userId.firstName} ${queue.userId.lastName}`
                  : "Unknown"
                : queue.manualUserId?.name || "Unknown",
            serviceName: queue.serviceId?.name || "Unknown",
            currentQueueStatus: queue.status,
          }));

        recentActions.push(...vendorActions);
      }

      // Sort by timestamp descending and take last N
      recentActions.sort((a, b) => b.timestamp - a.timestamp);
      const limitedActions = recentActions.slice(0, limit);

      res.json({
        success: true,
        message: "Recent actions retrieved successfully",
        data: {
          helperId,
          actions: limitedActions,
          totalActions: recentActions.length,
        },
      });
    } catch (error) {
      console.error("Error retrieving helper recent actions:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve recent actions",
        data: null,
      });
    }
  }
);

// Haversine formula to calculate distance between two points (in kilometers)
const getDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

//Search and Discovery Route
router.post(
  "/search-discover",
  [
    body("query").optional().isString().withMessage("Query must be a string"),
    body("businessType")
      .optional()
      .isString()
      .withMessage("Business type must be a string"),
    body("latitude")
      .isFloat({ min: -90, max: 90 })
      .withMessage("Valid latitude is required"),
    body("longitude")
      .isFloat({ min: -180, max: 180 })
      .withMessage("Valid longitude is required"),
    body("filters.location")
      .optional()
      .isBoolean()
      .withMessage("Location filter must be boolean"),
    body("filters.locationThreshold")
      .optional()
      .isFloat({ min: 0.1 })
      .withMessage("Location threshold must be positive"),
    body("filters.rating")
      .optional()
      .isBoolean()
      .withMessage("Rating filter must be boolean"),
    body("filters.minRating")
      .optional()
      .isFloat({ min: 0, max: 5 })
      .withMessage("Min rating must be between 0 and 5"),
    body("filters.popularity")
      .optional()
      .isBoolean()
      .withMessage("Popularity filter must be boolean"),
    body("filters.minPopularity")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Min popularity must be non-negative"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const {
      query = "",
      businessType = "all",
      latitude,
      longitude,
      filters = {},
    } = req.body;

    try {
      // Step 1: Build initial query for active businesses
      const businessQuery = {
        accountType: "owner",
        isDeleted: false,
        isSuspended: false,
        active: true,
      };

      // Step 2: Apply businessType filter (regex if not "all")
      if (businessType && businessType.toLowerCase() !== "all") {
        businessQuery.businessType = { $regex: businessType, $options: "i" };
      }

      // Step 3: Fetch all active businesses
      let businesses = await Vendor.find(businessQuery)
        .select(
          "_id businessName businessType businessAddress workingHours location avatar noOfSeats"
        )
        .lean();

      if (businesses.length === 0) {
        return res.json({
          success: true,
          message: "No businesses found",
          data: [],
        });
      }

      const businessIds = businesses.map((b) => b._id);

      // Step 4: Get all active services for these businesses
      const services = await RateCard.find({
        createdBy: { $in: businessIds },
        isDeleted: false,
      })
        .select("_id name duration rate gender createdBy")
        .lean();

      // Map services by business
      const servicesByBusiness = {};
      services.forEach((s) => {
        if (!servicesByBusiness[s.createdBy]) {
          servicesByBusiness[s.createdBy] = [];
        }
        servicesByBusiness[s.createdBy].push(s);
      });

      // Step 5: Apply search query filter (businessName OR service name)
      if (query && query.trim() !== "") {
        const searchRegex = new RegExp(query, "i");

        businesses = businesses.filter((business) => {
          // Check business name
          const matchesBusinessName = searchRegex.test(business.businessName);

          // Check service names
          const businessServices = servicesByBusiness[business._id] || [];
          const matchesServiceName = businessServices.some((s) =>
            searchRegex.test(s.name)
          );

          return matchesBusinessName || matchesServiceName;
        });
      }

      if (businesses.length === 0) {
        return res.json({
          success: true,
          message: "No businesses found matching search criteria",
          data: [],
        });
      }

      // Step 6: Calculate distance using Haversine formula
      const calculateDistance = (lat1, lon1, lat2, lon2) => {
        const R = 6371; // Earth's radius in km
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c; // Distance in km
      };

      // Add distance to each business
      businesses = businesses.map((business) => ({
        ...business,
        distance:
          business.location?.latitude && business.location?.longitude
            ? calculateDistance(
                latitude,
                longitude,
                business.location.latitude,
                business.location.longitude
              )
            : null,
      }));

      // Step 7: Apply location filter if enabled
      if (filters.location && filters.locationThreshold) {
        businesses = businesses.filter(
          (b) => b.distance !== null && b.distance <= filters.locationThreshold
        );
      }

      if (businesses.length === 0) {
        return res.json({
          success: true,
          message: "No businesses found within location threshold",
          data: [],
        });
      }

      const finalBusinessIds = businesses.map((b) => b._id);

      // Step 8: Calculate ratings and popularity from Queue collection
      const queueStats = await Queue.aggregate([
        {
          $match: {
            vendorId: { $in: finalBusinessIds },
            status: "completed",
          },
        },
        {
          $group: {
            _id: "$vendorId",
            totalCompleted: { $sum: 1 }, // Popularity
            ratings: { $push: "$rating" },
          },
        },
      ]);

      // Map stats by business
      const statsByBusiness = {};
      queueStats.forEach((stat) => {
        const validRatings = stat.ratings.filter((r) => r != null);
        const avgRating =
          validRatings.length > 0
            ? validRatings.reduce((sum, r) => sum + r, 0) / validRatings.length
            : 0;

        statsByBusiness[stat._id] = {
          avgRating: Math.round(avgRating * 10) / 10, // Round to 1 decimal
          totalCompleted: stat.totalCompleted,
          ratingCount: validRatings.length,
        };
      });

      // Step 9: Apply rating filter if enabled
      if (filters.rating && filters.minRating != null) {
        businesses = businesses.filter((b) => {
          const stats = statsByBusiness[b._id];
          return stats && stats.avgRating >= filters.minRating;
        });
      }

      // Step 10: Apply popularity filter if enabled
      if (filters.popularity && filters.minPopularity != null) {
        businesses = businesses.filter((b) => {
          const stats = statsByBusiness[b._id];
          return stats && stats.totalCompleted >= filters.minPopularity;
        });
      }

      if (businesses.length === 0) {
        return res.json({
          success: true,
          message: "No businesses found matching all filters",
          data: [],
        });
      }

      // Step 11: Get top 3 reviews for each business (completed with rating >= 4)
      const reviewsData = await Queue.find({
        vendorId: { $in: businesses.map((b) => b._id) },
        status: "completed",
        rating: { $gte: 4, $ne: null },
      })
        .populate("userId", "firstName lastName")
        .select("vendorId rating notes userId createdAt")
        .sort({ createdAt: -1 })
        .lean();

      // Group reviews by business (top 3 each)
      const reviewsByBusiness = {};
      reviewsData.forEach((review) => {
        if (!reviewsByBusiness[review.vendorId]) {
          reviewsByBusiness[review.vendorId] = [];
        }
        if (reviewsByBusiness[review.vendorId].length < 3) {
          reviewsByBusiness[review.vendorId].push({
            rating: review.rating,
            notes: review.notes || "",
            customerName: review.userId
              ? `${review.userId.firstName} ${review.userId.lastName}`
              : "Anonymous",
            date: review.createdAt,
          });
        }
      });

      // Step 12: Build final response
      const enrichedBusinesses = businesses.map((business) => {
        const stats = statsByBusiness[business._id] || {
          avgRating: 0,
          totalCompleted: 0,
          ratingCount: 0,
        };

        return {
          _id: business._id,
          businessName: business.businessName,
          businessType: business.businessType,
          businessAddress: business.businessAddress,
          avatar: business.avatar,
          noOfSeats: business.noOfSeats,
          workingHours: business.workingHours,
          location: business.location,
          distance: business.distance,
          rating: stats.avgRating,
          ratingCount: stats.ratingCount,
          popularity: stats.totalCompleted,
          services: servicesByBusiness[business._id] || [],
          reviews: reviewsByBusiness[business._id] || [],
        };
      });

      // Step 13: Sort by distance (nearest first)
      enrichedBusinesses.sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });

      res.json({
        success: true,
        message: "Businesses retrieved successfully",
        data: enrichedBusinesses,
      });
    } catch (error) {
      console.error("Error searching businesses:", error);
      res.status(500).json({
        success: false,
        message: "Failed to search businesses",
        data: null,
      });
    }
  }
);

module.exports = router;

const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const path = require("path");

const router = express.Router();

// Configure multer to use memory storage (buffer)
const upload = multer({ storage: multer.memoryStorage() });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Helper: Upload buffer to Cloudinary (returns Promise)
function uploadToCloudinary(buffer, originalname) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "QVuew",
        resource_type: "image",
        public_id: path.parse(originalname).name + "-" + Date.now(),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// Cloudinary upload route
router.post("/cloudinary", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        data: null,
        message: "No file uploaded. Please attach a file.",
        success: false,
      });
    }

    const result = await uploadToCloudinary(
      req.file.buffer,
      req.file.originalname
    );

    return res.status(200).json({
      data: {
        url: result.secure_url,
        public_id: result.public_id,
      },
      message: "File uploaded successfully to Cloudinary",
      success: true,
    });
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    return res.status(500).json({
      data: null,
      message: "Internal server error while uploading file to Cloudinary.",
      success: false,
    });
  }
});

module.exports = router;

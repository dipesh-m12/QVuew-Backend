const express = require("express");
const router = express.Router();
const multer = require("multer");
const axios = require("axios");
const { body, validationResult } = require("express-validator");
const FormData = require("form-data");
const fs = require("fs");

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, "uploads/"); // Temporary storage for uploaded files
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG, JPEG, and JPG images are allowed"), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Ensure uploads directory exists
const uploadDir = "uploads";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// OCR Route
router.post(
  "/ocr",
  upload.single("file"), // Expect file under 'file' key
  [
    body("file").custom((value, { req }) => {
      if (!req.file) {
        throw new Error("Image file is required");
      }
      return true;
    }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Delete uploaded file if validation fails
      if (req.file) fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const apiKey = process.env.OCR_SPACE_API_KEY || "K89675956188957";
    const url = "https://api.ocr.space/parse/image";

    try {
      // Create form data for OCR.space API
      const form = new FormData();
      form.append("file", fs.createReadStream(req.file.path));
      form.append("apikey", apiKey);
      form.append("language", "eng");
      form.append("isOverlayRequired", "false");

      // Send request to OCR.space API
      const response = await axios.post(url, form, {
        headers: {
          ...form.getHeaders(),
        },
      });

      // Delete the uploaded file
      fs.unlinkSync(req.file.path);

      if (response.status === 200) {
        const result = response.data;
        if (result.IsErroredOnProcessing) {
          return res.status(400).json({
            success: false,
            message: result.ErrorMessage || "OCR processing failed",
            data: null,
          });
        }

        const text = result.ParsedResults[0]?.ParsedText || "No text extracted";
        return res.json({
          success: true,
          message: "Text extracted successfully",
          data: { text },
          token: null,
        });
      } else {
        return res.status(response.status).json({
          success: false,
          message: `Failed to connect to OCR API. Status code: ${response.status}`,
          data: null,
        });
      }
    } catch (error) {
      // Delete the uploaded file in case of error
      if (req.file) fs.unlinkSync(req.file.path);
      console.error("OCR error:", error.message);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to process image",
        data: null,
      });
    }
  }
);

module.exports = router;

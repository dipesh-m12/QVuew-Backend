const express = require("express");
const router = express.Router();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { body, validationResult } = require("express-validator");

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || "AIzaSyA1z0cj5xxLFFhWMG0R4FmP_PMDDmjouqY"
);

// Convert OCR Text to Rate Cards
router.post(
  "/",
  [body("text").notEmpty().withMessage("OCR text is required")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ success: false, message: errors.array()[0].msg, data: null });
    }

    const { text } = req.body;

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const prompt = `
Parse the following menu text into a JSON object containing structured rate card data:

{
  "rateCards": [
    {
      "name": string,
      "gender": string[],
      "duration": number,
      "rate": number
    }
  ]
}

Menu text:
${text}

Rules:
- Default values: name="Unnamed Service", gender=["male", "female"], duration=30, rate=0
- Gender values must be "male", "female", or "child".
- If gender is unspecified, use ["male", "female"].
- Return only the JSON object, no backticks or "json" prefix.
- If no services are detected, return an empty rateCards array.
`;

      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      let extractedData;

      try {
        extractedData = JSON.parse(responseText);
      } catch (parseError) {
        console.error("Error parsing Gemini response:", parseError);
        return res.status(500).json({
          success: false,
          message: "Failed to parse rate card data",
          data: null,
        });
      }

      if (!extractedData.rateCards || !Array.isArray(extractedData.rateCards)) {
        return res.status(400).json({
          success: false,
          message: "Invalid data format from Gemini",
          data: null,
        });
      }

      // Validate and apply defaults to each rate card
      const validGenders = ["male", "female", "child"];
      const rateCards = extractedData.rateCards.map((card) => ({
        name:
          card.name && typeof card.name === "string"
            ? card.name
            : "Unnamed Service",
        gender:
          Array.isArray(card.gender) &&
          card.gender.length > 0 &&
          card.gender.every((g) => validGenders.includes(g))
            ? card.gender
            : ["male", "female"],
        duration:
          Number.isInteger(card.duration) && card.duration > 0
            ? card.duration
            : 30,
        rate: typeof card.rate === "number" && card.rate >= 0 ? card.rate : 0,
      }));

      res.json({
        success: true,
        message: "Rate cards extracted successfully",
        data: { rateCards },
        token: null,
      });
    } catch (error) {
      console.error("Gemini error:", error.message);
      res.status(500).json({
        success: false,
        message: "Failed to process rate cards",
        data: null,
      });
    }
  }
);

module.exports = router;

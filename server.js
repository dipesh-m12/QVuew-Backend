const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const session = require("express-session");

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/users", require("./routes/user"));

app.use("/api/service", require("./routes/service"));

app.use("/api/vendor", require("./routes/vendor"));
app.use("/api/ratecard", require("./routes/rateCards"));
app.use("/api/helper-connection", require("./routes/helperConnection"));
app.use("/api/payment", require("./routes/paymentRoutes"));
app.use("/api/sms", require("./routes/sms"));
app.use("/api/ocr", require("./routes/ocr"));
app.use("/api/gemini", require("./routes/gemini"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/device-login", require("./routes/deviceLogin"));
//pending
app.use("/api/queue", require("./routes/queue"));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const jwt = require("jsonwebtoken");
require("dotenv").config();
const redis = require("redis");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient
  .connect()
  .catch((err) => console.error("Redis connection error:", err));

const JWT_SECRET = process.env.JWT_SECRET;

const verifyUser = async (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "Unauthorized", data: null });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.session) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid token", data: null });
    }
    req.user = decoded;

    const session = await redisClient.get(decoded.session);
    if (!session) {
      return res
        .status(401)
        .json({ success: false, message: "Session expired", data: null });
    }
    next();
  } catch (err) {
    console.error("Verification error:", err.message);
    return res
      .status(401)
      .json({ success: false, message: "Authentication failed", data: null });
  }
};

module.exports = verifyUser;

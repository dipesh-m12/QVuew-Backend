const verifyUser = (req, res, next) => {
  if (!req.session.userId || !["user", "admin"].includes(req.session.role)) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized access", data: null });
  }
  next();
};

module.exports = verifyUser;

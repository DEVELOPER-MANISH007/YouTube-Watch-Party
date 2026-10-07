const mongoose = require("mongoose");

async function connectDatabase(uri) {
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");
}

module.exports = connectDatabase;

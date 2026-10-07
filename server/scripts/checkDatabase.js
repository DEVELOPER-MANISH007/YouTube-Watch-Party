const path = require("node:path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function checkDatabaseConnection() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("MongoDB connection check failed: MONGODB_URI is not set in server/.env.");
    process.exitCode = 1;
    return;
  }

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    console.log("MongoDB connection successful.");
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    console.error(
      `MongoDB connection failed (${errorType}). Check the URI, credentials, network access, and MongoDB availability.`
    );
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

checkDatabaseConnection().catch((error) => {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  console.error(`MongoDB connection check could not complete (${errorType}).`);
  process.exitCode = 1;
});

require("dotenv").config();

const http = require("node:http");
const cors = require("cors");
const express = require("express");
const connectDatabase = require("./config/database");
const healthRoutes = require("./routes/health.routes");
const initializeSocket = require("./socket");

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 5000;
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";

app.use(cors({ origin: clientUrl }));
app.use(express.json());
app.use("/api/health", healthRoutes);

initializeSocket(server, clientUrl);

async function startServer() {
  if (process.env.MONGODB_URI) {
    await connectDatabase(process.env.MONGODB_URI);
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("MONGODB_URI must be set in production.");
  } else {
    console.warn("MONGODB_URI is not set; starting without a database connection.");
  }

  server.listen(port, () => {
    console.log(`API and Socket.IO server listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exitCode = 1;
});

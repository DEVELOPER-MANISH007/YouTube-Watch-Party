const { Server } = require("socket.io");

function initializeSocket(server, clientUrl) {
  const io = new Server(server, {
    cors: {
      origin: clientUrl,
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

module.exports = initializeSocket;

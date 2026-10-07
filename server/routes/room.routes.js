const express = require("express");
const { createRoom, joinRoom, getRoom } = require("../controllers/room.controller");

const router = express.Router();

router.post("/", createRoom);
router.post("/:roomCode/join", joinRoom);
router.get("/:roomCode", getRoom);

module.exports = router;

const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true, trim: true, maxlength: 32 },
  role: { type: String, enum: ["host", "moderator", "participant"], required: true },
  sessionTokenHash: { type: String, required: true, select: false },
  isOnline: { type: Boolean, default: false },
}, { _id: false });

const roomSchema = new mongoose.Schema({
  roomCode: { type: String, required: true, unique: true, uppercase: true, index: true },
  hostId: { type: String, required: true },
  currentVideoId: { type: String, default: null, match: /^[\w-]{11}$/ },
  isPlaying: { type: Boolean, default: false },
  currentTime: { type: Number, default: 0, min: 0 },
  playbackUpdatedAt: { type: Date, default: Date.now },
  participants: { type: [participantSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.models.Room || mongoose.model("Room", roomSchema);

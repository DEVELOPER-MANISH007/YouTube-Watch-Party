# 🎬 YouTube Watch Party

A real-time collaborative YouTube watch party application where multiple users can join a shared room and watch videos together with synchronized playback, role-based permissions, and live room management.

[🚀 Live Demo](https://you-tube-watch-party-mauve.vercel.app/) · [🔗 GitHub Repository](https://github.com/DEVELOPER-MANISH007/YouTube-Watch-Party) · [🔧 Backend Health](https://youtube-watch-party-nmgj.onrender.com/api/health)

The health endpoint should return `{"status":"ok"}` when the backend is available.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?logo=socketdotio&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-persistence-47A248?logo=mongodb&logoColor=white)

## Overview

Create a room, share its code or link, and watch a YouTube video together. The Host manages the session and can grant playback controls to Moderators; Participants can watch along without playback-management permissions.

Playback and room membership are synchronized through Socket.IO. Room, participant, role, and playback state are persisted in MongoDB, while the YouTube IFrame API renders the video in each browser. New arrivals receive the current room state, and reconnecting participants can resume using their room session. The Host can explicitly transfer ownership or end the session.

## Features

| Area | Capabilities |
|---|---|
| **Room management** | Create a room; join with a room code or shared link; view online participants; leave a room; persist room/session state |
| **Real-time playback** | Synchronize play, pause, seek, and video changes; send current state to late joiners; serialize playback actions per room |
| **Roles and permissions** | Host, Moderator, and Participant roles, with server-checked permissions |
| **Host management** | Assign or remove Moderator status; remove a participant; explicitly transfer Host to an online Participant or Moderator; end the session |
| **Reliability** | Reconnect and disconnect handling; prevent removed participants from reconnecting with a removed session; allow a disconnected participant's username to be reused; notify remaining users when a session ends |
| **YouTube** | Embed videos using the YouTube IFrame API; accept supported YouTube URLs and video IDs |

## Roles and permissions

Playback permissions are enforced by the server. Only the Host can manage roles, remove participants, transfer Host, or end the session.

| Feature | Host | Moderator | Participant |
|---|:---:|:---:|:---:|
| Play | ✅ | ✅ | ❌ |
| Pause | ✅ | ✅ | ❌ |
| Seek | ✅ | ✅ | ❌ |
| Change video | ✅ | ✅ | ❌ |
| Assign Moderator | ✅ | ❌ | ❌ |
| Remove participant | ✅ | ❌ | ❌ |
| Transfer Host | ✅ | ❌ | ❌ |
| End session | ✅ | ❌ | ❌ |
| Watch video | ✅ | ✅ | ✅ |

## Host leave and session flow

When the Host selects **Leave**, they can choose **Leave Room**, **End Session**, or **Cancel**.

- **Leave Room:** Select an online Participant or Moderator to become the new Host. The transfer is explicit; Host ownership is not transferred automatically. Once confirmed, the previous Host leaves, the selected user becomes Host, and the session continues with playback preserved.
- **End Session:** Ends the room session. Remaining users are shown **Session Ended**, and the ended session cannot be rejoined.
- **Cancel:** Closes the leave flow and keeps the Host in the room.

If the Host disconnects without transferring Host or ending the session, the server ends the session and notifies the other room members.

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, JavaScript/JSX, CSS |
| Backend | Node.js, Express, Socket.IO |
| Database | MongoDB, Mongoose |
| Video | YouTube IFrame API |
| Deployment | Vercel (frontend), Render (backend), MongoDB Atlas (database) |

## Architecture

```text
┌──────────────────────────── Browser ────────────────────────────┐
│  React + Vite                                                    │
│     ├── REST API requests ─────────────────┐                     │
│     ├── Socket.IO events ──────────────────┼────┐                │
│     └── YouTube IFrame API → video player  │    │                │
└────────────────────────────────────────────┼────┼────────────────┘
                                             ▼    ▼
                              ┌─────────────────────────────┐
                              │ Node.js + Express + Socket.IO│
                              └──────────────┬──────────────┘
                                             │
                                             ▼
                                        MongoDB
```

- **REST API** handles room creation, joining, and room data.
- **Socket.IO** handles real-time room membership, playback, and role events.
- **The server** validates room sessions and permissions and is authoritative for shared playback state.
- **MongoDB** persists room, participant, role, and playback state.
- **The YouTube IFrame API** renders the video in each user's browser.

## Real-time design

The server is authoritative for room roles and playback mutations. A client cannot grant itself a role: it must join with its room session, and the server resolves the participant and role from persisted room data. Before applying an action, the server checks that the participant is online and allowed to perform it. This prevents a modified client from bypassing role restrictions.

Playback changes are serialized per room before being broadcast to connected users. Membership transitions are coordinated per room and participant. On joining or reconnecting, a participant receives a server-generated room snapshot, including the current video, playback state, and online participant list. Room and playback data are persisted in MongoDB so state can be restored independently of an individual browser connection.

## Socket.IO events

| Event | Description |
|---|---|
| `join_room` | Join a room using its code and the participant's room session. |
| `leave_room` | Leave a room; the current Host must transfer Host or end the session first. |
| `play` | Request synchronized playback. |
| `pause` | Request synchronized pause. |
| `seek` | Request a synchronized seek to a playback time. |
| `change_video` | Change the room's YouTube video. |
| `assign_role` | Assign Moderator or Participant status. |
| `remove_participant` | Remove a participant from the room. |
| `transfer_host` | Transfer Host to an eligible, online participant. |
| `end_session` | End the current room session as Host. |
| `sync_state` | Deliver the current room/playback state or broadcast an updated state. |
| `user_joined` | Notify existing room members that a participant joined. |
| `user_left` | Notify room members that a participant left or disconnected. |
| `role_assigned` | Broadcast a participant role or Host ownership update. |
| `participant_removed` | Notify the room that a participant was removed. |
| `session_ended` | Notify connected users that the session ended. |
| `session_replaced` | Notify a connection that its room session was replaced by another connection. |
| `socket_error` | Report a room or socket action error to the requesting client. |

## Project structure

```text
client/
├── src/
│   ├── components/       # Room form and YouTube player
│   ├── context/          # Shared UI context
│   ├── hooks/            # React hooks
│   ├── pages/            # Home and watch-room pages
│   ├── services/         # REST and Socket.IO clients
│   ├── utils/            # Permissions and YouTube helpers
│   ├── App.jsx
│   └── main.jsx
├── scripts/
│   └── verifyRealtime.cjs
├── vercel.json
└── package.json

server/
├── config/               # MongoDB connection
├── controllers/          # Room and health endpoints
├── middleware/           # Express error handling
├── models/               # Mongoose room model
├── routes/               # Room and health routes
├── socket/               # Socket.IO room and playback handlers
├── utils/                # Room authorization, serialization, and sessions
├── scripts/              # Database connection check
└── server.js
```

## Getting started

### Requirements

- Node.js 18 or newer
- MongoDB connection string (MongoDB Atlas for a hosted database)

### Install dependencies

```bash
cd server
npm install

cd ../client
npm install
```

### Configure environment

Create `server/.env` and set the backend values below. For local development, `CLIENT_URL` defaults to `http://localhost:5173` and the server listens on port `5000` unless `PORT` is set.

```env
MONGODB_URI=your-mongodb-atlas-uri
CLIENT_URL=http://localhost:5173
NODE_ENV=development
```

Create `client/.env` to point the frontend to the local API:

```env
VITE_API_URL=http://localhost:5000
```

### Run locally

Start the backend and frontend in separate terminals:

```bash
# Terminal 1
cd server
npm run dev
```

```bash
# Terminal 2
cd client
npm run dev
```

The frontend is available at `http://localhost:5173`; the API and Socket.IO server use `http://localhost:5000`.

## Environment variables

| Variable | Application | Purpose |
|---|---|---|
| `MONGODB_URI` | Backend | MongoDB connection string; required in production. |
| `CLIENT_URL` | Backend | Allowed frontend origin; required in production. |
| `NODE_ENV` | Backend | Runtime environment; set to `production` when deployed. |
| `PORT` | Backend | Optional listening port; defaults to `5000`. |
| `VITE_API_URL` | Frontend | Backend base URL used by the REST and Socket.IO clients. |

Backend variables are configured in Render; configure `VITE_API_URL` in Vercel. Never commit `.env` files or expose MongoDB credentials.

## Deployment

- **Frontend:** [Vercel](https://you-tube-watch-party-mauve.vercel.app/)
- **Backend:** [Render](https://youtube-watch-party-nmgj.onrender.com)
- **Database:** MongoDB Atlas

Set the backend's `CLIENT_URL` to the deployed frontend origin and the frontend's `VITE_API_URL` to the backend URL. The backend health endpoint is [`/api/health`](https://youtube-watch-party-nmgj.onrender.com/api/health).

## Useful checks

```bash
# Check MongoDB connectivity (run from server/)
npm run check:db

# Run the realtime verification script (run from client/)
npm run verify:realtime
```

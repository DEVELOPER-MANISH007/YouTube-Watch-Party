# YouTube Watch Party

A starter MERN application with a Vite/React client, an Express API, MongoDB
connection support, and a Socket.IO server.

## Project structure

```text
client/
  src/
    components/
    pages/
    hooks/
    context/
    services/
    utils/
    App.jsx
    main.jsx
server/
  config/
  controllers/
  models/
  routes/
  middleware/
  socket/
  utils/
  server.js
```

## Requirements

- Node.js 18 or newer
- MongoDB, if you want to use database-backed features

## Run locally

1. Install client dependencies: `cd client` then `npm install`.
2. Start the client: `npm run dev`.
3. In another terminal, install server dependencies: `cd server` then `npm install`.
4. Start the server: `npm run dev`.

The client is available at `http://localhost:5173`; the API and Socket.IO
server use port `5000`.

Set `MONGODB_URI` in the server environment to connect MongoDB. The server
starts without MongoDB in development, but requires it in production. Optional
environment variables are `PORT` and `CLIENT_URL`.

The API health check is available at `GET http://localhost:5000/api/health`.

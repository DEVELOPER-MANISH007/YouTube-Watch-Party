import { useEffect, useState } from "react";
import { Home } from "./pages/Home.jsx";
import { RoomForm } from "./components/RoomForm.jsx";
import { WatchRoom } from "./pages/WatchRoom.jsx";
import { createRoom, joinRoom, getRoom } from "./services/roomService.js";

export default function App() {
  const [route, setRoute] = useState(() => window.location.pathname);
  const [room, setRoom] = useState(null);
  const [notice, setNotice] = useState("");
  const [pendingJoinCode, setPendingJoinCode] = useState("");

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (path) => {
    window.history.pushState({}, "", path);
    setRoute(path);
    setNotice("");
  };

  useEffect(() => {
    const match = route.match(/^\/room\/([a-z0-9-]+)$/i);
    if (!match) { setRoom(null); setPendingJoinCode(""); return undefined; }
    const roomCode = match[1].toUpperCase();
    if (room?.roomCode === roomCode) return undefined;
    let cancelled = false;
    setRoom(null);
    setPendingJoinCode("");
    getRoom(roomCode).then((result) => {
      if (cancelled) return;
      if (result.ok && result.room.currentUser) setRoom(result.room);
      else if (result.ok) setPendingJoinCode(roomCode);
      else setNotice(result.error);
    });
    return () => { cancelled = true; };
  }, [route]);

  const submitCreate = ({ username, videoUrl }) => {
    return createRoom(username, videoUrl).then((result) => {
      if (!result.ok) return result;
      setPendingJoinCode("");
      setRoom(result.room);
      navigate(`/room/${result.room.roomCode}`);
      return { ok: true };
    });
  };

  const submitJoin = ({ username, roomCode }) => {
    return joinRoom(username, roomCode).then((result) => {
      if (!result.ok) return result;
      setPendingJoinCode("");
      setRoom(result.room);
      navigate(`/room/${result.room.roomCode}`);
      return { ok: true };
    });
  };

  if (route.startsWith("/room/")) {
    if (!room && pendingJoinCode) return <RoomForm mode="join" initialRoomCode={pendingJoinCode} onBack={() => navigate("/")} onSubmit={submitJoin} />;
    if (!room) return <main className="page-shell"><header className="nav"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>▶ <span>watchparty</span></a></header><section className="empty-page"><span className="eyebrow">ROOM UNAVAILABLE</span><h1>We couldn’t find that room.</h1><p>Check the room code with your host, or create a new party.</p><button className="button button-primary" onClick={() => navigate("/")}>Back to home</button></section></main>;
    return <WatchRoom room={room} onRoomChange={setRoom} onLeave={() => { setRoom(null); navigate("/"); }} toast={setNotice} notice={notice} />;
  }
  if (route === "/create") return <RoomForm mode="create" onBack={(path = "/") => navigate(path)} onSubmit={submitCreate} />;
  if (route === "/join") return <RoomForm mode="join" onBack={(path = "/") => navigate(path)} onSubmit={submitJoin} />;
  return <Home onNavigate={navigate} />;
}

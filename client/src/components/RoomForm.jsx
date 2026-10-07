import { useEffect, useState } from "react";

export function RoomForm({ mode, onBack, onSubmit, initialRoomCode = "" }) {
  const creating = mode === "create";
  const [username, setUsername] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [roomCode, setRoomCode] = useState(initialRoomCode);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setRoomCode(initialRoomCode), [initialRoomCode]);
  const submit = async (event) => {
    event.preventDefault(); setError("");
    if (!username.trim()) return setError("Enter a name so your friends know who joined.");
    if (!creating && !roomCode.trim()) return setError("Enter the room code shared by your host.");
    setBusy(true);
    try {
      const result = await onSubmit({ username: username.trim(), videoUrl: videoUrl.trim(), roomCode });
      if (!result.ok) setError(result.error);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return <main className="form-page"><header className="nav"><a className="brand" href="/" onClick={(e) => { e.preventDefault(); onBack(); }}>▶ <span>watchparty</span></a><button className="button button-quiet" onClick={onBack}>← Back</button></header><section className="form-card"><div className="form-icon">{creating ? "✦" : "↗"}</div><span className="eyebrow">{creating ? "START A NEW PARTY" : "JOIN YOUR FRIENDS"}</span><h1>{creating ? "Create a room" : "Join a room"}</h1><p>{creating ? "Set the scene. Your friends can join with a room code." : "Enter the room code and we’ll get you in."}</p><form onSubmit={submit} noValidate><label htmlFor="username">Your name</label><input id="username" autoComplete="nickname" maxLength="32" placeholder="e.g. Alex" value={username} onChange={(e) => setUsername(e.target.value)} />{creating ? <><label htmlFor="video-url">YouTube video <span className="optional">Optional</span></label><input id="video-url" type="url" placeholder="Paste a YouTube link" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} /><small>Choose a video now, or add one once everyone’s here.</small></> : <><label htmlFor="room-code">Room code</label><input id="room-code" autoCapitalize="characters" placeholder="e.g. K7PQ-2MNB" value={roomCode} onChange={(e) => setRoomCode(e.target.value.toUpperCase())} /></>}<div className="form-error" role="alert">{error}</div><button className="button button-primary form-submit" disabled={busy}>{busy ? "Please wait…" : creating ? "Create room  →" : "Join room  →"}</button></form><div className="form-foot">{creating ? "Already have a code?" : "Want to host instead?"} <button onClick={() => onBack(creating ? "/join" : "/create")}> {creating ? "Join a room" : "Create a room"}</button></div></section></main>;
}

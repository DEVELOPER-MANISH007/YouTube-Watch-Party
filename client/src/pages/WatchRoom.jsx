import { useCallback, useEffect, useRef, useState } from "react";
import { YouTubePlayer } from "../components/YouTubePlayer.jsx";
import { clearRoomSession } from "../services/roomService.js";
import { connectToRoom, disconnectSocket, emitRoomAction, leaveRoom } from "../services/socketService.js";
import { canAssignRole, canChangeVideo, canControlPlayback, canRemoveParticipant, ROLES } from "../utils/permissions.js";
import { extractVideoId, formatTime } from "../utils/youtube.js";

const roleLabel = (role) => role[0].toUpperCase() + role.slice(1);
function Avatar({ name }) { return <span className="participant-avatar">{name.slice(0, 1).toUpperCase()}</span>; }

export function WatchRoom({ room: initialRoom, onRoomChange, onLeave, toast, notice }) {
  const [room, setRoom] = useState(initialRoom); const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0);
  const [videoOpen, setVideoOpen] = useState(false); const [videoUrl, setVideoUrl] = useState(""); const [videoError, setVideoError] = useState(""); const [menuFor, setMenuFor] = useState(null); const [playerReady, setPlayerReady] = useState(false); const [connected, setConnected] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(Boolean(initialRoom.sessionEnded)); const [leaveStep, setLeaveStep] = useState(null); const [selectedHost, setSelectedHost] = useState(""); const [leaveError, setLeaveError] = useState("");
  const player = useRef(null); const canControl = canControlPlayback(room.currentUser.role);
  const onLeaveRef = useRef(onLeave); onLeaveRef.current = onLeave;
  const roomRef = useRef(initialRoom);
  const selectedHostRef = useRef(selectedHost); selectedHostRef.current = selectedHost;
  const seekValue = useRef(0);
  const commitRoom = useCallback((next) => { roomRef.current = next; setRoom(next); onRoomChange(next); }, [onRoomChange]);
  const applyRoom = useCallback((serverRoom) => {
    const previous = roomRef.current;
    commitRoom({ ...previous, ...serverRoom, currentUser: previous.currentUser, sessionToken: previous.sessionToken });
  }, [commitRoom]);
  const updateParticipants = useCallback((participants) => {
    commitRoom({ ...roomRef.current, participants });
  }, [commitRoom]);
  const updateDuration = useCallback((value) => { if (Number.isFinite(value) && value > 0) setDuration(value); }, []);
  const onStateChange = useCallback((state, target) => { setPlaying(state === 1); setCurrent(target?.getCurrentTime?.() || 0); updateDuration(target?.getDuration?.()); }, [updateDuration]);
  const onPlayerReady = useCallback((instance) => { updateDuration(instance.getDuration?.()); setPlayerReady(true); }, [updateDuration]);
  useEffect(() => { const timer = setInterval(() => { if (player.current && playing) { setCurrent(player.current.getCurrentTime?.() || 0); updateDuration(player.current.getDuration?.()); } }, 1000); return () => clearInterval(timer); }, [playing, updateDuration]);
  useEffect(() => { const onKey = (e) => { if (e.key === "Escape") { setVideoOpen(false); setMenuFor(null); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  useEffect(() => {
    let mounted = true;
    const onRole = ({ participant, participants }) => {
      const previous = roomRef.current;
      const currentUser = participant.userId === previous.currentUser.userId ? { ...previous.currentUser, role: participant.role } : previous.currentUser;
      commitRoom({ ...previous, participants, currentUser });
    };
    connectToRoom({
      roomCode: initialRoom.roomCode,
      userId: initialRoom.currentUser.userId,
      sessionToken: initialRoom.sessionToken,
      onSyncState: applyRoom,
      onUserJoined: ({ participants }) => { updateParticipants(participants); },
      onUserLeft: ({ participants }) => {
        updateParticipants(participants);
        if (selectedHostRef.current && !participants.some((person) => person.userId === selectedHostRef.current)) {
          setSelectedHost(""); setLeaveError("That participant is no longer available. Choose someone else.");
        }
      },
      onRoleAssigned: onRole,
      onParticipantRemoved: ({ participants, userId }) => {
        updateParticipants(participants || []);
        if (userId === selectedHostRef.current) { setSelectedHost(""); setLeaveError("That participant is no longer available. Choose someone else."); }
      },
      onSessionEnded: () => { setSessionEnded(true); setPlaying(false); setDuration(0); setVideoOpen(false); setLeaveStep(null); },
      onRemoved: (payload) => {
        clearRoomSession(initialRoom.roomCode);
        disconnectSocket();
        toast(payload?.message || "You were removed from this room.");
        onLeaveRef.current();
      },
      onError: (error) => toast(error.message || "Room connection error."),
    }).then((state) => { if (mounted) { setConnected(true); applyRoom(state); if (state.sessionEnded) setSessionEnded(true); } }).catch((error) => { if (mounted) { if (error.code === "SESSION_ENDED") setSessionEnded(true); else toast(error.message); } });
    return () => { mounted = false; disconnectSocket(); };
  }, [initialRoom.roomCode, initialRoom.currentUser.userId, initialRoom.sessionToken, applyRoom, updateParticipants, commitRoom, toast]);
  useEffect(() => {
    if (!playerReady || !room.currentVideo) return;
    const elapsed = room.playbackState === "playing" ? Math.max(0, Date.now() - (room.updatedAt || Date.now())) / 1000 : 0;
    player.current?.seekTo((room.currentTime || 0) + elapsed);
    if (room.playbackState === "playing") player.current?.play();
    else player.current?.pause();
  }, [playerReady, room.currentVideo, room.playbackState, room.currentTime]);
  const sendAction = async (event, payload = {}) => {
    try { await emitRoomAction(event, payload); }
    catch (error) { toast(error.message); }
  };
  const share = async () => { try { await navigator.clipboard.writeText(`${window.location.origin}/room/${room.roomCode}`); toast("Room link copied"); } catch { toast(`Room code: ${room.roomCode}`); } };
  const changeVideo = async (e) => { e.preventDefault(); const id = extractVideoId(videoUrl); if (!id) { setVideoError("That doesn’t look like a valid YouTube link."); return; } try { await emitRoomAction("change_video", { videoId: id }); setVideoOpen(false); setVideoUrl(""); setVideoError(""); } catch (error) { setVideoError(error.message); } };
  const changeRole = async (participant) => { const role = participant.role === ROLES.MODERATOR ? ROLES.PARTICIPANT : ROLES.MODERATOR; try { await emitRoomAction("assign_role", { userId: participant.userId, role }); setMenuFor(null); } catch (error) { toast(error.message); } };
  const removePerson = async (person) => { try { await emitRoomAction("remove_participant", { userId: person.userId }); setMenuFor(null); } catch (error) { toast(error.message); } };
  const copyCode = async () => { try { await navigator.clipboard.writeText(room.roomCode); toast("Room code copied"); } catch { toast(room.roomCode); } };
  const handleLeave = async () => {
    if (room.currentUser.role === ROLES.HOST) { setLeaveError(""); setSelectedHost(""); setLeaveStep("choice"); return; }
    await leaveRoom(); onLeaveRef.current();
  };
  const endSession = async () => {
    try { await emitRoomAction("end_session"); setSessionEnded(true); setPlaying(false); setDuration(0); setLeaveStep(null); disconnectSocket(); }
    catch (error) { setLeaveError(error.message); }
  };
  const transferHost = async () => {
    if (!selectedHost) { setLeaveError("Choose a participant to become Host."); return; }
    try { await emitRoomAction("transfer_host", { userId: selectedHost }); disconnectSocket(); setLeaveStep(null); onLeaveRef.current(); }
    catch (error) { setLeaveError(error.message); }
  };
  const commitSeek = () => { if (canControl && duration) void sendAction("seek", { time: seekValue.current }); };
  if (sessionEnded) return <main className="page-shell"><section className="empty-page session-ended"><span className="eyebrow">WATCH PARTY</span><h1>Session Ended</h1><p>The host has ended the watch party.</p><p>This session is no longer active.</p><button className="button button-primary" onClick={() => onLeaveRef.current()}>Back to Home</button></section></main>;
  return <main className="watch-page"><header className="watch-header"><a className="brand" href="/" onClick={(e) => e.preventDefault()}>▶ <span>watchparty</span></a><div className="room-meta"><span className="room-title">Watch party</span><span className="room-code-label">ROOM <button onClick={copyCode} title="Copy room code">{room.roomCode} ⧉</button></span></div><div className="header-actions"><span className={`role-pill role-${room.currentUser.role}`}>{roleLabel(room.currentUser.role)}</span><span className="header-count">● {room.participants.length}</span><button className="button button-secondary share-button" onClick={share}>↗ <span>Share</span></button><button className="button button-quiet leave-button" onClick={handleLeave}>Leave</button></div></header>
    <div className="watch-layout"><section className="watch-main"><div className="video-card"><YouTubePlayer ref={player} videoId={room.currentVideo} onStateChange={onStateChange} onReady={onPlayerReady} /><div className="video-details"><div><span className="eyebrow">NOW WATCHING</span><h1>{room.currentVideo ? "Your shared video" : "The room is yours"}</h1></div>{canChangeVideo(room.currentUser.role) && <button className="button button-secondary" onClick={() => setVideoOpen(true)}>{room.currentVideo ? "Change video" : "Add a video"}</button>}</div>
      {room.currentVideo && <div className={`controls ${!canControl ? "controls-disabled" : ""}`}><button className="play-toggle" disabled={!canControl} onClick={() => void sendAction(playing ? "pause" : "play", { currentTime: player.current?.getCurrentTime?.() || current })} aria-label={playing ? "Pause video" : "Play video"}>{playing ? "Ⅱ" : "▶"}</button><span className="timecode">{formatTime(current)}</span><input aria-label="Video progress" type="range" min="0" max={Math.max(duration, 1)} value={Math.min(current, duration || current)} disabled={!canControl || !duration} onChange={(e) => { const time = Number(e.target.value); seekValue.current = time; setCurrent(time); player.current?.seekTo(time); }} onPointerUp={commitSeek} onKeyUp={commitSeek} /><span className="timecode">{formatTime(duration)}</span><span className="control-hint">{canControl ? "Playback controls" : "Host controls playback"}</span></div>}
      <div className="permission-notice">{canControl ? <><span>◉</span> Playback controls are available to you as {roleLabel(room.currentUser.role).toLowerCase()}.</> : <><span>◉</span> You’re watching along. The host and moderators control playback.</>}</div></div>
      <div className="room-about"><div className="room-about-icon">✳</div><div><strong>A good night in</strong><p>Share a video and make a little time for your people.</p></div><span className="local-badge">{connected ? "CONNECTED" : "CONNECTING"}</span></div></section>
      <aside className="participants-card"><div className="participants-heading"><div><h2>In this room</h2><p>{room.participants.length} {room.participants.length === 1 ? "person" : "people"} watching</p></div><span className="participant-count">{room.participants.length}</span></div><div className="participant-list">{room.participants.length === 0 ? <div className="empty-participants"><span>☻</span><strong>It’s quiet in here</strong><p>Share the room link to invite someone.</p></div> : room.participants.map((person) => <div className="participant-row" key={person.userId}><Avatar name={person.username} /><div className="person-name"><strong>{person.username}{person.userId === room.currentUser.userId && <small>YOU</small>}</strong><span>{person.role === ROLES.HOST ? "Room host" : person.role === ROLES.MODERATOR ? "Can manage playback" : "Watching along"}</span></div>{person.role === ROLES.HOST ? <span className="role-badge role-host">Host</span> : person.userId === room.currentUser.userId ? <span className={`role-badge role-${person.role}`}>{roleLabel(person.role)}</span> : canAssignRole(room.currentUser.role) && <div className="person-menu-wrap"><button className="more-button" aria-label={`Manage ${person.username}`} aria-expanded={menuFor === person.userId} onClick={() => setMenuFor(menuFor === person.userId ? null : person.userId)}>•••</button>{menuFor === person.userId && <div className="person-menu"><button onClick={() => changeRole(person)}>{person.role === ROLES.MODERATOR ? "Remove moderator" : "Make moderator"}</button>{canRemoveParticipant(room.currentUser.role) && <button className="danger-text" onClick={() => removePerson(person)}>Remove from room</button>}</div>}</div>}</div>)}</div><div className="invite-box"><span className="invite-icon">↗</span><div><strong>Bring someone along</strong><p>They can join with your room code.</p></div><button onClick={share} aria-label="Copy invite link">⧉</button></div><div className="roles-legend"><span className="eyebrow">ROOM PERMISSIONS</span><div><i className="role-dot host-dot" />Host <span>Everything</span></div><div><i className="role-dot mod-dot" />Moderator <span>Playback</span></div><div><i className="role-dot participant-dot" />Participant <span>Watch only</span></div></div></aside></div>
    {notice && <div role="status" className="toast">✓ {notice}</div>}
    {leaveStep === "choice" && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="leave-title"><button className="modal-close" aria-label="Close" onClick={() => setLeaveStep(null)}>×</button><span className="eyebrow">HOST OPTIONS</span><h2 id="leave-title">Leave Watch Party?</h2><p>Choose what should happen to this session.</p>{room.participants.filter((person) => person.userId !== room.currentUser.userId).length === 0 && <p>No participant is available to become Host. End the session or cancel.</p>}<div className="modal-actions"><button className="button button-quiet" onClick={() => setLeaveStep(null)}>Cancel</button><button className="button button-secondary" disabled={!room.participants.some((person) => person.userId !== room.currentUser.userId)} onClick={() => { setLeaveError(""); setLeaveStep("transfer"); }}>Leave Room</button><button className="button button-primary" onClick={() => void endSession()}>End Session</button></div>{leaveError && <div className="form-error" role="alert">{leaveError}</div>}</section></div>}
    {leaveStep === "transfer" && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="host-title"><button className="modal-close" aria-label="Close" onClick={() => setLeaveStep(null)}>×</button><span className="eyebrow">HAND OFF THE PARTY</span><h2 id="host-title">Choose New Host</h2><p>Select a participant to take over this watch party.</p><div className="host-options">{room.participants.filter((person) => person.userId !== room.currentUser.userId).map((person) => <label key={person.userId}><input type="radio" name="new-host" value={person.userId} checked={selectedHost === person.userId} onChange={() => { setSelectedHost(person.userId); setLeaveError(""); }} /><span><strong>{person.username}</strong><small>{roleLabel(person.role)}</small></span></label>)}</div><div className="modal-actions"><button className="button button-quiet" onClick={() => { setLeaveError(""); setLeaveStep("choice"); }}>Back</button><button className="button button-primary" disabled={!selectedHost} onClick={() => void transferHost()}>Confirm New Host</button></div>{leaveError && <div className="form-error" role="alert">{leaveError}</div>}</section></div>}
    {videoOpen && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setVideoOpen(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="video-modal-title"><button className="modal-close" aria-label="Close" onClick={() => setVideoOpen(false)}>×</button><span className="eyebrow">SET THE SCENE</span><h2 id="video-modal-title">{room.currentVideo ? "Change the video" : "Add a video"}</h2><p>Paste a YouTube link for everyone in the room.</p><form onSubmit={changeVideo}><label htmlFor="new-video">YouTube URL</label><input id="new-video" autoFocus type="url" placeholder="https://youtube.com/watch?v=…" value={videoUrl} onChange={(e) => { setVideoUrl(e.target.value); setVideoError(""); }} /><div className="form-error" role="alert">{videoError}</div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => setVideoOpen(false)}>Cancel</button><button className="button button-primary">{room.currentVideo ? "Change video" : "Add video"}</button></div></form></section></div>}
    <div className="preview-disclaimer">Room state and playback are managed by the server. YouTube availability depends on the video.</div></main>;
}

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { extractVideoId } from "../utils/youtube.js";

let apiPromise;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      resolve(window.YT);
      try { previous?.(); } catch { /* Preserve the API ready signal if another callback fails. */ }
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        apiPromise = null;
        script.remove();
        reject(new Error("Unable to load the YouTube player API."));
      };
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

export const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, onStateChange, onReady }, ref) {
  const container = useRef(null); const player = useRef(null); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false);
  useImperativeHandle(ref, () => ({
    play: () => player.current?.playVideo(), pause: () => player.current?.pauseVideo(),
    seekTo: (time) => player.current?.seekTo(time, true), getCurrentTime: () => player.current?.getCurrentTime?.() || 0,
    getDuration: () => player.current?.getDuration?.() || 0,
    loadVideo: (id) => player.current?.loadVideoById(id),
  }), []);
  useEffect(() => {
    if (!videoId) { setLoading(false); return undefined; }
    setLoading(true);
    setFailed(false);
    if (!extractVideoId(videoId)) { setLoading(false); setFailed(true); return undefined; }
    let alive = true;
    loadApi().then((YT) => {
      if (!alive || !container.current) return;
      player.current = new YT.Player(container.current, { videoId, playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 }, events: {
        onReady: (event) => { if (alive) { setLoading(false); onReady?.(event.target); } },
        onStateChange: (event) => { if (alive) onStateChange?.(event.data, event.target); },
        onError: () => { if (alive) { setLoading(false); setFailed(true); } },
      } });
    }).catch(() => { if (alive) { setLoading(false); setFailed(true); } });
    return () => { alive = false; player.current?.destroy?.(); player.current = null; };
  }, [videoId, onReady, onStateChange]);
  if (!videoId) return <div className="video-placeholder"><div className="placeholder-mark">▶</div><h2>Pick the first video</h2><p>Add a YouTube link to get the watch party started.</p></div>;
  return <div className="player-frame"><div ref={container} className="youtube-embed" />{loading && <div className="player-overlay">Loading video…</div>}{failed && <div className="player-overlay"><strong>Video unavailable</strong><span>Try another public YouTube video.</span></div>}</div>;
});

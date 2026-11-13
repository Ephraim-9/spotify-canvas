// spotify-canvas: reports now-playing state to the local Canvas service (127.0.0.1:47800), which drives the
// full-screen Canvas display (/view) on its own monitor. Draws nothing inside Spotify. Spicetify extension.
(function spotifyCanvas() {
  const S = window.Spicetify;
  if (!S?.Player?.addEventListener || !S?.Menu) {
    setTimeout(spotifyCanvas, 300);
    return;
  }

  const ENDPOINT = "http://127.0.0.1:47800/nowplaying";
  const KEY = "spotify-canvas:display";
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== "false"; } catch {}

  const state = () => {
    const item = S.Player.data?.item;
    const md = item?.metadata || {};
    const id = /^spotify:track:([A-Za-z0-9]{22})$/.exec(item?.uri || "")?.[1] || null;
    let cover = md.image_xlarge_url || md.image_large_url || md.image_url || "";
    if (cover.startsWith("spotify:image:")) cover = "https://i.scdn.co/image/" + cover.slice(14);
    return {
      enabled, id, cover,
      title: item?.name || md.title || "",
      artist: item?.artists?.map(a => a.name).join(", ") || md.artist_name || "",
      duration: S.Player.getDuration?.() || +md.duration || 0,
      position: S.Player.getProgress?.() || 0,
      playing: !!S.Player.isPlaying?.(),
    };
  };
  // text/plain keeps this a "simple" request (no CORS preflight). Service down -> drop silently.
  const send = () => { try { fetch(ENDPOINT, { method: "POST", body: JSON.stringify(state()), keepalive: true }).catch(() => {}); } catch {} };

  // Seek detection: progress that jumps away from where it should be.
  let last = { pos: 0, at: 0 };
  S.Player.addEventListener("onprogress", () => {
    const now = Date.now(), pos = S.Player.getProgress?.() || 0;
    const expected = last.pos + (S.Player.isPlaying?.() ? now - last.at : 0);
    if (last.at && Math.abs(pos - expected) > 1500) send();
    last = { pos, at: now };
  });
  // Send at once (timers are throttled while Spotify is hidden), and again once Player.data has settled.
  const sendTwice = () => { send(); setTimeout(send, 500); };
  S.Player.addEventListener("songchange", sendTwice);
  S.Player.addEventListener("onplaypause", sendTwice);
  setInterval(send, 5000); // heartbeat; Chromium may stretch it to once a minute while the window is hidden

  const item = new S.Menu.Item("Canvas display", enabled, () => {
    enabled = !enabled;
    item.setState(enabled);
    try { localStorage.setItem(KEY, String(enabled)); } catch {}
    send();
  });
  item.register();

  // Clear settings left by the old in-Spotify layouts.
  try { for (const k of ["enabled", "layout", "fsOpen", "none"]) localStorage.removeItem("spotify-canvas:" + k); } catch {}
  send();
})();

// spotify-canvas: looping Canvas video for the current track, via the local converter service
// (canvasdownloader.com -> VP9 WebM on 127.0.0.1:47800). Spicetify extension.
(function spotifyCanvas() {
  const S = window.Spicetify;
  if (!S?.Player?.addEventListener || !S?.Menu || !S?.Topbar || !document.body) {
    setTimeout(spotifyCanvas, 300);
    return;
  }

  const API = "http://127.0.0.1:47800";
  const LAYOUTS = ["sidebar", "fullscreen", "ambient"];
  const NEG_TTL = 7 * 864e5;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem("spotify-canvas:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("spotify-canvas:" + k, JSON.stringify(v)); } catch {} },
  };
  const cfg = {
    enabled: ls.get("enabled", true),
    layout: LAYOUTS.includes(ls.get("layout")) ? ls.get("layout") : "fullscreen",
    fsOpen: ls.get("fsOpen", true),
  };
  const st = { id: null, src: null, cover: null, token: 0, lookups: 0 };
  const mem = new Map(); // trackId -> true (has canvas) | false (none)

  // ---------- styles ----------
  const style = document.createElement("style");
  style.id = "spc-style";
  style.textContent = `
  .spc-video{display:block;width:100%;height:100%;object-fit:cover;pointer-events:none}
  .spc-sidebar{position:relative;width:100%;aspect-ratio:9/16;border-radius:8px;overflow:hidden;background:#000;margin-bottom:16px}
  .spc-sidebar-on [data-testid="cover-drop-target"],.spc-sidebar-on [data-testid="track-visual-enhancement"]{display:none!important}
  #spc-fs{position:fixed;z-index:30;overflow:hidden;background:#000;display:none}
  #spc-fs.spc-show{display:block}
  #spc-fs .spc-bg{position:absolute;inset:-60px;width:calc(100% + 120px);height:calc(100% + 120px);object-fit:cover;filter:blur(48px) brightness(.4) saturate(1.2)}
  #spc-fs .spc-fg{position:absolute;top:0;left:50%;height:100%;width:auto;aspect-ratio:9/16;transform:translateX(-50%);object-fit:cover;box-shadow:0 0 60px rgba(0,0,0,.6)}
  #spc-fs img.spc-fg{aspect-ratio:1;height:auto;width:min(60%,70vh);top:50%;transform:translate(-50%,-50%);border-radius:8px}
  #spc-fs .spc-close{position:absolute;top:12px;right:12px;z-index:2;width:32px;height:32px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:18px;cursor:pointer}
  #spc-amb{position:fixed;inset:-80px;z-index:-1;pointer-events:none;display:none}
  #spc-amb .spc-video{filter:blur(56px) brightness(.35) saturate(1.3)}
  body.spc-ambient #spc-amb{display:block}
  body.spc-ambient,body.spc-ambient .Root,body.spc-ambient .Root__top-container{background:transparent!important}
  body.spc-ambient .Root__main-view,body.spc-ambient .Root__nav-bar,body.spc-ambient .Root__right-sidebar,
  body.spc-ambient .Root__now-playing-bar,body.spc-ambient .main-view-container{background-color:rgba(0,0,0,.35)!important}
  body.spc-ambient{background-color:#000!important}`;
  document.head.appendChild(style);

  // ---------- elements ----------
  const video = cls => {
    const v = document.createElement("video");
    v.className = "spc-video " + cls;
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
    v.disablePictureInPicture = true; v.setAttribute("aria-hidden", "true");
    v.addEventListener("error", () => onVideoError(v));
    return v;
  };
  const side = document.createElement("div");
  side.className = "spc-sidebar";
  const sideV = video("spc-side");
  side.appendChild(sideV);

  const fs = document.createElement("div");
  fs.id = "spc-fs";
  const fsBg = video("spc-bg"), fsFg = video("spc-fg");
  const fsImgBg = document.createElement("img"), fsImgFg = document.createElement("img");
  fsImgBg.className = "spc-video spc-bg"; fsImgFg.className = "spc-fg";
  const close = document.createElement("button");
  close.className = "spc-close"; close.textContent = "×"; close.title = "Close Canvas (Esc)";
  close.onclick = () => setFsOpen(false);
  fs.append(fsBg, fsFg, close);

  const amb = document.createElement("div");
  amb.id = "spc-amb";
  const ambV = video("spc-amb-v");
  amb.appendChild(ambV);
  document.body.prepend(amb);
  document.body.appendChild(fs);

  // ---------- helpers ----------
  const setSrc = (v, src) => {
    if (src) {
      if (v.getAttribute("src") !== src) { v.src = src; }
    } else if (v.hasAttribute("src")) {
      v.pause(); v.removeAttribute("src"); v.load(); // frees the decoder
    }
  };
  const playing = () => !S.Player.data?.isPaused;
  const syncPlay = () => {
    for (const v of [sideV, fsBg, fsFg, ambV]) {
      if (!v.getAttribute("src")) continue;
      if (playing() && !document.hidden) v.play().catch(() => {}); else v.pause();
    }
  };
  const trackId = () => {
    const uri = S.Player.data?.item?.uri || "";
    const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri);
    return m ? m[1] : null;
  };

  function mountSidebar() {
    const npv = document.querySelector('[data-testid="NPV_Panel_OpenDiv"]');
    const cover = npv?.querySelector('[data-testid="cover-drop-target"], [data-testid="track-visual-enhancement"]'); // slot name differs by client build
    if (!cover) return false;
    if (side.parentElement !== cover.parentElement || side.nextSibling !== cover) cover.parentElement.insertBefore(side, cover);
    npv.classList.add("spc-sidebar-on");
    return true;
  }
  function unmountSidebar() {
    side.remove();
    document.querySelectorAll(".spc-sidebar-on").forEach(e => e.classList.remove("spc-sidebar-on"));
  }
  function placeFs() {
    const host = document.querySelector(".main-view-container") || document.querySelector(".Root__main-view");
    if (!host) return;
    const r = host.getBoundingClientRect();
    Object.assign(fs.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }

  // ---------- render ----------
  function render() {
    try {
      const L = cfg.enabled ? cfg.layout : null;
      const src = st.src;
      // sidebar
      if (L === "sidebar" && src && mountSidebar()) setSrc(sideV, src);
      else { setSrc(sideV, null); unmountSidebar(); }
      // fullscreen (two decoders: sharp + blurred backdrop)
      const fsOn = L === "fullscreen" && cfg.fsOpen;
      fs.classList.toggle("spc-show", fsOn);
      if (fsOn) {
        placeFs();
        if (src) {
          if (fsImgFg.isConnected) { fsImgBg.remove(); fsImgFg.remove(); fs.prepend(fsBg); fsBg.after(fsFg); }
          setSrc(fsBg, src); setSrc(fsFg, src);
        } else {
          setSrc(fsBg, null); setSrc(fsFg, null);
          fsBg.remove(); fsFg.remove();
          if (st.cover) { fsImgBg.src = fsImgFg.src = st.cover; fs.prepend(fsImgBg); fsImgBg.after(fsImgFg); }
          else { fsImgBg.remove(); fsImgFg.remove(); }
        }
      } else { setSrc(fsBg, null); setSrc(fsFg, null); }
      // ambient
      const ambOn = L === "ambient" && !!src;
      document.body.classList.toggle("spc-ambient", ambOn);
      setSrc(ambV, ambOn ? src : null);
      syncPlay();
      updateTopbar();
    } catch (e) { console.warn("[spotify-canvas] render", e); }
  }

  // ---------- lookup ----------
  const negCache = () => ls.get("none", {});
  function cachedNone(id) {
    const t = negCache()[id];
    return t && Date.now() - t < NEG_TTL;
  }
  function rememberNone(id) {
    const c = negCache(); c[id] = Date.now();
    const keys = Object.keys(c);
    if (keys.length > 1000) keys.sort((a, b) => c[a] - c[b]).slice(0, keys.length - 1000).forEach(k => delete c[k]);
    ls.set("none", c);
  }
  async function lookup(id) {
    if (mem.has(id)) return mem.get(id);
    if (cachedNone(id)) { mem.set(id, false); return false; }
    st.lookups++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch(`${API}/lookup/${id}`, { signal: ctl.signal });
      if (r.status === 200) { mem.set(id, true); return true; }
      if (r.status === 404) { mem.set(id, false); rememberNone(id); return false; }
      return null; // upstream error: not cached here, service backs off
    } catch { return null; } // service down
    finally { clearTimeout(timer); }
  }

  async function onSong() {
    const tok = ++st.token;
    const id = trackId();
    st.id = id;
    st.cover = S.Player.data?.item?.metadata?.image_xlarge_url || S.Player.data?.item?.metadata?.image_large_url || null;
    if (st.cover?.startsWith("spotify:image:")) st.cover = "https://i.scdn.co/image/" + st.cover.slice(14);
    st.src = null;
    render();
    if (!id || !cfg.enabled) return;
    const has = await lookup(id);
    if (tok !== st.token) return; // song changed meanwhile
    st.src = has ? `${API}/canvas/${id}.webm` : null;
    render();
  }

  // MEDIA_ERR_DECODE (3): decoder/GPU process dropped -> reload the same file (max ~3 reloads per track; both fullscreen videos count).
  // Anything else (e.g. 4: file pruned from cache) -> re-run the lookup once, then give up quietly.
  let retries = 0, relooked = false;
  function onVideoError(v) {
    const src = v.getAttribute("src");
    if (!src || src !== st.src) return;
    console.warn("[spotify-canvas] video error", v.error?.code);
    if (v.error?.code === 3 && retries < 6) {
      retries++;
      const tok = st.token;
      setSrc(v, null);
      setTimeout(() => { if (tok === st.token) render(); }, 1000 * retries);
    } else if (!relooked) {
      relooked = true; mem.delete(st.id); onSong();
    } else { st.src = null; render(); }
  }

  // ---------- settings ----------
  function setFsOpen(open) { cfg.fsOpen = open; ls.set("fsOpen", open); render(); }
  function setLayout(l) {
    cfg.layout = l; ls.set("layout", l);
    if (l === "fullscreen") cfg.fsOpen = true, ls.set("fsOpen", true);
    layoutItems.forEach(([name, item]) => item.setState(name === l));
    render();
  }
  function setEnabled(on) {
    cfg.enabled = on; ls.set("enabled", on); enabledItem.setState(on);
    if (on) onSong(); else { st.src = null; render(); }
  }
  const enabledItem = new S.Menu.Item("Enabled", cfg.enabled, () => setEnabled(!cfg.enabled));
  const layoutItems = LAYOUTS.map(l => [l, new S.Menu.Item("Layout: " + l[0].toUpperCase() + l.slice(1), cfg.layout === l, () => setLayout(l))]);
  new S.Menu.SubMenu("Canvas", [enabledItem, ...layoutItems.map(x => x[1])]).register();

  const icon = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M4.5 1A1.5 1.5 0 0 0 3 2.5v11A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 11.5 1h-7zm2 4.2 4 2.8-4 2.8V5.2z"/></svg>';
  const topbar = new S.Topbar.Button("Canvas", icon, () => {
    if (cfg.layout !== "fullscreen") setLayout("fullscreen"); else setFsOpen(!cfg.fsOpen);
  });
  function updateTopbar() { try { topbar.active = cfg.enabled && cfg.layout === "fullscreen" && cfg.fsOpen; } catch {} }

  // ---------- wiring ----------
  S.Player.addEventListener("songchange", () => { retries = 0; relooked = false; onSong(); });
  S.Player.addEventListener("onplaypause", syncPlay);
  document.addEventListener("visibilitychange", syncPlay);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && fs.classList.contains("spc-show")) setFsOpen(false);
  });
  window.addEventListener("resize", () => fs.classList.contains("spc-show") && placeFs());
  // React re-renders the NPV / main view: re-attach cheaply instead of observing the whole DOM
  setInterval(() => {
    if (!cfg.enabled || !st.src) return;
    if (cfg.layout === "sidebar" && (!side.isConnected || !side.nextSibling)) render();
    else if (cfg.layout === "fullscreen" && cfg.fsOpen) placeFs();
  }, 1500);

  window.SpotifyCanvas = { cfg, st, setLayout, setEnabled, setFsOpen, render, refresh: onSong };
  onSong();
})();

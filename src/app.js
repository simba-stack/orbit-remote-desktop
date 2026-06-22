"use strict";
// Orbit Remote — desktop controller renderer.
// Connects to the signaling server, negotiates WebRTC (as the offerer), shows the
// remote screen and forwards mouse/keyboard input over a data channel.

const SIGNALING_URL = (window.orbit && window.orbit.defaultSignalingUrl) ||
  "wss://orbit-remote-signaling-production.up.railway.app/ws";

const LS_DEVICES = "orbit.devices";
const LS_THEME = "orbit.theme";

// ---- Control message types (must match the Android agent) ----
const CM = {
  TAP: "tap", DOUBLE_TAP: "double_tap", LONG_PRESS: "long_press",
  SWIPE: "swipe", SCROLL: "scroll", TEXT: "text", KEY: "key",
  CLIPBOARD_SET: "clipboard_set", CLIPBOARD_GET: "clipboard_get"
};
const KEY = { BACK: "back", HOME: "home", RECENTS: "recents", NOTIFICATIONS: "notifications", LOCK: "lock" };

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
function loadDevices() {
  try { return JSON.parse(localStorage.getItem(LS_DEVICES) || "[]"); } catch { return []; }
}
function saveDevices(list) { localStorage.setItem(LS_DEVICES, JSON.stringify(list)); }

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(LS_THEME, theme);
}

// ---------------------------------------------------------------------------
// Session: one signaling connection + one peer connection + its UI
// ---------------------------------------------------------------------------
class Session {
  constructor(deviceId, code, name) {
    this.deviceId = deviceId;
    this.code = code;
    this.name = name || deviceId;
    this.id = `${deviceId}-${Date.now()}`;
    this.sessionId = null;
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    this.statusEl = null;
    this.buildUi();
    this.connect();
  }

  setStatus(state, text) {
    if (this.tabDot) this.tabDot.className = `status-dot ${state}`;
    if (this.overlay) this.overlay.textContent = text || "";
    if (this.overlay) this.overlay.style.display = text ? "block" : "none";
  }

  // ---- UI ----
  buildUi() {
    // Tab
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.innerHTML = `<span class="status-dot"></span><span class="tab-name"></span><span class="tab-close">✕</span>`;
    tab.querySelector(".tab-name").textContent = this.name;
    this.tabDot = tab.querySelector(".status-dot");
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-close")) { this.close(); return; }
      activate(this.id);
    });
    this.tabEl = tab;
    document.getElementById("tabs").appendChild(tab);

    // Session view
    const view = document.createElement("div");
    view.className = "session-view";
    view.innerHTML = `
      <div class="session-toolbar">
        <button class="toolbar-btn" data-act="back">◀ Back</button>
        <button class="toolbar-btn" data-act="home">● Home</button>
        <button class="toolbar-btn" data-act="recents">▣ Recents</button>
        <button class="toolbar-btn" data-act="notifications">▼ Shade</button>
        <span class="spacer"></span>
        <button class="toolbar-btn" data-act="screenshot">⤓ Screenshot</button>
        <button class="toolbar-btn" data-act="fullscreen">⛶ Fullscreen</button>
        <button class="toolbar-btn danger" data-act="disconnect">⏻ Disconnect</button>
      </div>
      <div class="video-wrap">
        <video class="remote" autoplay playsinline></video>
        <div class="status-overlay"></div>
      </div>`;
    this.viewEl = view;
    this.video = view.querySelector("video.remote");
    this.overlay = view.querySelector(".status-overlay");
    document.getElementById("stage").appendChild(view);

    view.querySelectorAll(".toolbar-btn").forEach((b) =>
      b.addEventListener("click", () => this.onToolbar(b.dataset.act)));

    this.attachInput();
    this.setStatus("connecting", "Connecting…");
  }

  onToolbar(act) {
    switch (act) {
      case "back": this.sendControl({ type: CM.KEY, key: KEY.BACK }); break;
      case "home": this.sendControl({ type: CM.KEY, key: KEY.HOME }); break;
      case "recents": this.sendControl({ type: CM.KEY, key: KEY.RECENTS }); break;
      case "notifications": this.sendControl({ type: CM.KEY, key: KEY.NOTIFICATIONS }); break;
      case "screenshot": this.screenshot(); break;
      case "fullscreen": this.toggleFullscreen(); break;
      case "disconnect": this.close(); break;
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) this.viewEl.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  async screenshot() {
    const v = this.video;
    if (!v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext("2d").drawImage(v, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    if (window.orbit?.saveScreenshot) {
      await window.orbit.saveScreenshot(dataUrl, `orbit-${this.deviceId}-${Date.now()}.png`);
    }
  }

  // ---- Signaling ----
  connect() {
    this.ws = new WebSocket(SIGNALING_URL);
    this.ws.onmessage = (e) => this.onSignal(JSON.parse(e.data));
    this.ws.onclose = () => this.setStatus("error", "Disconnected");
    this.ws.onerror = () => this.setStatus("error", "Connection error");
  }

  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  onSignal(msg) {
    switch (msg.type) {
      case "welcome":
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) this.iceServers = msg.iceServers;
        this.send({ type: "connect", targetId: this.deviceId, code: this.code });
        break;
      case "connected":
        this.sessionId = msg.sessionId;
        if (msg.device?.name) { this.name = msg.device.name; this.tabEl.querySelector(".tab-name").textContent = this.name; }
        this.startPeer();
        break;
      case "signal":
        this.handleRemoteSignal(msg.data);
        break;
      case "session-end":
        this.setStatus("error", "Session ended by device");
        break;
      case "error":
        this.setStatus("error", `Error: ${msg.code}`);
        break;
    }
  }

  // ---- WebRTC (offerer) ----
  async startPeer() {
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.sessionId) {
        this.send({ type: "signal", sessionId: this.sessionId, data: {
          kind: "candidate",
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex
        }});
      }
    };
    this.pc.ontrack = (e) => {
      this.video.srcObject = e.streams[0];
      this.setStatus("connected", "");
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "connected") this.setStatus("connected", "");
      else if (s === "failed") this.setStatus("error", "Connection failed");
      else if (s === "disconnected") this.setStatus("connecting", "Reconnecting…");
    };

    // Receive video; create the control data channel.
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.dc = this.pc.createDataChannel("control", { ordered: true });
    this.dc.onmessage = (e) => this.onAgentEvent(JSON.parse(e.data));

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.send({ type: "signal", sessionId: this.sessionId, data: { kind: "offer", sdp: offer.sdp } });
  }

  async handleRemoteSignal(data) {
    if (!this.pc) return;
    if (data.kind === "answer") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    } else if (data.kind === "candidate") {
      try {
        await this.pc.addIceCandidate({
          candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex
        });
      } catch { /* ignore late candidates */ }
    }
  }

  onAgentEvent(ev) {
    if (ev.type === "clipboard" && ev.text != null) {
      navigator.clipboard?.writeText(ev.text).catch(() => {});
    }
  }

  sendControl(msg) {
    if (this.dc && this.dc.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  // ---- Input mapping ----
  attachInput() {
    const v = this.video;
    let down = null;

    const norm = (clientX, clientY) => {
      const rect = v.getBoundingClientRect();
      const vw = v.videoWidth || rect.width, vh = v.videoHeight || rect.height;
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const dispW = vw * scale, dispH = vh * scale;
      const offX = (rect.width - dispW) / 2, offY = (rect.height - dispH) / 2;
      const nx = (clientX - rect.left - offX) / dispW;
      const ny = (clientY - rect.top - offY) / dispH;
      return { x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) };
    };

    v.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const p = norm(e.clientX, e.clientY);
      down = { x: p.x, y: p.y, t: Date.now() };
    });
    v.addEventListener("mouseup", (e) => {
      if (!down) return;
      const p = norm(e.clientX, e.clientY);
      const dt = Date.now() - down.t;
      const dist = Math.hypot(p.x - down.x, p.y - down.y);
      if (dist < 0.02 && dt < 450) {
        this.sendControl({ type: CM.TAP, x: p.x, y: p.y });
      } else if (dist < 0.02) {
        this.sendControl({ type: CM.LONG_PRESS, x: p.x, y: p.y, durationMs: dt });
      } else {
        this.sendControl({ type: CM.SWIPE, x: down.x, y: down.y, x2: p.x, y2: p.y, durationMs: Math.min(800, Math.max(80, dt)) });
      }
      down = null;
    });
    v.addEventListener("dblclick", (e) => {
      const p = norm(e.clientX, e.clientY);
      this.sendControl({ type: CM.DOUBLE_TAP, x: p.x, y: p.y });
    });
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    v.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = norm(e.clientX, e.clientY);
      const amount = 0.25;
      const dy = e.deltaY > 0 ? -amount : amount; // wheel down → content scrolls up
      this.sendControl({ type: CM.SCROLL, x: p.x, y: p.y, x2: p.x, y2: Math.max(0, Math.min(1, p.y + dy)), durationMs: 150 });
    }, { passive: false });

    // Keyboard handled globally (see below) only when this session is active.
    this._keyHandler = (e) => {
      if (activeSessionId !== this.id) return;
      if (e.ctrlKey && e.key.toLowerCase() === "c") { this.sendControl({ type: CM.CLIPBOARD_GET }); return; }
      if (e.ctrlKey && e.key.toLowerCase() === "v") {
        navigator.clipboard?.readText().then((t) => {
          this.sendControl({ type: CM.CLIPBOARD_SET, text: t });
          this.sendControl({ type: CM.TEXT, text: t });
        });
        return;
      }
      if (e.key === "Escape") { this.sendControl({ type: CM.KEY, key: KEY.BACK }); e.preventDefault(); return; }
      if (e.key === "Enter") { this.sendControl({ type: CM.TEXT, text: "\n" }); e.preventDefault(); return; }
      if (e.key.length === 1) { this.sendControl({ type: CM.TEXT, text: e.key }); e.preventDefault(); }
    };
    window.addEventListener("keydown", this._keyHandler);
  }

  close() {
    try { if (this.sessionId) this.send({ type: "hangup", sessionId: this.sessionId }); } catch {}
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    window.removeEventListener("keydown", this._keyHandler);
    this.tabEl.remove();
    this.viewEl.remove();
    sessions.delete(this.id);
    if (activeSessionId === this.id) {
      const next = sessions.keys().next();
      activeSessionId = null;
      if (!next.done) activate(next.value); else updateEmptyState();
    }
  }
}

// ---------------------------------------------------------------------------
// App-level wiring
// ---------------------------------------------------------------------------
const sessions = new Map();
let activeSessionId = null;
const MAX_SESSIONS = 20;

function activate(id) {
  activeSessionId = id;
  for (const [sid, s] of sessions) {
    s.tabEl.classList.toggle("active", sid === id);
    s.viewEl.classList.toggle("active", sid === id);
  }
  updateEmptyState();
  const s = sessions.get(id);
  if (s) s.video.focus?.();
}

function updateEmptyState() {
  document.getElementById("empty-state").style.display = sessions.size ? "none" : "block";
}

function startSession(deviceId, code, name) {
  if (!deviceId || !code) return;
  if (sessions.size >= MAX_SESSIONS) {
    alert(`Maximum of ${MAX_SESSIONS} simultaneous sessions reached.`);
    return;
  }
  const s = new Session(deviceId.trim(), code.trim(), (name || "").trim());
  sessions.set(s.id, s);
  activate(s.id);
}

function renderDeviceList() {
  const list = document.getElementById("device-list");
  const q = (document.getElementById("search").value || "").toLowerCase();
  const devices = loadDevices()
    .filter((d) => !q || d.name.toLowerCase().includes(q) || d.id.includes(q))
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0));
  list.innerHTML = "";
  for (const d of devices) {
    const item = document.createElement("div");
    item.className = "device-item";
    item.innerHTML = `
      <span class="star ${d.fav ? "fav" : ""}">★</span>
      <div style="flex:1">
        <div class="d-name"></div>
        <div class="d-id"></div>
      </div>
      <span class="del">🗑</span>`;
    item.querySelector(".d-name").textContent = d.name;
    item.querySelector(".d-id").textContent = d.id;
    item.querySelector(".d-name").parentElement.addEventListener("click", () => startSession(d.id, d.code, d.name));
    item.querySelector(".star").addEventListener("click", (e) => { e.stopPropagation(); toggleFav(d.id); });
    item.querySelector(".del").addEventListener("click", (e) => { e.stopPropagation(); removeDevice(d.id); });
    list.appendChild(item);
  }
}

function toggleFav(id) {
  const list = loadDevices().map((d) => d.id === id ? { ...d, fav: !d.fav } : d);
  saveDevices(list); renderDeviceList();
}
function removeDevice(id) {
  saveDevices(loadDevices().filter((d) => d.id !== id)); renderDeviceList();
}
function upsertDevice(id, code, name) {
  const list = loadDevices();
  const i = list.findIndex((d) => d.id === id);
  const entry = { id, code, name: name || id, fav: i >= 0 ? list[i].fav : false };
  if (i >= 0) list[i] = entry; else list.push(entry);
  saveDevices(list); renderDeviceList();
}

// ---- Boot ----
function boot() {
  applyTheme(localStorage.getItem(LS_THEME) || "dark");
  renderDeviceList();

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  });
  document.getElementById("search").addEventListener("input", renderDeviceList);
  document.getElementById("connect-btn").addEventListener("click", () => {
    const id = document.getElementById("device-id").value;
    const code = document.getElementById("device-code").value;
    const name = document.getElementById("device-name").value;
    if (document.getElementById("save-device").checked && id && code) upsertDevice(id.trim(), code.trim(), name.trim());
    startSession(id, code, name);
  });
}

boot();

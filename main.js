// filename: main.js
// XSO Lock — Electron main process + embedded Express service
// Hardened to only relock on the REAL dslrBooth "session_end" event.
// - Prefers query param ?event_type=session_end (dslrBooth sends many phases via this key)
// - Ignores all other phases (countdown, capture_start, processing_start, sharing_screen, file_upload, …)
// - Requires an active session (token IN_USE) and a small grace window before relocking
// - Optional shared secret (?secret=... or /hook/<anything>/<secret>) for extra safety

const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const {
  PORT,
  BATCH_ID,
  HMAC_SECRET,
  DEV_ACCEPT_LISTED_TOKENS,
  ESC_MINIMIZE_ENABLED,
  BIND_HOST,
  HOOK_SECRET,
  MIN_SECONDS_BEFORE_SESSION_END
} = require("./config");

let win;                    // overlay window
let server;                 // express http server
let tokens = [];            // in-memory token store
let currentTokenId = null;  // uuid currently IN_USE
let unlockedAtMs = 0;       // timestamp when overlay hid (arming the session_end hook)

const TOKENS_FILE = path.join(__dirname, "tokens.json");

// ----------------------------- utilities -----------------------------
function safeLoadJson(filePath, def = []) {
  try {
    if (!fs.existsSync(filePath)) return def;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return def;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[XSO] WARN: ${path.basename(filePath)} invalid; using default. Reason: ${e.message}`);
    return def;
  }
}

function loadTokens() {
  tokens = safeLoadJson(TOKENS_FILE, []);
  try {
    if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, "[]");
    const raw = fs.readFileSync(TOKENS_FILE, "utf8").trim();
    if (!raw) fs.writeFileSync(TOKENS_FILE, "[]");
  } catch {}
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.error("[XSO] ERROR: Failed to save tokens.json:", e.message);
  }
}

function nowISO() { return new Date().toISOString(); }

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Verify QR payload — supports dev shortcut (accept any exact match in tokens.json)
function verifyPayload(payload) {
  if (!payload || typeof payload !== "string" || !payload.startsWith("ciu:1|"))
    return { ok: false, err: "invalid_format" };

  const parts = payload.split("|");
  if (parts.length !== 4) return { ok: false, err: "invalid_parts" };

  const [, batch, uuid, sig] = parts;
  if (batch !== BATCH_ID) return { ok: false, err: "batch_mismatch" };

  if (DEV_ACCEPT_LISTED_TOKENS) {
    const t = tokens.find(x => x.uuid === uuid && x.batch_id === batch && x.payload === payload);
    if (t) return { ok: true, batch, uuid };
  }

  const mac = crypto.createHmac("sha256", HMAC_SECRET).update(`${batch}.${uuid}`).digest();
  const expected = b64url(mac);
  if (sig !== expected) return { ok: false, err: "bad_signature" };

  return { ok: true, batch, uuid };
}

// Finalize current token to COMPLETED/CANCELLED; returns true if a transition happened
function finalizeCurrent(outcome) {
  if (!currentTokenId) return false;
  const t = tokens.find(x => x.uuid === currentTokenId);
  if (!t) { currentTokenId = null; return false; }

  if (t.status === "IN_USE") {
    t.status = (outcome === "COMPLETED") ? "COMPLETED" : "CANCELLED";
    t.completed_at = (t.status === "COMPLETED") ? nowISO() : null;
    saveTokens();
    currentTokenId = null;
    return true;
  }

  // Not in IN_USE; clear pointer anyway
  currentTokenId = null;
  return false;
}

// ----------------------------- express server -----------------------------
function createServer() {
  const appx = express();
  appx.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next(); });
  appx.use(bodyParser.json());

  // Health probe
  appx.get("/health", (_req, res) => res.json({ ok: true }));

  // Unified hook route that prefers the query's event_type
  // Examples dslrBooth can call:
  //   http://127.0.0.1:5858/hook?event_type=session_end
  //   http://127.0.0.1:5858/hook/anything?event_type=session_end
  // Other phases will come as event_type=countdown, capture_start, processing_start, sharing_screen, file_upload, etc.
  appx.get(["/hook", "/hook/:whatever"], (req, res) => {
    const qEvent = String(req.query.event_type || "").toLowerCase();   // authoritative
    const pathEvent = String(req.params.whatever || "").toLowerCase(); // legacy path piece (ignored if query exists)
    const event = qEvent || pathEvent;  // prefer query; fallback to path if no query provided

    // Optional shared-secret (?secret=...) enforcement
    const secret = (req.query.secret || "").toString();
    if (HOOK_SECRET && secret !== HOOK_SECRET) {
      console.log(`[XSO] Hook rejected (bad/missing secret). path=${pathEvent} q=${qEvent}`);
      return res.status(403).send("forbidden");
    }

    const ageSec = ((Date.now() - unlockedAtMs) / 1000).toFixed(2);
    console.log(`[XSO] Hook event='${event || "(none)"}' armed=${!!currentTokenId} age=${ageSec}s`);

    if (event === "session_end") {
      const armed = !!currentTokenId;  // only after a valid scan
      const oldEnough = (Date.now() - unlockedAtMs) / 1000 >= MIN_SECONDS_BEFORE_SESSION_END;

      if (armed && oldEnough) {
        const changed = finalizeCurrent("COMPLETED");
        if (changed) {
          console.log("[XSO] → finalized token + relocking overlay");
          showOverlay();
        } else {
          console.log("[XSO] → no token finalized; ignoring relock");
        }
      } else {
        console.log("[XSO] → early hook or not armed; ignoring");
      }
      return res.send("ok");
    }

    // Ignore everything else (countdown*, capture_start, processing_start, sharing_screen, file_upload, etc.)
    return res.send("ignored");
  });

  // QR scan → validate and hide overlay
  appx.post("/api/qr/scan", (req, res) => {
    const { payload } = req.body || {};
    const v = verifyPayload(payload);
    if (!v.ok) {
      const map = {
        invalid_format: "QR tidak dikenal",
        invalid_parts: "QR tidak dikenal",
        batch_mismatch: "QR bukan untuk event ini",
        bad_signature: "QR tidak valid"
      };
      return res.status(400).json({ error: map[v.err] || "Invalid QR" });
    }

    const t = tokens.find(x => x.uuid === v.uuid && x.batch_id === v.batch);
    if (!t) return res.status(400).json({ error: "QR tidak dikenal" });
    if (t.status === "COMPLETED") return res.status(409).json({ error: "QR sudah digunakan" });
    if (t.status === "IN_USE") return res.status(409).json({ error: "QR sedang dipakai" });
    if (t.status !== "ISSUED") return res.status(409).json({ error: "QR tidak dalam status ISSUED" });

    // atomic claim
    t.status = "IN_USE";
    t.claimed_at = nowISO();
    saveTokens();
    currentTokenId = t.uuid;

    hideOverlay();
    unlockedAtMs = Date.now();   // arm hook with timestamp
    res.json({ ok: true, token_id: t.uuid });
  });

  // Debug QR — renders one of the first two payloads of current batch
  appx.get("/debug/qr.png", async (req, res) => {
    const idx = req.query.id === "2" ? 1 : 0;
    const sample = tokens.filter(t => t.batch_id === BATCH_ID).slice(0, 2)[idx];
    if (!sample) return res.status(404).send("no sample tokens available");
    res.setHeader("Content-Type", "image/png");
    require("qrcode").toFileStream(res, sample.payload, { margin: 1, errorCorrectionLevel: "M" });
  });

  // Static files (renderer)
  appx.use("/", express.static(path.join(__dirname, "renderer")));

  server = http.createServer(appx).listen(PORT, BIND_HOST, () => {
    console.log(`[XSO] HTTP listening on http://${BIND_HOST}:${PORT}`);
    if (win) win.loadURL(`http://${BIND_HOST}:${PORT}/index.html`);
  });
}

// ----------------------------- electron window -----------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setMenuBarVisibility(false);
}

function showOverlay() {
  if (!win) return;
  win.show();
  win.setFullScreen(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.focus();
  // micro retries to win z-order/focus battles
  setTimeout(() => { if (win) { win.setAlwaysOnTop(true, "screen-saver"); win.focus(); } }, 80);
  setTimeout(() => { if (win) { win.setAlwaysOnTop(true, "screen-saver"); win.focus(); } }, 160);
}

function hideOverlay() {
  if (!win) return;
  // drop the always-on-top flag just before hiding to reduce focus glitches
  win.setAlwaysOnTop(false);
  win.hide();
}

// ----------------------------- IPC & hotkeys -----------------------------
ipcMain.handle("xso:hide", () => hideOverlay());
ipcMain.handle("xso:show", () => showOverlay());
ipcMain.handle("xso:minimize", () => { if (win && !win.isMinimized()) win.minimize(); });
ipcMain.handle("xso:get-flag", (_e, name) => {
  if (name === "ESC_MINIMIZE_ENABLED") return ESC_MINIMIZE_ENABLED;
  return undefined;
});

function registerHotkey() {
  // Force relock (operator) — also cancels the active token if IN_USE
  globalShortcut.register("Control+Shift+L", () => {
    const changed = finalizeCurrent("CANCELLED");
    if (changed) console.log("[XSO] Force relock: cancelled active token");
    showOverlay();
  });
}

// ----------------------------- lifecycle -----------------------------
app.whenReady().then(() => {
  loadTokens();

  // Orphan recovery: any IN_USE from a prior crash becomes CANCELLED
  let changed = false;
  for (const t of tokens) {
    if (t.status === "IN_USE") { t.status = "CANCELLED"; changed = true; }
  }
  if (changed) saveTokens();

  createWindow();
  createServer();
  registerHotkey();
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// XSO Lock — Electron main + embedded Express service
const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const {
  PORT, BATCH_ID, HMAC_SECRET, DEV_ACCEPT_LISTED_TOKENS, ESC_MINIMIZE_ENABLED,
  BIND_HOST, HOOK_SECRET, MIN_SECONDS_BEFORE_SESSION_END,
  ADMIN_ENABLED, ADMIN_PIN, ADMIN_QR_UUID
} = require("./config");

let win;                    // overlay window
let server;                 // http server
let tokens = [];            // in-memory token store
let currentTokenId = null;  // uuid currently IN_USE
let unlockedAtMs = 0;       // when overlay hid (arm session_end)
let adminSessionActive = false; // true when Admin QR unlocked
const TOKENS_FILE = path.join(__dirname, "tokens.json");

// ---------------- utils ----------------
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
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2)); }
  catch (e) { console.error("[XSO] ERROR: Failed to save tokens.json:", e.message); }
}
function nowISO() { return new Date().toISOString(); }
function b64url(buf) { return buf.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }

// Normalize status for admin reset (USER-FRIENDLY → INTERNAL)
function normStatus(s) {
  const u = String(s || "").toUpperCase().trim();
  if (u === "USED") return "COMPLETED";
  return u;
}
function normFromList(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(",");
  return arr.map(s => normStatus(s));
}

// Verify QR payload — supports dev helper: accept exact matches from tokens.json
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

// finalize current guest token; returns true if status changed
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
  currentTokenId = null;
  return false;
}

// ---------------- express ----------------
function createServer() {
  const appx = express();
  appx.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next(); });
  appx.use(bodyParser.json());

  // Health
  appx.get("/health", (_req, res) => res.json({ ok: true }));

  // Small config for UI
  appx.get("/admin/config", (_req, res) => {
    res.json({
      ok: true,
      batch_id: BATCH_ID,
      admin_qr_enabled: !!ADMIN_QR_UUID,
      esc_minimize_enabled: ESC_MINIMIZE_ENABLED
    });
  });

  // Stats
  appx.get("/admin/stats", (req, res) => {
    if (!ADMIN_ENABLED) return res.status(403).json({ error: "admin_disabled" });
    const batch = (req.query.batch || "").toString();
    const subset = batch ? tokens.filter(t => t.batch_id === batch) : tokens;
    const counts = subset.reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});
    res.json({ ok: true, batch: batch || null, total: subset.length, counts });
  });

  // Beginner-friendly reset
  appx.post("/admin/reset", (req, res) => {
    if (!ADMIN_ENABLED) return res.status(403).json({ error: "admin_disabled" });

    let { pin, mode, batch_id, uuid, to, from } = req.body || {};
    if (!pin || pin !== ADMIN_PIN) return res.status(401).json({ error: "bad_pin" });

    to = normStatus(to);
    const fromSet = new Set(normFromList(from || ["IN_USE","COMPLETED","CANCELLED"]));

    const match = (t) => {
      if (mode === "batch_all")  return t.batch_id === batch_id && fromSet.has(String(t.status).toUpperCase());
      if (mode === "batch_inuse")return t.batch_id === batch_id && String(t.status).toUpperCase() === "IN_USE";
      if (mode === "uuid_one")   return t.uuid === uuid && fromSet.has(String(t.status).toUpperCase());
      if (mode === "all_batches")return fromSet.has(String(t.status).toUpperCase());
      return false;
    };

    let changed = 0;
    const before = {};
    for (const t of tokens) {
      if (match(t)) {
        before[t.status] = (before[t.status] || 0) + 1;
        t.status = to;
        if (t.status === "ISSUED") { t.claimed_at = null; t.completed_at = null; }
        else if (t.status !== "COMPLETED") { t.completed_at = null; }
        if (currentTokenId === t.uuid) currentTokenId = null;
        changed++;
      }
    }
    saveTokens();
    res.json({ ok: true, changed, to, from_counts: before });
  });

  // Unified hook — prefer query ?event_type=
  appx.get(["/hook", "/hook/:whatever"], (req, res) => {
    const qEvent = String(req.query.event_type || "").toLowerCase();
    const pathEvent = String(req.params.whatever || "").toLowerCase();
    const event = qEvent || pathEvent;

    const secret = (req.query.secret || "").toString();
    if (HOOK_SECRET && secret !== HOOK_SECRET) {
      console.log(`[XSO] Hook rejected (bad/missing secret). path=${pathEvent} q=${qEvent}`);
      return res.status(403).send("forbidden");
    }

    const ageSec = ((Date.now() - unlockedAtMs) / 1000).toFixed(2);
    console.log(`[XSO] Hook event='${event || "(none)"}' armedGuest=${!!currentTokenId} adminActive=${adminSessionActive} age=${ageSec}s`);

    if (event === "session_end") {
      const oldEnough = (Date.now() - unlockedAtMs) / 1000 >= MIN_SECONDS_BEFORE_SESSION_END;

      // Admin QR path: just relock, no token changes
      if (adminSessionActive && oldEnough) {
        adminSessionActive = false;
        console.log("[XSO] Admin QR session: relocking overlay");
        showOverlay();
        return res.send("ok");
      }

      // Normal guest path
      if (currentTokenId && oldEnough) {
        const changed = finalizeCurrent("COMPLETED");
        if (changed) { console.log("[XSO] Guest session finalized + relocking"); showOverlay(); }
        else { console.log("[XSO] No guest token finalized; ignoring"); }
        return res.send("ok");
      }

      console.log("[XSO] Early hook or not armed; ignoring");
      return res.send("ok");
    }
    return res.send("ignored");
  });

  // Scan endpoint
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

    // --- Admin QR: always allowed, does NOT consume a token ---
    if (ADMIN_QR_UUID && v.uuid === ADMIN_QR_UUID) {
      adminSessionActive = true;
      currentTokenId = null;
      hideOverlay();
      unlockedAtMs = Date.now();
      console.log("[XSO] Admin QR scanned → unlocked (rescanable)");
      return res.json({ ok: true, admin: true });
    }

    // --- Guest QR ---
    const t = tokens.find(x => x.uuid === v.uuid && x.batch_id === v.batch);
    if (!t) return res.status(400).json({ error: "QR tidak dikenal" });
    if (t.status === "COMPLETED") return res.status(409).json({ error: "QR sudah digunakan" });
    if (t.status === "IN_USE") return res.status(409).json({ error: "QR sedang dipakai" });
    if (t.status !== "ISSUED") return res.status(409).json({ error: "QR tidak dalam status ISSUED" });

    t.status = "IN_USE";
    t.claimed_at = nowISO();
    saveTokens();

    adminSessionActive = false;
    currentTokenId = t.uuid;

    hideOverlay();
    unlockedAtMs = Date.now();
    res.json({ ok: true, token_id: t.uuid });
  });

  // (Kept for dev convenience; no longer linked in UI)
  appx.get("/debug/qr.png", async (req, res) => {
    const idx = req.query.id === "2" ? 1 : 0;
    const sample = tokens.filter(t => t.batch_id === BATCH_ID).slice(0, 2)[idx];
    if (!sample) return res.status(404).send("no sample tokens available");
    res.setHeader("Content-Type", "image/png");
    require("qrcode").toFileStream(res, sample.payload, { margin: 1, errorCorrectionLevel: "M" });
  });

  // static files (renderer)
  appx.use("/", express.static(path.join(__dirname, "renderer")));

  server = http.createServer(appx).listen(PORT, BIND_HOST, () => {
    console.log(`[XSO] HTTP listening on http://${BIND_HOST}:${PORT}`);
    if (win) win.loadURL(`http://${BIND_HOST}:${PORT}/index.html`);
  });
}

// ---------------- window ----------------
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
  setTimeout(() => { if (win) { win.setAlwaysOnTop(true, "screen-saver"); win.focus(); } }, 80);
  setTimeout(() => { if (win) { win.setAlwaysOnTop(true, "screen-saver"); win.focus(); } }, 160);
}
function hideOverlay() {
  if (!win) return;
  win.setAlwaysOnTop(false);
  win.hide();
}

// ---------------- IPC & hotkeys ----------------
ipcMain.handle("xso:hide", () => hideOverlay());
ipcMain.handle("xso:show", () => showOverlay());
ipcMain.handle("xso:minimize", () => { if (win && !win.isMinimized()) win.minimize(); });
ipcMain.handle("xso:get-flag", (_e, name) => {
  if (name === "ESC_MINIMIZE_ENABLED") return ESC_MINIMIZE_ENABLED;
  if (name === "ADMIN_ENABLED") return ADMIN_ENABLED;
  return undefined;
});

function registerHotkey() {
  globalShortcut.register("Control+Shift+L", () => {
    // Cancel guest session if any
    const changed = finalizeCurrent("CANCELLED");
    if (changed) console.log("[XSO] Force relock: cancelled active guest token");
    // End admin session if active
    if (adminSessionActive) {
      adminSessionActive = false;
      console.log("[XSO] Force relock: ended admin session");
    }
    showOverlay();
  });
}

// ---------------- lifecycle ----------------
app.whenReady().then(() => {
  loadTokens();
  // orphan recovery
  let changed = false;
  for (const t of tokens) if (t.status === "IN_USE") { t.status = "CANCELLED"; changed = true; }
  if (changed) saveTokens();

  createWindow();
  createServer();
  registerHotkey();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

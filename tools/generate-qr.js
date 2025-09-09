#!/usr/bin/env node
"use strict";
/**
 * Pre-generate signed QR codes into a folder and register tokens in tokens.json.
 * - Robust against empty/corrupted tokens.json
 * - Creates PNGs, tokens.csv, labels.pdf, batch.json
 * - Default batch/location can be overridden by CLI args or env
 *
 * Usage examples:
 *   node generate-qr.js --count 10 --out qr/B2025-09-08-A --batch B2025-09-08-A
 *   node generate-qr.js --count 8000 --out qr/B2025-09-08-A --batch B2025-09-08-A
 *   node generate-qr.js --count 100 --out qr/MYBATCH --batch MYBATCH --reset
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

// ---------- Config (env-overridable defaults) ----------
const DEFAULT_BATCH_ID = process.env.BATCH_ID || "B2025-09-08-A";
const HMAC_SECRET = process.env.HMAC_SECRET || "XSO_TEST_SECRET_2025"; // keep secret in prod
const TOKENS_FILE = path.resolve("tokens.json");

// ---------- Helpers ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count" || a === "-c") out.count = Number(argv[++i]);
    else if (a === "--out" || a === "-o") out.out = argv[++i];
    else if (a === "--batch" || a === "-b") out.batch = argv[++i];
    else if (a === "--reset") out.reset = true;
  }
  return out;
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sign(batch, uuid, secret) {
  const mac = crypto.createHmac("sha256", secret).update(`${batch}.${uuid}`).digest();
  return b64url(mac);
}

function safeLoadJson(filePath, def = []) {
  try {
    if (!fs.existsSync(filePath)) return def;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return def;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[WARN] ${path.basename(filePath)} invalid; starting fresh. Reason: ${e.message}`);
    return def;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function detectStartIndex(outDir) {
  // Count existing "#####-xxxxxx.png" files to continue numbering without overwrite
  try {
    const files = fs.readdirSync(outDir);
    const nums = files
      .map((n) => {
        const m = n.match(/^(\d{5})-/);
        return m ? Number(m[1]) : null;
      })
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0) return 1;
    return Math.max(...nums) + 1;
  } catch {
    return 1;
  }
}

// ---------- Main ----------
(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const COUNT = Number.isFinite(args.count) ? args.count : 10;
  const BATCH_ID = args.batch || DEFAULT_BATCH_ID;
  const outDir = path.resolve(args.out || `qr/${BATCH_ID}`);
  const RESET = !!args.reset;

  ensureDir(outDir);

  // Load/initialize token store
  let tokens = RESET ? [] : safeLoadJson(TOKENS_FILE, []);
  if (!fs.existsSync(TOKENS_FILE)) {
    fs.writeFileSync(TOKENS_FILE, "[]");
  }

  // Determine starting index based on existing PNGs in outDir
  let index = detectStartIndex(outDir);

  const newTokens = [];
  for (let i = 0; i < COUNT; i++) {
    const uuid = crypto.randomUUID();
    const sig = sign(BATCH_ID, uuid, HMAC_SECRET);
    const payload = `ciu:1|${BATCH_ID}|${uuid}|${sig}`;

    const token = {
      uuid,
      batch_id: BATCH_ID,
      payload,
      status: "ISSUED",
      claimed_at: null,
      completed_at: null,
      created_at: new Date().toISOString()
    };

    // Append to in-memory store & newTokens
    tokens.push(token);
    newTokens.push(token);

    // File name: 5-digit running index + short uuid prefix
    const filename = `${String(index).padStart(5, "0")}-${uuid.slice(0, 8)}.png`;
    index++;

    const filePath = path.join(outDir, filename);
    await QRCode.toFile(filePath, payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 600
    });
  }

  // Persist tokens.json (full store with appended entries)
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));

  // CSV for just the new batch (easy to print/reconcile per run)
  const csv = ["uuid,batch_id,payload,status"]
    .concat(newTokens.map((t) => `${t.uuid},${t.batch_id},${t.payload},${t.status}`))
    .join("\n");
  fs.writeFileSync(path.join(outDir, "tokens.csv"), csv);

  // PDF labels (A4, 2 columns x 5 rows per page → 10 per page)
  const pdfPath = path.join(outDir, "labels.pdf");
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(fs.createWriteStream(pdfPath));

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const COLS = 2;
  const ROWS = 5; // 10 labels/page
  const cellW = pageW / COLS;
  const cellH = pageH / ROWS;

  for (let idx = 0; idx < newTokens.length; idx++) {
    const t = newTokens[idx];

    if (idx > 0 && idx % (COLS * ROWS) === 0) doc.addPage();

    const pageIndexIdx = idx % (COLS * ROWS);
    const r = Math.floor(pageIndexIdx / COLS);
    const c = pageIndexIdx % COLS;

    const x = doc.page.margins.left + c * cellW;
    const y = doc.page.margins.top + r * cellH;

    const label = `${t.batch_id} • ${t.uuid.slice(0, 8)}`;
    const buf = await QRCode.toBuffer(t.payload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: Math.min(cellW - 24, 260)
    });

    // draw cell frame
    doc.rect(x, y, cellW, cellH).strokeColor("#cccccc").lineWidth(0.5).stroke();
    // QR
    doc.image(buf, x + 12, y + 12, { fit: [cellW - 24, cellH - 60] });
    // text
    doc.fontSize(10).fillColor("#000").text(label, x + 12, y + cellH - 36, {
      width: cellW - 24,
      align: "center"
    });
  }

  doc.end();

  // Batch summary (handy for auditing)
  const batchSummary = {
    batch_id: BATCH_ID,
    total_generated: newTokens.length,
    output_dir: outDir,
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(outDir, "batch.json"), JSON.stringify(batchSummary, null, 2));

  console.log(`✅ Generated ${newTokens.length} QR(s) in ${outDir}`);
  console.log(`   - tokens saved to tokens.json (total now: ${tokens.length})`);
  console.log(`   - CSV:  ${path.join(outDir, "tokens.csv")}`);
  console.log(`   - PDF:  ${path.join(outDir, "labels.pdf")}`);
  console.log(`   - Info: ${path.join(outDir, "batch.json")}`);
})().catch((err) => {
  console.error("❌ QR generation failed:", err);
  process.exit(1);
});
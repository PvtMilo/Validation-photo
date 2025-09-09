#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const TOKENS_FILE = path.resolve("tokens.json");

function loadTokens() {
  const raw = fs.readFileSync(TOKENS_FILE, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

function auditBatch(batchId, dir) {
  const tokens = loadTokens().filter(t => t.batch_id === batchId);
  if (!tokens.length) {
    console.log(`No tokens found for batch ${batchId}`);
    process.exit(1);
  }
  const ids = new Set();
  const payloads = new Set();
  let badPayload = 0;

  for (const t of tokens) {
    if (ids.has(t.uuid)) throw new Error(`Duplicate uuid ${t.uuid}`);
    ids.add(t.uuid);

    if (!t.payload || !t.payload.startsWith("ciu:1|")) badPayload++;
    payloads.add(t.payload);
  }

  const pngs = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith(".png"))
    : [];

  const statuses = tokens.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`Batch: ${batchId}`);
  console.log(`- Tokens in store: ${tokens.length}`);
  console.log(`- Unique UUIDs:    ${ids.size}`);
  console.log(`- Unique payloads: ${payloads.size}`);
  console.log(`- PNG files:       ${pngs.length} ${pngs.length ? `(${dir})` : "(missing dir)"}`);
  console.log(`- Status counts:   ${JSON.stringify(statuses)}`);
  if (badPayload) console.log(`- Bad payloads:    ${badPayload}`);

  if (ids.size !== tokens.length) throw new Error("UUIDs are not unique");
  if (payloads.size !== tokens.length) throw new Error("Payloads are not unique");
  if (pngs.length && Math.abs(pngs.length - tokens.length) > 0) {
    console.warn("WARN: PNG count != token count (ok if you split printing into subsets)");
  }

  console.log("OK: batch audit passed.");
}

(function main() {
  const batch = process.argv[2] || process.env.BATCH_ID;
  if (!batch) {
    console.log("Usage: node tools/qr-audit.js <BATCH_ID> [DIR]");
    console.log("Example: node tools/qr-audit.js B2025-09-08-A qr/B2025-09-08-A");
    process.exit(1);
  }
  const dir = process.argv[3] || path.join("qr", batch);
  auditBatch(batch, dir);
})();

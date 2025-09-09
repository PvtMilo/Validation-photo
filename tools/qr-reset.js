#!/usr/bin/env node
"use strict";
/**
 * Reset QR token statuses in tokens.json with filters.
 * Examples:
 *  node tools/qr-reset.js --all
 *  node tools/qr-reset.js --batch B2025-09-08-A --from COMPLETED --to ISSUED
 *  node tools/qr-reset.js --uuid 123e4567-e89b-12d3-a456-426614174000
 *  node tools/qr-reset.js --from IN_USE,COMPLETED --dry-run
 */

const fs = require("fs");
const path = require("path");

const TOKENS_FILE = path.resolve("tokens.json");

function parseArgs(argv) {
  const a = {
    all: false,
    from: ["IN_USE", "COMPLETED", "CANCELLED"],
    to: "ISSUED",
    batch: null,
    uuids: [],
    dryRun: false,
    noBackup: false
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--all") a.all = true;
    else if (v === "--from") a.from = String(argv[++i]).split(",").map(s => s.trim().toUpperCase());
    else if (v === "--to") a.to = String(argv[++i]).trim().toUpperCase();
    else if (v === "--batch") a.batch = String(argv[++i]).trim();
    else if (v === "--uuid") a.uuids.push(String(argv[++i]).trim());
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--no-backup") a.noBackup = true;
  }
  return a;
}

function safeLoadTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    const raw = fs.readFileSync(TOKENS_FILE, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) {
    console.error("[qr-reset] ERROR: tokens.json invalid:", e.message);
    process.exit(2);
  }
}

(function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokens = safeLoadTokens();

  if (!args.all && !args.batch && args.uuids.length === 0) {
    console.log("Nothing to do. Provide --all or --batch <ID> or --uuid <UUID> [repeatable].");
    console.log("Examples:");
    console.log("  node tools/qr-reset.js --all");
    console.log("  node tools/qr-reset.js --batch B2025-09-08-A --from COMPLETED --to ISSUED");
    console.log("  node tools/qr-reset.js --uuid <uuid>");
    process.exit(1);
  }

  const match = (t) => {
    if (!args.all) {
      if (args.batch && t.batch_id !== args.batch) return false;
      if (args.uuids.length && !args.uuids.includes(t.uuid)) return false;
    }
    return args.from.includes(String(t.status).toUpperCase());
  };

  const selected = tokens.filter(match);
  if (selected.length === 0) {
    console.log("No tokens matched your filters.");
    process.exit(0);
  }

  console.log(`[qr-reset] Will set ${selected.length} token(s) → ${args.to}`);
  if (args.dryRun) {
    console.log("[qr-reset] Dry-run only. No changes written.");
    process.exit(0);
  }

  if (!args.noBackup) {
    const bak = TOKENS_FILE + ".bak_" + Date.now();
    try { fs.copyFileSync(TOKENS_FILE, bak); console.log("[qr-reset] Backup:", bak); }
    catch (e) { console.warn("[qr-reset] WARN: failed to backup:", e.message); }
  }

  let changed = 0;
  for (const t of selected) {
    t.status = args.to;
    if (args.to === "ISSUED") {
      t.claimed_at = null;
      t.completed_at = null;
    } else if (args.to !== "COMPLETED") {
      t.completed_at = null;
    }
    changed++;
  }

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  console.log(`[qr-reset] Updated ${changed} token(s). Done.`);
})();

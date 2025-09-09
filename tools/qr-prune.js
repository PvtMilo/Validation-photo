#!/usr/bin/env node
"use strict";
/**
 * Delete tokens from tokens.json with safety backup.
 * Examples:
 *  node tools/qr-prune.js --all
 *  node tools/qr-prune.js --batch B2025-09-08-A
 *  node tools/qr-prune.js --uuid <uuid1> --uuid <uuid2>
 *  node tools/qr-prune.js --batch B2025-09-08-A --status COMPLETED,IN_USE
 *  node tools/qr-prune.js --all --keep-admin
 *  node tools/qr-prune.js --dry-run --batch B2025-09-08-A
 */

const fs = require("fs");
const path = require("path");

const TOKENS_FILE = path.resolve("tokens.json");
const ADMIN_UUID = process.env.ADMIN_QR_UUID || "";

function parseArgs(argv) {
  const a = {
    all: false,
    batch: null,
    uuids: [],
    status: null,
    keepAdmin: false,
    dryRun: false,
    noBackup: false
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--all") a.all = true;
    else if (v === "--batch") a.batch = String(argv[++i]).trim();
    else if (v === "--uuid") a.uuids.push(String(argv[++i]).trim());
    else if (v === "--status") a.status = String(argv[++i]).split(",").map(s => s.toUpperCase().trim());
    else if (v === "--keep-admin") a.keepAdmin = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--no-backup") a.noBackup = true;
  }
  return a;
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return [];
  const raw = fs.readFileSync(TOKENS_FILE, "utf8").trim();
  return raw ? JSON.parse(raw) : [];
}

(function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokens = loadTokens();

  if (!args.all && !args.batch && args.uuids.length === 0) {
    console.log("Nothing to do. Provide --all or --batch <ID> or --uuid <UUID> [repeatable].");
    process.exit(1);
  }

  const statusSet = args.status ? new Set(args.status) : null;

  const keep = [];
  const remove = [];
  for (const t of tokens) {
    let candidate = args.all;

    if (args.batch && t.batch_id === args.batch) candidate = true;
    if (args.uuids.length && args.uuids.includes(t.uuid)) candidate = true;

    if (statusSet && !statusSet.has(String(t.status).toUpperCase())) {
      // if filtering by status, and token status NOT in filter, then do not remove
      candidate = false;
    }

    // protect admin uuid if requested
    if (args.keepAdmin && ADMIN_UUID && t.uuid === ADMIN_UUID) candidate = false;

    if (candidate) remove.push(t); else keep.push(t);
  }

  console.log(`Would remove ${remove.length} token(s), keep ${keep.length}.`);
  if (args.dryRun) {
    console.log("Dry-run: no changes written.");
    process.exit(0);
  }

  if (!args.noBackup && fs.existsSync(TOKENS_FILE)) {
    const bak = TOKENS_FILE + ".bak_" + Date.now();
    try { fs.copyFileSync(TOKENS_FILE, bak); console.log("Backup:", bak); }
    catch (e) { console.warn("WARN: failed to backup:", e.message); }
  }

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(keep, null, 2));
  console.log("Prune complete.");
})();

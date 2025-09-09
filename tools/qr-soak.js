#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.PORT || 5858);
const HOST = process.env.BIND_HOST || "127.0.0.1";
const TOKENS_FILE = path.resolve("tokens.json");

function loadTokens(batchId) {
  const raw = fs.readFileSync(TOKENS_FILE, "utf8").trim();
  const all = raw ? JSON.parse(raw) : [];
  return all.filter(t => t.batch_id === batchId && t.status === "ISSUED");
}

function postJSON(pathname, data) {
  const body = Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) } },
      res => { let buf = ""; res.on("data", d => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf })); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: pathname }, res => {
      let buf = ""; res.on("data", d => buf += d); res.on("end", () => resolve({ status: res.statusCode, body: buf })); })
      .on("error", reject);
  });
}

(async function main() {
  const batchId = process.argv[2] || process.env.BATCH_ID;
  const count = Number(process.argv[3] || 50);

  if (!batchId) {
    console.log("Usage: node tools/qr-soak.js <BATCH_ID> [COUNT]");
    process.exit(1);
  }

  const tokens = loadTokens(batchId).slice(0, count);
  if (tokens.length === 0) {
    console.log("No ISSUED tokens available for soak test.");
    process.exit(1);
  }

  console.log(`Starting soak against http://${HOST}:${PORT} for batch ${batchId} with ${tokens.length} tokens...`);
  let ok = 0, failed = 0;
  const times = [];

  for (const t of tokens) {
    const start = Date.now();
    const s = await postJSON("/api/qr/scan", { payload: t.payload });
    if (s.status !== 200) {
      console.log(`SCAN FAIL: ${t.uuid} -> ${s.status} ${s.body}`);
      failed++; continue;
    }
    const h = await get("/hook?event_type=session_end");
    if (h.status !== 200) {
      console.log(`HOOK FAIL: ${t.uuid} -> ${h.status} ${h.body}`);
      failed++; continue;
    }
    const elapsed = Date.now() - start;
    times.push(elapsed);
    ok++;
  }

  const avg = times.length ? (times.reduce((a,b)=>a+b,0)/times.length).toFixed(1) : 0;
  console.log(`Soak complete. OK=${ok} FAIL=${failed} avgRoundTripMs=${avg}`);
})();

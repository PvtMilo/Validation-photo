// config.js — hardened
function getBool(name, def = true) {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}
function getStr(name, def) {
  const v = process.env[name];
  return v === undefined ? def : v;
}
function getNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

module.exports = {
  PORT: getNum("PORT", 5858),
  BATCH_ID: getStr("BATCH_ID", "B2025-09-08-A"),
  HMAC_SECRET: getStr("HMAC_SECRET", "XSO_TEST_SECRET_2025"),
  DEV_ACCEPT_LISTED_TOKENS: getBool("DEV_ACCEPT_LISTED_TOKENS", true),
  ESC_MINIMIZE_ENABLED: getBool("ESC_MINIMIZE_ENABLED", true),

  // bind local only for safety
  BIND_HOST: getStr("BIND_HOST", "127.0.0.1"),

  // optional shared secret in hook URL: /hook/session_end/<HOOK_SECRET>
  HOOK_SECRET: getStr("HOOK_SECRET", ""),

  // ignore "session_end" hooks that arrive earlier than this (# seconds) after unlock
  MIN_SECONDS_BEFORE_SESSION_END: getNum("MIN_SECONDS_BEFORE_SESSION_END", 3)
};

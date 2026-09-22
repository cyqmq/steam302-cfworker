import { DEFAULT_MANIFEST } from "./router.js";

let local = {
  cfg: null,
  ts: 0,
};

function merge(base, parsed) {
  return {
    version: parsed.version ?? base.version,
    failover: { ...base.failover, ...(parsed.failover || {}) },
    token: parsed.token ?? base.token,
    routes:
      Array.isArray(parsed.routes) && parsed.routes.length
        ? parsed.routes
        : base.routes,
  };
}

export async function loadConfig(env) {
  if (local.cfg && Date.now() - local.ts < 30_000) return local.cfg;
  let cfg = structuredClone(DEFAULT_MANIFEST);
  let text = null;
  if (env.ROUTES) {
    try {
      text = await env.ROUTES.get("manifest");
    } catch (_) {}
  }
  if (!text && env.MANIFEST) {
    text = env.MANIFEST;
  }
  if (text) {
    try {
      cfg = merge(cfg, JSON.parse(text));
    } catch (_) {}
  }
  if (env.FAILOVER) {
    try {
      cfg.failover = { ...cfg.failover, ...JSON.parse(env.FAILOVER) };
    } catch (_) {}
  }
  local = { cfg, ts: Date.now() };
  return cfg;
}
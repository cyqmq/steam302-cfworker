import { DEFAULT_UA, hash } from "./util.js";
import { getIpPool } from "./doh.js";

const LOCAL = new Map();
let snapshot = { ts: 0, value: null };
let stealthMod;

function getStealthMod() {
  if (stealthMod === undefined) {
    stealthMod = import("./stealth.js").catch(() => null);
  }
  return stealthMod;
}

async function probeIp(ip, sniHost, ua) {
  const m = await getStealthMod();
  if (!m || typeof m.stealthFetch !== "function" || !m.stealthSupported()) {
    return null;
  }
  try {
    const res = await m.stealthFetch("https://" + ip + "/", {
      method: "HEAD",
      headers: { "user-agent": ua, host: sniHost },
      sni: sniHost,
    });
    try {
      await res.body?.cancel?.();
    } catch (_) {}
    return res.status < 500 && res.status !== 429;
  } catch (_) {
    return false;
  }
}

function kvKey(id, upstream) {
  return "health:" + id + ":" + hash(upstream);
}

export async function readHealth(env, id, upstream) {
  const k = id + "|" + upstream;
  const v = LOCAL.get(k);
  if (v && Date.now() < v.until) return v;
  if (env.HEALTH_KV) {
    try {
      const kv = await env.HEALTH_KV.get(kvKey(id, upstream), "json");
      if (kv) {
        LOCAL.set(k, kv);
        return kv;
      }
    } catch (_) {}
  }
  return null;
}

export async function markFail(env, id, upstream, maxFails, cooldownMs) {
  const k = id + "|" + upstream;
  let v = LOCAL.get(k);
  if (!v) {
    if (env.HEALTH_KV) {
      try {
        v = await env.HEALTH_KV.get(kvKey(id, upstream), "json");
      } catch (_) {}
    }
    v = v || { fails: 0, until: 0 };
  }
  v.fails = (v.fails || 0) + 1;
  if (v.fails >= maxFails) {
    v.until = Date.now() + cooldownMs;
    v.fails = 0;
    if (env.HEALTH_KV) {
      try {
        await env.HEALTH_KV.put(kvKey(id, upstream), JSON.stringify(v));
      } catch (_) {}
    }
  }
  LOCAL.set(k, v);
}

export function isDown(v) {
  return !!(v && v.until && Date.now() < v.until);
}

export async function getSnapshot(env) {
  const now = Date.now();
  if (snapshot.ts && now - snapshot.ts < 30_000) return snapshot.value;
  let value = null;
  if (env.HEALTH_KV) {
    try {
      value = await env.HEALTH_KV.get("snapshot", "json");
    } catch (_) {}
  }
  snapshot = { ts: now, value };
  return value;
}

async function probe(url, route) {
  const ua = route.ua || DEFAULT_UA;
  try {
    let res = await fetchHead(url, ua);
    if (!res) return false;
    let status = res.status;
    if (status === 405 || status === 501) {
      res = await fetchGet(url, ua);
      if (!res) return false;
      status = res.status;
      await riskCancel(res);
    } else {
      await riskCancel(res);
    }
    return status < 500 && status !== 429;
  } catch (_) {
    return false;
  }
}

async function fetchHead(url, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await fetch(url, {
      method: "HEAD",
      headers: { "user-agent": ua },
      redirect: "manual",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGet(url, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { "user-agent": ua, range: "bytes=0-0" },
      redirect: "manual",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function riskCancel(res) {
  try {
    await res.body?.cancel();
  } catch (_) {}
}

export async function scheduledCheck(env, cfg) {
  const failed = {};
  const cooldownMs = (cfg.failover.cooldown_s || 45) * 1000;
  for (const r of cfg.routes || []) {
    const targets = new Set();
    let poolHost = null;
    for (const host of r.hosts || []) {
      if (host.startsWith("*.")) continue;
      if (!poolHost) poolHost = host;
      targets.add(
        r.mode === "same-host" ? "https://" + host : r.target || "https://" + host
      );
    }
    for (const u of r.upstreams || []) targets.add(u.replace(/\/+$/, ""));
    for (const up of targets) {
      const ok = await probe(up, r);
      if (!ok) failed[up] = { until: Date.now() + cooldownMs };
    }
    if (r.stealth && r.ip_pool !== false && poolHost) {
      const ips = await getIpPool(poolHost);
      for (const ip of ips.slice(0, 3)) {
        const ok = await probeIp(ip, r.sni || poolHost, r.ua || DEFAULT_UA);
        if (ok === false) {
          failed["https://" + ip] = { until: Date.now() + cooldownMs };
        }
      }
    }
  }
  const value = { ts: Date.now(), failed };
  snapshot = { ts: value.ts, value };
  if (env.HEALTH_KV) {
    try {
      await env.HEALTH_KV.put("snapshot", JSON.stringify(value));
    } catch (_) {}
  }
  return Object.keys(failed).length;
}
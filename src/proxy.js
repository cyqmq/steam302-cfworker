import { DEFAULT_UA, isAssetHost, isHeavyHost } from "./util.js";
import { readHealth, markFail, isDown, getSnapshot } from "./health.js";
import { cachePolicy, cacheLookup, cacheStore } from "./cache.js";
import { getIpPool } from "./doh.js";

let stealthPromise;
function getStealth() {
  if (stealthPromise === undefined) {
    stealthPromise = import("./stealth.js").catch(() => null);
  }
  return stealthPromise;
}

const STRIP_IN = /^(cf-|x-real-ip|forwarded|x-forwarded-)/i;
const REDIRECT_TO_GET = (s) => s >= 300 && s <= 303;

function candidates(route, host) {
  const out = [];
  const push = (u, hostOverride, sni) => {
    if (!u) return;
    const url = String(u).replace(/\/+$/, "");
    if (out.some((o) => o.url === url)) return;
    out.push({ url, host: hostOverride, sni: sni || hostOverride });
  };
  if (route.mode === "same-host") push("https://" + host, host, route.sni);
  else push(route.target, host, route.sni);
  for (const u of route.upstreams || []) push(u, host, route.sni);
  return out;
}

function buildReqHeaders(inHeaders, ua, hostOverride) {
  const out = new Headers();
  for (const [k, v] of inHeaders.entries()) {
    if (STRIP_IN.test(k)) continue;
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length") continue;
    out.set(k, v);
  }
  out.set("User-Agent", ua || DEFAULT_UA);
  if (hostOverride) out.set("Host", hostOverride);
  return out;
}

async function nativeFetch(req, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.failover.timeout_ms || 6000);
  try {
    return await fetch(req, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function attemptFetch(request, target, route, origHost, cfg, stealth, sni) {
  const isBodyless = request.method === "GET" || request.method === "HEAD";
  const body = isBodyless ? undefined : await request.clone().arrayBuffer();
  const req = new Request(target, {
    method: request.method,
    headers: buildReqHeaders(request.headers, route.ua, origHost),
    body,
    redirect: "manual",
  });
  if (stealth) {
    const m = await getStealth();
    if (m && typeof m.stealthFetch === "function" && m.stealthSupported()) {
      try {
        return await m.stealthFetch(req.url, {
          method: req.method,
          headers: req.headers,
          body,
          sni,
        });
      } catch (_) {}
    }
  }
  return nativeFetch(req, cfg);
}

function finalize(res) {
  const h = new Headers(res.headers);
  for (const k of [
    "content-security-policy",
    "content-security-policy-report-only",
    "clear-site-data",
  ]) {
    h.delete(k);
  }
  h.set("access-control-allow-origin", "*");
  h.set("access-control-expose-headers", "*");
  h.set("access-control-allow-private-network", "true");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

function err(status, msg) {
  return new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function failAndReport(env, route, up, cfg, last) {
  await markFail(
    env,
    route.id,
    up,
    cfg.failover.max_fails || 2,
    (cfg.failover.cooldown_s || 45) * 1000
  );
  return last;
}

async function redirectChain(res, request, cfg, route, base, env, depth) {
  if (depth > 8) return err(508, "too many redirects");
  const loc = res.headers.get("location");
  if (!loc) return finalize(res);
  let locUrl = null;
  try {
    locUrl = new URL(loc, base);
  } catch (_) {}
  if (!locUrl) return finalize(res);
  if (isAssetHost(locUrl.hostname)) {
    const method = REDIRECT_TO_GET(res.status) ? "GET" : request.method;
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request.clone().arrayBuffer();
    const innerReq = new Request(locUrl.toString(), {
      method,
      headers: buildReqHeaders(request.headers, DEFAULT_UA, locUrl.hostname),
      body,
      redirect: "manual",
    });
    const up = locUrl.origin;
    try {
      const r2 = await attemptFetch(
        innerReq,
        locUrl.toString(),
        route,
        locUrl.hostname,
        cfg,
        route.stealth && !isHeavyHost(locUrl.hostname),
        route.sni || locUrl.hostname
      );
      if (r2.status >= 500 || r2.status === 429) {
        await failAndReport(env, route, up, cfg, r2.status);
        return err(502, "asset upstream failed: " + r2.status);
      }
      return redirectChain(r2, innerReq, cfg, route, up, env, depth + 1);
    } catch (_) {
      await failAndReport(env, route, up, cfg, 502);
      return err(502, "asset upstream unreachable");
    }
  }
  return finalize(res);
}

function emitAnalytics(env, ctx, data) {
  if (!env || !env.ANALYTICS) return;
  try {
    const ev = env.ANALYTICS.writeDataEvent;
    const task = typeof ev === "function"
      ? ev({ indexName: "request", data })
      : null;
    if (task && ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  } catch (_) {}
}

export async function proxyRequest(request, cfg, route, host, env, ctx) {
  const t0 = Date.now();
  const reqUrl = new URL(request.url);
  const tail = reqUrl.pathname + reqUrl.search;
  const cands = candidates(route, host);
  const list = cands.map((c) => ({ url: c.url + tail, host: c.host, sni: c.sni }));

  const result = { status: 502, upstream: "", ok: false };
  const keyOf = (u) => new URL(u).origin;

  const lookupUrl = list[0] && list[0].url;
  if (lookupUrl) {
    const hitPolicy = cachePolicy(route, new URL(lookupUrl), request.method, request.headers);
    if (hitPolicy) {
      const hit = await cacheLookup(lookupUrl);
      if (hit) {
        result.status = hit.status;
        result.upstream = "cache";
        result.ok = true;
        const out = finalize(hit);
        emitAnalytics(env, ctx, { route: route.id, host, ...result, ms: Date.now() - t0 });
        return out;
      }
    }
  }

  const snap = await getSnapshot(env);
  const down = new Set();
  for (const up of list) {
    const k = keyOf(up.url);
    const kv = snap?.failed?.[k];
    if (kv && Date.now() < (kv.until || 0)) down.add(k);
    const h = await readHealth(env, route.id, k);
    if (isDown(h)) down.add(k);
  }
  const ordered = [
    ...list.filter((c) => !down.has(keyOf(c.url))),
    ...list.filter((c) => down.has(keyOf(c.url))),
  ];

  let last = 502;
  async function tryCandidate(up, stealth) {
    try {
      const res = await attemptFetch(request, up.url, route, up.host, cfg, stealth, up.sni);
      result.upstream = up.url;
      if (res.status >= 500 || res.status === 429) {
        last = await failAndReport(env, route, keyOf(up.url), cfg, res.status);
        return null;
      }
      if (res.status < 300 && request.method === "GET") {
        const policy = cachePolicy(route, new URL(up.url), request.method, request.headers);
        if (policy) await cacheStore(up.url, res.clone(), policy, ctx);
      }
      result.status = res.status;
      result.ok = res.status < 400;
      return redirectChain(res, request, cfg, route, up.url, env, 0);
    } catch (_) {
      last = await failAndReport(env, route, keyOf(up.url), cfg, 502);
      return null;
    }
  }

  for (const up of ordered) {
    const stealth =
      !!route.stealth && !isHeavyHost(new URL(up.url).hostname);
    const out = await tryCandidate(up, stealth);
    if (out) {
      emitAnalytics(env, ctx, { route: route.id, host, ...result, ms: Date.now() - t0 });
      return out;
    }
  }

  if (route.stealth && route.ip_pool !== false) {
    const ips = await getIpPool(host);
    for (const ip of ips.slice(0, 4)) {
      const ipCand = {
        url: "https://" + ip + tail,
        host,
        sni: route.sni || host,
      };
      const out = await tryCandidate(ipCand, true);
      if (out) {
        emitAnalytics(env, ctx, { route: route.id, host, ...result, ms: Date.now() - t0 });
        return out;
      }
    }
  }

  result.status = last >= 500 ? last : 502;
  emitAnalytics(env, ctx, { route: route.id, host, ...result, ms: Date.now() - t0 });
  return err(result.status, "all upstreams unreachable");
}
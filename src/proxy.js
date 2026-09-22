import { DEFAULT_UA, isAssetHost, isHeavyHost } from "./util.js";
import { readHealth, markFail, isDown, getSnapshot } from "./health.js";
import { cachePolicy, cacheLookup, cacheStore } from "./cache.js";

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
  const push = (u, hostOverride) => {
    if (!u) return;
    const url = String(u).replace(/\/+$/, "");
    if (out.some((o) => o.url === url)) return;
    out.push({ url, host: hostOverride });
  };
  if (route.mode === "same-host") push("https://" + host, host);
  else push(route.target, host);
  for (const u of route.upstreams || []) push(u, host);
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

async function attemptFetch(request, target, route, origHost, cfg, stealth) {
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
        route.stealth && !isHeavyHost(locUrl.hostname)
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

export async function proxyRequest(request, cfg, route, host, env, ctx) {
  const reqUrl = new URL(request.url);
  const tail = reqUrl.pathname + reqUrl.search;
  const cands = candidates(route, host);
  const list = cands.map((c) => ({ url: c.url + tail, host: c.host }));

  const lookupUrl = list[0] && list[0].url;
  if (lookupUrl) {
    const hitPolicy = cachePolicy(route, new URL(lookupUrl), request.method, request.headers);
    if (hitPolicy) {
      const hit = await cacheLookup(lookupUrl);
      if (hit) return finalize(hit);
    }
  }

  const snap = await getSnapshot(env);
  const down = new Set();
  for (const up of list) {
    const kv = snap?.failed?.[up.url];
    if (kv && Date.now() < (kv.until || 0)) down.add(up.url);
    const h = await readHealth(env, route.id, up.url);
    if (isDown(h)) down.add(up.url);
  }
  const ordered = [
    ...list.filter((c) => !down.has(c.url)),
    ...list.filter((c) => down.has(c.url)),
  ];

  let last = 502;
  for (const up of ordered) {
    const stealth =
      !!route.stealth && !isHeavyHost(new URL(up.url).hostname);
    try {
      const res = await attemptFetch(request, up.url, route, up.host, cfg, stealth);
      if (res.status >= 500 || res.status === 429) {
        last = await failAndReport(env, route, up.url, cfg, res.status);
        continue;
      }
      if (res.status < 300 && request.method === "GET") {
        const policy = cachePolicy(route, new URL(up.url), request.method, request.headers);
        if (policy) await cacheStore(up.url, res.clone(), policy, ctx);
      }
      return redirectChain(res, request, cfg, route, up.url, env, 0);
    } catch (_) {
      last = await failAndReport(env, route, up.url, cfg, 502);
    }
  }
  return err(last >= 500 ? last : 502, "all upstreams unreachable");
}
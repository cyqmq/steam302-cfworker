import { matchRoute } from "./router.js";
import { loadConfig } from "./config.js";
import { proxyRequest } from "./proxy.js";
import { scheduledCheck } from "./health.js";
import { cacheDelete } from "./cache.js";

const PREFLIGHT = new Response(null, {
  status: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "1728000",
    "access-control-allow-private-network": "true",
  },
});

function passAcl(cfg, env, request) {
  const token = env.ACCESS_TOKEN || cfg.token;
  if (token) {
    const auth = request.headers.get("authorization") || "";
    const qtoken = new URL(request.url).searchParams.get("token");
    if (auth !== "Bearer " + token && qtoken !== token) return false;
  }
  const allow = (env.ALLOW_IPS || "").trim();
  if (allow) {
    const set = allow
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const ip = request.headers.get("cf-connecting-ip") || "";
    if (set.length && !set.includes(ip)) return false;
  }
  return true;
}

export default {
  async fetch(request, env, ctx) {
    const cfg = await loadConfig(env);
    const url = new URL(request.url);
    if (url.pathname === "/__health") {
      return new Response("ok", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (!passAcl(cfg, env, request)) {
      return new Response("forbidden", { status: 403 });
    }
    if (request.method === "OPTIONS") return PREFLIGHT;
    const host = (request.headers.get("host") || url.hostname)
      .toLowerCase()
      .replace(/:\d+$/, "");
    if (url.pathname === "/__flush-cache") {
      const target = url.searchParams.get("url");
      if (!target) {
        return new Response("need ?url=<full origin url>", {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      let deleted = false;
      try { deleted = await cacheDelete(target); } catch (_) {}
      return new Response(
        JSON.stringify({ deleted }),
        { headers: { "content-type": "application/json" } }
      );
    }
    const route = matchRoute(cfg.routes, host);
    if (!route) {
      return new Response("no route for host: " + host, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return proxyRequest(request, cfg, route, host, env, ctx);
  },

  async scheduled(_controller, env) {
    const cfg = await loadConfig(env);
    return scheduledCheck(env, cfg);
  },
};
const STATIC_RE = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|eot)$/i;
const MAX_ENTRY = 25 * 1024 * 1024;

function cacheEnabled() {
  return typeof caches !== "undefined" && typeof caches.default !== "undefined";
}

export function cachePolicy(route, url, method, inHeaders) {
  if (method !== "GET") return null;
  if (inHeaders.has("cookie") || inHeaders.has("authorization") || inHeaders.has("range")) return null;
  const r = route.cache || {};
  const p = (url.pathname || "").toLowerCase();
  if (STATIC_RE.test(p)) {
    const secs = Math.max(1, Math.round((r.static_ms ?? 7 * 24 * 3600 * 1000) / 1000));
    return { ttlMs: r.static_ms ?? 7 * 24 * 3600 * 1000, ctrl: "public, max-age=" + secs + ", immutable" };
  }
  if (r.micro_ms && (/\/api\//.test(p) || p.startsWith("/graphql-"))) {
    const secs = Math.max(1, Math.round(r.micro_ms / 1000));
    return { ttlMs: r.micro_ms, ctrl: "public, max-age=" + secs };
  }
  return null;
}

export async function cacheLookup(url) {
  if (!cacheEnabled()) return null;
  try {
    return await caches.default.match(url);
  } catch (_) {
    return null;
  }
}

export async function cacheStore(url, response, policy, ctx) {
  if (!cacheEnabled() || !policy || !response) return;
  if (response.status < 200 || response.status >= 300) return;
  if (response.headers.has("set-cookie") || response.headers.has("vary")) return;
  const cc = (response.headers.get("cache-control") || "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) return;
  const len = Number(response.headers.get("content-length") || 0);
  if (len > MAX_ENTRY) return;
  const copy = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  copy.headers.set("cache-control", policy.ctrl);
  const task = caches.default.put(url, copy);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  else await task;
}

export async function cacheDelete(url) {
  if (!cacheEnabled()) return false;
  try {
    return await caches.default.delete(url);
  } catch (_) {
    return false;
  }
}
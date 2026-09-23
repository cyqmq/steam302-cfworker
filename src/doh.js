const V4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const TTL_MS = 300_000;
const pool = new Map();

async function dohLookup(host) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(
      "https://cloudflare-dns.com/dns-query?name=" +
        encodeURIComponent(host) +
        "&type=A",
      { headers: { accept: "application/dns-json" }, signal: ctrl.signal }
    );
    const json = await res.json();
    const out = [];
    for (const a of json.Answer || []) {
      if (a.type === 1 && V4.test(a.data) && !out.includes(a.data)) {
        out.push(a.data);
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function getIpPool(host) {
  if (!host || V4.test(host)) return [];
  const hit = pool.get(host);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.ips;
  try {
    const ips = await dohLookup(host);
    if (ips.length) pool.set(host, { ts: Date.now(), ips });
    return ips;
  } catch (_) {
    return hit ? hit.ips : [];
  }
}

export function clearIpPool() {
  pool.clear();
}
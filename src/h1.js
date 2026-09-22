export function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(13, i);
    if (nl < 0) break;
    const size = parseInt(
      new TextDecoder().decode(buf.subarray(i, nl)).trim(),
      16
    );
    if (!size) break;
    const start = nl + 2;
    if (start + size > buf.length) break;
    out.push(buf.subarray(start, start + size));
    i = start + size + 2;
  }
  const total = out.reduce((n, c) => n + c.length, 0);
  const res = new Uint8Array(total);
  let p = 0;
  for (const c of out) {
    res.set(c, p);
    p += c.length;
  }
  return res;
}

export function indexOfBytes(buf, seq, from = 0) {
  const n = buf.length;
  const m = seq.length;
  outer: for (let i = Math.max(0, from); i <= n - m; i++) {
    for (let j = 0; j < m; j++) {
      if (buf[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function parseResponseBytes(all, method) {
  const sep = indexOfBytes(all, new Uint8Array([13, 10, 13, 10]));
  if (sep < 0) throw new Error("malformed http headers");

  const head = new TextDecoder().decode(all.subarray(0, sep));
  const lines = head.split("\r\n");
  if (!lines[0]) throw new Error("malformed status line");

  const statusParts = lines[0].split(" ");
  const status = Number(statusParts[1]);
  const statusText = statusParts.slice(2).join(" ");

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const ci = lines[i].indexOf(":");
    if (ci < 0) continue;
    const k = lines[i].slice(0, ci).trim();
    const v = lines[i].slice(ci + 1).trim();
    if (k) headers.append(k, v);
  }

  let body = all.subarray(sep + 4);
  if (method !== "HEAD") {
    const te = (headers.get("transfer-encoding") || "").toLowerCase();
    if (te.includes("chunked")) {
      body = dechunk(body);
    } else if (headers.has("content-length")) {
      const len = Number(headers.get("content-length") || 0);
      body = body.subarray(0, len || body.length);
    }
  }
  return { status, statusText, headers, body };
}

export function buildRequestLines(method, url, headers) {
  const lines = [method + " " + url.pathname + url.search + " HTTP/1.1"];
  const put = new Set();
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "connection" || lk === "content-length") continue;
    if (put.has(lk)) continue;
    put.add(lk);
    lines.push(k + ": " + v);
  }
  if (!put.has("host")) lines.push("Host: " + url.host);
  lines.push("Accept-Encoding: identity");
  lines.push("Connection: close");
  return lines.join("\r\n") + "\r\n\r\n";
}

export async function decodeBody(headers, body) {
  const enc = (headers.get("content-encoding") || "").toLowerCase();
  const fmt =
    enc === "gzip" || enc === "x-gzip"
      ? "gzip"
      : enc === "deflate"
        ? "deflate"
        : enc === "br"
          ? "br"
          : null;
  if (!fmt || !body.length || typeof DecompressionStream === "undefined") return body;
  try {
    const stream = new Blob([body])
      .stream()
      .pipeThrough(new DecompressionStream(fmt));
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  } catch (_) {
    return body;
  }
}

export function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const res = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    res.set(c, p);
    p += c.length;
  }
  return res;
}
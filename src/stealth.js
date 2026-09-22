import { connect } from "cloudflare:sockets";
import { parseResponseBytes, decodeBody, buildRequestLines, concat } from "./h1.js";

export function stealthSupported() {
  return typeof connect === "function";
}

export async function stealthFetch(target, init, timeoutMs = 15000) {
  const url = typeof target === "string" ? new URL(target) : target;
  const method = (init && init.method) || "GET";
  const headers = (init && init.headers) || new Headers();
  const body = (init && init.body) || undefined;
  const sni = (init && init.sni) || url.hostname;
  const useTls = url.protocol === "https:";
  const port = url.port || (useTls ? 443 : 80);

  let socket;
  try {
    socket = connect(
      { hostname: url.hostname, port },
      { secureTransport: useTls ? "starttls" : "off" }
    );
  } catch (e) {
    throw new Error("socket connect failed: " + e.message);
  }

  let cxn = socket;
  if (useTls) {
    try {
      cxn = socket.startTls({
        ALPNProtocols: ["http/1.1"],
        serverName: sni,
      });
    } catch (e) {
      try { socket.close(); } catch (_) {}
      throw new Error("tls failed: " + e.message);
    }
  }

  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      try { cxn.close(); } catch (_) {}
    }
  }, timeoutMs);

  try {
    const writer = cxn.writable.getWriter();
    const enc = new TextEncoder();
    await writer.write(enc.encode(buildRequestLines(method, url, headers)));
    if (body && body.byteLength) await writer.write(new Uint8Array(body));
    try { await writer.close(); } catch (_) {}

    const reader = cxn.readable.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const parsed = parseResponseBytes(concat(chunks), method);
    const decoded = await decodeBody(parsed.headers, parsed.body);
    parsed.headers.delete("content-encoding");
    parsed.headers.delete("content-length");
    parsed.headers.delete("transfer-encoding");
    return new Response(new Uint8Array(decoded), {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    try { cxn.close(); } catch (_) {}
  }
}
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ASSET_HOSTS = new Set([
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "media.githubusercontent.com",
]);

export function isAssetHost(host) {
  return ASSET_HOSTS.has(String(host).toLowerCase());
}

const HEAVY_HOSTS = new Set([
  ...ASSET_HOSTS,
  "avatars.githubusercontent.com",
  "cdn.steamstatic.com",
  "cdn.cloudflare.steamstatic.com",
  "shared.cloudflare.steamstatic.com",
]);

export function isHeavyHost(host) {
  return HEAVY_HOSTS.has(String(host).toLowerCase());
}

export function hash(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x.toString(36);
}
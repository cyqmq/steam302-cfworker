const UA_GOOGLEBOT = "Googlebot/2.1 (+http://www.google.com/bot.html)";

const GITHUB_HOSTS = [
  "github.com",
  "www.github.com",
  "gist.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "raw.github.com",
  "camo.githubusercontent.com",
  "cloud.githubusercontent.com",
  "avatars.githubusercontent.com",
  "avatars0.githubusercontent.com",
  "avatars1.githubusercontent.com",
  "avatars2.githubusercontent.com",
  "avatars3.githubusercontent.com",
  "user-images.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "objects.githubusercontent.com",
  "media.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "assets-cdn.github.com",
  "github.githubassets.com",
  "help.github.com",
  "docs.github.com",
  "codeload.github.com",
  "github.io",
  "www.github.io",
  "*.github.io",
  "pages.github.com",
  "copilot.github.com",
  "services.github.com",
  "resources.github.com",
  "developer.github.com",
  "partner.github.com",
  "desktop.github.com",
  "guides.github.com",
  "support.github.com",
  "education.github.com",
  "enterprise.github.com",
  "lab.github.com",
  "classroom.github.com",
  "central.github.com",
  "desktop.githubusercontent.com",
];

const STEAM_HOSTS = [
  "steamcommunity.com",
  "www.steamcommunity.com",
  "store.steampowered.com",
  "cdn.cloudflare.steamstatic.com",
];

const MODIO_HOSTS = [
  "mod.io",
  "www.mod.io",
  "stats.mod.io",
  "api.mod.io",
  "api-v3.mod.io",
  "forums.mod.io",
];

export function matchRoute(routes, hostRaw) {
  const host = String(hostRaw).toLowerCase().replace(/:\d+$/, "");
  let best = null;
  let bestDots = -1;
  for (const r of routes || []) {
    for (const pat of r.hosts || []) {
      const p = pat.toLowerCase();
      if (p === host) return r;
      if (p.startsWith("*.")) {
        const suffix = p.slice(2);
        if (host.endsWith("." + suffix)) {
          const dots = suffix.split(".").length;
          if (dots > bestDots) {
            best = r;
            bestDots = dots;
          }
        }
      }
    }
  }
  return best;
}

export const DEFAULT_MANIFEST = {
  version: 1,
  failover: {
    timeout_ms: 6000,
    max_fails: 2,
    cooldown_s: 45,
  },
  routes: [
    {
      id: "github",
      group: "github",
      name: "GitHub 加速",
      mode: "same-host",
      hosts: GITHUB_HOSTS,
      ua: null,
      upstreams: [],
      cache: { static_ms: 7 * 24 * 3600 * 1000 },
    },
    {
      id: "steam",
      group: "steam",
      name: "Steam 社区/商店",
      mode: "same-host",
      hosts: STEAM_HOSTS,
      ua: UA_GOOGLEBOT,
      upstreams: [],
      stealth: true,
      cache: { static_ms: 24 * 3600 * 1000 },
    },
    {
      id: "modio",
      group: "modio",
      name: "mod.io 模组站",
      mode: "same-host",
      hosts: MODIO_HOSTS,
      ua: null,
      upstreams: [],
      cache: { static_ms: 7 * 24 * 3600 * 1000 },
    },
  ],
};
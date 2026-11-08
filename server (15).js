// Lumo Extras: a Stremio-compatible addon that adds bloopers, behind-the-scenes clips,
// featurettes and post-credits scene info (from TMDB) to the Sources list of a title.
// Node 18+. Environment: TMDB_API_KEY (required), PORT (optional).
const http = require("http");
const KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 7000;

const manifest = {
  id: "community.lumo.extras",
  version: "1.0.0",
  name: "Extras: bloopers, behind the scenes, post-credits",
  description: "Bloopers, behind-the-scenes clips, featurettes and post-credits scene info from TMDB.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb"],
  catalogs: [],
  behaviorHints: { configurable: false }
};

const cache = new Map();
const tmdb = async (path, params = {}) => {
  const url = new URL("https://api.themoviedb.org/3" + path);
  url.searchParams.set("api_key", KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) { const val = await r.json(); cache.set(key, { val, exp: Date.now() + 6 * 3600e3 }); return val; }
      if (r.status === 404) return null;
    } catch (_) {}
  }
  return null;
};

// Works out the TMDB id and type from a Stremio id (tt1234567, tt1234567:1:2 or tmdb:603)
const resolve = async (type, rawId) => {
  const tmdbType = type === "movie" ? "movie" : "tv";
  const t = rawId.match(/^tmdb:(\d+)/);
  if (t) return { tmdbType, id: t[1] };
  const m = rawId.match(/^(tt\d+)/);
  if (!m) return null;
  const found = await tmdb(`/find/${m[1]}`, { external_source: "imdb_id" });
  const hit = (tmdbType === "movie" ? found?.movie_results : found?.tv_results)?.[0];
  return hit ? { tmdbType, id: String(hit.id) } : null;
};

const KINDS = [
  { type: "Bloopers", icon: "😂", label: "Bloopers", max: 5 },
  { type: "Behind the Scenes", icon: "🎬", label: "Behind the scenes", max: 5 },
  { type: "Featurette", icon: "🎞", label: "Featurette", max: 4 },
  { type: "Clip", icon: "📽", label: "Clip", max: 3 }
];

const getStreams = async (type, rawId) => {
  if (!KEY || !["movie", "series"].includes(type)) return [];
  const r = await resolve(type, decodeURIComponent(rawId));
  if (!r) return [];
  const [vids, kw] = await Promise.all([
    tmdb(`/${r.tmdbType}/${r.id}/videos`, { language: "en-US", include_video_language: "en,null" }),
    tmdb(`/${r.tmdbType}/${r.id}/keywords`)
  ]);
  const streams = [];

  // Post-credits scene info (comes from TMDB keywords; coverage is not complete)
  const names = (kw?.keywords || kw?.results || []).map(k => String(k.name).toLowerCase());
  const during = names.some(n => /during.?credits|mid.?credits/.test(n));
  const after = names.some(n => /after.?credits|post.?credits/.test(n));
  if (during || after) {
    const parts = [];
    if (during) parts.push("a scene during the credits");
    if (after) parts.push("a scene after the credits");
    streams.push({
      name: "⏱ Post-credits",
      title: "This title has " + parts.join(" and ") + ". Stay until the end.",
      externalUrl: `https://www.themoviedb.org/${r.tmdbType}/${r.id}`
    });
  }

  // Videos from YouTube, grouped by kind
  const list = (vids?.results || []).filter(v => v.site === "YouTube" && v.key);
  for (const k of KINDS) {
    list.filter(v => v.type === k.type).slice(0, k.max).forEach(v =>
      streams.push({ name: `${k.icon} ${k.label}`, title: v.name || k.label, ytId: v.key })
    );
  }
  return streams;
};

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, {
    "Content-Type": type + "; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": type === "application/json" ? "public, max-age=3600" : "no-cache"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const path = req.url.split("?")[0];
  try {
    if (path === "/health") return send(res, 200, { ok: true, version: manifest.version, tmdbKey: Boolean(KEY) });
    if (path === "/manifest.json") return send(res, 200, manifest);
    const m = path.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (m) return send(res, 200, { streams: await getStreams(m[1], m[2]) });
    if (path === "/") {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      return send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumo Extras</title><body style="font-family:system-ui;background:#0b0f14;color:#eef2f7;text-align:center;padding:30px"><h1>Lumo Extras</h1><p>Bloopers, behind-the-scenes clips and post-credits info for Stremio-compatible apps.</p><p>Manifest: https://${host}/manifest.json</p></body>`, "text/html");
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return send(res, 200, { streams: [] });
  }
}).listen(PORT, () => console.log(`Lumo Extras listening on ${PORT}; TMDB key ${KEY ? "set" : "missing"}`));

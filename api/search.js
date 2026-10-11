// Vercel Serverless Function: /api/search?url=<link tiktok>[&deep=1]
// Beberapa API TikTok di RapidAPI (satu key). Kalau jatah satu habis, otomatis pindah ke berikutnya.
const KEY = process.env.RAPIDAPI_KEY;

const TTL_HIT = 6 * 3600e3, TTL_MISS = 3600e3;
const cache = new Map(), inflight = new Map(), visits = new Map();
const LIMIT = 15, WINDOW = 10 * 60e3; // maks 15 pencarian baru / 10 menit / IP

async function rapid(host, path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://${host}${path}?${qs}`, { headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": host } });
  if ([401, 403, 429].includes(r.status)) throw new Error("DOWN"); // kuota habis / belum subscribe
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error("FAIL");
  return j;
}

const first = (o) => (o && o.url_list && o.url_list[0]) || "";
const nR = (c) => ({ id: c.id, text: c.text, replies: c.reply_total || 0, by: c.user && c.user.unique_id });
const nS = (c) => ({
  id: c.cid || c.id, text: c.text, replies: c.reply_comment_total || c.reply_comment_count || 0,
  by: c.user && (c.user.unique_id || c.user.nickname),
  prev: (Array.isArray(c.reply_comment) ? c.reply_comment : []).map((x) => ({ text: x && x.text, by: x && x.user && x.user.unique_id })),
});

// Urutan = prioritas. "lean" = jatah kecil, dipakai hemat (1 halaman, sedikit balasan).
const PROVIDERS = [
  {
    name: "tikwm", host: "tiktok-scraper7.p.rapidapi.com", lean: false, down: 0,
    async detail(url) {
      const j = await rapid(this.host, "/", { url, hd: 0 });
      const v = j.data;
      if (!v) { if (j.msg) throw new Error("FAIL"); return null; }
      return { id: v.id, title: v.title || "", cover: v.cover || v.origin_cover || "", play: v.play || v.wmplay || "", author: v.author ? v.author.unique_id : "", comments: v.comment_count || 0, views: v.play_count || 0, likes: v.digg_count || 0 };
    },
    async page(url, id, cursor) {
      const d = (await rapid(this.host, "/comment/list", { url, count: 50, cursor })).data || {};
      return { list: (d.comments || []).map(nR), next: d.hasMore ? d.cursor : null };
    },
    async replies(id, cm) {
      const j = await rapid(this.host, "/comment/reply", { video_id: id, comment_id: cm.id, count: 50, cursor: 0 });
      return ((j.data && j.data.comments) || []).map(nR);
    },
    async bio(author) {
      const j = await rapid(this.host, "/user/info", { unique_id: author });
      return j.data && j.data.user && j.data.user.signature;
    },
  },
  {
    name: "scraptik", host: "scraptik.p.rapidapi.com", lean: true, down: 0,
    async detail(url, id) {
      if (!id) throw new Error("FAIL");
      const j = await rapid(this.host, "/get-post", { aweme_id: id });
      const x = j.aweme_detail || (j.data && (j.data.aweme_detail || j.data)) || null;
      if (!x || (!x.aweme_id && !x.desc)) return null;
      const st = x.statistics || {}, vd = x.video || {};
      return { id: x.aweme_id || id, title: x.desc || "", cover: first(vd.cover) || first(vd.origin_cover), play: first(vd.play_addr), author: (x.author && x.author.unique_id) || "", comments: st.comment_count == null ? 1 : st.comment_count, views: st.play_count || 0, likes: st.digg_count || 0 };
    },
    async page(url, id, cursor) {
      const j = await rapid(this.host, "/list-comments", { aweme_id: id, count: 30, cursor });
      const d = j.comments ? j : j.data || {};
      return { list: (d.comments || []).map(nS), next: d.has_more === 1 || d.has_more === true ? d.cursor : null };
    },
    async replies(id, cm) {
      const j = await rapid(this.host, "/list-comments-replies", { comment_id: cm.id, aweme_id: id, count: 30, cursor: 0 });
      return ((j.comments ? j : j.data || {}).comments || []).map(nS);
    },
    async bio() { return ""; },
  },
];
const up = (p) => Date.now() > p.down;
const mark = (p) => { p.down = Date.now() + 30 * 60e3; }; // 30 menit istirahat kalau kuota habis

async function resolve(u) {
  if (!/\/\/(vt|vm)\.tiktok\.com/i.test(u)) return u;
  try {
    const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
    return r.url.split("?")[0] || u;
  } catch (e) { return u; }
}

const RE_AM = /https?:\/\/alightcreative\.com\/am\/share\/[^\s"'<>]+/gi;
const RE_DRIVE = /https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)[^\s"'<>]+/gi;
const HINT = /link|preset|xml|5mb|minta|mana|pls|please|kak|bang|share|req/i;

function extract(text, source, by, out) {
  if (!text) return;
  const add = (type, m) => {
    const url = m.replace(/[)\].,;!?]+$/, "");
    if (!out.some((o) => o.url === url)) out.push({ type, url, source, by });
  };
  (text.match(RE_AM) || []).forEach((m) => add("5mb", m));
  (text.match(RE_DRIVE) || []).forEach((m) => add("xml", m));
}

async function scan(url, deep) {
  const vid = (url.match(/\/video\/(\d+)/) || [])[1];

  // 1) detail video: coba API berurutan sampai ada yang berhasil
  let pi = -1, video = null;
  for (let i = 0; i < PROVIDERS.length && !video; i++) {
    const p = PROVIDERS[i];
    if (!up(p)) continue;
    try {
      const v = await p.detail(url, vid);
      if (!v) throw new Error("NOTFOUND");
      video = v; pi = i;
    } catch (e) {
      if (e.message === "NOTFOUND") throw e;
      if (e.message === "DOWN") mark(p);
    }
  }
  if (!video) throw new Error("ALLDOWN");

  const results = [];
  const done = () => results.some((r) => r.type === "5mb") && results.some((r) => r.type === "xml");
  extract(video.title, "deskripsi", video.author, results);
  const lean = () => !!(PROVIDERS[pi] && PROVIDERS[pi].lean);

  // 2) komentar & balasan: pakai API yang sama; kalau habis di tengah jalan pindah ke berikutnya
  const page = async (cursor) => {
    for (; pi < PROVIDERS.length; pi++) {
      const p = PROVIDERS[pi];
      if (!up(p)) { cursor = 0; continue; }
      try { return await p.page(url, video.id, cursor); } catch (e) { if (e.message === "DOWN") mark(p); cursor = 0; }
    }
    return { list: [], next: null };
  };
  const repliesOf = async (cm) => {
    for (; pi < PROVIDERS.length; pi++) {
      const p = PROVIDERS[pi];
      if (!up(p)) continue;
      try { return await p.replies(video.id, cm); } catch (e) { if (e.message === "DOWN") mark(p); }
    }
    return [];
  };

  const withReplies = [], tried = new Set();
  const repliesStage = async (n) => {
    const q = withReplies.filter((c) => !tried.has(c.id));
    q.sort((a, b) => (HINT.test(b.text || "") - HINT.test(a.text || "")) || b.replies - a.replies);
    const pick = q.slice(0, n);
    for (let i = 0; i < pick.length && !done(); i += 2) {
      await Promise.all(pick.slice(i, i + 2).map(async (cm) => {
        tried.add(cm.id);
        (await repliesOf(cm)).forEach((rp) => extract(rp.text, "balasan", rp.by, results));
      }));
    }
  };

  let cursor = 0;
  for (let p = 0; p < (lean() ? 1 : deep ? 25 : 2) && !done() && video.comments > 0; p++) {
    const r = await page(cursor);
    if (!r.list.length) break;
    for (const cm of r.list) {
      extract(cm.text, "komentar", cm.by, results);
      (cm.prev || []).forEach((pv) => extract(pv.text, "balasan", pv.by, results));
      if (cm.replies > 0) withReplies.push(cm);
    }
    if (p === 0 && !done()) await repliesStage(lean() ? 2 : 3);
    if (done() || r.next == null) break;
    cursor = r.next;
  }
  if (!done()) await repliesStage(lean() ? 3 : deep ? 10 : 6);

  // 3) bio paling akhir, hanya kalau API utama masih hidup
  if (!done() && video.author) {
    const p = PROVIDERS[0];
    if (up(p) && p.name === "tikwm") {
      try { extract(await p.bio(video.author), "bio", video.author, results); } catch (e) { if (e.message === "DOWN") mark(p); }
    }
  }

  const one = ["5mb", "xml"].map((t) => results.find((r) => r.type === t)).filter(Boolean);
  return { video, results: one, deep: !!deep, deepable: !deep && !one.length && video.comments > 100 };
}

function send(res, data) {
  res.setHeader("Cache-Control", data.results.length ? "public, s-maxage=86400, stale-while-revalidate=86400" : "public, s-maxage=3600");
  res.status(200).json(data);
}

export default async function handler(req, res) {
  const input = (req.query.url || "").trim();
  res.setHeader("Cache-Control", "no-store");
  if (!/tiktok\.com/i.test(input)) return res.status(400).json({ error: "Link TikTok tidak valid." });
  if (!KEY) return res.status(500).json({ error: "RAPIDAPI_KEY belum diisi di Vercel." });

  try {
    const url = await resolve(input);
    const id = (url.match(/\/video\/(\d+)/) || [])[1];
    const key = id || url;
    const deep = req.query.deep === "1";

    const hit = cache.get(key);
    if (hit && hit.exp > Date.now() && (!deep || hit.data.deep || hit.data.results.length)) return send(res, hit.data);

    const ip = ((req.headers["x-forwarded-for"] || "").split(",")[0] || "x").trim();
    const now = Date.now();
    const list = (visits.get(ip) || []).filter((t) => now - t < WINDOW);
    const cost = deep ? 5 : 1;
    if (list.length + cost > LIMIT) return res.status(429).json({ error: "Terlalu sering mencari. Tunggu beberapa menit." });
    for (let i = 0; i < cost; i++) list.push(now);
    visits.set(ip, list);
    if (visits.size > 2000) visits.clear();

    const fk = key + (deep ? ":d" : "");
    let p = inflight.get(fk);
    if (!p) { p = scan(url, deep).finally(() => inflight.delete(fk)); inflight.set(fk, p); }
    const data = await p;

    cache.set(key, { data, exp: now + (data.results.length ? TTL_HIT : TTL_MISS) });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    send(res, data);
  } catch (e) {
    if (e.message === "NOTFOUND") return res.status(404).json({ error: "Video tidak ditemukan atau akun privat." });
    if (e.message === "ALLDOWN") return res.status(429).json({ error: "Kuota API habis atau server sedang ramai. Coba lagi nanti." });
    res.status(500).json({ error: "Gagal mengambil data. Coba lagi." });
  }
                      }
  

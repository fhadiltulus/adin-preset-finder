// Vercel Serverless Function: /api/search?url=<link tiktok>
const HOST = "tiktok-scraper7.p.rapidapi.com";
const KEY = process.env.RAPIDAPI_KEY;

async function call(path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://${HOST}${path}?${qs}`, {
    headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST },
  });
  if (r.status === 429) throw new Error("QUOTA");
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new Error("API key salah atau belum subscribe: " + (j.message || r.status));
  if (j && j.data) return j.data;
  if (j && j.msg && path === "/") throw new Error("API: " + j.msg);
  return null;
}

// ubah link pendek (vt.tiktok.com / vm.tiktok.com) jadi link video lengkap
async function resolve(u) {
  if (!/\/\/(vt|vm)\.tiktok\.com/i.test(u)) return u;
  try {
    const r = await fetch(u, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
    return r.url.split("?")[0] || u;
  } catch (e) { return u; }
}

const RE_AM = /https?:\/\/alightcreative\.com\/am\/share\/[^\s"'<>]+/gi;
const RE_DRIVE = /https?:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)[^\s"'<>]+/gi;

function extract(text, source, by, out) {
  if (!text) return;
  const add = (type, m) => {
    const url = m.replace(/[)\].,;!?]+$/, "");
    if (!out.some((o) => o.url === url)) out.push({ type, url, source, by });
  };
  (text.match(RE_AM) || []).forEach((m) => add("5mb", m));
  (text.match(RE_DRIVE) || []).forEach((m) => add("xml", m));
}

export default async function handler(req, res) {
  const input = (req.query.url || "").trim();
  if (!/tiktok\.com/i.test(input)) return res.status(400).json({ error: "Link TikTok tidak valid." });
  if (!KEY) return res.status(500).json({ error: "RAPIDAPI_KEY belum diisi di Vercel." });

  try {
    const url = await resolve(input);
    const v = await call("/", { url, hd: 0 });
    if (!v) return res.status(404).json({ error: "Video tidak ditemukan atau akun privat." });

    const video = {
      id: v.id,
      title: v.title || "",
      cover: v.cover || v.origin_cover || "",
      play: v.play || v.wmplay || "",
      author: v.author ? v.author.unique_id : "",
      comments: v.comment_count || 0,
      views: v.play_count || 0,
      likes: v.digg_count || 0,
    };
    const results = [];
    const done = () => results.some((r) => r.type === "5mb") && results.some((r) => r.type === "xml");
    extract(video.title, "deskripsi", video.author, results);

    if (video.author && !done()) {
      const u = await call("/user/info", { unique_id: video.author }).catch(() => null);
      extract(u && u.user && u.user.signature, "bio", video.author, results);
    }

    // komentar (maks 3 halaman) + balasan (maks 20 komentar yang punya balasan)
    const withReplies = [];
    let cursor = 0;
    for (let p = 0; p < 3 && !done(); p++) {
      const c = await call("/comment/list", { url, count: 50, cursor }).catch((e) => { if (e.message === "QUOTA") throw e; return null; });
      if (!c || !c.comments) break;
      for (const cm of c.comments) {
        extract(cm.text, "komentar", cm.user && cm.user.unique_id, results);
        if (cm.reply_total > 0) withReplies.push(cm);
      }
      if (done() || !c.hasMore) break;
      cursor = c.cursor;
    }
    const queue = withReplies.slice(0, 20);
    for (let i = 0; i < queue.length && !done(); i += 5) {
      await Promise.all(
        queue.slice(i, i + 5).map(async (cm) => {
          const r = await call("/comment/reply", { video_id: video.id, comment_id: cm.id, count: 50, cursor: 0 }).catch(() => null);
          ((r && r.comments) || []).forEach((rp) => extract(rp.text, "balasan", rp.user && rp.user.unique_id, results));
        })
      );
    }

    // cukup satu link per jenis: 5MB satu, XML satu
    const one = ["5mb", "xml"].map((t) => results.find((r) => r.type === t)).filter(Boolean);

    res.setHeader("Cache-Control", "s-maxage=600");
    res.status(200).json({ video, results: one });
  } catch (e) {
    if (/^API/.test(e.message)) return res.status(502).json({ error: e.message });
    if (e.message === "QUOTA") return res.status(429).json({ error: "Kuota API habis. Coba lagi nanti." });
    res.status(500).json({ error: "Gagal mengambil data. Coba lagi." });
  }
    }
                               

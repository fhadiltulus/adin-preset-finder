// Vercel Serverless Function: /api/download?src=<url video>&name=<nama file>
// Meneruskan video agar browser mau menyimpannya sebagai file (anchor download lintas-domain biasanya diabaikan).
import { Readable } from "node:stream";

const ALLOWED = [
  /(^|\.)tikwm\.com$/,
  /(^|\.)tiktokcdn(-[a-z]+)?\.com$/,
  /(^|\.)tiktokv\.(com|us)$/,
  /(^|\.)ibytedtos\.com$/,
  /(^|\.)byteoversea\.com$/,
  /(^|\.)muscdn\.com$/,
];
const okHost = (h) => ALLOWED.some((re) => re.test(h));

export default async function handler(req, res) {
  let u;
  try { u = new URL(String(req.query.src || "")); } catch { return res.status(400).json({ error: "Link video tidak valid." }); }
  if (u.protocol !== "https:" || !okHost(u.hostname)) return res.status(400).json({ error: "Sumber video tidak diizinkan." });

  const name = String(req.query.name || "video").replace(/[^\w.-]+/g, "_").replace(/\.mp4$/i, "").slice(0, 80) || "video";

  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0", referer: "https://www.tiktok.com/" }, redirect: "follow" });
    if (!r.ok || !r.body) return res.status(502).json({ error: "Gagal mengambil video." });
    if (r.url && !okHost(new URL(r.url).hostname)) return res.status(400).json({ error: "Sumber video tidak diizinkan." });

    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.mp4"`);
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res);
  } catch {
    res.status(500).json({ error: "Gagal mengunduh video." });
  }
    }

import puppeteer from "@cloudflare/puppeteer";

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  EDIT_TOKEN: string; // wrangler secret
}

const MAX_UPLOAD = 10 * 1024 * 1024; // 1ファイル10MB
const MAX_HEIGHT = 10000; // キャプチャ最大高さ(px)
const MAX_PAGES = 30; // 1案件あたりの最大ページ数
const MAX_JSON = 1_500_000; // D1の1行上限(2MB)対策

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const err = (m: string, s = 400) => json({ error: m }, s);
const rid = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

function authed(req: Request, env: Env): boolean {
  const t = req.headers.get("x-edit-token") || "";
  const e = env.EDIT_TOKEN || "";
  if (!e || t.length !== e.length) return false;
  let d = 0;
  for (let i = 0; i < t.length; i++) d |= t.charCodeAt(i) ^ e.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const p = new URL(req.url).pathname;
    const m = req.method;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      let r: RegExpMatchArray | null;
      // --- 認証不要（共有URL閲覧用） ---
      if (m === "GET" && (r = p.match(/^\/api\/share\/([a-f0-9]{32})$/))) return await share(r[1], env);
      if (m === "GET" && (r = p.match(/^\/api\/files\/([a-f0-9]{32})$/))) return await file(r[1], env);
      // --- 以下は編集用トークン必須 ---
      if (!authed(req, env)) return err("unauthorized", 401);
      if (m === "GET" && p === "/api/auth") return new Response(null, { status: 204 });
      if (m === "POST" && p === "/api/capture") return await capture(req, env);
      if (m === "POST" && p === "/api/upload") return await upload(req, env);
      if (p === "/api/projects") {
        if (m === "GET") return await list(env);
        if (m === "POST") return await create(req, env);
      }
      if ((r = p.match(/^\/api\/projects\/([a-f0-9]{32})$/))) {
        if (m === "GET") return await get(r[1], env);
        if (m === "PUT") return await update(r[1], req, env);
        if (m === "DELETE") return await remove(r[1], env);
      }
      return err("not found", 404);
    } catch (e: any) {
      return err(e?.message || "server error", 500);
    }
  },
};

/* ---------- キャプチャ ---------- */
function isPrivateHost(h: string) {
  h = h.toLowerCase();
  return (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) ||
    h === "[::1]" || h.startsWith("[fc") || h.startsWith("[fd") || h.startsWith("[fe80")
  );
}

async function capture(req: Request, env: Env): Promise<Response> {
  const b: any = await req.json().catch(() => ({}));
  let u: URL;
  try { u = new URL(String(b.url)); } catch { return err("URLが正しくありません"); }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return err("このURLは取得できません");

  const sp = b.device === "sp";
  const width = sp ? 375 : 1280;
  const browser = await puppeteer.launch(env.BROWSER as any);
  try {
    const page = await browser.newPage();
    // Basic認証：認証情報は保存せず、このリクエスト内でのみ使用
    if (b.basicAuth?.user) await page.authenticate({ username: String(b.basicAuth.user), password: String(b.basicAuth.pass ?? "") });
    await page.setViewport({ width, height: sp ? 812 : 800, deviceScaleFactor: 1, isMobile: sp, hasTouch: sp });
    if (sp) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");

    const resp = await page.goto(u.toString(), { waitUntil: "load", timeout: 30000 });
    const st = resp?.status() ?? 0;
    if (st === 401) return err("Basic認証に失敗しました。IDとパスワードを確認してください", 422);
    if (st >= 400) return err(`ページを取得できませんでした (HTTP ${st})`, 422);

    const title = (await page.title()) || u.hostname;
    const h = Number(await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || 800;
    const height = Math.max(1, Math.min(h, MAX_HEIGHT));
    const shot = (await page.screenshot({
      type: "jpeg", quality: 85,
      clip: { x: 0, y: 0, width, height },
      captureBeyondViewport: true,
    })) as Uint8Array;

    const key = rid();
    await env.BUCKET.put(key, shot, { httpMetadata: { contentType: "image/jpeg" } });
    return json({ title, imageKey: key, truncated: h > MAX_HEIGHT });
  } finally {
    await browser.close();
  }
}

/* ---------- ファイル ---------- */
async function upload(req: Request, env: Env): Promise<Response> {
  if (Number(req.headers.get("content-length") || 0) > MAX_UPLOAD) return err("ファイルサイズは10MBまでです", 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD) return err("ファイルサイズは10MBまでです", 413);
  const key = rid();
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: req.headers.get("content-type") || "application/octet-stream" } });
  return json({ key });
}

async function file(key: string, env: Env): Promise<Response> {
  const o = await env.BUCKET.get(key);
  if (!o) return err("not found", 404);
  const h = new Headers();
  o.writeHttpMetadata(h);
  h.set("etag", o.httpEtag);
  h.set("cache-control", "public, max-age=31536000, immutable");
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "sandbox");
  const ct = h.get("content-type") || "";
  if (!/^image\/(png|jpeg|gif|webp)$/.test(ct) && ct !== "application/pdf") h.set("content-disposition", "attachment");
  return new Response(o.body, { headers: h });
}

/* ---------- 案件 ---------- */
function keysOf(pages: any[]): string[] {
  const k: string[] = [];
  for (const p of pages) {
    if (p.img) k.push(p.img);
    for (const r of p.regions || []) for (const f of r.files || []) if (f.key) k.push(f.key);
  }
  return k.filter((x) => /^[a-f0-9]{32}$/.test(x));
}

async function parse(req: Request) {
  const text = await req.text();
  if (text.length > MAX_JSON) throw new Error("データが大きすぎます");
  const b = JSON.parse(text);
  if (!b || !Array.isArray(b.pages)) throw new Error("データ形式が正しくありません");
  if (b.pages.length > MAX_PAGES) throw new Error(`1案件のページ数は${MAX_PAGES}までです`);
  return { title: String(b.title || "").slice(0, 200), data: JSON.stringify(b.pages) };
}

async function list(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, share_id AS shareId, title, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC LIMIT 100").all();
  return json(results);
}

async function create(req: Request, env: Env) {
  const { title, data } = await parse(req);
  const id = rid(), shareId = rid(), now = Date.now();
  await env.DB.prepare("INSERT INTO projects (id, share_id, title, data, created_at, updated_at) VALUES (?,?,?,?,?,?)").bind(id, shareId, title, data, now, now).run();
  return json({ id, shareId, updatedAt: now }, 201);
}

async function get(id: string, env: Env) {
  const row: any = await env.DB.prepare("SELECT id, share_id, title, data, updated_at FROM projects WHERE id = ?").bind(id).first();
  if (!row) return err("not found", 404);
  return json({ id: row.id, shareId: row.share_id, title: row.title, pages: JSON.parse(row.data), updatedAt: row.updated_at });
}

async function update(id: string, req: Request, env: Env) {
  const { title, data } = await parse(req);
  const now = Date.now();
  const r = await env.DB.prepare("UPDATE projects SET title = ?, data = ?, updated_at = ? WHERE id = ?").bind(title, data, now, id).run();
  if (!r.meta.changes) return err("not found", 404);
  return json({ ok: true, updatedAt: now });
}

async function remove(id: string, env: Env) {
  const row: any = await env.DB.prepare("SELECT data FROM projects WHERE id = ?").bind(id).first();
  if (!row) return err("not found", 404);
  const keys = keysOf(JSON.parse(row.data));
  if (keys.length) await env.BUCKET.delete(keys);
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function share(shareId: string, env: Env) {
  const row: any = await env.DB.prepare("SELECT title, data FROM projects WHERE share_id = ?").bind(shareId).first();
  if (!row) return err("not found", 404);
  return json({ title: row.title, pages: JSON.parse(row.data) });
}

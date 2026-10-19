// Cloudflare Worker — 로그인 + 화면 + 기사 데이터 제공
// 무료 요금제는 요청당 CPU 10ms라서 수집/묶기는 하지 않고(GitHub Actions가 담당),
// KV에 저장된 결과를 읽어서 보여주기만 합니다.
//
// 바인딩/비밀값
//   NEWS            KV 네임스페이스 (키: snapshot)
//   ASSETS          정적 파일(public/)
//   SESSION_SECRET  쿠키 서명용 긴 무작위 문자열 (비밀값)
//   FAMILY_USERS    계정 JSON  {"아이디":"hs256$..", "관리자":{"h":"hs256$..","admin":true}}  (node users.js export-cf 로 생성, 비밀값)
//   KV 키 audit     접속 기록 (관리자 화면에서 조회)
//   KV 키 accounts  웹에서 추가한 계정 (관리자 화면에서 추가/삭제)

import { fetchTicker } from '../../lib/ticker.js';

const COOKIE = 'nm_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_SEC = 15 * 60;
const enc = new TextEncoder();

// ───── 유틸 ─────
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToStr(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(data));
}
function secretUsers(env) {
  try { return JSON.parse(env.FAMILY_USERS || '{}'); } catch { return {}; }
}
const hashOf = (v) => (v && typeof v === 'object' ? v.h : v);
const adminOf = (v) => !!(v && typeof v === 'object' && v.admin);

// ───── 계정 저장소 ─────
// 고정 계정: 비밀값 FAMILY_USERS (첫 관리자용, 웹에서 지우거나 바꿀 수 없음 → 관리자가 잠길 일이 없음)
// 웹 계정: KV 키 accounts  {"아이디":{"h":"hs256$..","admin":false,"created":1700000000000}}  (관리자 화면에서 추가/삭제)
async function loadUsers(env, fresh = false) {
  let web = {};
  try { web = (await (fresh ? env.NEWS.get('accounts', 'json') : env.NEWS.get('accounts', { type: 'json', cacheTtl: 30 }))) || {}; } catch {}
  const out = {};
  for (const [id, v] of Object.entries(web)) out[id] = { h: v.h, admin: !!v.admin, created: v.created || 0, source: 'web' };
  for (const [id, v] of Object.entries(secretUsers(env))) out[id] = { h: hashOf(v), admin: adminOf(v), created: 0, source: 'secret' };
  return out;
}
async function hashNew(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `hs256$${toHex(salt)}$${toHex(await hmac(salt, pw))}`;
}
function genPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자 제외
  return [...crypto.getRandomValues(new Uint8Array(12))].map((x) => chars[x % chars.length]).join('');
}


// ───── 비밀번호 / 세션 ─────
async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'hs256' || !saltHex || !hashHex) return false;
  return safeEqual(toHex(await hmac(fromHex(saltHex), pw)), hashHex);
}
async function makeToken(env, user) {
  const body = b64url(enc.encode(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS })));
  return `${body}.${b64url(await hmac(enc.encode(env.SESSION_SECRET), body))}`;
}
async function readToken(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = b64url(await hmac(enc.encode(env.SESSION_SECRET), body));
  if (!safeEqual(sig, good)) return null;
  try {
    const { u, exp } = JSON.parse(b64urlToStr(body));
    return u && exp > Date.now() ? u : null;
  } catch { return null; }
}
function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
async function currentUser(request, env) {
  if (!env.SESSION_SECRET) return null;
  const u = await readToken(env, getCookie(request, COOKIE));
  return u && Object.prototype.hasOwnProperty.call(await loadUsers(env), u) ? u : null; // 계정을 지우면 곧(최대 30초) 로그아웃
}
const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ───── 로그인 시도 제한 (KV 사용: 실패 때만 기록) ─────
// KV 장애·무료 쓰기 한도 초과 시에도 로그인 자체는 동작하도록 모두 try/catch 처리
async function lockedFor(env, keys) {
  try {
    for (const k of keys) {
      const f = await env.NEWS.get(k, 'json');
      if (f && f.n >= MAX_FAILS) return true;
    }
  } catch {}
  return false;
}
async function recordFail(env, keys) {
  try {
    for (const k of keys) {
      const f = (await env.NEWS.get(k, 'json')) || { n: 0 };
      await env.NEWS.put(k, JSON.stringify({ n: f.n + 1 }), { expirationTtl: LOCK_SEC });
    }
  } catch {}
}
async function clearFails(env, keys) { try { for (const k of keys) await env.NEWS.delete(k); } catch {} }

// ───── 접속 기록 (KV 키 audit) ─────
// 로그인(login)·로그인 실패(fail)·방문(visit, 같은 사용자는 30분에 한 번만)을 남깁니다. 비밀번호는 기록하지 않습니다.
// 무료 KV 쓰기(하루 1,000회)를 아끼려고 방문은 30분 간격으로만 기록합니다.
const VISIT_GAP_MS = 30 * 60 * 1000;
const MAX_EVENTS = 500;
const MAX_IPS = 20;
function device(ua = '') {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기타';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? '삼성인터넷' : /Whale/.test(ua) ? '웨일' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
async function auditRecord(env, request, type, user, known = false) {
  try {
    const now = Date.now();
    user = String(user || '').slice(0, 40);
    const d = (await env.NEWS.get('audit', 'json')) || { users: {}, events: [] };
    d.users ||= {}; d.events ||= [];
    if (type === 'visit') {
      const u = d.users[user];
      if (u && now - (u.lastSeen || 0) < VISIT_GAP_MS) return;
    }
    const ip = request.headers.get('cf-connecting-ip') || '-';
    const dev = device(request.headers.get('user-agent') || '');
    const cc = (request.cf && request.cf.country) || '';
    d.events.unshift({ t: now, type, user, ip, ua: dev, cc });
    if (d.events.length > MAX_EVENTS) d.events.length = MAX_EVENTS;
    if (type === 'login' || type === 'visit') {
      const u = (d.users[user] ||= { count: 0, first: now, fails: 0, ips: {} });
      u.count++; u.last = now; u.lastSeen = now; u.lastIp = ip; u.lastUa = dev; u.lastCc = cc;
      const e = (u.ips[ip] ||= { n: 0, last: 0 });
      e.n++; e.last = now;
      const keys = Object.keys(u.ips);
      if (keys.length > MAX_IPS) for (const k of keys.sort((a, b) => u.ips[a].last - u.ips[b].last).slice(0, keys.length - MAX_IPS)) delete u.ips[k];
    } else if (type === 'fail' && known) {
      const u = (d.users[user] ||= { count: 0, first: now, fails: 0, ips: {} });
      u.fails++; u.lastFail = now; u.lastFailIp = ip;
    }
    await env.NEWS.put('audit', JSON.stringify(d));
  } catch {}
}

// ───── 응답 도우미 ─────
function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function secure(res) {
  const r = new Response(res.body, res);
  r.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'DENY');
  r.headers.set('Referrer-Policy', 'no-referrer');
  return r;
}
function sameOrigin(request) {
  const o = request.headers.get('origin');
  if (!o) return true;
  try { return new URL(o).host === new URL(request.url).host; } catch { return false; }
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
  if (path === '/healthz') return new Response('ok');

  // ── 로그인 / 로그아웃 ──
  if (path === '/login') {
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return json(403, { error: '허용되지 않은 요청입니다.' });
      if (!env.SESSION_SECRET) return json(500, { error: '서버 설정(SESSION_SECRET)이 없습니다.' });
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 4096) throw new Error('large');
        body = JSON.parse(raw);
      } catch { return json(400, { error: '잘못된 요청입니다.' }); }
      const id = String(body.username || '').trim().toLowerCase().slice(0, 40);
      const pw = String(body.password || '').slice(0, 200);
      const keys = ['f:ip:' + (request.headers.get('cf-connecting-ip') || 'x'), 'f:u:' + id];
      if (await lockedFor(env, keys)) return json(429, { error: '시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.' });
      const all = await loadUsers(env, true);
      const known = Object.prototype.hasOwnProperty.call(all, id);
      const ok = await verifyPassword(pw, known ? hashOf(all[id]) : 'hs256$00$00') && known;
      if (!ok) { await recordFail(env, keys); ctx.waitUntil(auditRecord(env, request, 'fail', id, known)); return json(401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' }); }
      await clearFails(env, keys);
      ctx.waitUntil(auditRecord(env, request, 'login', id));
      return json(200, { ok: true }, { 'set-cookie': sessionCookie(await makeToken(env, id), SESSION_MS / 1000) });
    }
    if (await currentUser(request, env)) return Response.redirect(url.origin + '/', 302);
    const page = await env.ASSETS.fetch(new Request(url.origin + '/login.html'));
    const r = new Response(page.body, page);
    r.headers.set('cache-control', 'no-store');
    return r;
  }
  if (path === '/logout' && request.method === 'POST') {
    if (!sameOrigin(request)) return json(403, { error: '허용되지 않은 요청입니다.' });
    return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  }

  // ── 이하 로그인 필요 ──
  const user = await currentUser(request, env);
  if (!user) {
    if (path.startsWith('/api/')) return json(401, { error: 'login required' });
    return Response.redirect(url.origin + '/login', 302);
  }

  const admin = !!(await loadUsers(env))[user]?.admin;
  if (path === '/api/me') return json(200, { user, admin });

  // ── 내 키워드 (계정별 저장: KV 키 kw:<아이디>) ──
  if (path === '/api/keywords') {
    const key = 'kw:' + user;
    if (request.method === 'GET') return json(200, (await env.NEWS.get(key, 'json')) || { include: [], exclude: [] });
    if (request.method === 'PUT') {
      if (!sameOrigin(request)) return json(403, { error: '허용되지 않은 요청입니다.' });
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 16384) throw new Error('large');
        body = JSON.parse(raw);
      } catch { return json(400, { error: '잘못된 요청입니다.' }); }
      const clean = (a) => {
        const seen = new Set(), out = [];
        for (const v of Array.isArray(a) ? a : []) {
          const k = String(v).trim().slice(0, 40);
          if (k && !seen.has(k.toLowerCase()) && out.length < 30) { seen.add(k.toLowerCase()); out.push(k); }
        }
        return out;
      };
      const val = { include: clean(body.include), exclude: clean(body.exclude) };
      await env.NEWS.put(key, JSON.stringify(val));
      return json(200, val);
    }
    return json(405, { error: 'method not allowed' });
  }

  // ── 시세 자막 (네이버 시세를 1분 캐시로 조회, 실패 시 수집기가 저장해 둔 값 사용) ──
  if (path === '/api/ticker') {
    const cache = caches.default;
    const key = new Request('https://ticker.internal/v1');
    const hit = await cache.match(key);
    if (hit) return json(200, await hit.json());
    const fallback = await env.NEWS.get('ticker', 'json').catch(() => null);
    let data;
    try { data = await fetchTicker((fallback && fallback.items) || []); } catch { data = fallback; }
    if (!data) return json(503, { error: '시세를 가져오지 못했습니다' });
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } })));
    return json(200, data);
  }

  // ── 관리자 전용 ──
  if (path === '/admin' || path === '/admin.html') {
    if (!admin) return Response.redirect(url.origin + '/', 302);
    if (path === '/admin.html') return Response.redirect(url.origin + '/admin', 302);
    const page = await env.ASSETS.fetch(new Request(url.origin + '/admin.html'));
    const r = new Response(page.body, page);
    r.headers.set('cache-control', 'no-store');
    return r;
  }
  if (path === '/api/admin/audit') {
    if (!admin) return json(403, { error: 'forbidden' });
    const d = (await env.NEWS.get('audit', 'json').catch(() => null)) || { users: {}, events: [] };
    const accounts = Object.entries(await loadUsers(env, true)).map(([id, v]) => ({ id, admin: v.admin }));
    return json(200, { now: Date.now(), accounts, users: d.users || {}, events: d.events || [] });
  }
  // ── 계정 관리 (관리자) ──
  if (path === '/api/admin/accounts' || path.startsWith('/api/admin/accounts/')) {
    if (!admin) return json(403, { error: 'forbidden' });
    const all = await loadUsers(env, true);
    const list = () => Object.entries(all)
      .map(([id, v]) => ({ id, admin: v.admin, source: v.source, created: v.created }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (request.method === 'GET') return json(200, { me: user, accounts: list() });
    if (request.method !== 'POST' || !sameOrigin(request)) return json(403, { error: '허용되지 않은 요청입니다.' });
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 4096) throw new Error('large');
      body = JSON.parse(raw);
    } catch { return json(400, { error: '잘못된 요청입니다.' }); }

    const id = String(body.id || '').trim().toLowerCase();
    const sub = path.slice('/api/admin/accounts'.length);
    const web = (await env.NEWS.get('accounts', 'json')) || {};
    const save = () => env.NEWS.put('accounts', JSON.stringify(web));
    const pwOf = () => (body.password ? String(body.password) : genPassword());

    if (sub === '') { // 추가
      if (!/^[a-z0-9._-]{2,30}$/.test(id)) return json(400, { error: '아이디는 영문 소문자·숫자·. _ - 2~30자로 입력해 주세요.' });
      if (all[id]) return json(409, { error: '이미 있는 아이디입니다.' });
      const pw = pwOf();
      if (pw.length < 10 || pw.length > 100) return json(400, { error: '비밀번호는 10자 이상이어야 합니다.' });
      web[id] = { h: await hashNew(pw), admin: !!body.admin, created: Date.now() };
      await save();
      return json(200, { ok: true, id, password: pw });
    }
    const target = all[id];
    if (!target) return json(404, { error: '없는 아이디입니다.' });
    if (target.source !== 'web') return json(400, { error: '고정 계정(처음 만든 관리자)은 웹에서 바꿀 수 없습니다.' });
    if (!web[id]) return json(404, { error: '없는 아이디입니다.' });

    if (sub === '/passwd') {
      const pw = pwOf();
      if (pw.length < 10 || pw.length > 100) return json(400, { error: '비밀번호는 10자 이상이어야 합니다.' });
      web[id].h = await hashNew(pw);
      await save();
      return json(200, { ok: true, id, password: pw });
    }
    if (sub === '/delete') {
      if (id === user) return json(400, { error: '자기 자신은 삭제할 수 없습니다.' });
      delete web[id];
      await save();
      try { await env.NEWS.delete('kw:' + id); } catch {}
      return json(200, { ok: true });
    }
    if (sub === '/admin') {
      if (id === user) return json(400, { error: '자기 자신의 관리자 권한은 바꿀 수 없습니다.' });
      web[id].admin = !!body.admin;
      await save();
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }
  if (path === '/' || path === '/index.html') ctx.waitUntil(auditRecord(env, request, 'visit', user));
  if (path === '/api/news') {
    const body = await env.NEWS.get('snapshot', 'stream'); // 파싱 없이 그대로 전달 (CPU 절약)
    if (!body) return json(503, { error: '아직 수집된 기사가 없습니다. 잠시 후 다시 시도해 주세요.' });
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (path === '/api/refresh' && request.method === 'POST') return json(202, { ok: true }); // 수집은 GitHub Actions가 담당 — 화면은 최신 저장분을 다시 읽음

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try { return secure(await handle(request, env, ctx)); }
    catch (e) { return secure(json(500, { error: '서버 오류' })); }
  },
};

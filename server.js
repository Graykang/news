// 뉴스 모아보기 — 로컬/자체 호스팅용 서버 (로그인 포함)
// 실행: node server.js  →  http://localhost:3100
// 외부 패키지 없이 Node.js(18+) 기본 기능만 사용합니다.
// (Cloudflare에 올리는 방식은 cloudflare/ 폴더와 배포 안내.md 참고)

const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const audit = require('./audit');
const collect = require('./lib/collect');
const ticker = require('./lib/ticker');
let tk = { at: 0, data: null }; // 시세 자막 1분 캐시
const PF = path.join(__dirname, 'profiles.json'); // 계정별 환영 메시지
const readProf = () => { try { return JSON.parse(fs.readFileSync(PF, 'utf8')); } catch { return {}; } };
const writeProf = (o) => { try { fs.writeFileSync(PF, JSON.stringify(o)); } catch {} };
const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); // 줄바꿈·제어문자 제거 후 길이 제한

const { OUTLETS, CATEGORIES, refresh, REFRESH_MS } = collect;

const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ───────────── HTTP 서버 ─────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
let lastManualRefresh = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 검색엔진·캐시·프레임 삽입 차단
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); } // 호스팅 상태 확인용(데이터 없음)

  // ── 로그인 / 로그아웃 (이 두 경로만 로그인 없이 접근 가능) ──
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
      let body;
      try {
        const raw = await readBody(req);
        body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      } catch { return sendJson(res, 400, { error: '잘못된 요청입니다.' }); }
      const r = auth.login(req, body.username, body.password, body.remember !== false);
      const ip = auth.clientIp(req), ua = req.headers['user-agent'] || '';
      if (!r.ok) {
        if (r.status === 401) audit.record('fail', r.id, ip, ua, Object.prototype.hasOwnProperty.call(auth.loadUsers(), r.id));
        return sendJson(res, r.status, { error: r.error });
      }
      audit.record('login', r.user, ip, ua);
      return sendJson(res, 200, { ok: true }, { 'set-cookie': r.cookie });
    }
    if (auth.currentUser(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'login.html')));
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
    return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.logoutCookie(req) });
  }

  // 로그인 화면 배경 사진(이 두 파일만 로그인 전에도 공개, 하루 캐시)
  if (url.pathname === '/img/login-bg.jpg' || url.pathname === '/img/login-bg-m.jpg') {
    return fs.readFile(path.join(PUBLIC_DIR, url.pathname), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
      res.end(data);
    });
  }

  // ── 이하 모두 로그인 필요 (화면 파일과 API 모두) ──
  const user = auth.currentUser(req);
  if (!user) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'login required' });
    res.writeHead(302, { location: '/login' });
    return res.end();
  }

  const admin = auth.isAdmin(user);
  if (url.pathname === '/api/me') { const renew = auth.renewCookie(req); const p = readProf()[user] || {}; return sendJson(res, 200, { user, admin, welcome: p.welcome || '' }, renew ? { 'set-cookie': renew } : {}); }

  // ── 내 키워드 (계정별 저장: keywords.json) ──
  if (url.pathname === '/api/keywords') {
    const KF = path.join(__dirname, 'keywords.json');
    const readKw = () => { try { return JSON.parse(fs.readFileSync(KF, 'utf8')); } catch { return {}; } };
    if (req.method === 'GET') return sendJson(res, 200, readKw()[user] || { include: [], exclude: [] });
    if (req.method === 'PUT') {
      if (!sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
      let body;
      try { body = JSON.parse(await readBody(req, 16384)); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다.' }); }
      const clean = (a) => {
        const seen = new Set(), out = [];
        for (const v of Array.isArray(a) ? a : []) {
          const k = String(v).trim().slice(0, 40);
          if (k && !seen.has(k.toLowerCase()) && out.length < 30) { seen.add(k.toLowerCase()); out.push(k); }
        }
        return out;
      };
      const all = readKw();
      all[user] = { include: clean(body.include), exclude: clean(body.exclude) };
      try { fs.writeFileSync(KF, JSON.stringify(all)); } catch {}
      return sendJson(res, 200, all[user]);
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // ── 시세 자막 (1분 캐시) ──
  if (url.pathname === '/api/ticker') {
    if (Date.now() - tk.at > 60000) {
      try { tk = { at: Date.now(), data: await ticker.fetchTicker((tk.data && tk.data.items) || []) }; } catch { tk.at = Date.now() - 50000; }
    }
    return tk.data ? sendJson(res, 200, tk.data) : sendJson(res, 503, { error: '시세를 가져오지 못했습니다' });
  }

  // ── 관리자 전용 ──
  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    if (!admin) { res.writeHead(302, { location: '/' }); return res.end(); }
    if (url.pathname === '/admin.html') { res.writeHead(302, { location: '/admin' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html')));
  }
  if (url.pathname === '/api/admin/audit') {
    if (!admin) return sendJson(res, 403, { error: 'forbidden' });
    const accounts = Object.entries(auth.loadUsers()).map(([id, v]) => ({ id, admin: !!(v && v.admin) }));
    return sendJson(res, 200, { now: Date.now(), accounts, ...audit.snapshot() });
  }
  // ── 계정 관리 (관리자) ──
  if (url.pathname === '/api/admin/accounts' || url.pathname.startsWith('/api/admin/accounts/')) {
    if (!admin) return sendJson(res, 403, { error: 'forbidden' });
    let fixed = [];
    try { fixed = Object.keys(JSON.parse(process.env.FAMILY_USERS || '{}')); } catch {}
    const list = () => Object.entries(auth.loadUsers())
      .map(([id, v]) => ({ id, admin: !!(v && v.admin), source: fixed.includes(id) ? 'secret' : 'web', created: (v && v.created) || 0, welcome: (readProf()[id] || {}).welcome || '' }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (req.method === 'GET') return sendJson(res, 200, { me: user, accounts: list() });
    if (req.method !== 'POST' || !sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: '잘못된 요청입니다.' }); }

    const id = String(body.id || '').trim().toLowerCase();
    const sub = url.pathname.slice('/api/admin/accounts'.length);
    const file = auth.fileUsers();
    const isAdm = (v) => !!(v && typeof v === 'object' && v.admin);
    const genPw = () => { const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(require('crypto').randomBytes(12), (b) => c[b % c.length]).join(''); };
    const pwOf = () => (body.password ? String(body.password) : genPw());
    const bad = (pw) => pw.length < 10 || pw.length > 100;

    if (sub === '') {
      if (!/^[a-z0-9._-]{2,30}$/.test(id)) return sendJson(res, 400, { error: '아이디는 영문 소문자·숫자·. _ - 2~30자로 입력해 주세요.' });
      if (auth.loadUsers()[id]) return sendJson(res, 409, { error: '이미 있는 아이디입니다.' });
      const pw = pwOf();
      if (bad(pw)) return sendJson(res, 400, { error: '비밀번호는 10자 이상이어야 합니다.' });
      file[id] = { ...auth.makeRecord(pw, !!body.admin), created: Date.now() };
      auth.saveUsers(file);
      return sendJson(res, 200, { ok: true, id, password: pw });
    }
    if (!auth.loadUsers()[id]) return sendJson(res, 404, { error: '없는 아이디입니다.' });
    if (sub === '/welcome') { // 환영 메시지는 고정 계정을 포함한 모든 계정에 설정 가능
      const welcome = cleanText(body.welcome, 100);
      const all = readProf(); const p = all[id] || {};
      if (welcome) p.welcome = welcome; else delete p.welcome;
      all[id] = p; writeProf(all);
      return sendJson(res, 200, { ok: true, welcome });
    }
    if (fixed.includes(id) || !file[id]) return sendJson(res, 400, { error: '고정 계정은 웹에서 바꿀 수 없습니다.' });

    if (sub === '/passwd') {
      const pw = pwOf();
      if (bad(pw)) return sendJson(res, 400, { error: '비밀번호는 10자 이상이어야 합니다.' });
      file[id] = { ...auth.makeRecord(pw, isAdm(file[id])), created: file[id].created || Date.now() };
      auth.saveUsers(file);
      return sendJson(res, 200, { ok: true, id, password: pw });
    }
    if (sub === '/delete') {
      if (id === user) return sendJson(res, 400, { error: '자기 자신은 삭제할 수 없습니다.' });
      delete file[id];
      auth.saveUsers(file);
      { const pf = readProf(); delete pf[id]; writeProf(pf); }
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/admin') {
      if (id === user) return sendJson(res, 400, { error: '자기 자신의 관리자 권한은 바꿀 수 없습니다.' });
      if (typeof file[id] !== 'object') return sendJson(res, 400, { error: '이전 형식의 계정입니다. 비밀번호를 다시 설정해 주세요.' });
      if (body.admin) file[id].admin = true; else delete file[id].admin;
      auth.saveUsers(file);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  if (url.pathname === '/' || url.pathname === '/index.html') audit.record('visit', user, auth.clientIp(req), req.headers['user-agent'] || '');

  if (url.pathname === '/api/news/version') return sendJson(res, 200, { updatedAt: collect.getState().updatedAt }); // 가벼운 버전 확인
  if (url.pathname === '/api/news') {
    const state = collect.getState();
    return sendJson(res, 200, {
      updatedAt: state.updatedAt,
      loading: state.loading,
      outlets: OUTLETS,
      categories: CATEGORIES,
      feedStatus: state.feedStatus,
      clusters: state.clusters,
    });
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '허용되지 않은 요청입니다.' });
    if (Date.now() - lastManualRefresh > 60000) { lastManualRefresh = Date.now(); refresh(); } // 매체 서버 보호: 1분에 한 번만
    return sendJson(res, 202, { ok: true });
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  📰 뉴스 모아보기 실행 중 →  http://localhost:${PORT}\n  (종료: Ctrl+C)\n`);
  if (!Object.keys(auth.loadUsers()).length) console.log('  ⚠ 계정이 없습니다. 먼저 실행하세요:  node users.js add 아이디');
  refresh();
  setInterval(refresh, REFRESH_MS);
});

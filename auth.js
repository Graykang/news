// 로그인/세션 처리 — 외부 패키지 없이 Node.js 내장 crypto만 사용합니다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const SECRET_FILE = path.join(__dirname, '.secret');
const COOKIE = 'nm_session';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 로그인 30일 유지

// ───── 비밀번호 해시 (scrypt) ─────
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
// Cloudflare Worker용 해시: Worker는 CPU 시간이 매우 짧아 scrypt를 못 쓰므로 HMAC-SHA256을 씁니다.
// (비밀번호는 users.js가 만드는 긴 무작위 값이므로 안전하고, 해시는 Worker 비밀값에만 보관됩니다.)
function hashPasswordFast(pw) {
  const salt = crypto.randomBytes(16);
  return `hs256$${salt.toString('hex')}$${crypto.createHmac('sha256', salt).update(pw).digest('hex')}`;
}
// 한 계정 = { s: scrypt(로컬 서버용), h: hs256(Cloudflare용) }
function makeRecord(pw, admin) { return { s: hashPassword(pw), h: hashPasswordFast(pw), ...(admin ? { admin: true } : {}) }; }

function verifyPassword(pw, stored) {
  if (stored && typeof stored === 'object') stored = stored.s;
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY = hashPassword('dummy-password-for-timing'); // 없는 아이디도 같은 시간이 걸리게

// ───── 계정 저장소 ─────
// users.json: { "아이디": "scrypt$..." }
// 무료 호스팅처럼 파일이 사라지는 환경에서는 같은 JSON을 환경변수 FAMILY_USERS에 넣으면 됩니다.
function loadUsers() {
  let users = {};
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
  if (process.env.FAMILY_USERS) {
    try { users = { ...users, ...JSON.parse(process.env.FAMILY_USERS) }; } catch { console.error('FAMILY_USERS 형식이 올바르지 않습니다.'); }
  }
  return users;
}
function fileUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ───── 세션 쿠키 (HMAC 서명) ─────
function getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, s); } catch {}
  return s;
}
const SECRET = getSecret();
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function makeToken(user) {
  const body = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!u || exp < Date.now()) return null;
    return u;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const u = readToken(parseCookies(req)[COOKIE]);
  return u && loadUsers()[u] ? u : null; // 계정을 삭제하면 바로 로그아웃 처리
}
function isAdmin(user) { const r = loadUsers()[user]; return !!(r && typeof r === 'object' && r.admin); }
function isHttps(req) {
  return !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
}

// ───── 로그인 시도 제한 (무차별 대입 방지) ─────
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // key -> { n, until, last }
function clientIp(req) {
  if (process.env.TRUST_PROXY) { // 호스팅 프록시 뒤: 프록시가 덧붙인 가장 오른쪽 값을 사용
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || '';
}
function lockedFor(keys) {
  const now = Date.now();
  let wait = 0;
  for (const k of keys) { const f = fails.get(k); if (f && f.until > now) wait = Math.max(wait, f.until - now); }
  return wait;
}
function recordFail(keys) {
  const now = Date.now();
  for (const k of keys) {
    const f = fails.get(k) || { n: 0, until: 0, last: 0 };
    if (now - f.last > LOCK_MS) f.n = 0;
    f.n++; f.last = now;
    if (f.n >= MAX_FAILS) { f.until = now + LOCK_MS; f.n = 0; }
    fails.set(k, f);
  }
}
function clearFails(keys) { keys.forEach(k => fails.delete(k)); }
setInterval(() => { const now = Date.now(); for (const [k, f] of fails) if (now - f.last > LOCK_MS && f.until < now) fails.delete(k); }, 3600e3).unref();

function login(req, username, password) {
  const id = String(username || '').trim().toLowerCase().slice(0, 40);
  const keys = ['ip:' + clientIp(req), 'u:' + id];
  const wait = lockedFor(keys);
  if (wait) return { ok: false, id, status: 429, error: `시도가 너무 많습니다. ${Math.ceil(wait / 60000)}분 뒤에 다시 시도해 주세요.` };
  const users = loadUsers();
  const stored = Object.prototype.hasOwnProperty.call(users, id) ? users[id] : DUMMY;
  const ok = verifyPassword(String(password || '').slice(0, 200), stored) && stored !== DUMMY;
  if (!ok) { recordFail(keys); return { ok: false, id, status: 401, error: '아이디 또는 비밀번호가 올바르지 않습니다.' }; }
  clearFails(keys);
  return { ok: true, user: id, cookie: sessionCookie(req, makeToken(id), SESSION_MS / 1000) };
}
function logoutCookie(req) { return sessionCookie(req, '', 0); }

module.exports = { hashPassword, makeRecord, isAdmin, clientIp, fileUsers, loadUsers, saveUsers, currentUser, login, logoutCookie };

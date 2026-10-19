// 접속 기록 (로컬/자체 호스팅 서버용) — audit.json 파일에 저장합니다.
// Cloudflare Worker는 같은 형식으로 KV에 저장합니다 (cloudflare/src/worker.js).
//
// 기록하는 것: 로그인 성공(login) · 로그인 실패(fail) · 방문(visit, 같은 사용자는 30분에 한 번만)
// 기록하지 않는 것: 비밀번호, 읽은 기사 내용
// 접속 횟수 = 로그인 + 30분 이상 간격의 방문 횟수

const fs = require('fs');
const path = require('path');

const FILE = process.env.AUDIT_FILE || path.join(__dirname, 'audit.json');
const VISIT_GAP_MS = 30 * 60 * 1000;
const MAX_EVENTS = 500;
const MAX_IPS = 20;

let db = null;
function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { users: {}, events: [] }; }
  db.users ||= {}; db.events ||= [];
  return db;
}
function save() { try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch {} }

function device(ua = '') {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기타';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? '삼성인터넷' : /Whale/.test(ua) ? '웨일' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

// type: 'login' | 'visit' | 'fail'   user: 아이디(실패 시 입력한 아이디)   known: 실패한 아이디가 실제 계정인지
// IPv6는 앞 4덩어리(/64, 같은 가정·같은 망)가 같으면 같은 곳으로 보고 하나로 묶음. IPv4는 그대로.
function ipKey(ip) {
  if (!ip || !ip.includes(':') || ip.includes('.')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : (tail ? tail.split(':') : []);
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '::/64';
}

function record(type, user, ip, ua, known = false) {
  const d = load();
  const now = Date.now();
  user = String(user || '').slice(0, 40);
  const dev = device(ua);
  if (type === 'visit') {
    const u = d.users[user];
    if (u && now - (u.lastSeen || 0) < VISIT_GAP_MS) return; // 30분 안의 재방문은 기록하지 않음
  }
  d.events.unshift({ t: now, type, user, ip, ua: dev });
  if (d.events.length > MAX_EVENTS) d.events.length = MAX_EVENTS;

  if (type === 'login' || type === 'visit') {
    const u = (d.users[user] ||= { count: 0, first: now, fails: 0, ips: {} });
    u.count++; u.last = now; u.lastSeen = now; u.lastIp = ip; u.lastUa = dev;
    // 예전 기록(전체 주소 단위)도 같은 기준으로 합쳐서 정리
    const merged = {};
    for (const [k, v] of Object.entries(u.ips)) {
      const nk = ipKey(k);
      const m = (merged[nk] ||= { n: 0, last: 0, isp: '', city: '' });
      m.n += v.n || 0; m.last = Math.max(m.last, v.last || 0);
      m.isp = m.isp || v.isp || ''; m.city = m.city || v.city || '';
    }
    u.ips = merged;
    const e = (u.ips[ipKey(ip)] ||= { n: 0, last: 0, isp: '', city: '' });
    e.n++; e.last = now;
    const keys = Object.keys(u.ips);
    if (keys.length > MAX_IPS) for (const k of keys.sort((a, b) => u.ips[a].last - u.ips[b].last).slice(0, keys.length - MAX_IPS)) delete u.ips[k];
  } else if (type === 'fail' && known) {
    const u = (d.users[user] ||= { count: 0, first: now, fails: 0, ips: {} });
    u.fails++; u.lastFail = now; u.lastFailIp = ip;
  }
  save();
}

function snapshot() { const d = load(); return { users: d.users, events: d.events }; }

module.exports = { record, snapshot };

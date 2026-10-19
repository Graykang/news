#!/usr/bin/env node
// 가족 계정 관리 (가입 기능은 없고, 여기서 발급한 계정만 로그인할 수 있습니다)
//
//   node users.js add 아이디 [비밀번호] [--admin]   계정을 만듭니다 (비밀번호 생략 시 자동 생성, --admin 은 관리자)
//   node users.js passwd 아이디 [새 비밀번호]        비밀번호를 바꿉니다
//   node users.js admin 아이디 [off]                 관리자 권한을 주거나(기본) 뺍니다(off)
//   node users.js remove 아이디                      계정을 삭제합니다
//   node users.js list                               계정 목록
//   node users.js export                             자체 서버 호스팅용 환경변수(FAMILY_USERS) 값을 출력합니다
//   node users.js export-cf                          Cloudflare Worker 비밀값(FAMILY_USERS) 값을 출력합니다

const crypto = require('crypto');
const { makeRecord, saveUsers } = require('./auth');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'users.json');
function fileUsers() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }

const args = process.argv.slice(2);
const wantAdmin = args.includes('--admin');
const [cmd, rawId, pwArg] = args.filter((a) => a !== '--admin');
const id = (rawId || '').trim().toLowerCase();
const users = fileUsers(); // 파일 기준으로만 편집(환경변수 계정은 건드리지 않음)

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(l,1,O,0) 제외
  return Array.from(crypto.randomBytes(12), b => chars[b % chars.length]).join('');
}
function fail(msg) { console.error(msg); process.exit(1); }
function needId() {
  if (!/^[a-z0-9._-]{2,30}$/.test(id)) fail('아이디는 영문 소문자·숫자·. _ - 2~30자로 입력해 주세요.');
}
function needPw(pw) { if (pw.length < 10) fail('비밀번호는 10자 이상이어야 합니다.'); }
const isAdmin = (v) => !!(v && typeof v === 'object' && v.admin);

switch (cmd) {
  case 'add': {
    needId();
    if (users[id]) fail(`이미 있는 아이디입니다: ${id}  (비밀번호 변경은 passwd)`);
    const pw = pwArg || randomPassword();
    needPw(pw);
    users[id] = makeRecord(pw, wantAdmin);
    saveUsers(users);
    console.log(`계정을 만들었습니다.${wantAdmin ? ' (관리자)' : ''}\n  아이디: ${id}\n  비밀번호: ${pw}\n(비밀번호는 저장되지 않고 암호화된 값만 users.json에 남습니다. 지금 가족에게 전달해 주세요.)`);
    break;
  }
  case 'passwd': {
    needId();
    if (!users[id]) fail('없는 아이디입니다.');
    const pw = pwArg || randomPassword();
    needPw(pw);
    users[id] = makeRecord(pw, isAdmin(users[id]));
    saveUsers(users);
    console.log(`비밀번호를 바꿨습니다.\n  아이디: ${id}\n  새 비밀번호: ${pw}`);
    break;
  }
  case 'admin': {
    needId();
    if (!users[id]) fail('없는 아이디입니다.');
    if (typeof users[id] !== 'object') fail('이전 형식의 계정입니다. passwd 로 비밀번호를 다시 설정한 뒤 시도해 주세요.');
    const off = pwArg === 'off';
    if (off) delete users[id].admin; else users[id].admin = true;
    saveUsers(users);
    console.log(`${id}: 관리자 ${off ? '해제' : '지정'}했습니다.`);
    break;
  }
  case 'remove': {
    needId();
    if (!users[id]) fail('없는 아이디입니다.');
    delete users[id];
    saveUsers(users);
    console.log(`삭제했습니다: ${id}`);
    break;
  }
  case 'list': {
    const names = Object.keys(users);
    console.log(names.length ? names.map(n => '  ' + n + (isAdmin(users[n]) ? '  (관리자)' : '')).join('\n') : '(계정이 없습니다. node users.js add 아이디 --admin)');
    break;
  }
  case 'export': {
    console.log('아래 한 줄을 호스팅 서비스의 환경변수 FAMILY_USERS 값으로 붙여넣으세요:\n');
    console.log(JSON.stringify(users));
    break;
  }
  case 'export-cf': {
    const cf = {};
    for (const [k, v] of Object.entries(users)) if (v && v.h) cf[k] = v.admin ? { h: v.h, admin: true } : v.h;
    console.log('아래 한 줄을 Cloudflare Worker 비밀값 FAMILY_USERS로 등록하세요 (배포 안내.md 참고):\n');
    console.log(JSON.stringify(cf));
    break;
  }
  default:
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

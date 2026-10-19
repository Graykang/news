// 공용 수집 모듈: RSS 수집 → 파싱 → 중복 묶기 → 분류
// 로컬 서버(server.js)와 클라우드 게시(publish.js)가 함께 사용합니다.
const fs = require('fs');
const path = require('path');

const REFRESH_MS = 20 * 60 * 1000; // 20분마다 새로 수집(매체 서버 부담 최소화)
const MAX_AGE_MS = 48 * 3600 * 1000; // 48시간 이내 기사만

const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, '..', 'cache.json');

// 피드별 마지막 정상 수집분: 매체가 일시적으로 빈 응답/오류를 줄 때 화면이 비지 않도록 유지
const lastGood = new Map(); // url -> { at, items }
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [u, v] of Object.entries(saved)) lastGood.set(u, v);
} catch {}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(lastGood))); } catch {}
}

// ───────────── 매체 & 피드 ─────────────
// rank: 클러스터(비슷한 기사) 대표를 고를 때의 우선순위 (낮을수록 우선)
const OUTLETS = {
  yna:    { name: '연합뉴스',   rank: 1, color: '#1d4ed8' },
  chosun: { name: '조선일보',   rank: 2, color: '#64748b' },
  donga:  { name: '동아일보',   rank: 3, color: '#b91c1c' },
  hani:   { name: '한겨레',     rank: 4, color: '#15803d' },
  khan:   { name: '경향신문',   rank: 5, color: '#0369a1' },
  mk:     { name: '매일경제',   rank: 6, color: '#be123c' },
  hk:     { name: '한국경제',   rank: 7, color: '#7c3aed' },
  sbs:    { name: 'SBS',        rank: 8, color: '#ea580c' },
  segye:  { name: '세계일보',   rank: 9, color: '#0d9488' },
  mt:     { name: '머니투데이', rank: 10, color: '#a16207' },
};

// cat: economy | politics | society | world | opinion
const FEEDS = [
  // 경제
  ['yna', 'economy', 'https://www.yna.co.kr/rss/economy.xml'],
  ['chosun', 'economy', 'https://www.chosun.com/arc/outboundfeeds/rss/category/economy/?outputType=xml'],
  ['donga', 'economy', 'https://rss.donga.com/economy.xml'],
  ['hani', 'economy', 'https://www.hani.co.kr/rss/economy/'],
  ['khan', 'economy', 'https://www.khan.co.kr/rss/rssdata/economy_news.xml'],
  ['mk', 'economy', 'https://www.mk.co.kr/rss/30100041/'],
  ['hk', 'economy', 'https://www.hankyung.com/feed/economy'],
  ['sbs', 'economy', 'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=02&plink=RSSREADER'],
  ['segye', 'economy', 'https://www.segye.com/Articles/RSSList/segye_economy.xml'],
  ['mt', 'economy', 'https://rss.mt.co.kr/mt_news.xml'],
  // 정치
  ['yna', 'politics', 'https://www.yna.co.kr/rss/politics.xml'],
  ['chosun', 'politics', 'https://www.chosun.com/arc/outboundfeeds/rss/category/politics/?outputType=xml'],
  ['donga', 'politics', 'https://rss.donga.com/politics.xml'],
  ['hani', 'politics', 'https://www.hani.co.kr/rss/politics/'],
  ['khan', 'politics', 'https://www.khan.co.kr/rss/rssdata/politic_news.xml'],
  ['mk', 'politics', 'https://www.mk.co.kr/rss/30200030/'],
  ['hk', 'politics', 'https://www.hankyung.com/feed/politics'],
  ['sbs', 'politics', 'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=01&plink=RSSREADER'],
  // 사회
  ['yna', 'society', 'https://www.yna.co.kr/rss/society.xml'],
  ['chosun', 'society', 'https://www.chosun.com/arc/outboundfeeds/rss/category/national/?outputType=xml'],
  ['donga', 'society', 'https://rss.donga.com/national.xml'],
  ['hani', 'society', 'https://www.hani.co.kr/rss/society/'],
  ['khan', 'society', 'https://www.khan.co.kr/rss/rssdata/society_news.xml'],
  ['mk', 'society', 'https://www.mk.co.kr/rss/50400012/'],
  ['hk', 'society', 'https://www.hankyung.com/feed/society'],
  ['sbs', 'society', 'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=03&plink=RSSREADER'],
  // 국제
  ['yna', 'world', 'https://www.yna.co.kr/rss/international.xml'],
  ['chosun', 'world', 'https://www.chosun.com/arc/outboundfeeds/rss/category/international/?outputType=xml'],
  ['donga', 'world', 'https://rss.donga.com/international.xml'],
  ['hani', 'world', 'https://www.hani.co.kr/rss/international/'],
  ['khan', 'world', 'https://www.khan.co.kr/rss/rssdata/kh_world.xml'],
  ['mk', 'world', 'https://www.mk.co.kr/rss/30300018/'],
  ['hk', 'world', 'https://www.hankyung.com/feed/international'],
  ['sbs', 'world', 'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=07&plink=RSSREADER'],
  // 스포츠
  ['yna', 'sports', 'https://www.yna.co.kr/rss/sports.xml'],
  ['chosun', 'sports', 'https://www.chosun.com/arc/outboundfeeds/rss/category/sports/?outputType=xml'],
  ['donga', 'sports', 'https://rss.donga.com/sports.xml'],
  ['hani', 'sports', 'https://www.hani.co.kr/rss/sports/'],
  ['khan', 'sports', 'https://www.khan.co.kr/rss/rssdata/kh_sports.xml'],
  ['mk', 'sports', 'https://www.mk.co.kr/rss/71000001/'],
  ['hk', 'sports', 'https://www.hankyung.com/feed/sports'],
  ['sbs', 'sports', 'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=09&plink=RSSREADER'],
  ['segye', 'sports', 'https://www.segye.com/Articles/RSSList/segye_sports.xml'],
  // 사설·칼럼
  ['chosun', 'opinion', 'https://www.chosun.com/arc/outboundfeeds/rss/category/opinion/?outputType=xml'],
  ['donga', 'opinion', 'https://rss.donga.com/editorials.xml'],
  ['hani', 'opinion', 'https://www.hani.co.kr/rss/opinion/'],
  ['khan', 'opinion', 'https://www.khan.co.kr/rss/rssdata/opinion_news.xml'],
  ['hk', 'opinion', 'https://www.hankyung.com/feed/opinion'],
];

const CATEGORIES = [
  { id: 'economy', name: '경제' },
  { id: 'politics', name: '정치' },
  { id: 'society', name: '사회' },
  { id: 'world', name: '국제' },
  { id: 'sports', name: '스포츠' },
  { id: 'opinion', name: '사설·칼럼' },
];

// ───────────── XML 파싱 ─────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function unwrap(s) {
  if (s == null) return '';
  s = s.trim();
  const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : decodeEntities(s);
}
function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? unwrap(m[1]) : '';
}
function attr(block, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*?\\s${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}
function stripHtml(html) {
  return decodeEntities(
    html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
  ).replace(/[ㅤ​ ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function absUrl(u, base) {
  if (!u) return '';
  try { return new URL(u.startsWith('//') ? 'https:' + u : u, base).href; } catch { return ''; }
}
function firstImg(html) {
  const m = html.match(/<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)/i);
  return m ? decodeEntities(m[1]) : '';
}
function parseDate(s) {
  if (!s) return NaN;
  s = s.trim().replace(/^(\w{3}),(\d)/, '$1, $2'); // "Mon,19 Oct" 보정
  let t = Date.parse(s);
  if (isNaN(t)) t = Date.parse(s.replace(/\./g, '-'));
  return t;
}
function cleanAuthor(a) {
  a = stripHtml(a || '');
  const m = a.match(/\(([^)]*기자[^)]*)\)/); // "yj@sbs.co.kr (홍영재 기자)"
  if (m) a = m[1];
  a = a.replace(/\S+@\S+/g, '').replace(/^\s*[,·]\s*/, '').trim();
  if (!a || a.length > 40) return '';
  return a;
}

async function decodeBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = (head.match(/encoding=["']([^"']+)["']/i) || [])[1] || 'utf-8';
  try { return new TextDecoder(enc.toLowerCase().replace('ks_c_5601-1987', 'euc-kr')).decode(buf); }
  catch { return buf.toString('utf8'); }
}

function parseFeed(xml, outletKey, cat, feedUrl) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    let title = stripHtml(tag(b, 'title'));
    let link = tag(b, 'link').trim() || tag(b, 'guid').trim();
    if (!title || !/^https?:/i.test(link)) continue;
    link = link.replace(/[?&]utm_[^&]*(&utm_[^&]*)*$/i, '').replace(/&amp;/g, '&');

    const descRaw = tag(b, 'description');
    const encoded = tag(b, 'content:encoded');
    let summary = stripHtml(descRaw);
    if (summary.length < 30 && encoded) summary = stripHtml(encoded);
    if (summary === title) summary = '';
    summary = summary.replace(/^\(?[가-힣·\s]{2,12}=연합뉴스\)?\s*[가-힣\s]{0,8}기자\s*=\s*/, ''); // 연합 기사 머리말 제거
    if (summary.length > 220) summary = summary.slice(0, 220).replace(/\s+\S*$/, '') + '…';
    if (summary.length < 12) summary = '';

    let image = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') || '';
    if (!image) { const e = b.match(/<enclosure\b[^>]*>/i); if (e && /image/i.test(e[0])) image = attr(e[0], 'enclosure', 'url'); }
    if (!image) image = firstImg(descRaw) || firstImg(encoded);
    image = absUrl(image, link);
    // 매체가 쓰는 작은 썸네일 대신 가능한 한 큰 버전을 요청
    image = image.replace(/(hani\.co\.kr\/flexible\/normal\/)\d+\/\d+/, '$1640/400');
    image = image.replace(/\/resizer\/v2\/([^?]+)\?([^"]*)/, (m, f, q) => `/resizer/v2/${f}?${q.replace(/width=\d+/, 'width=800').replace(/&?height=\d+/, '')}`);
    if (/blank|spacer|1x1|\.gif(\?|$)/i.test(image)) image = '';

    const video = /video|영상|동영상|\[영상\]|\[포토\]|\[사진\]/i.test(title) ? /영상/.test(title) : false;

    const author = cleanAuthor(tag(b, 'dc:creator') || tag(b, 'author'));
    let t = parseDate(tag(b, 'pubDate') || tag(b, 'dc:date'));
    if (isNaN(t)) {
      // 날짜 없는 피드(한겨레): 이미지 파일명에 업로드 시각(유닉스 초)이 들어 있음
      const m = image.match(/_(1[6-9]\d{8})\d*_/);
      if (m) t = Number(m[1]) * 1000;
    }
    let itemCat = cat;
    if (outletKey === 'mt') {
      // 머니투데이는 전체 뉴스 피드 하나뿐이라 URL 경로로 분류하고, 스포츠·연예는 제외
      const sec = new URL(link).pathname.split('/')[1];
      if (/^(entertainment|star|life|photo|video)$/.test(sec)) continue;
      itemCat = { politics: 'politics', society: 'society', world: 'world', sports: 'sports' }[sec] || 'economy';
    }
    items.push({ outlet: outletKey, cat: itemCat, title, link, summary, image, author, video, ts: t });
  }
  return items;
}

// ───────────── 수집 ─────────────
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 NewsDigest', // 일부 매체는 브라우저형 UA를 막고 단순 UA만 허용
];
async function fetchFeed([outlet, cat, url]) {
  try {
    let res;
    for (const ua of UAS) {
      res = await fetch(url, {
        headers: { 'user-agent': ua, accept: 'application/rss+xml, application/xml, text/xml, */*' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status !== 403) break;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await decodeBody(res);
    const items = parseFeed(xml, outlet, cat, url);
    if (!items.length) throw new Error('기사 없음');
    lastGood.set(url, { at: Date.now(), items });
    return { ok: true, outlet, cat, items };
  } catch (e) {
    const g = lastGood.get(url);
    const items = g && Date.now() - g.at < 12 * 3600 * 1000 ? g.items : [];
    return { ok: false, outlet, cat, url, error: e.cause?.code || e.message, items, stale: items.length > 0 };
  }
}

// ───────────── 중복 제거(클러스터링) ─────────────
const STOP = new Set(['단독', '속보', '종합', '사설', '칼럼', '영상', '포토', '사진', '오늘', '내일', '올해', '이번']);
function normalize(title) {
  return title
    .replace(/\[[^\]]{0,12}\]|\([^)]{0,12}\)|<[^>]{0,12}>/g, ' ')
    .replace(/[“”"'‘’…·,.:;!?~\-–—|/]/g, ' ')
    .toLowerCase();
}
function tokens(title) {
  const words = normalize(title).split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  const set = new Set();
  for (const w of words) {
    // 어미 변화에 둔감하도록 앞 3글자(조사 제거) + 2-gram 사용
    set.add(w.length > 3 ? w.slice(0, 3) : w);
    for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
  }
  return set;
}
function similarity(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const min = Math.min(a.size, b.size);
  return min ? inter / (a.size + b.size - inter) * 0.5 + inter / min * 0.5 : 0;
}

function cluster(articles) {
  // 최신순 정렬 후, 가까운 시간대의 비슷한 제목을 하나로 묶음
  const sorted = [...articles].sort((a, b) => b.ts - a.ts);
  const clusters = [];
  for (const a of sorted) {
    a._tok = tokens(a.title);
    let best = null, bestSim = 0, isUpdate = false;
    for (const c of clusters) {
      if ((c.cat === 'opinion') !== (a.cat === 'opinion')) continue; // 사설은 사설끼리
      if (Math.abs(c.lead.ts - a.ts) > 12 * 3600 * 1000) continue;
      const same = c.members.find(m => m.outlet === a.outlet);
      if (same) {
        // 같은 매체의 거의 같은 제목(예: '(종합)' 재송고)은 갱신본으로 보고 건너뜀, 다른 각도의 기사면 별개
        if (similarity(same._tok, a._tok) >= 0.6) { isUpdate = true; break; }
        continue;
      }
      const sim = Math.max(...c.members.map(m => similarity(m._tok, a._tok)));
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (isUpdate) continue;
    if (best && bestSim >= (best.cat === a.cat ? 0.42 : 0.5)) best.members.push(a);
    else clusters.push({ cat: a.cat, lead: a, members: [a] });
  }
  return clusters.map(c => {
    // 대표 기사: 사진이 있고 대형 매체인 기사를 우선
    const members = c.members.sort((x, y) =>
      (OUTLETS[x.outlet].rank + (x.image ? 0 : 3)) - (OUTLETS[y.outlet].rank + (y.image ? 0 : 3)));
    const main = members[0];
    const image = main.image || (members.find(m => m.image) || {}).image || '';
    const summary = main.summary || (members.find(m => m.summary) || {}).summary || '';
    const ts = Math.max(...members.map(m => m.ts));
    const cats = [...new Set(members.flatMap(m => [...m.cats]))];
    const votes = {};
    members.forEach(m => m.cats.forEach(k => { votes[k] = (votes[k] || 0) + 1; }));
    const cat = cats.sort((a, b) => votes[b] - votes[a])[0];
    return { main, members, image, summary, ts, cat, cats };
  });
}

// ───────────── 제도·정책 변화 감지 ─────────────
const POLICY_STRONG = /시행|개정안?|도입|신설|폐지|개편안|제도 개선|제도개선|바뀐다|바뀌는|달라진다|달라지는|의무화|법안|입법|시행령|내년부터|다음 달부터|다음달부터|입법예고|본회의 통과|국회 통과|세법|감면|공제 확대|한도 상향/;
const POLICY_SOFT = /제도|규제|세제|과세|지원금|보조금|상향|하향|완화|강화/;

function isPolicy(c) {
  if (c.cat === 'opinion' || c.cat === 'world' || c.cat === 'sports') return false;
  const titles = c.members.map(m => m.title);
  return POLICY_STRONG.test(c.main.title) || (titles.some(t => POLICY_STRONG.test(t)) && titles.some(t => POLICY_SOFT.test(t)));
}

// ───────────── 상태 ─────────────
const firstSeen = new Map();
let state = { updatedAt: 0, clusters: [], feedStatus: [], loading: false };

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  const t0 = Date.now();
  try {
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const now = Date.now();
    const all = [];
    const seen = new Map();
    for (const r of results) {
      r.items.forEach((it, idx) => {
        if (isNaN(it.ts)) {
          // 날짜가 없는 피드(예: 한겨레): 처음 본 시각을 쓰고, 첫 수집분은 피드 순서를 유지
          if (!firstSeen.has(it.link)) firstSeen.set(it.link, now - idx * 60000);
          it.ts = firstSeen.get(it.link);
        }
        if (it.ts > now + 3600 * 1000) it.ts = now;
        if (now - it.ts > MAX_AGE_MS) return;
        const dup = seen.get(it.link);
        if (dup) { dup.cats.add(it.cat); return; }
        it.cats = new Set([it.cat]);
        seen.set(it.link, it);
        all.push(it);
      });
    }
    saveCache();
    for (const [k, v] of firstSeen) if (now - v > MAX_AGE_MS) firstSeen.delete(k);
    // 같은 기사가 여러 분류 피드에 중복 등장하면 하나만 유지(링크 기준은 위에서 처리됨)
    const clusters = cluster(all).map(c => ({
      id: c.main.link,
      cat: c.cat,
      cats: c.cats,
      ts: c.ts,
      title: c.main.title,
      link: c.main.link,
      outlet: c.main.outlet,
      author: c.main.author || (c.members.find(m => m.author) || {}).author || '',
      summary: c.summary,
      image: c.image,
      video: c.members.some(m => m.video),
      policy: isPolicy(c),
      editorial: c.cat === 'opinion' && c.members.some(m => /\[[^\]]*사설[^\]]*\]|^사설/.test(m.title)),
      count: c.members.length,
      others: c.members.slice(1).map(m => ({ outlet: m.outlet, title: m.title, link: m.link })),
    }));
    clusters.sort((a, b) => b.ts - a.ts);
    state = {
      updatedAt: now,
      clusters,
      feedStatus: results.map(r => ({ outlet: r.outlet, cat: r.cat, ok: r.ok, n: r.items.length, error: r.error })),
      loading: false,
    };
    const okN = results.filter(r => r.ok).length;
    console.log(`[${new Date().toLocaleTimeString('ko-KR')}] 수집 완료: 피드 ${okN}/${results.length}, 기사 ${all.length}건 → ${clusters.length}묶음 (${Date.now() - t0}ms)`);
    for (const r of results.filter(r => !r.ok)) console.log(`   ✗ ${OUTLETS[r.outlet].name}/${r.cat}: ${r.error}${r.stale ? ' (이전 수집분 유지)' : ''}`);
  } catch (e) {
    console.error('수집 오류', e);
    state.loading = false;
  }
}

module.exports = { OUTLETS, CATEGORIES, REFRESH_MS, refresh, getState: () => state };

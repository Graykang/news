// 상단 시세 자막 데이터 — 네이버 금융이 앱/웹에서 쓰는 시세 주소를 읽어 옵니다.
// fetch만 사용하므로 Node(로컬 서버·수집)와 Cloudflare Worker가 함께 씁니다.
//
// ※ 네이버가 공식 제공하는 API가 아니라 앱/웹이 내부적으로 쓰는 주소라서, 예고 없이 바뀌거나 막힐 수 있습니다.
//    가족용 비공개 화면에서 1분에 한 번 정도만 조회하도록 캐시합니다. 투자 판단용이 아니라 참고용 표시입니다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const M = 'https://m.stock.naver.com';
const fx = (code) => `${M}/front-api/marketIndex/productDetail?category=exchange&reutersCode=${code}`;

// kind: 'mi'(환율·금: result 안에 부호가 있는 값) | 'q'(지수·종목: 변동폭이 부호 없는 값 + 방향 코드)
const ITEMS = [
  { id: 'usd', label: '달러', kind: 'mi', url: fx('FX_USDKRW') },
  { id: 'cny', label: '위안', kind: 'mi', url: fx('FX_CNYKRW') },
  { id: 'jpy', label: '엔(100)', kind: 'mi', url: fx('FX_JPYKRW') },
  { id: 'gold', label: '금(원/g)', kind: 'mi', url: `${M}/front-api/marketIndex/productDetail?category=metals&reutersCode=M04020000` },
  { id: 'kospi', label: '코스피', kind: 'q', url: `${M}/api/index/KOSPI/basic` },
  { id: 'kosdaq', label: '코스닥', kind: 'q', url: `${M}/api/index/KOSDAQ/basic` },
  { id: 'dji', label: '다우', kind: 'q', url: 'https://api.stock.naver.com/index/.DJI/basic' },
  { id: 'ixic', label: '나스닥', kind: 'q', url: 'https://api.stock.naver.com/index/.IXIC/basic' },
  { id: 'spx', label: 'S&P500', kind: 'q', url: 'https://api.stock.naver.com/index/.INX/basic' },
  { id: 'samsung', label: '삼성전자', kind: 'q', url: `${M}/api/stock/005930/basic` },
  { id: 'hynix', label: 'SK하이닉스', kind: 'q', url: `${M}/api/stock/000660/basic` },
];

const unsigned = (s) => String(s ?? '').replace(/^[+-]/, '').trim();
const dirOf = (code) => ({ 1: 'up', 2: 'up', 4: 'down', 5: 'down' }[String(code)] || 'flat'); // 1상한 2상승 3보합 4하한 5하락

async function one(it) {
  const res = await fetch(it.url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  let price, change, pct, code, status, at;
  if (it.kind === 'mi') {
    const r = j.result || {};
    price = r.closePrice; change = r.fluctuations; pct = r.fluctuationsRatio;
    code = r.fluctuationsType && r.fluctuationsType.code; status = r.marketStatus; at = r.localTradedAt;
  } else {
    price = j.closePrice; change = j.compareToPreviousClosePrice; pct = j.fluctuationsRatio;
    code = j.compareToPreviousPrice && j.compareToPreviousPrice.code; status = j.marketStatus; at = j.localTradedAt;
  }
  if (!price) throw new Error('no price');
  const dir = dirOf(code);
  const sign = dir === 'up' ? '+' : dir === 'down' ? '-' : '';
  return { id: it.id, label: it.label, price: String(price), change: sign + unsigned(change), pct: sign + unsigned(pct), dir, status: status || '', at: at || '' };
}

// prev: 직전에 받은 항목 배열 — 일부 항목만 실패해도 이전 값으로 채움
async function fetchTicker(prev = []) {
  const rs = await Promise.allSettled(ITEMS.map(one));
  const items = rs.map((r, i) => (r.status === 'fulfilled' ? r.value : prev.find((p) => p.id === ITEMS[i].id))).filter(Boolean);
  if (!items.length) throw new Error('시세를 가져오지 못했습니다');
  return { t: Date.now(), items };
}

module.exports = { fetchTicker, ITEMS };

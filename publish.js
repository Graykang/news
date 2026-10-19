#!/usr/bin/env node
// 기사를 수집해서 Cloudflare KV에 올립니다. (GitHub Actions가 20분마다 실행하며, 내 PC에서 직접 실행해도 됩니다)
//
//   node publish.js            수집 후 Cloudflare KV에 업로드
//   node publish.js --file     업로드 대신 snapshot.json 파일로 저장 (테스트용)
//
// 필요한 환경변수(업로드 시): CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID

const fs = require('fs');
const path = require('path');
const { refresh, getState, OUTLETS, CATEGORIES } = require('./lib/collect');

const MIN_OK_FEEDS = 0.6; // 정상 수집된 피드가 이 비율 미만이면 기존 데이터를 덮어쓰지 않음

(async () => {
  const toFile = process.argv.includes('--file');
  await refresh();
  const st = getState();
  const okFeeds = st.feedStatus.filter((f) => f.ok).length;
  const ratio = okFeeds / Math.max(1, st.feedStatus.length);
  if (!st.clusters.length || ratio < MIN_OK_FEEDS) {
    console.error(`수집 결과가 부족해 업로드하지 않습니다. (정상 피드 ${okFeeds}/${st.feedStatus.length}, 기사 묶음 ${st.clusters.length})`);
    process.exit(1);
  }
  const snapshot = JSON.stringify({
    updatedAt: st.updatedAt,
    outlets: OUTLETS,
    categories: CATEGORIES,
    feedStatus: st.feedStatus,
    clusters: st.clusters,
  });
  console.log(`스냅샷 ${(snapshot.length / 1024).toFixed(0)}KB, 기사 묶음 ${st.clusters.length}개, 정상 피드 ${okFeeds}/${st.feedStatus.length}`);

  if (toFile) {
    fs.writeFileSync(path.join(__dirname, 'snapshot.json'), snapshot);
    console.log('snapshot.json 에 저장했습니다.');
    return;
  }

  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID } = process.env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_KV_NAMESPACE_ID) {
    console.error('환경변수 CF_API_TOKEN, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID 가 필요합니다.');
    process.exit(1);
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/snapshot`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'text/plain' },
    body: snapshot,
  });
  if (!res.ok) {
    console.error('KV 업로드 실패:', res.status, (await res.text()).slice(0, 300));
    process.exit(1);
  }
  console.log('Cloudflare KV 업로드 완료');
  try { // 시세 자막 백업: Worker가 직접 조회하지 못할 때 쓰는 마지막 값
    const tk = await require('./lib/ticker').fetchTicker();
    const r2 = await fetch(url.replace('/values/snapshot', '/values/ticker'), {
      method: 'PUT', headers: { authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'text/plain' }, body: JSON.stringify(tk),
    });
    console.log(r2.ok ? '시세 백업 업로드 완료' : '시세 백업 업로드 실패 ' + r2.status);
  } catch (e) { console.log('시세 백업 건너뜀:', e.message); }
})().catch((e) => { console.error(e); process.exit(1); });

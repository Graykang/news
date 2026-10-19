(() => {
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const PAGE = 40;
  const TABS = [
    { id: 'economy', name: '경제', desc: '' },
    { id: 'finance', name: '금융', desc: '은행·금리·대출·보험·가상자산 등 (경제의 하위 분류, 제목 키워드와 금융 피드로 분류)' },
    { id: 'corporate', name: '기업', desc: '기업 소식·실적·인수합병 등 (경제의 하위 분류, 제목 키워드와 산업 피드로 분류)' },
    { id: 'securities', name: '증권', desc: '증시·주가·종목·상장 등 (경제의 하위 분류, 제목 키워드와 증권 피드로 분류)' },
    { id: 'realestate', name: '부동산', desc: '부동산 전용 피드와 제목 키워드(아파트·전세·청약 등)로 모은 기사' },
    { id: 'education', name: '교육', desc: '교육 피드와 제목 키워드(수능·입시·교육부 등)로 모은 기사' },
    { id: 'tech', name: 'IT과학', desc: 'IT·과학 피드와 제목 키워드(AI·반도체·우주 등)로 모은 기사' },
    { id: 'politics', name: '정치', desc: '' },
    { id: 'society', name: '사회', desc: '' },
    { id: 'world', name: '세계', desc: '' },
    { id: 'culture', name: '생활문화', desc: '' },
    { id: 'entertainment', name: '연예', desc: '' },
    { id: 'sports', name: '스포츠', desc: '' },
    { id: 'weather', name: '날씨', desc: '날씨 예보와 기상 관련 기사 (제목 키워드로 분류)' },
    { id: 'fortune', name: '운세', desc: '오늘의 운세·띠별 운세 (제목 키워드로 분류)' },
    { id: 'opinion', name: '사설·칼럼', desc: '신문사 사설과 오피니언' },
    { id: 'policy', name: '제도·정책', desc: '시행·개정·도입 등 앞으로 바뀌는 제도와 정책 관련 기사' },
    { id: 'mine', name: '★ 내 키워드', desc: '내가 등록한 키워드가 제목·요약에 들어 있는 기사만 모아 보여 줍니다. 키워드는 내 계정에만 저장되며 다른 가족에게는 보이지 않습니다.' },
    { id: 'all', name: '전체', desc: '' },
  ];

  let data = null;
  let tab = store.get('tab', 'economy');
  if (!TABS.some(t => t.id === tab)) tab = 'economy';
  let off = new Set(store.get('offOutlets', []));
  let read = new Set(store.get('read', []));
  let lastVisit = store.get('lastVisit', 0);
  const sessionStart = Date.now();
  let shown = PAGE;
  let query = '';
  let sub = store.get('opinionSub', 'ed'); // 사설·칼럼 탭: ed(사설) | col(칼럼·기고) | all
  let me = '';
  let appReady = false; // 첫 기사 목록이 그려졌는지(시작 화면이 사라지는 시점 판단용)
  let sortMode = store.get('sort', 'latest'); // latest(최신순) | hot(많이 다룬 순)
  let pending = null; // 새로 도착했지만 아직 반영하지 않은 데이터

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');

  // ── 내 키워드 (계정별로 서버에 저장) ──
  let kw = { include: [], exclude: [] };
  const norm = (s) => String(s).trim().toLowerCase();
  function kwMatch(c) {
    if (!kw.include.length) return [];
    const h = (c._h ??= (c.title + ' ' + c.summary + ' ' + c.others.map(o => o.title).join(' ')).toLowerCase());
    if (kw.exclude.some(k => h.includes(norm(k)))) return [];
    return kw.include.filter(k => h.includes(norm(k)));
  }
  function hl(text) { // 키워드를 <mark>로 강조 (HTML 안전하게)
    const ks = kw.include.map(norm).filter(Boolean);
    if (!ks.length) return esc(text);
    const re = new RegExp('(' + ks.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return String(text).split(re).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
  }
  function renderKw() {
    const chips = (list, type) => list.length
      ? list.map((k, i) => `<span class="kwchip ${type}">${esc(k)}<button type="button" data-type="${type}" data-i="${i}" aria-label="${esc(k)} 삭제">×</button></span>`).join('')
      : '<span class="kwnone">없음</span>';
    $('#kwinc').innerHTML = chips(kw.include, 'include');
    $('#kwexc').innerHTML = chips(kw.exclude, 'exclude');
  }
  let kwTimer;
  function saveKw() {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(() => {
      fetch('/api/keywords', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kw) }).catch(() => {});
    }, 400);
  }
  function addKw(type, raw) {
    const list = kw[type];
    for (let k of String(raw).split(/[,\n]/)) {
      k = k.trim().slice(0, 40);
      if (k && list.length < 30 && !list.some(x => norm(x) === norm(k))) list.push(k);
    }
    saveKw(); renderKw(); renderTabs(); shown = PAGE; renderFeed();
  }

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 6) return h + '시간 전';
    const d = new Date(ts);
    const hhmm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return (isToday(ts) ? '오늘 ' : '어제 ') + hhmm;
  }
  const dayKey = (ts) => new Date(ts).toDateString();
  const isToday = (ts) => dayKey(ts) === new Date().toDateString();
  function dayLabel(ts) {
    if (isToday(ts)) return '오늘';
    if (dayKey(ts) === new Date(Date.now() - 864e5).toDateString()) return '어제';
    return new Date(ts).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  }

  // ── 목록 만들기 ──
  function visible() {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    let list = data.clusters.filter(c => {
      // 매체 필터: 켜진 매체가 하나라도 보도했으면 표시
      const outs = [c.outlet, ...c.others.map(o => o.outlet)];
      if (!outs.some(o => !off.has(o))) return false;
      if (q && !(c.title + ' ' + c.summary + ' ' + c.others.map(o => o.title).join(' ')).toLowerCase().includes(q)) return false;
      switch (tab) {
        case 'mine': return kwMatch(c).length > 0;
        case 'policy': return c.policy;
        case 'all': return true;
        case 'opinion': return c.cat === 'opinion' && (sub === 'all' || (sub === 'ed') === !!c.editorial);
        default: return c.cats.includes(tab);
      }
    });
    if (sortMode === 'hot') list = list.filter(c => now - c.ts < 24 * 36e5).sort((a, b) => b.count - a.count || b.ts - a.ts); // 최근 24시간 중 여러 매체가 다룬 순
    return list.map(adjustForOutlets);
  }
  function renderSort() {
    document.querySelectorAll('#sortbar .seg').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === sortMode)));
    $('#sorthint').textContent = sortMode === 'hot' ? '최근 24시간 · 여러 매체가 함께 보도한 순' : '';
  }
  // 신문사를 골라서 볼 때, 묶음의 대표 기사가 꺼 둔 신문사 것이면 켜 둔 신문사의 기사로 바꿔서 보여 줌
  function adjustForOutlets(c) {
    if (!off.has(c.outlet)) return c;
    const i = c.others.findIndex(o => !off.has(o.outlet));
    if (i < 0) return c;
    const o = c.others[i];
    return {
      ...c, outlet: o.outlet, title: o.title, link: o.link, summary: '', author: '', // 요약·기자는 대표 기사 것이라 비움
      others: [{ outlet: c.outlet, title: c.title, link: c.link }, ...c.others.filter((_, j) => j !== i)],
    };
  }
  function counts() {
    const out = {};
    const now = Date.now();
    for (const t of TABS) out[t.id] = 0;
    for (const c of data.clusters) {
      out.all++;
      for (const k of c.cats) if (out[k] != null) out[k]++;
      if (c.policy) out.policy++;
      if (c.cat === 'opinion' && c.editorial) out.opinion_ed = (out.opinion_ed || 0) + 1;
      if (kw.include.length && kwMatch(c).length) out.mine++;
    }
    return out;
  }

  // ── 그리기 ──
  function cardHtml(c) {
    const o = data.outlets[c.outlet];
    const isNew = lastVisit && c.ts > lastVisit;
    const cls = ['card', c.image ? 'has-img' : '', read.has(c.id) ? 'read' : ''].join(' ');
    const catName = (data.categories.find(k => k.id === c.cat) || {}).name || '';
    const others = c.others.length
      ? `<details class="others"><summary><b>${c.count}개 매체</b>가 함께 보도 ▾</summary><ul>${
          c.others.map(x => `<li><span class="o">${esc(data.outlets[x.outlet].name)}</span><a href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a></li>`).join('')
        }</ul></details>` : '';
    const img = c.image
      ? `<a class="thumb" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true"><img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.card').classList.remove('has-img');this.parentNode.remove()">${c.video ? '<span class="play">▶ 영상</span>' : ''}</a>` : '';
    return `<article class="${cls}" data-id="${esc(c.id)}">
      <div class="body">
        <div class="meta">
          <span class="outlet" style="--c:${o.color}"><i></i>${esc(o.name)}</span>
          <span class="sep">·</span><span>${ago(c.ts)}</span>
          <span class="sep">·</span><span>${esc(catName)}</span>
          ${isNew ? '<span class="tag new">NEW</span>' : ''}
          ${c.policy && tab !== 'policy' ? '<span class="tag">제도·정책</span>' : ''}
          ${tab !== 'mine' && kw.include.length && kwMatch(c).length ? '<span class="tag kw">★ 키워드</span>' : ''}
        </div>
        <a class="title" href="${esc(safeUrl(c.link))}" target="_blank" rel="noopener noreferrer">${tab === 'mine' ? hl(c.title) : esc(c.title)}</a>
        ${c.summary ? `<p class="sum">${tab === 'mine' ? hl(c.summary) : esc(c.summary)}</p>` : ''}
        ${c.author ? `<div class="byline">${esc(c.author.replace(/\s*기자$/, ''))} 기자</div>` : ''}
        ${others}
      </div>
      ${img}
    </article>`;
  }

  function renderTabs() {
    const n = counts();
    $('#tabs').innerHTML = TABS.map(t =>
      `<button class="tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}">${t.name}<span class="n">${n[t.id] || ''}</span></button>`).join('');
  }
  function renderOutlets() {
    $('#outlets').innerHTML = Object.entries(data.outlets).map(([k, o]) =>
      `<button class="chip" data-o="${k}" style="--c:${o.color}" aria-pressed="${!off.has(k)}"><i></i>${esc(o.name)}</button>`).join('') +
      '<button class="chip ghost" data-all="off">전체 해제</button><button class="chip ghost" data-all="on">전체 선택</button>';
  }
  function renderFeed() {
    const list = visible();
    renderSort();
    const t = TABS.find(x => x.id === tab);
    if (tab === 'opinion') {
      const seg = [['ed', '사설'], ['col', '칼럼·기고'], ['all', '전체']];
      $('#desc').innerHTML = seg.map(([k, n]) => `<button class="seg" data-sub="${k}" aria-pressed="${sub === k}">${n}</button>`).join('');
      $('#desc').className = 'desc segs';
    } else {
      $('#desc').className = 'desc';
      $('#desc').textContent = t.desc || '';
    }
    $('#desc').hidden = tab !== 'opinion' && !t.desc;
    $('#kwbox').hidden = tab !== 'mine';
    if (tab === 'mine') renderKw();
    let html = '', lastDay = '';
    const slice = list.slice(0, shown);
    for (const c of slice) {
      if (sortMode !== 'hot') {
        const dk = dayKey(c.ts);
        if (dk !== lastDay) { html += `<div class="day">${dayLabel(c.ts)}</div>`; lastDay = dk; }
      }
      html += cardHtml(c);
    }
    $('#feed').innerHTML = html;
    $('#more').hidden = list.length <= shown;
    $('#empty').hidden = list.length > 0;
    if (!list.length) $('#empty').textContent = off.size >= Object.keys(data.outlets).length ? '보고 싶은 신문사를 위에서 선택해 주세요.' : query ? '검색 결과가 없습니다.' : tab === 'mine' ? (kw.include.length ? '키워드에 해당하는 최근 기사가 없습니다.' : '위에서 키워드를 추가해 보세요. 예: 금리, 삼성전자, 부동산') : '표시할 기사가 없습니다.';
  }
  function renderMeta() {
    $('#whoname').textContent = me;
    $('#today').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    $('#updated').textContent = data.updatedAt ? '업데이트 ' + new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const bad = [...new Set(data.feedStatus.filter(f => !f.ok).map(f => data.outlets[f.outlet].name))];
    $('#feedwarn').innerHTML = bad.length ? `<span class="warn">일시적으로 가져오지 못한 매체: ${esc(bad.join(', '))}</span>` : '';
  }
  function renderAll() { appReady = true; renderMeta(); renderTabs(); renderOutlets(); renderFeed(); }

  // ── 데이터 ──
  async function load(first) {
    const btn = $('#refresh');
    btn.classList.add('spin');
    try {
      const res = await fetch('/api/news', { cache: 'no-store' });
      if (res.status === 401) { location.href = '/login'; return; }
      const j = await res.json();
      if (!j.updatedAt) { setTimeout(() => load(first), 1500); return; } // 서버가 첫 수집 중
      if (first || !data) { data = j; renderAll(); }
      else if (j.updatedAt !== data.updatedAt) {
        const known = new Set(data.clusters.map(c => c.id));
        const fresh = j.clusters.filter(c => !known.has(c.id) && c.ts > data.updatedAt - 36e5).length;
        pending = j;
        if (fresh > 0) {
          $('#newbar').hidden = false;
          $('#newbar').innerHTML = `<button>새 기사 ${fresh}건 보기</button>`;
        } else { applyPending(); }
      }
    } catch (e) {
      if (!data) { $('#empty').hidden = false; $('#empty').textContent = '연결이 불안정합니다. 잠시 후 다시 시도합니다…'; setTimeout(() => load(first), 3000); }
    } finally { btn.classList.remove('spin'); }
  }
  function applyPending() {
    if (!pending) return;
    data = pending; pending = null;
    $('#newbar').hidden = true;
    renderAll();
  }

  // ── 이벤트 ──
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    tab = b.dataset.tab; store.set('tab', tab); shown = PAGE;
    renderTabs(); renderFeed(); window.scrollTo({ top: 0 });
  });
  $('#outlets').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.all) off = b.dataset.all === 'off' ? new Set(Object.keys(data.outlets)) : new Set();
    else { const k = b.dataset.o; off.has(k) ? off.delete(k) : off.add(k); }
    store.set('offOutlets', [...off]); shown = PAGE;
    renderOutlets(); renderFeed();
  });
  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => { query = e.target.value; shown = PAGE; renderFeed(); }, 150);
  });
  $('#desc').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    sub = b.dataset.sub; store.set('opinionSub', sub); shown = PAGE; renderFeed();
  });
  $('#sortbar').addEventListener('click', (e) => {
    const b = e.target.closest('.seg'); if (!b) return;
    sortMode = b.dataset.sort; store.set('sort', sortMode); shown = PAGE; renderFeed();
  });
  $('#more').addEventListener('click', () => { shown += PAGE; renderFeed(); });
  $('#newbar').addEventListener('click', () => { applyPending(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('#feed').addEventListener('click', (e) => {
    const a = e.target.closest('a.title, a.thumb, .others a'); if (!a) return;
    const card = a.closest('.card'); const id = card.dataset.id;
    if (!read.has(id)) {
      read.add(id); card.classList.add('read');
      store.set('read', [...read].slice(-1500));
    }
  });
  $('#refresh').addEventListener('click', async () => {
    $('#refresh').classList.add('spin');
    try { await fetch('/api/refresh', { method: 'POST' }); } catch {}
    setTimeout(() => { pending = null; load(true); }, 3500);
  });

  $('#logout').addEventListener('click', async () => {
    try { await fetch('/logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  });

  // 키워드 편집
  $('#kwbox').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.closest('form'); if (!f) return;
    const inp = f.querySelector('input');
    addKw(f.dataset.type, inp.value);
    inp.value = ''; inp.focus();
  });
  $('#kwbox').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    kw[b.dataset.type].splice(Number(b.dataset.i), 1);
    saveKw(); renderKw(); renderTabs(); shown = PAGE; renderFeed();
  });

  // ── 상단 시세 자막 ──
  let tkSig = '';
  const tkT0 = performance.now();
  function renderTicker(d) {
    const html = d.items.map(i => {
      const arrow = i.dir === 'up' ? '▲' : i.dir === 'down' ? '▼' : '';
      const chg = i.dir === 'flat' ? '보합' : `${arrow} ${esc(i.change.replace(/^[+-]/, ''))} (${esc(i.pct.replace(/^[+-]/, ''))}%)`;
      const state = i.status === 'OPEN' ? '장중' : i.status === 'CLOSE' ? '장마감' : '';
      const when = i.at ? new Date(i.at).toLocaleString('ko-KR') : '';
      return `<span class="tk" title="${esc((state + ' ' + when).trim())}"><b>${esc(i.label)}</b><span class="tv">${esc(i.price)}</span><span class="tc ${i.dir}">${chg}</span></span>`;
    }).join('');
    if (html === tkSig) return;
    tkSig = html;
    const track = $('#tickerTrack');
    track.innerHTML = html + html; // 두 번 이어 붙여 끊김 없이 반복
    const dur = Math.max(25, track.scrollWidth / 2 / 55); // 초당 약 55px
    track.style.animationDuration = dur + 's';
    track.style.animationDelay = -(((performance.now() - tkT0) / 1000) % dur) + 's'; // 갱신해도 위치를 이어서
    $('#ticker').hidden = false;
  }
  async function loadTicker() {
    try {
      const r = await fetch('/api/ticker', { cache: 'no-store' });
      if (r.ok) renderTicker(await r.json());
    } catch {}
  }

  // ── 시작 화면(하루 첫 접속 때 한 번) · 내 설정 ──
  let profile = { welcome: '', motto: '' };
  const splashEl = $('#splash');
  const splashOn = document.documentElement.classList.contains('splash-on'); // 오늘 아직 안 봤을 때만 켜짐(head의 짧은 스크립트가 판단)
  let splashT0 = performance.now(), splashMin = 1300, splashFilled = false, splashDone = false;
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? '편안한 밤 되세요' : h < 11 ? '좋은 아침입니다' : h < 14 ? '즐거운 점심시간입니다' : h < 18 ? '좋은 오후입니다' : h < 22 ? '좋은 저녁입니다' : '편안한 밤 되세요';
  }
  function endSplash() {
    if (splashDone) return;
    splashDone = true;
    splashEl.classList.add('sp-out');
    setTimeout(() => document.documentElement.classList.remove('splash-on'), 480);
    try {
      const d = new Date();
      localStorage.setItem('splashDay', `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
      sessionStorage.removeItem('justLoggedIn');
    } catch {}
  }
  function fillSplash(j) {
    profile = { welcome: j.welcome || '', motto: j.motto || '' };
    if (!splashOn) return;
    let manual = false;
    try { manual = sessionStorage.getItem('justLoggedIn') === '1'; } catch {}
    $('#spHello').textContent = `${j.user}님, ${greeting()}`;
    $('#spMsg').textContent = profile.welcome;
    $('#spMotto').textContent = profile.motto ? `“${profile.motto}”` : '';
    $('#spAuto').textContent = manual ? '로그인되었습니다' : '자동 로그인되었습니다';
    splashMin = (profile.welcome || profile.motto) ? 2300 : 1300; // 문구가 있으면 읽을 시간을 조금 더
    splashT0 = performance.now();
    splashFilled = true;
    splashEl.classList.add('sp-ready');
  }
  if (splashOn) {
    splashEl.addEventListener('click', endSplash);          // 화면을 누르면 바로 건너뜀
    document.addEventListener('keydown', endSplash, { once: true });
    const bootT0 = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      // 문구를 보여 준 뒤 최소 시간이 지나고 기사 목록도 준비됐을 때 사라짐(기다리게 하지 않음). 무슨 일이 있어도 4.5초면 종료
      if ((splashFilled && now - splashT0 >= splashMin && appReady) || now - bootT0 > 4500) { clearInterval(tick); endSplash(); }
    }, 100);
  }

  const dlg = $('#prof');
  $('#settings').addEventListener('click', () => {
    let off = false;
    try { off = localStorage.getItem('splashOff') === '1'; } catch {}
    $('#pfSplash').checked = !off;
    $('#pfMotto').value = profile.motto || '';
    $('#pfWelcome').textContent = profile.welcome ? `관리자가 남긴 메시지: ${profile.welcome}` : '';
    $('#pfMsg').textContent = '';
    dlg.showModal();
  });
  $('#pfClose').addEventListener('click', () => dlg.close());
  $('#pfSave').addEventListener('click', async () => {
    try { localStorage.setItem('splashOff', $('#pfSplash').checked ? '0' : '1'); } catch {}
    try {
      const r = await fetch('/api/me/profile', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ motto: $('#pfMotto').value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '저장하지 못했습니다.');
      profile.motto = j.motto || '';
      $('#pfMsg').textContent = '저장했습니다.';
      setTimeout(() => dlg.close(), 700);
    } catch (e) { $('#pfMsg').textContent = e.message; }
  });

  // 테마
  const root = document.documentElement;
  const savedTheme = store.get('theme', null);
  if (savedTheme) root.dataset.theme = savedTheme;
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  });

  // 시간 표기 갱신 & 자동 새로고침
  setInterval(() => { if (data) renderFeed(); }, 60000);
  // 기사 전체를 다시 받지 않고, 새 수집이 있을 때만 가져옴(휴대폰 데이터 절약)
  async function poll() {
    if (!data) return load(false);
    try {
      const r = await fetch('/api/news/version', { cache: 'no-store' });
      if (r.status === 401) { location.href = '/login'; return; }
      if (!r.ok) return load(false); // 버전 확인이 안 되는 서버면 예전 방식으로
      const j = await r.json();
      const known = pending ? pending.updatedAt : data.updatedAt;
      if (j.updatedAt && j.updatedAt !== known) await load(false);
    } catch {}
  }
  setInterval(poll, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) poll(); });
  window.addEventListener('pagehide', () => store.set('lastVisit', Date.now()));

  $('#feed').innerHTML = '<div class="sk"></div>'.repeat(5);
  $('#today').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  fetch('/api/me').then(r => r.json()).then(j => { me = j.user || ''; $('#whoname').textContent = me; $('#adminlink').hidden = !j.admin; fillSplash(j); }).catch(() => {});
  fetch('/api/keywords').then(r => r.json()).then(j => {
    kw = { include: j.include || [], exclude: j.exclude || [] };
    if (data) { renderTabs(); renderFeed(); }
  }).catch(() => {});
  loadTicker(); setInterval(loadTicker, 60000);
  load(true);
})();

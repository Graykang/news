(() => {
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const PAGE = 40;
  const NOISY = new Set(['opinion', 'sports', 'entertainment', 'weather', 'fortune']); // 주요 이슈에서 제외
  const TABS = [
    { id: 'issue', name: '주요 이슈', desc: '여러 매체가 동시에 다룬, 지금 가장 크게 보도되는 소식 (최근 24시간)' },
    { id: 'economy', name: '경제', desc: '' },
    { id: 'politics', name: '정치', desc: '' },
    { id: 'society', name: '사회', desc: '' },
    { id: 'world', name: '세계', desc: '' },
    { id: 'realestate', name: '부동산', desc: '부동산 전용 피드와 제목 키워드(아파트·전세·청약 등)로 모은 기사' },
    { id: 'education', name: '교육', desc: '교육 피드와 제목 키워드(수능·입시·교육부 등)로 모은 기사' },
    { id: 'tech', name: 'IT과학', desc: 'IT·과학 피드와 제목 키워드(AI·반도체·우주 등)로 모은 기사' },
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
        case 'issue': return c.count >= 3 && now - c.ts < 24 * 36e5 && !NOISY.has(c.cat);
        case 'mine': return kwMatch(c).length > 0;
        case 'policy': return c.policy;
        case 'all': return true;
        case 'opinion': return c.cat === 'opinion' && (sub === 'all' || (sub === 'ed') === !!c.editorial);
        default: return c.cats.includes(tab);
      }
    });
    if (tab === 'issue') list = list.sort((a, b) => b.count - a.count || b.ts - a.ts);
    return list;
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
      if (c.count >= 3 && now - c.ts < 24 * 36e5 && !NOISY.has(c.cat)) out.issue++;
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
      ? `<details class="others"><summary>${tab === 'issue' ? '<span class="hot">●</span> ' : ''}<b>${c.count}개 매체</b>가 함께 보도 ▾</summary><ul>${
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
      `<button class="chip" data-o="${k}" style="--c:${o.color}" aria-pressed="${!off.has(k)}"><i></i>${esc(o.name)}</button>`).join('');
  }
  function renderFeed() {
    const list = visible();
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
      if (tab !== 'issue') {
        const dk = dayKey(c.ts);
        if (dk !== lastDay) { html += `<div class="day">${dayLabel(c.ts)}</div>`; lastDay = dk; }
      }
      html += cardHtml(c);
    }
    $('#feed').innerHTML = html;
    $('#more').hidden = list.length <= shown;
    $('#empty').hidden = list.length > 0;
    if (!list.length) $('#empty').textContent = query ? '검색 결과가 없습니다.' : tab === 'mine' ? (kw.include.length ? '키워드에 해당하는 최근 기사가 없습니다.' : '위에서 키워드를 추가해 보세요. 예: 금리, 삼성전자, 부동산') : '표시할 기사가 없습니다.';
  }
  function renderMeta() {
    $('#whoname').textContent = me;
    $('#today').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    $('#updated').textContent = data.updatedAt ? '업데이트 ' + new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const bad = [...new Set(data.feedStatus.filter(f => !f.ok).map(f => data.outlets[f.outlet].name))];
    $('#feedwarn').innerHTML = bad.length ? `<span class="warn">일시적으로 가져오지 못한 매체: ${esc(bad.join(', '))}</span>` : '';
  }
  function renderAll() { renderMeta(); renderTabs(); renderOutlets(); renderFeed(); }

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
      if (!data) $('#empty').hidden = false, $('#empty').textContent = '서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요.';
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
    const k = b.dataset.o;
    off.has(k) ? off.delete(k) : off.add(k);
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
  setInterval(() => load(false), 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data) load(false); });
  window.addEventListener('pagehide', () => store.set('lastVisit', Date.now()));

  $('#feed').innerHTML = '<div class="sk"></div>'.repeat(5);
  $('#today').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  fetch('/api/me').then(r => r.json()).then(j => { me = j.user || ''; $('#whoname').textContent = me; $('#adminlink').hidden = !j.admin; }).catch(() => {});
  fetch('/api/keywords').then(r => r.json()).then(j => {
    kw = { include: j.include || [], exclude: j.exclude || [] };
    if (data) { renderTabs(); renderFeed(); }
  }).catch(() => {});
  load(true);
})();

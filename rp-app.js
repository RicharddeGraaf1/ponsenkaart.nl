// ============================================================
// Ponsenkaart.nl — RP-planvoorraad app
// Rendert KPI's, gemeentelijst, planlijst met ponskaart-tijdlijn,
// filterbalk en detail-overlay. Data via OCD-API (rp-data.js):
// nationale KPI's + gemeentelijst bij init, plannen lazy per gemeente.
// ============================================================
(function () {
  'use strict';

  const RP = window.RPData;
  const CLASS = RP.CLASS;
  const PLANSTATUS = RP.PLANSTATUS;
  // Worden gevuld in init() na RP.init().
  let SNAPSHOTS = [], N = 0, GEMEENTEN = [], NATIONAL = null;

  const PS_KLEUR = {};
  PLANSTATUS.forEach(s => { PS_KLEUR[s.key] = s.kleur; });
  const psKleur = (k) => PS_KLEUR[(k || '').toLowerCase()] || 'gray';

  const NL = new Intl.NumberFormat('nl-NL');
  const NL_DATE = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  const NL_MONTH = new Intl.DateTimeFormat('nl-NL', { month: 'short', year: '2-digit' });
  const fmtDate = (iso) => NL_DATE.format(new Date(iso));
  const fmtMonth = (iso) => NL_MONTH.format(new Date(iso));
  const signed = (n) => (n > 0 ? '+' : '') + NL.format(n);

  const state = {
    sort: 'pct',
    selected: null,
    filters: { WEG: true, AANWEZIG: true },
    planstatusOff: new Set(PLANSTATUS.filter(s => !s.on).map(s => s.key)),
    periode: 'alle',
    query: '',
  };

  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  // ---------------- KPI-strip ----------------
  function renderKPIs() {
    $('#kpiVoorraad').textContent = NL.format(NATIONAL.inVoorraad);
    const peil = RP.peildatum ? fmtDate(RP.peildatum) : '';
    $('#kpiPeil').textContent = peil ? ('stand per ' + peil) : 'gevestigde bestemmingsplannen';

    $('#kpiVerdwenen').textContent = NL.format(NATIONAL.sindsStartVerdwenen);

    $('#kpiLeeg').textContent = NL.format(NATIONAL.gemeentenLeeg);
    const pct = Math.round((NATIONAL.gemeentenLeeg / NATIONAL.gemeentenTotaal) * 100);
    $('#kpiLeegBar').style.width = pct + '%';
    $('#kpiLeegPct').textContent = pct + '%';
  }

  // ---------------- Gemeentelijst ----------------
  function sortedGemeenten() {
    const g = GEMEENTEN.slice();
    switch (state.sort) {
      case 'naam': g.sort((a, b) => a.naam.localeCompare(b.naam, 'nl')); break;
      case 'nu': g.sort((a, b) => b.plansNu - a.plansNu); break;
      case 'verdwenen': g.sort((a, b) => b.verdwenen - a.verdwenen); break;
      default: g.sort((a, b) => b.pctAf - a.pctAf);
    }
    return g;
  }

  function renderGemeenten() {
    const list = $('#gemList');
    list.innerHTML = '';
    sortedGemeenten().forEach(g => {
      const row = el('div', 'gem-row' + (g === state.selected ? ' selected' : ''));
      row.innerHTML = `
        <span class="gem-dot ${g.stip}"></span>
        <div class="gem-mid">
          <div class="gem-name">${g.naam} <span class="code">${g.code}</span></div>
          <div class="gem-meta">
            <span class="mono">${g.plansNu}</span> in voorraad
            <span class="sep">·</span>
            <span class="mono">${g.verdwenen}</span> verdwenen
          </div>
          <div class="gem-bar"><i style="width:${Math.round(g.pctAf * 100)}%"></i></div>
        </div>
        <div class="gem-right">
          <div class="gem-pct">${Math.round(g.pctAf * 100)}<span class="u">%</span></div>
          <div class="gem-sub2">afgenomen</div>
        </div>`;
      row.addEventListener('click', () => selectGemeente(g));
      list.appendChild(row);
    });
  }

  async function selectGemeente(g) {
    state.selected = g;
    renderGemeenten();
    showDetailLoading();
    try {
      await RP.ensurePlans(g);
    } catch (e) {
      $('#detailCol').innerHTML = `<div class="no-results">Kon plannen niet laden: ${e.message}</div>`;
      return;
    }
    if (state.selected === g) renderDetail();
  }

  // ---------------- Datum-blok (vervangt de ponskaart-cellen) ----------------
  function planDatesHtml(p) {
    const start = p.startDatum ? fmtDate(p.startDatum) : '—';
    const eind = (p.classificatie === 'WEG')
      ? `<span class="pd-label">Weggehaald</span><span class="pd-val weg">${p.wegDatum ? fmtDate(p.wegDatum) : '—'}</span>`
      : `<span class="pd-label">Status</span><span class="pd-val nu">nog in voorraad</span>`;
    return `<div class="plan-dates">
      <div class="pd-row"><span class="pd-label">In voorraad sinds</span><span class="pd-val">${start}</span></div>
      <div class="pd-row">${eind}</div>
    </div>`;
  }

  // ---------------- Detailpaneel ----------------
  function filteredPlans(g) {
    const q = state.query.trim().toLowerCase();
    return (g.plans || []).filter(p => {
      if (!state.filters[p.classificatie]) return false;
      if (state.planstatusOff.has(p.planstatus)) return false;
      if (state.periode !== 'alle') {
        const from = N - parseInt(state.periode, 10);
        const veranderd = p.presence.slice(from).some((v, i, arr) => i > 0 && v !== arr[i - 1]);
        if (!veranderd) return false;
      }
      if (q && !(
        (p.titel || '').toLowerCase().includes(q) ||
        (p.id || '').toLowerCase().includes(q) ||
        (p.dossier || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function classCounts(g) {
    const c = { WEG: 0, AANWEZIG: 0 };
    (g.plans || []).forEach(p => { c[p.classificatie] = (c[p.classificatie] || 0) + 1; });
    return c;
  }

  function renderDetail() {
    const g = state.selected;
    if (!g) return;
    const col = $('#detailCol');
    col.innerHTML = '';

    const head = el('div', 'detail-head');
    head.innerHTML = `
      <div class="detail-title-row">
        <div>
          <h2 class="detail-title">${g.naam}</h2>
          <div class="detail-sub">
            <span class="mono">${g.code}</span> · ${g.bronhouder || '—'}
          </div>
        </div>
      </div>
      <div class="detail-stats">
        <div class="dstat"><div class="v">${g.plansNu}</div><div class="l">In voorraad</div></div>
        <div class="dstat"><div class="v green">${g.verdwenen}</div><div class="l">Weggehaald</div></div>
        <div class="dstat"><div class="v">${Math.round(g.pctAf * 100)}%</div><div class="l">Voorraad afgenomen</div></div>
      </div>`;
    col.appendChild(head);

    if (g.leeg) {
      const done = el('div', 'empty-done');
      done.innerHTML = `
        <div class="ico">✓</div>
        <h3>Manifest is leeg — ${g.naam} is klaar</h3>
        <p>Alle bestemmingsplannen zijn uit het IMRO-manifest verdwenen en niet teruggekeerd.
           Het omgevingsplan heeft de planvoorraad volledig overgenomen. Dit is de gewenste eindtoestand.</p>
        <div class="meta">${g.verdwenen} plannen weggehaald</div>`;
      col.appendChild(done);
      const histH = el('div', 'ov-section-h', 'Historie (weggehaalde plannen)');
      histH.style.padding = '0 22px';
      histH.style.margin = '8px 22px 12px';
      col.appendChild(histH);
      renderPlanRows(col, g, g.plans || []);
      return;
    }

    col.appendChild(buildFilterbar(g));
    renderPlanRows(col, g, filteredPlans(g));
  }

  function buildFilterbar(g) {
    const counts = classCounts(g);
    const bar = el('div', 'filterbar');
    const toggles = ['WEG', 'AANWEZIG'].map(k => {
      const c = CLASS[k];
      const on = state.filters[k];
      return `<span class="class-toggle ${c.kleur} ${on ? 'on' : 'off'}" data-class="${k}">
        <span class="chip-dot"></span>${c.kort} <span class="cnt">${counts[k]}</span>
      </span>`;
    }).join('');

    const psCounts = {};
    (g.plans || []).forEach(p => { psCounts[p.planstatus] = (psCounts[p.planstatus] || 0) + 1; });
    const psList = PLANSTATUS.filter(s => psCounts[s.key]);
    const psToggles = psList.map(s => {
      const on = !state.planstatusOff.has(s.key);
      return `<span class="class-toggle ${s.kleur} ${on ? 'on' : 'off'}" data-pstatus="${s.key}">
        <span class="chip-dot"></span>${s.key} <span class="cnt">${psCounts[s.key]}</span>
      </span>`;
    }).join('');

    bar.innerHTML = `
      <div class="fb-group"><span class="fb-label">Status</span>${toggles}</div>
      ${psToggles ? `<div class="fb-group"><span class="fb-label">Planstatus</span>${psToggles}</div>` : ''}
      <div class="fb-group">
        <select class="fb-select" id="fbPeriode">
          <option value="alle" ${state.periode === 'alle' ? 'selected' : ''}>Hele periode</option>
          <option value="3" ${state.periode === '3' ? 'selected' : ''}>Laatste 3 snapshots</option>
          <option value="6" ${state.periode === '6' ? 'selected' : ''}>Laatste 6 snapshots</option>
        </select>
      </div>
      <div class="fb-spacer"></div>
      <div class="fb-search-wrap">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 13.5 L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <input class="fb-search" id="fbSearch" type="text" placeholder="Zoek titel of identificatie…" value="${state.query.replace(/"/g, '&quot;')}">
      </div>`;

    bar.querySelectorAll('.class-toggle[data-class]').forEach(t => {
      t.addEventListener('click', () => {
        const k = t.dataset.class;
        state.filters[k] = !state.filters[k];
        renderDetail();
      });
    });
    bar.querySelectorAll('.class-toggle[data-pstatus]').forEach(t => {
      t.addEventListener('click', () => {
        const k = t.dataset.pstatus;
        if (state.planstatusOff.has(k)) state.planstatusOff.delete(k);
        else state.planstatusOff.add(k);
        renderDetail();
      });
    });
    bar.querySelector('#fbPeriode').addEventListener('change', e => { state.periode = e.target.value; renderDetail(); });
    const si = bar.querySelector('#fbSearch');
    si.addEventListener('input', e => {
      state.query = e.target.value;
      const list = $('#planlist');
      if (list) { list.replaceWith(buildPlanList(g, filteredPlans(g))); }
    });
    return bar;
  }

  function buildPlanList(g, plans) {
    const wrap = el('div', 'planlist');
    wrap.id = 'planlist';
    if (!plans.length) {
      wrap.appendChild(el('div', 'no-results', 'Geen plannen die aan de filters voldoen.'));
      return wrap;
    }
    plans.forEach(p => {
      const c = CLASS[p.classificatie];
      const row = el('div', 'plan-row');
      const procTag = (p.dossierstatus && p.dossierstatus.indexOf('voorbereiding') >= 0)
        ? '<span class="tag proc">In procedure</span>' : '';
      row.innerHTML = `
        <div class="plan-badge">
          <span class="badge ${c.kleur}"><span class="bg">${c.glyph}</span>${c.kort}</span>
        </div>
        <div class="plan-mid">
          <div class="plan-titel" title="${p.titel || ''}">${p.titel || '—'}</div>
          <div class="plan-ids">
            <span class="imro">${p.id}</span>
            <span>${p.dossier || ''}</span>
          </div>
          <div class="plan-tags">
            <span class="pstatus ${psKleur(p.planstatus)}"><span class="d"></span>${p.planstatus || '—'}</span>
            ${procTag}
          </div>
        </div>
        ${planDatesHtml(p)}`;
      row.addEventListener('click', () => openOverlay(g, p));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderPlanRows(col, g, plans) {
    col.appendChild(buildPlanList(g, plans));
    col.appendChild(buildFooter());
  }

  function buildFooter() {
    const f = el('div', 'rp-foot');
    const range = (SNAPSHOTS.length)
      ? `${fmtDate(SNAPSHOTS[0])} – ${fmtDate(SNAPSHOTS[N - 1])}` : '';
    f.innerHTML = `
      <div class="legenda">
        <span class="lg green"><span class="chip-dot"></span>Weggehaald = gewenste eindtoestand</span>
        <span class="lg gray"><span class="chip-dot"></span>Aanwezig = nog niet weg</span>
      </div>
      <div>Bron: IMRO-manifest via ruimtelijkeplannen.nl · ${N} snapshots · ${range}</div>`;
    return f;
  }

  // ---------------- Detail-overlay ----------------
  function openOverlay(g, p) {
    const c = CLASS[p.classificatie];
    const scrim = $('#overlay');
    const body = $('#overlayBody');

    let diffHtml;
    if (p.classificatie === 'WEG') {
      diffHtml = `
        <div class="ov-section-h">Weggehaald</div>
        <div class="weg-callout">
          <span class="wc-ico">✓</span>
          <div>
            <div class="wc-date">${p.wegDatum ? fmtDate(p.wegDatum) : '—'}</div>
            <div class="wc-sub">Verdwenen uit het IMRO-manifest en niet teruggekeerd. Dit is de gewenste eindtoestand.</div>
          </div>
        </div>`;
    } else {
      diffHtml = `
        <div class="diff-note"><b>Status:</b> aanwezig in het manifest op de huidige peildatum
        (${fmtDate(SNAPSHOTS[N - 1])}). Nog niet weggehaald.</div>`;
    }

    body.innerHTML = `
      <div class="ov-head">
        <div>
          <h3 class="ov-titel">${p.titel || '—'}</h3>
          <div class="ov-sub">${g.naam} · ${g.bronhouder || '—'}</div>
        </div>
        <button class="ov-close" id="ovClose" aria-label="Sluiten">✕</button>
      </div>
      <div class="ov-body">
        <div style="margin-bottom:16px"><span class="badge ${c.kleur}"><span class="bg">${c.glyph}</span>${c.label}</span></div>
        <div class="ov-grid">
          <div class="ov-kv"><div class="k">Identificatie</div><div class="v">${p.id}</div></div>
          <div class="ov-kv"><div class="k">Dossiernummer</div><div class="v">${p.dossier || '—'}</div></div>
          <div class="ov-kv"><div class="k">Planstatus</div><div class="v sans">${p.planstatus || '—'}</div></div>
          <div class="ov-kv"><div class="k">Bronhouder</div><div class="v sans">${g.bronhouder || '—'}</div></div>
          <div class="ov-kv"><div class="k">In voorraad sinds</div><div class="v">${p.startDatum ? fmtDate(p.startDatum) : '—'}</div></div>
          <div class="ov-kv"><div class="k">${p.classificatie === 'WEG' ? 'Weggehaald op' : 'Status'}</div><div class="v ${p.classificatie === 'WEG' ? '' : 'sans'}">${p.classificatie === 'WEG' ? (p.wegDatum ? fmtDate(p.wegDatum) : '—') : 'nog in voorraad'}</div></div>
        </div>

        ${diffHtml}
      </div>`;

    scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#ovClose').addEventListener('click', closeOverlay);
  }
  function closeOverlay() {
    $('#overlay').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------------- Cel-tooltip (hover) ----------------
  function setupCellTooltip() {
    const tip = $('#pcTip');
    document.addEventListener('mouseover', e => {
      const cell = e.target.closest('.pc-cell');
      if (!cell || !cell.dataset.date) { return; }
      tip.innerHTML = `<span class="d">${cell.dataset.date}</span><span class="s">${cell.dataset.status}</span>`;
      tip.hidden = false;
    });
    document.addEventListener('mousemove', e => {
      if (tip.hidden) return;
      const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest('.pc-cell')) tip.hidden = true;
    });
  }

  // ---------------- Sort-knoppen ----------------
  function setupSort() {
    document.querySelectorAll('.gem-sort button').forEach(b => {
      b.addEventListener('click', () => {
        state.sort = b.dataset.sort;
        document.querySelectorAll('.gem-sort button').forEach(x => x.classList.toggle('active', x === b));
        renderGemeenten();
      });
    });
  }

  // ---------------- Zoekveld topbar (gemeente) ----------------
  function setupTopSearch() {
    const input = $('#search');
    const box = $('#searchResults');
    if (!input) return;
    input.placeholder = 'Zoek gemeente…';
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; return; }
      const hits = GEMEENTEN.filter(g => g.naam.toLowerCase().includes(q)).slice(0, 8);
      box.innerHTML = hits.map(g =>
        `<div class="search-result" data-code="${g.code}">
          <span class="sr-name">${g.naam}</span>
          <span class="sr-pct">${Math.round(g.pctAf * 100)}% af</span>
        </div>`).join('') || '<div class="search-result">Geen gemeente gevonden</div>';
      box.hidden = false;
      box.querySelectorAll('[data-code]').forEach(r => {
        r.addEventListener('click', () => {
          const g = GEMEENTEN.find(x => x.code === r.dataset.code);
          box.hidden = true; input.value = '';
          if (g) selectGemeente(g);
        });
      });
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search')) box.hidden = true;
    });
  }

  // ---------------- Loading skeletons ----------------
  function showSkeletons() {
    const gl = $('#gemList');
    gl.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div class="gem-row"><span class="gem-dot gray"></span>
        <div class="gem-mid"><div class="skel" style="height:13px;width:50%"></div>
          <div class="skel" style="height:10px;width:70%;margin-top:8px"></div>
          <div class="skel" style="height:5px;width:64px;margin-top:8px"></div></div>
        <div class="skel" style="height:24px;width:36px"></div></div>`).join('');
    showDetailLoading();
  }

  function showDetailLoading() {
    const col = $('#detailCol');
    let rows = '';
    for (let i = 0; i < 5; i++) {
      let cells = '';
      for (let j = 0; j < (N || 14); j++) cells += `<span class="skel-cell ${j % 2 ? 'on' : ''}"></span>`;
      rows += `<div class="skel-row">
        <div class="skel" style="height:24px;width:110px"></div>
        <div><div class="skel" style="height:14px;width:60%"></div>
          <div class="skel" style="height:10px;width:40%;margin-top:8px"></div></div>
        <div class="skel-cells">${cells}</div>
      </div>`;
    }
    col.innerHTML = `<div class="detail-head"><div class="skel" style="height:26px;width:160px"></div>
      <div class="detail-stats" style="margin-top:14px"><div class="skel" style="height:40px;width:280px"></div></div></div>${rows}`;
  }

  // ---------------- Init ----------------
  async function init() {
    showSkeletons();
    setupSort();
    setupTopSearch();
    setupCellTooltip();
    $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeOverlay(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlay(); });

    try {
      await RP.init();
    } catch (e) {
      $('#detailCol').innerHTML = `<div class="no-results">Kon planvoorraad niet laden: ${e.message}</div>`;
      return;
    }
    SNAPSHOTS = RP.SNAPSHOTS; N = RP.N; GEMEENTEN = RP.GEMEENTEN; NATIONAL = RP.NATIONAL;

    renderKPIs();
    renderGemeenten();
    state.selected = GEMEENTEN[0] || null;
    if (state.selected) {
      renderGemeenten();
      showDetailLoading();
      await RP.ensurePlans(state.selected);
      renderDetail();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

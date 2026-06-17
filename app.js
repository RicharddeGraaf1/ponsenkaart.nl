// ============================================================
// Ponsenkaart.nl — app
// ============================================================
(function () {
  'use strict';

  const TODAY = new Date(2026, 4, 18); // 18 mei 2026 (peildatum demo)
  const START = new Date(2024, 0, 1);
  const DEADLINE = new Date(2032, 0, 1);

  const NL_FORMAT = new Intl.NumberFormat('nl-NL');
  const NL_FORMAT_1 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const NL_FORMAT_2 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const NL_FORMAT_3 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  // Adaptive precision: ≥1% → 1 decimaal, ≥0,1% → 2 decimalen, daaronder
  // 3 decimalen. Voorkomt dat een gemeente met een postzegel-pons als
  // "0,0%" verschijnt en niet te onderscheiden is van "echt 0".
  function formatPctNum(pct) {
    if (!pct || pct <= 0) return '0';
    if (pct >= 1) return NL_FORMAT_1.format(pct);
    if (pct >= 0.1) return NL_FORMAT_2.format(pct);
    return NL_FORMAT_3.format(pct);
  }
  function formatPct(pct) {
    return formatPctNum(pct) + '%';
  }
  const NL_DATE_LONG = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

  function monthsBetween(a, b) {
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  const state = {
    features: [],
    byName: new Map(),
    agg: null,
    provinces: [],
    selected: null,
    hover: null,
    mode: 'pons', // pons | pct
    map: null,
    valById: new Map(),
    ponsPolygons: [],         // alle pons-features uit OCD-API
    mode_data_source: 'ocd',
  };

  // Color scales: piecewise-linear interpolation between stops
  const SCALES = {
    pct: [
      [0,   '#FAF1D8'],
      [15,  '#ECD27A'],
      [35,  '#C9CB66'],
      [60,  '#7CAB60'],
      [85,  '#3E8650'],
      [100, '#1F6B43']
    ],
    abs: [
      [0,   '#FAF1D8'],
      [10,  '#ECD27A'],
      [30,  '#C9CB66'],
      [80,  '#7CAB60'],
      [150, '#3E8650'],
      [300, '#1F6B43']
    ],
    cnt: [
      [0,  '#FAF1D8'],
      [2,  '#ECD27A'],
      [5,  '#C9CB66'],
      [10, '#7CAB60'],
      [20, '#3E8650'],
      [40, '#1F6B43']
    ]
  };

  function interpolateColor(c1, c2, t) {
    function parse(hex) {
      return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
      ];
    }
    const a = parse(c1), b = parse(c2);
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  function colorFromScale(scale, v) {
    if (v <= 0) return '#B8B2A8';
    for (let i = 0; i < scale.length - 1; i++) {
      const [v1, c1] = scale[i];
      const [v2, c2] = scale[i + 1];
      if (v <= v2) {
        const t = (v - v1) / (v2 - v1);
        return interpolateColor(c1, c2, Math.max(0, Math.min(1, t)));
      }
    }
    return scale[scale.length - 1][1];
  }

  function styleFn(feature) {
    // In pons-mode dempen we de gemeente-fill zodat de polygonen visueel domineren.
    if (state.mode === 'pons') {
      if ((feature.properties.ponsCount || 0) <= 0) return '#E8E5DD';
      // Lichte tint naar groen — alleen om gestart/niet-gestart te tonen
      return '#E0EAE4';
    }
    const val = state.valById.get(feature.id);
    if (val == null || val <= 0) return '#B8B2A8';
    return colorFromScale(SCALES[state.mode], val);
  }

  // ============ Init ============
  async function init() {
    showStatus('Gemeentegrenzen laden…');
    const data = await Ponsen.loadGeoJSON();
    state.features = data.features;
    state.mode_data_source = data.mode;

    data.features.forEach((f, i) => {
      if (f.id == null) f.id = i + 1;
      state.byName.set(f.properties.name, f);
    });

    state.agg = aggregateNow();
    state.provinces = Ponsen.provinceAggregates(state.features);

    setupMap();
    setupKPIs();
    setupLeaderboard();
    setupToggle();
    setupSearch();
    setupRouting();

    renderPanelNational();
    updateUrlFromState({ replace: true });
  }

  function showStatus(msg, isError) {
    const el = document.getElementById('mapStatus');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.toggle('hidden', !msg);
  }

  // ============ Map ============
  async function setupMap() {
    const container = document.getElementById('map');
    const m = new PonsMap(container);
    state.map = m;
    m.setStyleFn(styleFn);
    m.setFeatures(state.features);

    // Alle pons-polygonen async laden (kleine response, <100KB voor heel NL).
    try {
      const polys = await Ponsen.loadPonsPolygons();
      state.ponsPolygons = polys;
      m.setPonsPolygons(polys);
    } catch (e) {
      console.warn('Pons-polygonen niet geladen:', e);
      state.ponsPolygons = [];
    }

    applyMode();

    m.on('hover', (f, e) => {
      if (!f) return;
      showTooltip(f, { clientX: e.clientX, clientY: e.clientY });
    });
    m.on('leave', hideTooltip);
    m.on('click', (name) => {
      if (name) selectGemeente(name, { zoom: true });
      else if (state.selected) deselect();
    });

    setTimeout(() => showStatus(''), 50);
  }

  function applyMode() {
    if (!state.map || !state.features.length) return;

    for (const f of state.features) {
      const pct = f.properties.pct || 0;
      let val;
      if (state.mode === 'pct') {
        val = pct;
      } else if (state.mode === 'abs') {
        val = pct * (f.properties.areaKm2 || 0) / 100;
      } else if (state.mode === 'cnt') {
        val = f.properties.ponsCount || 0;
      } else {
        val = pct; // pons-mode: niet via valById gebruikt
      }
      state.valById.set(f.id, val);
    }
    state.map.setAlwaysShowPons(state.mode === 'pons');
    state.map.refresh();
  }

  // ============ KPIs ============
  function setupKPIs() {
    document.getElementById('lastUpdate').textContent = NL_DATE_LONG.format(TODAY);
    renderKPIs();
  }

  function renderKPIs() {
    const a = state.agg;

    document.getElementById('kpiPct').textContent = NL_FORMAT_1.format(a.pct);
    const deltaEl = document.getElementById('kpiPctDelta');
    deltaEl.textContent = (a.delta >= 0 ? '+' : '') + NL_FORMAT_2.format(a.delta) + ' pp';
    deltaEl.className = 'delta ' + (a.delta > 0.005 ? 'up' : a.delta < -0.005 ? 'down' : 'flat');

    document.getElementById('kpiStarted').textContent = NL_FORMAT.format(a.started);
    document.getElementById('kpiStartedBar').style.width = (a.started / 342 * 100) + '%';
    document.getElementById('kpiStartedPct').textContent =
      Math.round(a.started / 342 * 100) + '% van NL';

    document.getElementById('kpiDone').textContent = NL_FORMAT.format(a.done);
    document.getElementById('kpiDoneBar').style.width = (a.done / 342 * 100) + '%';
    document.getElementById('kpiDonePct').textContent =
      Math.round(a.done / 342 * 100) + '% van NL';

    // Resterende tijd t.o.v. 1 jan 2032
    const remainMonths = Math.max(0, monthsBetween(TODAY, DEADLINE));
    const yrs = Math.floor(remainMonths / 12);
    const mnths = remainMonths % 12;
    document.getElementById('kpiYears').textContent = yrs;
    document.getElementById('kpiMonths').textContent = mnths;
    const totalTransitionMonths = monthsBetween(START, DEADLINE);
    const elapsed = monthsBetween(START, TODAY);
    const pct = (elapsed / totalTransitionMonths) * 100;
    const timeBar = document.getElementById('kpiTimeBar');
    timeBar.style.width = Math.min(100, pct) + '%';
    // Schaalt de gradient relatief aan de hele balk (zie styles.css);
    // ondergrens voorkomt divisie-door-nul issues bij pct = 0.
    timeBar.style.setProperty('--time-fraction', Math.max(0.01, Math.min(1, pct / 100)));
    document.getElementById('kpiTimePct').textContent =
      Math.round(pct) + '% van transitieperiode verstreken';
  }

  function aggregateNow() {
    let started = 0, done = 0, sumAbs = 0, prevAbs = 0, totalArea = 0, totalPons = 0;
    for (const f of state.features) {
      const pct = f.properties.pct;
      const prevPct = Math.max(0, pct - (f.properties.delta || 0));
      const area = f.properties.areaKm2;
      totalArea += area;
      sumAbs += pct / 100 * area;
      prevAbs += prevPct / 100 * area;
      if ((f.properties.ponsCount || 0) > 0) started++;
      if (pct >= 95) done++;
      totalPons += f.properties.ponsCount;
    }
    return {
      pct: sumAbs / totalArea * 100,
      delta: (sumAbs - prevAbs) / totalArea * 100,
      started, done, totalPons,
      sumAbs, totalArea
    };
  }

  // ============ Leaderboard ============
  function setupLeaderboard() {
    document.getElementById('lbToggle').addEventListener('click', () => {
      document.getElementById('leaderboard').classList.toggle('collapsed');
    });
    let lbMode = 'top';
    document.querySelectorAll('.lb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        lbMode = btn.dataset.lb;
        renderLeaderboard(lbMode);
      });
    });
    renderLeaderboard(lbMode);
    window._renderLeaderboard = renderLeaderboard;
  }

  function renderLeaderboard(mode) {
    // 'top'  → alleen gestarte gemeenten, hoogste % eerst, max 10 (klassieke leaderboard)
    // 'all'  → alle 342 gemeenten, hoogste % eerst, scrollbaar (zoeken naar specifieke gemeente)
    const sorted = mode === 'top'
      ? [...state.features]
          .filter(f => f.properties.started)
          .sort((a, b) => b.properties.pct - a.properties.pct)
          .slice(0, 10)
      : [...state.features]
          .sort((a, b) => b.properties.pct - a.properties.pct);
    const list = document.getElementById('lbList');
    list.innerHTML = '';
    sorted.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = 'lb-row';
      if (state.selected === f.properties.name) li.classList.add('selected');
      const pct = f.properties.pct;
      li.innerHTML =
        `<span class="lb-rank">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="lb-name">${escapeHtml(f.properties.name)}</span>` +
        `<span class="lb-pct"><span class="lb-pct-dot" style="background:${colorForPct(pct)}"></span>${formatPct(pct)}</span>`;
      li.addEventListener('click', () => selectGemeente(f.properties.name, { zoom: true }));
      list.appendChild(li);
    });
  }

  function colorForPct(p) {
    if (p === 0) return '#B8B2A8';
    if (p < 15) return '#ECD27A';
    if (p < 35) return '#C9CB66';
    if (p < 60) return '#7CAB60';
    if (p < 85) return '#3E8650';
    return '#1F6B43';
  }

  // ============ Mode toggle ============
  function setupToggle() {
    document.querySelectorAll('.seg').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        state.mode = btn.dataset.mode;
        updateLegendForMode();
        applyMode();
      });
    });
    updateLegendForMode();
  }

  function updateLegendForMode() {
    const t = document.getElementById('legendTitle');
    const s = document.getElementById('legendScale');
    const bar = document.getElementById('legendBar');
    const extra = document.querySelector('.legend-extra');

    if (state.mode === 'pct') {
      t.textContent = '% van gemeente geponst';
      s.innerHTML = '<span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>';
      bar.style.display = '';
      s.style.display = '';
      if (extra) extra.innerHTML = '<span class="sw sw-gray"></span> nog niet gestart';
    } else if (state.mode === 'abs') {
      t.textContent = 'absoluut geponst opp. (km²)';
      s.innerHTML = '<span>0</span><span>30</span><span>80</span><span>150</span><span>300+</span>';
      bar.style.display = '';
      s.style.display = '';
      if (extra) extra.innerHTML = '<span class="sw sw-gray"></span> nog niet gestart';
    } else if (state.mode === 'cnt') {
      t.textContent = 'aantal ponsen per gemeente';
      s.innerHTML = '<span>0</span><span>2</span><span>5</span><span>10</span><span>40+</span>';
      bar.style.display = '';
      s.style.display = '';
      if (extra) extra.innerHTML = '<span class="sw sw-gray"></span> nog niet gestart';
    } else {
      // pons-mode
      t.textContent = 'individuele pons-polygonen';
      bar.style.display = 'none';
      s.style.display = 'none';
      if (extra) extra.innerHTML =
        '<span class="sw" style="background:#1F6B43;opacity:0.55"></span> pons (geponst gebied)' +
        '<br><span class="sw" style="background:#E0EAE4;margin-top:4px"></span> gemeente waarin reeds is geponst' +
        '<br><span class="sw sw-gray" style="margin-top:4px"></span> nog niet gestart';
    }
  }

  // ============ Tooltip ============
  function showTooltip(f, point) {
    const tt = document.getElementById('tooltip');
    const pct = f.properties.pct;
    document.getElementById('ttName').textContent = f.properties.name;
    document.getElementById('ttPct').textContent = formatPct(pct);
    const d = f.properties.delta;
    document.getElementById('ttDelta').textContent =
      (d > 0 ? '+' : '') + NL_FORMAT_2.format(d) + ' pp';
    document.getElementById('ttCount').textContent = NL_FORMAT.format(f.properties.ponsCount);
    tt.hidden = false;
    const mapRect = document.getElementById('map').getBoundingClientRect();
    let x = point.clientX - mapRect.left + 14;
    let y = point.clientY - mapRect.top + 14;
    if (x + 220 > mapRect.width) x = (point.clientX - mapRect.left) - 220;
    if (y + 110 > mapRect.height) y = (point.clientY - mapRect.top) - 110;
    tt.style.left = Math.max(8, x) + 'px';
    tt.style.top = Math.max(8, y) + 'px';
  }
  function hideTooltip() { document.getElementById('tooltip').hidden = true; }

  // ============ Selection ============
  function selectGemeente(name, opts) {
    opts = opts || {};
    const f = state.byName.get(name);
    if (!f) return;

    state.selected = name;
    state.map.select(name);

    renderPanelGemeente(name);
    if (window._renderLeaderboard) {
      const activeTab = document.querySelector('.lb-tab.active');
      window._renderLeaderboard(activeTab ? activeTab.dataset.lb : 'top');
    }
    updateUrlFromState();

    if (opts.zoom !== false) {
      state.map.flyToFeature(name);
    }
  }

  function deselect() {
    state.selected = null;
    state.map.deselect();
    renderPanelNational();
    if (window._renderLeaderboard) {
      const activeTab = document.querySelector('.lb-tab.active');
      window._renderLeaderboard(activeTab ? activeTab.dataset.lb : 'top');
    }
    updateUrlFromState();
    state.map.flyHome();
  }

  // ============ Right panel: national ============
  function renderPanelNational() {
    state.selected = null;
    const a = state.agg;
    const deltaCls = a.delta > 0.005 ? 'up' : a.delta < -0.005 ? 'down' : 'flat';

    const movers = topMovers(5);

    document.getElementById('panel').innerHTML = `
      <div class="panel-head">
        <div class="panel-eyebrow">Overzicht</div>
        <h1 class="panel-title">Heel Nederland</h1>
        <div class="panel-subtitle">${NL_FORMAT.format(state.features.length)} gemeenten · stand ${NL_DATE_LONG.format(TODAY)}</div>
      </div>
      <div class="panel-body">
        <div class="headline-stat">
          <span class="hs-value">${formatPctNum(a.pct)}</span>
          <span class="hs-unit">% geponst</span>
          <span class="delta ${deltaCls} hs-delta">${(a.delta >= 0 ? '+' : '')}${NL_FORMAT_2.format(a.delta)} pp</span>
        </div>

        <div class="stat-grid">
          <div class="stat-cell">
            <div class="sc-label">Geponst opp.</div>
            <div class="sc-value">${NL_FORMAT.format(Math.round(a.sumAbs))} km²</div>
            <div class="sc-sub">van ${NL_FORMAT.format(Math.round(a.totalArea))} km² totaal</div>
          </div>
          <div class="stat-cell">
            <div class="sc-label">Ponsen totaal</div>
            <div class="sc-value">${NL_FORMAT.format(a.totalPons)}</div>
            <div class="sc-sub">over ${a.started} gemeenten</div>
          </div>
          <div class="stat-cell">
            <div class="sc-label">Gestart</div>
            <div class="sc-value">${a.started} <span style="font-size:12px;color:var(--ink-muted);font-weight:500">/ 342</span></div>
            <div class="sc-sub">${Math.round(a.started / 342 * 100)}% van gemeenten</div>
          </div>
          <div class="stat-cell">
            <div class="sc-label">Klaar (≥ 95%)</div>
            <div class="sc-value">${a.done} <span style="font-size:12px;color:var(--ink-muted);font-weight:500">/ 342</span></div>
            <div class="sc-sub">${Math.round(a.done / 342 * 100)}% van gemeenten</div>
          </div>
        </div>

        <div>
          <div class="section-head"><span>Per provincie</span><span style="font-family:var(--mono);font-size:10px;color:var(--ink-faint)">% geponst</span></div>
          <div class="prov-list">
            ${state.provinces.map(p => `
              <div class="prov-row">
                <span class="prov-name">${escapeHtml(p.name)}</span>
                <div class="prov-bar"><div class="prov-bar-fill" style="width:${Math.max(1, p.pct)}%; background:${colorForPct(p.pct)}"></div></div>
                <span class="prov-pct">${formatPct(p.pct)}</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div>
          <div class="section-head"><span>Grootste stijgers afgelopen maand</span><span style="font-family:var(--mono);font-size:10px;color:var(--ink-faint)">Δ pp</span></div>
          <div class="punch-list">
            ${movers.map((m, i) => `
              <div class="punch-row" data-name="${escapeAttr(m.name)}" style="cursor:pointer">
                <span class="punch-idx">${String(i + 1).padStart(2, '0')}</span>
                <span class="punch-name">${escapeHtml(m.name)} <span style="color:var(--ink-faint);font-size:11px">· ${escapeHtml(m.province)}</span></span>
                <span class="punch-date">+${NL_FORMAT_2.format(m.delta)} pp</span>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="disclaimer">
          Demo-data, gegenereerd uit een reproduceerbare seed. Productie-versie sluit aan op DSO (Digitaal Stelsel Omgevingswet) en Kadaster-WFS. Wro = oude bestemmingsplannen, omgevingsplan = nieuw regime onder de Omgevingswet (verplicht klaar vóór 1 januari 2032).
        </div>
      </div>
    `;

    document.querySelectorAll('.punch-row[data-name]').forEach(row => {
      row.addEventListener('click', () => selectGemeente(row.dataset.name, { zoom: true }));
    });
  }

  function topMovers(n) {
    return state.features
      .map(f => ({
        name: f.properties.name,
        province: f.properties.province,
        delta: f.properties.delta || 0
      }))
      .filter(x => x.delta > 0.05)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, n);
  }

  // ============ Right panel: gemeente ============
  function renderPanelGemeente(name) {
    const f = state.byName.get(name);
    if (!f) { renderPanelNational(); return; }
    state.selected = name;

    const pct = f.properties.pct;
    const delta = f.properties.delta || 0;
    const deltaCls = delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'flat';
    const ponsedAreaAtT = pct / 100 * f.properties.areaKm2;

    let punchListHtml = '';
    const overheidscode = f.properties.overheidscode;
    const gemPolys = (state.ponsPolygons || []).filter(
      p => p.properties.bronhouder === overheidscode
    );
    if (gemPolys.length > 0) {
      punchListHtml = `
        <div>
          <div class="section-head"><span>Ponsen in ${escapeHtml(name)}</span><span style="font-family:var(--mono);font-size:10px;color:var(--ink-faint)">${gemPolys.length} ${gemPolys.length === 1 ? 'pons' : 'ponsen'} · zoom in voor polygonen</span></div>
          <div class="punch-list">
            ${gemPolys.map((p, i) => `
              <div class="punch-row">
                <span class="punch-idx">${String(i + 1).padStart(2, '0')}</span>
                <span class="punch-name">${escapeHtml((p.properties.pons_id || '').split('.').slice(-1)[0])}</span>
                <span class="punch-date">${NL_FORMAT_1.format(p.properties.opp_km2)} km²</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    } else if (f.properties.ponsCount > 0) {
      punchListHtml = `
        <div class="disclaimer" style="border-style:solid;background:var(--bg);">
          <b>${escapeHtml(name)}</b> heeft ${f.properties.ponsCount} ${f.properties.ponsCount === 1 ? 'pons' : 'ponsen'} volgens de statistieken, maar de polygonen zijn op dit moment niet beschikbaar.
        </div>
      `;
    } else {
      punchListHtml = `
        <div class="disclaimer" style="border-style:solid;background:var(--bg);">
          ${escapeHtml(name)} is nog niet gestart met ponsen. Het oude regime (Wro-bestemmingsplannen) is hier volledig nog van kracht.
        </div>
      `;
    }

    document.getElementById('panel').innerHTML = `
      <div class="panel-head">
        <div class="panel-eyebrow">
          <button class="panel-back" id="panelBack">← Heel Nederland</button>
          <span style="margin-left:auto;color:var(--ink-faint)">${escapeHtml(f.properties.province)}</span>
        </div>
        <h1 class="panel-title">${escapeHtml(name)}</h1>
        <div class="panel-subtitle">stand ${NL_DATE_LONG.format(TODAY)}</div>
      </div>
      <div class="panel-body">
        <div class="headline-stat">
          <span class="hs-value">${formatPctNum(pct)}</span>
          <span class="hs-unit">% geponst</span>
          <span class="delta ${deltaCls} hs-delta">${(delta >= 0 ? '+' : '')}${NL_FORMAT_2.format(delta)} pp</span>
        </div>

        <div class="stat-grid">
          <div class="stat-cell">
            <div class="sc-label">Ponsen</div>
            <div class="sc-value">${NL_FORMAT.format(f.properties.ponsCount)}</div>
            <div class="sc-sub">cumulatief</div>
          </div>
          <div class="stat-cell">
            <div class="sc-label">Geponst opp.</div>
            <div class="sc-value">${NL_FORMAT_1.format(ponsedAreaAtT)} km²</div>
            <div class="sc-sub">van ${NL_FORMAT.format(f.properties.areaKm2)} km²</div>
          </div>
        </div>

        ${punchListHtml}

        <a class="dso-link" href="https://omgevingswet.overheid.nl/regels-op-de-kaart/" target="_blank" rel="noopener">
          Bekijk in DSO Viewer →
        </a>
      </div>
    `;

    const back = document.getElementById('panelBack');
    if (back) back.addEventListener('click', deselect);
  }

  // ============ Search ============
  function setupSearch() {
    const input = document.getElementById('search');
    const results = document.getElementById('searchResults');
    let activeIdx = -1;
    let matches = [];

    function close() {
      results.hidden = true;
      activeIdx = -1;
    }
    function open() {
      if (matches.length) results.hidden = false;
    }
    function commit(name) {
      input.value = name;
      close();
      selectGemeente(name, { zoom: true });
    }

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }

      if (/^\d{4}/.test(q)) {
        results.innerHTML = `<div class="search-result" style="cursor:default">
          <span class="sr-name" style="color:var(--ink-muted)">Postcode-zoek niet beschikbaar in deze demo</span>
        </div>`;
        results.hidden = false;
        return;
      }

      matches = state.features
        .filter(f => f.properties.name.toLowerCase().includes(q))
        .sort((a, b) => {
          const ai = a.properties.name.toLowerCase().indexOf(q);
          const bi = b.properties.name.toLowerCase().indexOf(q);
          return ai - bi || a.properties.name.localeCompare(b.properties.name);
        })
        .slice(0, 12);

      if (!matches.length) {
        results.innerHTML = `<div class="search-result" style="cursor:default">
          <span class="sr-name" style="color:var(--ink-muted)">Geen resultaten voor "${escapeHtml(q)}"</span>
        </div>`;
        results.hidden = false;
        return;
      }

      results.innerHTML = matches.map((f, i) => `
        <div class="search-result${i === 0 ? ' active' : ''}" data-name="${escapeAttr(f.properties.name)}">
          <span class="sr-name">${highlight(f.properties.name, q)}</span>
          <span class="sr-prov">${escapeHtml(f.properties.province)}</span>
          <span class="sr-pct">${formatPct(f.properties.pct)}</span>
        </div>
      `).join('');
      activeIdx = 0;
      results.querySelectorAll('.search-result[data-name]').forEach((el, i) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(el.dataset.name);
        });
        el.addEventListener('mouseenter', () => {
          results.querySelectorAll('.search-result').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          activeIdx = i;
        });
      });
      open();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        activeIdx = Math.min(matches.length - 1, activeIdx + 1);
        repaintActive();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        activeIdx = Math.max(0, activeIdx - 1);
        repaintActive();
        e.preventDefault();
      } else if (e.key === 'Enter' && matches[activeIdx]) {
        commit(matches[activeIdx].properties.name);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        close();
      }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    function repaintActive() {
      results.querySelectorAll('.search-result').forEach((el, i) =>
        el.classList.toggle('active', i === activeIdx));
    }
  }

  function highlight(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escapeHtml(text);
    return escapeHtml(text.slice(0, i))
      + '<b>' + escapeHtml(text.slice(i, i + q.length)) + '</b>'
      + escapeHtml(text.slice(i + q.length));
  }

  // ============ URL routing ============
  function setupRouting() {
    window.addEventListener('hashchange', applyUrl);
    applyUrl();
  }
  function applyUrl() {
    const h = location.hash.replace(/^#\/?/, '');
    if (!h) {
      if (state.selected) deselect();
      return;
    }
    const m = h.match(/^gemeente\/(.+)$/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (state.byName.has(name) && state.selected !== name) {
        selectGemeente(name, { zoom: true });
      }
    }
  }
  function updateUrlFromState(opts) {
    opts = opts || {};
    const want = state.selected ? '#/gemeente/' + encodeURIComponent(state.selected) : '#/';
    if (location.hash !== want) {
      if (opts.replace) {
        history.replaceState(null, '', want);
      } else {
        history.pushState(null, '', want);
      }
    }
  }

  // ============ Utils ============
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ============ Boot ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

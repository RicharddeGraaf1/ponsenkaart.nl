// ============================================================
// Ponsenkaart data layer — leest uit OCD-API
// - GET /v1/ponsenkaart/gemeenten  → choropleth + per-gemeente stats
// - GET /v1/ponsenkaart/ponsen     → individuele pons-polygonen
//
// Bij ontbreken/uitval van de API valt deze laag terug op een minimale
// fallback (geen mock-statistieken, alleen "nog niet beschikbaar").
// ============================================================

(function () {
  'use strict';

  const API_BASE = (window.OCD_API_BASE || 'http://localhost:8002');
  const API_KEY  = (window.OCD_API_KEY  || '');

  const PROVINCES = [
    'Groningen','Fryslân','Drenthe','Overijssel','Flevoland',
    'Gelderland','Utrecht','Noord-Holland','Zuid-Holland','Zeeland',
    'Noord-Brabant','Limburg'
  ];

  // ─────────────────────────────────────────────────────────────────
  // HTTP helper
  // ─────────────────────────────────────────────────────────────────

  async function apiGet(path) {
    const headers = {};
    if (API_KEY) headers['X-Api-Key'] = API_KEY;
    const res = await fetch(API_BASE + path, { headers });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // ─────────────────────────────────────────────────────────────────
  // Per-gemeente stats (geen temporale dimensie tot G-72 is opgelost)
  // ─────────────────────────────────────────────────────────────────

  function featurePropsFromApi(p) {
    const pct = p.pct || 0;
    const areaKm2 = p.gemeente_opp_km2 || 0;
    const absKm2 = p.geponst_opp_km2 || 0;
    return {
      // Stabiele namen die app.js verwacht:
      name: p.naam,
      province: p.provincie,
      pct: +pct.toFixed(2),
      // Δ vorige maand: nog niet bekend (G-72). Vast op 0 zodat
      // de delta-tooltip "0.00 pp" toont in plaats van neppe data.
      delta: 0,
      ponsCount: p.pons_count || 0,
      areaKm2: areaKm2,
      absKm2: absKm2,
      started: (p.pons_count || 0) > 0,
      done: pct >= 95,
      // Pons-datum onbekend (G-72) — chart toont vlakke lijn:
      firstPonsMonth: (p.pons_count || 0) > 0 ? 0 : null,
      // Extra OCD-velden:
      overheidscode: p.overheidscode,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Tijdserie (statisch tot pons-datum-uitbreiding G-72)
  //
  // Returns een vlakke historie op huidige pct + lineaire projectie
  // naar 100% in 2032. Géén verzonnen S-curve over historie.
  // ─────────────────────────────────────────────────────────────────

  function timeseries(stats) {
    const start = new Date(2024, 0, 1);
    const now = new Date(2026, 4, 18);
    const deadline = new Date(2032, 0, 1);

    function monthsBetween(a, b) {
      return (b.getFullYear() - a.getFullYear()) * 12
           + (b.getMonth() - a.getMonth());
    }

    const months = [];
    const d = new Date(start);
    while (d <= deadline) {
      months.push({ year: d.getFullYear(), month: d.getMonth(), date: new Date(d) });
      d.setMonth(d.getMonth() + 1);
    }
    const nowIdx = monthsBetween(start, now);
    const totalIdx = months.length - 1;
    const pct = stats.pct || 0;

    const series = [];
    for (let i = 0; i < months.length; i++) {
      let v;
      if (i <= nowIdx) {
        // Geen historische data — vlakke lijn op huidige pct (vanaf 0)
        v = stats.started ? pct : 0;
      } else {
        // Lineaire projectie naar 100% op deadline
        const t = (i - nowIdx) / Math.max(1, (totalIdx - nowIdx));
        v = pct + (100 - pct) * Math.min(1, t);
      }
      series.push({
        idx: i,
        year: months[i].year,
        month: months[i].month,
        date: months[i].date,
        pct: +v.toFixed(2),
        projection: i > nowIdx,
      });
    }
    return { months, series, nowIdx, totalMonths: totalIdx };
  }

  // ─────────────────────────────────────────────────────────────────
  // Aggregaten (lokaal berekend uit features)
  // ─────────────────────────────────────────────────────────────────

  function aggregate(allStats) {
    let started = 0, done = 0, sumAbs = 0, totalArea = 0, totalPons = 0;
    for (const s of allStats) {
      if (s.started) started++;
      if (s.done) done++;
      sumAbs += s.absKm2;
      totalArea += s.areaKm2;
      totalPons += s.ponsCount;
    }
    const pct = totalArea > 0 ? (sumAbs / totalArea) * 100 : 0;
    return {
      pct: +pct.toFixed(2),
      delta: 0, // G-72
      started,
      done,
      totalPons,
      totalArea: Math.round(totalArea),
      ponsedArea: Math.round(sumAbs),
    };
  }

  function provinceAggregates(features) {
    const m = {};
    for (const f of features) {
      const p = f.properties.province;
      if (!p) continue;
      if (!m[p]) m[p] = { name: p, count: 0, started: 0, done: 0,
                         sumAbs: 0, totalArea: 0 };
      m[p].count++;
      if (f.properties.started) m[p].started++;
      if (f.properties.done) m[p].done++;
      m[p].sumAbs += f.properties.absKm2;
      m[p].totalArea += f.properties.areaKm2;
    }
    return Object.values(m)
      .map(p => ({
        name: p.name,
        count: p.count,
        started: p.started,
        done: p.done,
        pct: p.totalArea > 0 ? +(p.sumAbs / p.totalArea * 100).toFixed(2) : 0,
      }))
      .sort((a, b) => b.pct - a.pct);
  }

  // ─────────────────────────────────────────────────────────────────
  // GeoJSON loaders
  // ─────────────────────────────────────────────────────────────────

  async function loadGeoJSON() {
    const gj = await apiGet('/v1/ponsenkaart/gemeenten');
    if (!gj || !Array.isArray(gj.features)) {
      throw new Error('Onverwacht response-formaat van /gemeenten');
    }

    // Numerieke id's voor map.js (hover/select doet +parseInt op data-id).
    // De OCD-overheidscode (gm0307) blijft in properties.overheidscode beschikbaar.
    const features = gj.features.map((f, i) => ({
      type: 'Feature',
      id: i + 1,
      geometry: f.geometry,
      properties: featurePropsFromApi(f.properties),
    }));

    return {
      features,
      source: API_BASE + '/v1/ponsenkaart/gemeenten',
      mode: 'ocd',
    };
  }

  async function loadPonsPolygons(gemeenteOverheidscode) {
    const path = gemeenteOverheidscode
      ? `/v1/ponsenkaart/ponsen?gemeente=${encodeURIComponent(gemeenteOverheidscode)}`
      : '/v1/ponsenkaart/ponsen';
    const gj = await apiGet(path);
    if (!gj || !Array.isArray(gj.features)) return [];
    return gj.features;
  }

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  window.Ponsen = {
    PROVINCES,
    timeseries,
    aggregate,
    provinceAggregates,
    loadGeoJSON,
    loadPonsPolygons,
  };
})();

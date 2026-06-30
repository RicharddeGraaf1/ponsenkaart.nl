// ============================================================
// Ponsenkaart.nl — RP-planvoorraad data layer
// Leest uit de OCD-API /v1/planvoorraad/* (geen statische dummy meer).
//   GET /v1/planvoorraad/national   → KPI's + snapshot-tijdas
//   GET /v1/planvoorraad/gemeenten  → per-gemeente aggregaten (incl. lege)
//   GET /v1/planvoorraad/{code}     → plannen + presence-tijdlijn (lazy)
//
// Classificatie v1: WEG (verwijderd) / AANWEZIG. Per-gemeente plannen worden
// pas geladen bij selectie (er zijn tienduizenden plannen landelijk).
// ============================================================
(function () {
  'use strict';

  const API_BASE = (window.OCD_API_BASE || 'http://localhost:8002');
  const API_KEY  = (window.OCD_API_KEY  || '');

  async function apiGet(path) {
    const headers = {};
    if (API_KEY) headers['X-Api-Key'] = API_KEY;
    const res = await fetch(API_BASE + path, { headers });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // Visuele identiteit van de classificaties (v1: 2 klassen).
  const CLASS = {
    WEG:      { key: 'WEG',      label: 'Weggehaald', kort: 'Weggehaald', kleur: 'green', glyph: '✓' },
    AANWEZIG: { key: 'AANWEZIG', label: 'Aanwezig',   kort: 'Aanwezig',   kleur: 'gray',  glyph: '●' },
  };

  // Planstatus-waarden zoals de RP-Opvragen API ze levert (lowercase).
  const PLANSTATUS = [
    { key: 'onherroepelijk', kleur: 'ink',    on: true },
    { key: 'vastgesteld',    kleur: 'green',  on: true },
    { key: 'geconsolideerd', kleur: 'gray',   on: true },
    { key: 'ontwerp',        kleur: 'yellow', on: false },
  ];

  // ─────────────────────────────────────────────────────────────────
  // Init: nationale KPI's + gemeentelijst (zonder plannen)
  // ─────────────────────────────────────────────────────────────────
  async function init() {
    const [nat, gem] = await Promise.all([
      apiGet('/v1/planvoorraad/national'),
      apiGet('/v1/planvoorraad/gemeenten'),
    ]);

    RPData.SNAPSHOTS = nat.snapshots || [];
    RPData.N = RPData.SNAPSHOTS.length;
    RPData.peildatum = nat.peildatum;
    RPData.NATIONAL = {
      inVoorraad: nat.in_voorraad,
      // Afname van de voorraad is de gewenste richting → toon als negatieve delta.
      inVoorraadDelta: -(nat.weg_deze_snapshot || 0),
      sindsStartVerdwenen: nat.sinds_start_verdwenen,
      wegDezeSnapshot: nat.weg_deze_snapshot,
      gemeentenLeeg: nat.gemeenten_leeg,
      gemeentenTotaal: nat.gemeenten_totaal,
    };

    RPData.GEMEENTEN = (gem || []).map(g => ({
      naam: g.naam, code: g.code, provincie: g.provincie,
      plansNu: g.plans_nu, verdwenen: g.verdwenen, pctAf: g.pct_af,
      leeg: g.leeg, stip: g.stip,
      bronhouder: null, leegSinds: null,
      plans: null,            // lazy
    }));

    return RPData;
  }

  // ─────────────────────────────────────────────────────────────────
  // Lazy: plannen + presence-tijdlijn van één gemeente
  // ─────────────────────────────────────────────────────────────────
  async function ensurePlans(g) {
    if (!g || g.plans) return g;
    const d = await apiGet('/v1/planvoorraad/' + encodeURIComponent(g.code));
    g.bronhouder = d.bronhouder;
    g.plans = (d.plans || []).map(p => ({
      id: p.id,
      titel: p.titel,
      dossier: p.dossier,
      planstatus: (p.planstatus || '').toLowerCase(),
      dossierstatus: p.dossierstatus,
      classificatie: p.classificatie,
      presence: p.presence,
      wegIdx: p.weg_idx,
      wegDatum: p.weg_datum,
      startDatum: p.start_datum,
    }));
    // Synchroniseer aggregaten met de detail-respons.
    g.plansNu = d.plans_nu;
    g.verdwenen = d.verdwenen;
    g.pctAf = d.pct_af;
    g.leeg = d.leeg;
    return g;
  }

  window.RPData = {
    CLASS, PLANSTATUS,
    init, ensurePlans,
    SNAPSHOTS: [], N: 0, GEMEENTEN: [], NATIONAL: null, peildatum: null,
  };
})();

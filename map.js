// ============================================================
// MapLibre-backed PonsMap voor Ponsenkaart.nl
//
// Vorige iteratie was een zelf-gebouwde SVG-renderer (Web Mercator,
// viewBox pan/zoom). Daar misten we een echt-kaart-gevoel: geen
// steden/wegen/water, alleen polygonen op een dot-grid.
//
// Nu: MapLibre GL JS met PDOK BRT-Achtergrondkaart (grijs) als raster-
// basemap + onze data als GeoJSON-layers erbovenop. Public interface
// is bewust gelijk gehouden aan de oude PonsMap zodat app.js niet
// hoefde te veranderen.
// ============================================================

(function () {
  'use strict';

  // PDOK BRT-Achtergrondkaart (Kadaster, gratis WMTS). Variant 'grijs'
  // houdt de basemap rustig zodat de choropleth visueel kan domineren.
  // Andere varianten beschikbaar: standaard, pastel, water.
  const PDOK_TILES = [
    'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png'
  ];

  const ATTRIBUTION =
    'Kaartgegevens © <a href="https://www.pdok.nl/" target="_blank" rel="noopener">Kadaster / PDOK</a>';

  // Bbox rond NL voor initiele view en hard-stop op pannen
  const NL_BOUNDS = [[3.0, 50.6], [7.5, 53.7]];
  const MAX_BOUNDS = [[1.5, 49.5], [9.5, 54.5]];

  class PonsMap {
    constructor(container) {
      this.container = container;
      this.features = [];
      this.byIdMap = new Map();
      this.byNameMap = new Map();
      this.handlers = { hover: null, click: null, leave: null };
      this.styleFn = () => '#B8B2A8';
      this.selectedId = null;
      this.hoverId = null;
      this.ponsAlwaysVisible = false;
      this._loaded = false;
      this._pendingFeatures = null;
      this._pendingPons = null;

      this._initMap();
    }

    _initMap() {
      this.map = new maplibregl.Map({
        container: this.container,
        style: {
          version: 8,
          sources: {
            'pdok-brt': {
              type: 'raster',
              tiles: PDOK_TILES,
              tileSize: 256,
              attribution: ATTRIBUTION
            }
          },
          layers: [{ id: 'pdok-brt-base', type: 'raster', source: 'pdok-brt' }]
        },
        bounds: NL_BOUNDS,
        fitBoundsOptions: { padding: 20 },
        minZoom: 6,
        maxZoom: 14,
        maxBounds: MAX_BOUNDS,
        attributionControl: { compact: true }
      });

      this.map.on('load', () => this._onLoad());
    }

    _onLoad() {
      this._loaded = true;

      this.map.addSource('gemeenten', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      this.map.addSource('ponsen', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      // Choropleth-fill (semi-transparant zodat basemap doorschijnt)
      this.map.addLayer({
        id: 'gemeenten-fill',
        source: 'gemeenten',
        type: 'fill',
        paint: {
          'fill-color': ['coalesce', ['get', '_fillColor'], '#B8B2A8'],
          'fill-opacity': ['case',
            ['boolean', ['feature-state', 'selected'], false], 0.85,
            ['boolean', ['feature-state', 'hover'], false], 0.85,
            0.55
          ]
        }
      });

      // Gemeente-grens (hover/select highlight)
      this.map.addLayer({
        id: 'gemeenten-line',
        source: 'gemeenten',
        type: 'line',
        paint: {
          'line-color': ['case',
            ['boolean', ['feature-state', 'selected'], false], '#1a1a17',
            ['boolean', ['feature-state', 'hover'], false], '#1a1a17',
            '#ffffff'
          ],
          'line-width': ['case',
            ['boolean', ['feature-state', 'selected'], false], 2,
            ['boolean', ['feature-state', 'hover'], false], 1.4,
            0.6
          ]
        }
      });

      // Pons-polygonen (eigen kleur, default verborgen; toggle via setAlwaysShowPons)
      this.map.addLayer({
        id: 'ponsen-fill',
        source: 'ponsen',
        type: 'fill',
        paint: {
          'fill-color': '#1F6B43',
          'fill-opacity': 0.6,
          'fill-outline-color': '#0d4d2f'
        },
        layout: { visibility: this.ponsAlwaysVisible ? 'visible' : 'none' }
      });

      this._installInteractions();

      if (this._pendingFeatures) {
        this.setFeatures(this._pendingFeatures);
        this._pendingFeatures = null;
      }
      if (this._pendingPons) {
        this.setPonsPolygons(this._pendingPons);
        this._pendingPons = null;
      }
    }

    _installInteractions() {
      const canvas = this.map.getCanvas();

      this.map.on('mousemove', 'gemeenten-fill', (e) => {
        if (!e.features.length) return;
        const id = e.features[0].id;
        if (this.hoverId !== id) {
          if (this.hoverId != null) {
            this.map.setFeatureState({ source: 'gemeenten', id: this.hoverId }, { hover: false });
          }
          this.hoverId = id;
          this.map.setFeatureState({ source: 'gemeenten', id }, { hover: true });
        }
        if (this.handlers.hover) {
          const feature = this.byIdMap.get(id);
          if (feature) this.handlers.hover(feature, e.originalEvent);
        }
        canvas.style.cursor = 'pointer';
      });

      this.map.on('mouseleave', 'gemeenten-fill', () => {
        if (this.hoverId != null) {
          this.map.setFeatureState({ source: 'gemeenten', id: this.hoverId }, { hover: false });
          this.hoverId = null;
        }
        if (this.handlers.leave) this.handlers.leave();
        canvas.style.cursor = '';
      });

      this.map.on('click', 'gemeenten-fill', (e) => {
        if (!e.features.length) return;
        const name = e.features[0].properties.name;
        if (this.handlers.click) this.handlers.click(name, e.originalEvent);
      });

      // Klik op lege ruimte = deselect
      this.map.on('click', (e) => {
        const hits = this.map.queryRenderedFeatures(e.point, { layers: ['gemeenten-fill'] });
        if (!hits.length && this.handlers.click) {
          this.handlers.click(null, e.originalEvent);
        }
      });
    }

    on(name, fn) { this.handlers[name] = fn; }

    setFeatures(features) {
      if (!this._loaded) { this._pendingFeatures = features; return; }
      this.features = features;
      this.byIdMap.clear();
      this.byNameMap.clear();

      for (const f of features) {
        f.properties._fillColor = this.styleFn(f);
        this.byIdMap.set(f.id, f);
        this.byNameMap.set(f.properties.name, f);
      }
      this.map.getSource('gemeenten').setData({ type: 'FeatureCollection', features });
    }

    setStyleFn(fn) { this.styleFn = fn; }

    refresh() {
      if (!this._loaded || !this.features.length) return;
      for (const f of this.features) {
        f.properties._fillColor = this.styleFn(f);
      }
      this.map.getSource('gemeenten').setData({ type: 'FeatureCollection', features: this.features });
    }

    setPonsPolygons(features) {
      if (!this._loaded) { this._pendingPons = features; return; }
      this.map.getSource('ponsen').setData({ type: 'FeatureCollection', features });
    }

    showPons(visible) { this.setAlwaysShowPons(visible); }

    setAlwaysShowPons(visible) {
      this.ponsAlwaysVisible = visible;
      if (this._loaded) {
        this.map.setLayoutProperty('ponsen-fill', 'visibility', visible ? 'visible' : 'none');
      }
    }

    byId(id) {
      return this.byIdMap.get(id) || null;
    }

    select(name) {
      const f = this.byNameMap.get(name);
      if (!f) return;
      if (this.selectedId != null && this.selectedId !== f.id) {
        this.map.setFeatureState({ source: 'gemeenten', id: this.selectedId }, { selected: false });
      }
      this.selectedId = f.id;
      this.map.setFeatureState({ source: 'gemeenten', id: f.id }, { selected: true });
    }

    deselect() {
      if (this.selectedId != null) {
        this.map.setFeatureState({ source: 'gemeenten', id: this.selectedId }, { selected: false });
        this.selectedId = null;
      }
    }

    flyToFeature(name) {
      const f = this.byNameMap.get(name);
      if (!f) return;
      const b = this._bboxOfGeometry(f.geometry);
      this.map.fitBounds([[b.minX, b.minY], [b.maxX, b.maxY]], {
        padding: 60,
        maxZoom: 12,
        duration: 700
      });
    }

    flyHome() {
      this.map.fitBounds(NL_BOUNDS, { padding: 20, duration: 700 });
    }

    _bboxOfGeometry(geom) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const walk = (c) => {
        if (typeof c[0] === 'number') {
          if (c[0] < minX) minX = c[0];
          if (c[1] < minY) minY = c[1];
          if (c[0] > maxX) maxX = c[0];
          if (c[1] > maxY) maxY = c[1];
        } else {
          for (const cc of c) walk(cc);
        }
      };
      walk(geom.coordinates);
      return { minX, minY, maxX, maxY };
    }
  }

  window.PonsMap = PonsMap;
})();

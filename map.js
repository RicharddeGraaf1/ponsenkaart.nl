// ============================================================
// SVG choropleth map for Ponsenkaart
// - Web Mercator projection
// - viewBox-based pan/zoom
// - per-feature fill driven by application state
// ============================================================

(function () {
  'use strict';

  function project(lon, lat) {
    const x = lon;
    const rad = lat * Math.PI / 180;
    const y = -Math.log(Math.tan(Math.PI / 4 + rad / 2)) * 180 / Math.PI;
    return [x, y];
  }

  function ringToPath(ring) {
    let s = '';
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = project(ring[i][0], ring[i][1]);
      s += (i === 0 ? 'M' : 'L') + x.toFixed(4) + ',' + y.toFixed(4);
    }
    return s + 'Z';
  }
  function geometryToPath(g) {
    if (g.type === 'Polygon') {
      return g.coordinates.map(ringToPath).join('');
    }
    if (g.type === 'MultiPolygon') {
      return g.coordinates.map(rings => rings.map(ringToPath).join('')).join('');
    }
    return '';
  }
  function bboxOfGeom(g, out) {
    out = out || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    function walk(c) {
      if (typeof c[0] === 'number') {
        const [x, y] = project(c[0], c[1]);
        if (x < out.minX) out.minX = x;
        if (y < out.minY) out.minY = y;
        if (x > out.maxX) out.maxX = x;
        if (y > out.maxY) out.maxY = y;
      } else {
        for (const cc of c) walk(cc);
      }
    }
    walk(g.coordinates);
    return out;
  }

  function svg(tag, attrs, parent) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }

  class PonsMap {
    constructor(container) {
      this.container = container;
      this.features = [];
      this.paths = new Map();  // id -> path element
      this.bbox = null;
      this.view = { x: 0, y: 0, w: 1, h: 1 };
      this.home = null;
      this.handlers = { hover: null, click: null, leave: null };
      this.hoverId = null;
      this.selectedId = null;
      this.styleFn = () => '#B8B2A8';
      this._raf = null;
      this._alwaysShowPons = false;
    }

    on(name, fn) { this.handlers[name] = fn; }

    setFeatures(features) {
      this.features = features;
      this._render();
    }

    _render() {
      this.container.innerHTML = '';

      // SVG root
      const root = svg('svg', {
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'xMidYMid meet'
      });
      root.style.display = 'block';
      root.style.userSelect = 'none';
      root.style.cursor = 'grab';
      this.root = root;

      // Background hatching/dots already on container; svg is transparent
      // Defs (subtle grain pattern for the "not started" fill)
      const defs = svg('defs', {}, root);
      const pat = svg('pattern', {
        id: 'no-start-hatch', patternUnits: 'userSpaceOnUse',
        width: '0.06', height: '0.06', patternTransform: 'rotate(45)'
      }, defs);
      svg('rect', { width: '0.06', height: '0.06', fill: '#D6D2C7' }, pat);
      svg('line', { x1: 0, y1: 0, x2: 0, y2: '0.06', stroke: '#C2BCAF', 'stroke-width': '0.012' }, pat);

      // Compute bbox over all features
      const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const f of this.features) bboxOfGeom(f.geometry, bbox);
      const pad = 0.1;
      this.bbox = {
        x: bbox.minX - pad,
        y: bbox.minY - pad,
        w: (bbox.maxX - bbox.minX) + pad * 2,
        h: (bbox.maxY - bbox.minY) + pad * 2
      };
      this.home = { ...this.bbox };
      this.view = { ...this.bbox };
      this._applyView();

      // Group for all gemeente paths
      const g = svg('g', { id: 'gemeenten-layer' }, root);
      this.layer = g;

      for (const f of this.features) {
        const p = svg('path', {
          d: geometryToPath(f.geometry),
          fill: this.styleFn(f),
          stroke: '#ffffff',
          'stroke-width': '0.6',
          'stroke-linejoin': 'round',
          'vector-effect': 'non-scaling-stroke',
          'data-id': String(f.id),
          'data-name': f.properties.name
        }, g);
        p.style.cursor = 'pointer';
        p.style.transition = 'fill 180ms cubic-bezier(.2,.7,.2,1)';
        this.paths.set(f.id, p);
      }

      // City label group (overlay, big cities only)
      this.labelLayer = svg('g', { id: 'label-layer', 'pointer-events': 'none' }, root);
      this._renderLabels();

      // Pons polygons overlay (for Leiden detail)
      this.ponsLayer = svg('g', { id: 'pons-layer', 'pointer-events': 'none', opacity: '0' }, root);

      // Hover/click via event delegation
      g.addEventListener('pointermove', (e) => {
        if (e.target.tagName !== 'path') return;
        const id = +e.target.getAttribute('data-id');
        if (this.hoverId !== id) this._setHover(id);
        if (this.handlers.hover) this.handlers.hover(this.byId(id), e);
      });
      g.addEventListener('pointerleave', () => {
        this._setHover(null);
        if (this.handlers.leave) this.handlers.leave();
      });
      g.addEventListener('click', (e) => {
        if (e.target.tagName !== 'path') return;
        if (this._didPan) { this._didPan = false; return; }
        const name = e.target.getAttribute('data-name');
        if (this.handlers.click) this.handlers.click(name, e);
      });

      // Empty-area click handler (deselect)
      root.addEventListener('click', (e) => {
        if (this._didPan) { this._didPan = false; return; }
        if (e.target === root || e.target.tagName === 'rect') {
          if (this.handlers.click) this.handlers.click(null, e);
        }
      });

      this.container.appendChild(root);
      this._installPanZoom(root);
    }

    _renderLabels() {
      const layer = this.labelLayer;
      while (layer.firstChild) layer.removeChild(layer.firstChild);

      // pick known cities and place labels at polygon centroid
      const CITIES = new Set([
        'Amsterdam','Rotterdam','Den Haag','Utrecht','Eindhoven','Groningen',
        'Tilburg','Almere','Breda','Nijmegen','Maastricht','Leiden',
        'Leeuwarden','Zwolle','Apeldoorn','Arnhem','Enschede','Haarlem',
        'Middelburg','Assen'
      ]);
      for (const f of this.features) {
        if (!CITIES.has(f.properties.name)) continue;
        const c = this._centroid(f.geometry);
        if (!c) continue;
        const [cx, cy] = project(c[0], c[1]);
        const halo = svg('text', {
          x: cx, y: cy,
          'font-family': 'Inter, sans-serif',
          'font-size': '0.08',
          'font-weight': '600',
          fill: 'rgba(255,255,255,0.95)',
          stroke: 'rgba(255,255,255,0.95)',
          'stroke-width': '0.04',
          'text-anchor': 'middle',
          'paint-order': 'stroke fill'
        }, layer);
        halo.textContent = f.properties.name;
        const text = svg('text', {
          x: cx, y: cy,
          'font-family': 'Inter, sans-serif',
          'font-size': '0.08',
          'font-weight': '600',
          fill: '#1a1a17',
          'text-anchor': 'middle'
        }, layer);
        text.textContent = f.properties.name;
      }
      // Scale label font size to current zoom
      this._scaleLabels();
    }

    _scaleLabels() {
      // viewBox width vs container px width = base unit
      const scaleFactor = Math.max(0.3, Math.min(2.5, this.bbox.w / this.view.w));
      // Make labels readable at all zooms; smaller when zoomed in (less visual mess)
      const base = 0.10;
      const size = base / Math.max(0.6, scaleFactor);
      // Tweak per zoom: hide labels at very low zoom
      this.labelLayer.style.opacity = this.view.w > this.bbox.w * 0.85 ? '0.85' : '0.4';
      this.labelLayer.querySelectorAll('text').forEach(t => {
        t.setAttribute('font-size', size.toFixed(3));
        if (t.getAttribute('stroke') !== 'none' && t.getAttribute('stroke-width')) {
          t.setAttribute('stroke-width', (size * 0.45).toFixed(3));
        }
      });
    }

    _centroid(g) {
      // Approximate centroid of the largest polygon ring
      let best = null, bestArea = 0;
      const rings = g.type === 'Polygon' ? [g.coordinates[0]] :
        g.coordinates.map(r => r[0]);
      for (const r of rings) {
        let area = 0, cx = 0, cy = 0;
        for (let i = 0; i < r.length - 1; i++) {
          const [x1, y1] = r[i], [x2, y2] = r[i + 1];
          const cross = x1 * y2 - x2 * y1;
          area += cross;
          cx += (x1 + x2) * cross;
          cy += (y1 + y2) * cross;
        }
        area /= 2;
        if (Math.abs(area) > Math.abs(bestArea)) {
          bestArea = area;
          best = [cx / (6 * area), cy / (6 * area)];
        }
      }
      return best;
    }

    setStyleFn(fn) {
      this.styleFn = fn;
      // Repaint all
      for (const f of this.features) {
        const p = this.paths.get(f.id);
        if (p) p.setAttribute('fill', fn(f));
      }
    }

    refresh() {
      for (const f of this.features) {
        const p = this.paths.get(f.id);
        if (p) p.setAttribute('fill', this.styleFn(f));
      }
    }

    setPonsPolygons(features) {
      // Build overlay group children
      while (this.ponsLayer.firstChild) this.ponsLayer.removeChild(this.ponsLayer.firstChild);
      for (const f of features) {
        svg('path', {
          d: geometryToPath(f.geometry),
          fill: '#1F6B43',
          'fill-opacity': '0.55',
          stroke: '#ffffff',
          'stroke-width': '0.5',
          'vector-effect': 'non-scaling-stroke',
        }, this.ponsLayer);
      }
    }
    showPons(visible) {
      this.ponsLayer.style.opacity = visible ? '1' : '0';
    }
    setAlwaysShowPons(on) {
      this._alwaysShowPons = !!on;
      if (this.ponsLayer) {
        if (on) {
          this.ponsLayer.style.opacity = '1';
        } else {
          this._applyView();
        }
      }
    }

    byId(id) {
      return this.features.find(f => f.id === id) || null;
    }

    _setHover(id) {
      if (this.hoverId === id) return;
      if (this.hoverId !== null) {
        const prev = this.paths.get(this.hoverId);
        if (prev && +prev.getAttribute('data-id') !== this.selectedId) {
          prev.setAttribute('stroke-width', '0.6');
          prev.setAttribute('stroke', '#ffffff');
        }
      }
      this.hoverId = id;
      if (id !== null) {
        const cur = this.paths.get(id);
        if (cur) {
          cur.setAttribute('stroke-width', '1.6');
          cur.setAttribute('stroke', '#1a1a17');
          // bring to front
          if (cur.parentNode) cur.parentNode.appendChild(cur);
        }
      }
    }

    select(name) {
      if (this.selectedId !== null) {
        const prev = this.paths.get(this.selectedId);
        if (prev) {
          prev.setAttribute('stroke', '#ffffff');
          prev.setAttribute('stroke-width', '0.6');
        }
      }
      const f = this.features.find(ff => ff.properties.name === name);
      if (!f) return;
      this.selectedId = f.id;
      const p = this.paths.get(f.id);
      if (p) {
        p.setAttribute('stroke', '#1a1a17');
        p.setAttribute('stroke-width', '1.8');
        if (p.parentNode) p.parentNode.appendChild(p);
      }
    }
    deselect() {
      if (this.selectedId === null) return;
      const prev = this.paths.get(this.selectedId);
      if (prev) {
        prev.setAttribute('stroke', '#ffffff');
        prev.setAttribute('stroke-width', '0.6');
      }
      this.selectedId = null;
    }

    flyToFeature(name, opts) {
      opts = opts || {};
      const f = this.features.find(ff => ff.properties.name === name);
      if (!f) return;
      const b = bboxOfGeom(f.geometry);
      const pad = 0.06;
      let w = (b.maxX - b.minX) + pad * 2;
      let h = (b.maxY - b.minY) + pad * 2;
      // Maintain aspect of container
      const rect = this.container.getBoundingClientRect();
      const aspect = rect.width / rect.height;
      const targetAspect = w / h;
      if (targetAspect > aspect) h = w / aspect;
      else w = h * aspect;
      // Constrain max zoom in
      const minW = this.bbox.w * 0.04;
      if (w < minW) {
        const factor = minW / w;
        w *= factor; h *= factor;
      }
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      this._animateTo({ x: cx - w / 2, y: cy - h / 2, w, h });
    }

    flyHome() {
      this._animateTo(this.home);
    }

    _animateTo(target) {
      const from = { ...this.view };
      const dur = 600;
      const t0 = performance.now();
      if (this._raf) cancelAnimationFrame(this._raf);
      const step = (now) => {
        let t = Math.min(1, (now - t0) / dur);
        t = 1 - Math.pow(1 - t, 3);
        this.view = {
          x: from.x + (target.x - from.x) * t,
          y: from.y + (target.y - from.y) * t,
          w: from.w + (target.w - from.w) * t,
          h: from.h + (target.h - from.h) * t
        };
        this._applyView();
        if (t < 1) this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }

    _applyView() {
      const v = this.view;
      this.root.setAttribute('viewBox',
        v.x.toFixed(4) + ' ' + v.y.toFixed(4) + ' ' + v.w.toFixed(4) + ' ' + v.h.toFixed(4));
      if (this.labelLayer) this._scaleLabels();
      // Toggle Leiden polygons when zoomed enough (unless mode forces always-on)
      if (this.ponsLayer && !this._alwaysShowPons) {
        const visible = v.w < this.bbox.w * 0.12;
        this.ponsLayer.style.opacity = visible ? '1' : '0';
      }
    }

    _installPanZoom(root) {
      let isDown = false;
      let lastX = 0, lastY = 0;
      let startX = 0, startY = 0;

      root.addEventListener('pointerdown', (e) => {
        isDown = true;
        lastX = e.clientX; lastY = e.clientY;
        startX = e.clientX; startY = e.clientY;
        root.style.cursor = 'grabbing';
        root.setPointerCapture(e.pointerId);
      });
      root.addEventListener('pointermove', (e) => {
        if (!isDown) return;
        const rect = root.getBoundingClientRect();
        const scale = this.view.w / rect.width;
        const dx = (e.clientX - lastX) * scale;
        const dy = (e.clientY - lastY) * scale;
        this.view.x -= dx;
        this.view.y -= dy;
        this._applyView();
        lastX = e.clientX; lastY = e.clientY;
      });
      const release = (e) => {
        if (!isDown) return;
        isDown = false;
        root.style.cursor = 'grab';
        try { root.releasePointerCapture(e.pointerId); } catch (_) {}
        const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
        this._didPan = moved > 5;
      };
      root.addEventListener('pointerup', release);
      root.addEventListener('pointercancel', release);

      root.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = root.getBoundingClientRect();
        // mouse position in viewBox coords
        const tx = this.view.x + (e.clientX - rect.left) / rect.width * this.view.w;
        const ty = this.view.y + (e.clientY - rect.top) / rect.height * this.view.h;
        const factor = Math.pow(1.0015, e.deltaY); // up = zoom in
        let nw = this.view.w * factor;
        let nh = this.view.h * factor;
        // bounds: keep between 4% and 200% of bbox
        const minW = this.bbox.w * 0.025;
        const maxW = this.bbox.w * 1.4;
        if (nw < minW) { nh *= minW / nw; nw = minW; }
        if (nw > maxW) { nh *= maxW / nw; nw = maxW; }
        const nx = tx - (e.clientX - rect.left) / rect.width * nw;
        const ny = ty - (e.clientY - rect.top) / rect.height * nh;
        this.view = { x: nx, y: ny, w: nw, h: nh };
        this._applyView();
      }, { passive: false });
    }
  }

  window.PonsMap = PonsMap;
})();

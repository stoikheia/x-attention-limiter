// Attention History line chart (SPEC §24-30) on a plain canvas: state backgrounds,
// RESET / BLOCK markers, crosshair tooltip, drag-to-select range.

const PAD = { l: 52, r: 14, t: 22, b: 26 };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtTime(ts, withDate) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export class HistoryChart {
  constructor(canvas, tipEl, { onSelect } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.tip = tipEl;
    this.onSelect = onSelect || (() => {});
    this.d = null;
    this.metric = 'rate';
    this.hover = null;
    this.drag = null;
    this.selection = null;
    this._bind();
    new ResizeObserver(() => this.draw()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }

  setData(d) {
    this.d = d;
    this.selection = null;
    this.hover = null;
    this.draw();
  }

  setMetric(m) {
    this.metric = m;
    this.draw();
  }

  // ---- geometry
  _plot() {
    const W = this.c.clientWidth;
    const H = this.c.clientHeight;
    return { x0: PAD.l, x1: W - PAD.r, y0: PAD.t, y1: H - PAD.b, W, H };
  }
  _xOf(ts, p) {
    const { lo, hi } = this.d;
    return p.x0 + ((ts - lo) / (hi - lo)) * (p.x1 - p.x0);
  }
  _tsOf(x, p) {
    const { lo, hi } = this.d;
    return lo + ((x - p.x0) / (p.x1 - p.x0)) * (hi - lo);
  }
  _values() {
    return this.metric === 'cum' ? this.d.cumulative : this.d.buckets;
  }
  _bucketAt(x, p) {
    const i = Math.floor((this._tsOf(x, p) - this.d.lo) / this.d.bucketMs);
    return Math.max(0, Math.min(this.d.buckets.length - 1, i));
  }

  // ---- drawing
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.c.clientWidth;
    const H = this.c.clientHeight;
    if (this.c.width !== Math.round(W * dpr) || this.c.height !== Math.round(H * dpr)) {
      this.c.width = Math.round(W * dpr);
      this.c.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.d) return;
    const p = this._plot();
    const d = this.d;
    const vals = this._values();
    const max = Math.max(1, ...vals) * 1.1;
    const yOf = (v) => p.y1 - (v / max) * (p.y1 - p.y0);

    // state backgrounds
    const bgColor = { INACTIVE: cssVar('--bg-inactive'), UNLIMITED: cssVar('--bg-unlimited'), BLOCKED: cssVar('--bg-blocked') };
    for (const s of d.segments) {
      const col = bgColor[s.state];
      if (!col) continue;
      const xa = Math.max(p.x0, this._xOf(s.from, p));
      const xb = Math.min(p.x1, this._xOf(s.to, p));
      if (xb <= xa) continue;
      ctx.fillStyle = col;
      ctx.fillRect(xa, p.y0, xb - xa, p.y1 - p.y0);
    }

    // selection
    if (this.selection) {
      ctx.fillStyle = 'rgba(42,120,214,0.14)';
      const xa = this._xOf(this.selection.lo, p);
      const xb = this._xOf(this.selection.hi, p);
      ctx.fillRect(xa, p.y0, xb - xa, p.y1 - p.y0);
      ctx.strokeStyle = cssVar('--series');
      ctx.lineWidth = 1;
      ctx.strokeRect(xa + 0.5, p.y0 + 0.5, xb - xa - 1, p.y1 - p.y0 - 1);
    }

    // grid + y labels
    ctx.strokeStyle = cssVar('--grid');
    ctx.fillStyle = cssVar('--text-3');
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p.x0, y);
      ctx.lineTo(p.x1, y);
      ctx.stroke();
      ctx.fillText(Math.round(v).toLocaleString(), p.x0 - 6, y);
    }

    // x labels
    const span = d.hi - d.lo;
    const step = span <= 3 * 3600e3 ? 1800e3 : span <= 6 * 3600e3 ? 3600e3 : span <= 12 * 3600e3 ? 7200e3 : span <= 86400e3 ? 4 * 3600e3 : span <= 3 * 86400e3 ? 12 * 3600e3 : 86400e3;
    const withDate = span > 12 * 3600e3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const first = Math.ceil(d.lo / step) * step;
    for (let t = first; t <= d.hi; t += step) {
      const x = Math.round(this._xOf(t, p)) + 0.5;
      ctx.strokeStyle = cssVar('--grid');
      ctx.beginPath();
      ctx.moveTo(x, p.y0);
      ctx.lineTo(x, p.y1);
      ctx.stroke();
      ctx.fillStyle = cssVar('--text-3');
      ctx.fillText(fmtTime(t, withDate), x, p.y1 + 6);
    }

    // series
    const n = vals.length;
    const bw = (p.x1 - p.x0) / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = p.x0 + bw * (i + 0.5);
      const y = yOf(vals[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = cssVar('--series');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(p.x0 + bw * (n - 0.5), p.y1);
    ctx.lineTo(p.x0 + bw * 0.5, p.y1);
    ctx.closePath();
    ctx.fillStyle = cssVar('--series-fill');
    ctx.fill();

    // markers
    ctx.font = 'bold 10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    for (const m of d.markers) {
      const x = Math.round(this._xOf(m.ts, p)) + 0.5;
      if (x < p.x0 || x > p.x1) continue;
      const col = m.kind === 'RESET' ? cssVar('--mk-reset') : cssVar('--mk-block');
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(m.kind === 'RESET' ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x, p.y0);
      ctx.lineTo(x, p.y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.fillText(m.kind, x, p.y0 - 3);
    }

    // hover crosshair
    if (this.hover != null) {
      const i = this.hover;
      const x = p.x0 + bw * (i + 0.5);
      ctx.strokeStyle = cssVar('--text-3');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, p.y0);
      ctx.lineTo(Math.round(x) + 0.5, p.y1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--series');
      ctx.beginPath();
      ctx.arc(x, yOf(vals[i]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = cssVar('--surface');
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // axes
    ctx.strokeStyle = cssVar('--border');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x0 + 0.5, p.y0);
    ctx.lineTo(p.x0 + 0.5, p.y1 + 0.5);
    ctx.lineTo(p.x1, p.y1 + 0.5);
    ctx.stroke();
  }

  _stateAt(ts) {
    let s = 'ACTIVE';
    for (const seg of this.d.segments) if (ts >= seg.from && ts < seg.to) s = seg.state;
    return s;
  }

  // ---- interaction
  _bind() {
    const c = this.c;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('mousemove', (e) => {
      if (!this.d) return;
      const p = this._plot();
      const { x, y } = pos(e);
      if (x < p.x0 || x > p.x1) {
        this.hover = null;
        this.tip.hidden = true;
        this.draw();
        return;
      }
      const i = this._bucketAt(x, p);
      this.hover = i;
      if (this.drag) {
        const a = this._tsOf(Math.min(this.drag.x, x), p);
        const b = this._tsOf(Math.max(this.drag.x, x), p);
        this.selection = { lo: a, hi: b };
      }
      const t0 = this.d.lo + i * this.d.bucketMs;
      const v = this._values()[i];
      const withDate = this.d.hi - this.d.lo > 12 * 3600e3;
      this.tip.textContent = `${fmtTime(t0, withDate)}–${fmtTime(t0 + this.d.bucketMs, false)}  ${Math.round(v).toLocaleString()} pt  ·  ${this._stateAt(t0)}`;
      this.tip.hidden = false;
      const wrap = c.parentElement.getBoundingClientRect();
      const tipW = this.tip.offsetWidth;
      let tx = e.clientX - wrap.left + 14;
      if (tx + tipW > wrap.width - 8) tx = e.clientX - wrap.left - tipW - 14;
      this.tip.style.left = `${tx}px`;
      this.tip.style.top = `${Math.max(4, y - 30)}px`;
      this.draw();
    });
    c.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.hidden = true;
      this.draw();
    });
    c.addEventListener('mousedown', (e) => {
      if (!this.d) return;
      this.drag = { x: pos(e).x, moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (this.drag && Math.abs(pos(e).x - this.drag.x) > 3) this.drag.moved = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.drag || !this.d) return;
      const p = this._plot();
      const { x } = pos(e);
      const xa = Math.max(p.x0, Math.min(p.x1, Math.min(this.drag.x, x)));
      const xb = Math.max(p.x0, Math.min(p.x1, Math.max(this.drag.x, x)));
      if (this.drag.moved) {
        this.selection = { lo: this._tsOf(xa, p), hi: this._tsOf(xb, p) };
      } else {
        const i = this._bucketAt(this.drag.x, p);
        const lo = this.d.lo + i * this.d.bucketMs;
        this.selection = { lo, hi: lo + this.d.bucketMs };
      }
      this.drag = null;
      this.draw();
      this.onSelect(this.selection.lo, this.selection.hi);
    });
  }
}

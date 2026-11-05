import { visibilityAt } from './maze-model.mjs';

export class MazeView {
  constructor(canvas, maze, config, assetBase, lang='zh') {
    this.lang=lang;
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.maze = maze; this.config = config;
    this.layer = document.createElement('canvas'); this.ink = this.layer.getContext('2d');
    this.taka = new Image(); this.taka.src = assetBase + 'taka.svg';
    this.shell = new Image(); this.shell.src = assetBase + 'shell.svg';
    this.resize(); this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas.parentElement);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, r.width); this.height = Math.max(1, r.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
    this.layer.width = this.canvas.width; this.layer.height = this.canvas.height;
    const top=this.height<420?58:92,bottom=this.width<768?108:90;
    this.cell = Math.min((this.width-32) / (this.maze.cols + .4), Math.max(120,this.height-top-bottom) / (this.maze.rows + .4));
    this.ox = (this.width - (this.maze.cols - 1) * this.cell) / 2;
    this.oy = top+(this.height-top-bottom-(this.maze.rows-1)*this.cell)/2;
    this.buildGlass();
  }
  buildGlass() {
    // Outline the UNION of the actual corridors, so junctions have no fake seams.
    const rects = this.maze.free;
    const xs = [...new Set(rects.flatMap(r => [r[0], r[2]]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [r[1], r[3]]))].sort((a, b) => a - b);
    const occupied = (i, j) => i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1 && rects.some(r => (xs[i] + xs[i + 1]) / 2 > r[0] && (xs[i] + xs[i + 1]) / 2 < r[2] && (ys[j] + ys[j + 1]) / 2 > r[1] && (ys[j] + ys[j + 1]) / 2 < r[3]);
    this.glassArea = new Path2D(); this.glassEdge = new Path2D(); this.glassInner = new Path2D();
    const edge = (a, b, nx, ny) => {
      const p = this.screen(a), q = this.screen(b);
      this.glassEdge.moveTo(...p); this.glassEdge.lineTo(...q);
      this.glassInner.moveTo(p[0] + nx * 2.2, p[1] + ny * 2.2); this.glassInner.lineTo(q[0] + nx * 2.2, q[1] + ny * 2.2);
    };
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      if (!occupied(i, j)) continue;
      const [x, y] = this.screen([xs[i], ys[j]]);
      this.glassArea.rect(x, y, (xs[i + 1] - xs[i]) * this.cell, (ys[j + 1] - ys[j]) * this.cell);
      if (!occupied(i, j - 1)) edge([xs[i], ys[j]], [xs[i + 1], ys[j]], 0, 1);
      if (!occupied(i, j + 1)) edge([xs[i], ys[j + 1]], [xs[i + 1], ys[j + 1]], 0, -1);
      if (!occupied(i - 1, j)) edge([xs[i], ys[j]], [xs[i], ys[j + 1]], 1, 0);
      if (!occupied(i + 1, j)) edge([xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]], -1, 0);
    }
  }
  drawGlass(k, time) {
    const w = this.width, h = this.height, s = this.cell;
    // The ocean remains visible through the pane. Only the edges catch much light.
    const wash = k.createLinearGradient(0, 0, w, h);
    wash.addColorStop(0, '#c2eef50b'); wash.addColorStop(.45, '#b3dce803'); wash.addColorStop(1, '#a0d7e509');
    k.fillStyle = wash; k.fill(this.glassArea);
    const rim = k.createLinearGradient(0, 0, w * .85, h);
    rim.addColorStop(0, '#d7f5fa8c'); rim.addColorStop(.35, '#a5dce147'); rim.addColorStop(.7, '#d3f4f07a'); rim.addColorStop(1, '#9cced840');
    k.lineJoin = 'round'; k.lineCap = 'round'; k.lineWidth = 1.1; k.strokeStyle = rim; k.stroke(this.glassEdge);
    k.lineWidth = .65; k.strokeStyle = '#bdebf32b'; k.stroke(this.glassInner);
    k.save(); k.clip(this.glassArea);
    // A grazing reflection, narrow refraction lines and soft moving caustics.
    k.lineWidth = s * .06; k.strokeStyle = '#e5fbff07';
    for (let n = 0; n < 5; n++) {
      const x = (n * 2.1 + .3) * s;
      k.beginPath(); k.moveTo(x, 0); k.lineTo(x - h * .32, h); k.stroke();
      k.lineWidth = .6; k.strokeStyle = '#dcf6ff12'; k.beginPath(); k.moveTo(x + s * .07, 0); k.lineTo(x - h * .32 + s * .07, h); k.stroke();
      k.lineWidth = s * .06; k.strokeStyle = '#e5fbff07';
    }
    k.strokeStyle = '#c1edf411'; k.lineWidth = .8;
    for (let n = 0; n < 6; n++) {
      k.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const y = (n + .4) * s + Math.sin(x / (s * .75) + time * .23 + n) * s * .12;
        if (x === 0) k.moveTo(x, y); else k.lineTo(x, y);
      }
      k.stroke();
    }
    k.restore();
  }
  screen(p) { return [this.ox + p[0] * this.cell, this.oy + p[1] * this.cell]; }
  world(clientX, clientY) { const r = this.canvas.getBoundingClientRect(); return [(clientX - r.left - this.ox) / this.cell, (clientY - r.top - this.oy) / this.cell]; }
  client(p) { const [x, y] = this.screen(p), r = this.canvas.getBoundingClientRect(); return [x + r.left, y + r.top]; }
  path(ctx, a, b) { const p = this.screen(a), q = this.screen(b); ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke(); }
  room(ctx, p, width, fill) {
    const [x, y] = this.screen(p), w = this.cell * width;
    ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x - w / 2, y - w / 2, w, w, this.cell * .10); ctx.fill();
  }
  draw(state) {
    const c = this.ctx, k = this.ink, w = this.width, h = this.height, s = this.cell, time = state.visualTime;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.clearRect(0, 0, w, h);
    const glow = c.createRadialGradient(w * .45, h * .5, 0, w * .45, h * .5, w * .7);
    glow.addColorStop(0, '#163a4c50'); glow.addColorStop(1, '#071c2900'); c.fillStyle = glow; c.fillRect(0, 0, w, h);
    for (let n = 0; n < 36; n++) {
      const x = ((n * 113.7 + Math.sin(n) * 43) % w + w) % w, y = ((n * 73.9 - time * (2 + n % 4)) % h + h) % h;
      c.fillStyle = `rgba(163,202,211,${.035 + n % 3 * .018})`; c.beginPath(); c.arc(x, y, n % 5 === 0 ? 1.4 : .6, 0, Math.PI * 2); c.fill();
    }
    k.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); k.clearRect(0, 0, w, h);
    this.drawGlass(k, time);
    if (this.config.showRoute) {
      k.save(); k.strokeStyle = '#dfc995a0'; k.lineWidth = 1.5; k.setLineDash([5, 5]);
      for (let i = 1; i < this.maze.mainRoute.length; i++) this.path(k, this.maze.mainRoute[i - 1], this.maze.mainRoute[i]);
      k.restore();
    }
    for (const key of state.visited) {
      const p = key.split(',').map(Number); if (Math.hypot(p[0] - state.point[0], p[1] - state.point[1]) > this.config.fade) continue;
      const [x, y] = this.screen(p); k.fillStyle = '#c0cbb929';
      k.fillRect(x - s * .055, y - s * .03, s * .035, s * .06); k.fillRect(x + s * .025, y - s * .03, s * .035, s * .06);
    }
    if (this.maze.distance(this.maze.nodeOf(state.point)) <= 3) {
      k.strokeStyle = '#b2d4d625'; k.lineWidth = 1.3;
      const path = this.maze.path(this.maze.nodeOf(state.point));
      for (let i = 1; i < Math.min(path.length, 3); i++) this.path(k, [path[i - 1][0] + .19, path[i - 1][1]], [path[i][0] + .19, path[i][1]]);
    }
    const [px, py] = this.screen(state.point);
    const all = this.config.showAll || state.mapRemaining > 0;
    if (!all) {
      k.save(); k.globalCompositeOperation = 'destination-in';
      const mask = k.createRadialGradient(px, py, this.config.clear * s, px, py, this.config.fade * s);
      for (let i = 0; i <= 10; i++) mask.addColorStop(i / 10, `rgba(255,255,255,${visibilityAt(this.config.clear + (this.config.fade - this.config.clear) * i / 10, this.config.clear, this.config.fade)})`);
      k.fillStyle = mask; k.fillRect(0, 0, w, h); k.restore();
    }
    c.drawImage(this.layer, 0, 0, w, h);
    if (state.hintEdge && state.hintRemaining > 0) {
      const { a, b } = state.hintEdge;
      c.save(); c.strokeStyle = '#d4c9a898'; c.lineWidth = s * .035; c.setLineDash([s * .09, s * .08]); this.path(c, a, b); c.restore();
      const [x, y] = this.screen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      c.strokeStyle = '#ead8ae'; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, s * .11, 0, Math.PI * 2); c.stroke();
    }
    const shellVisible = Math.hypot(state.point[0] - this.maze.goal[0], state.point[1] - this.maze.goal[1]) <= this.config.clear;
    const drawGoal = () => {
      if (!shellVisible && !['found', 'taking', 'done'].includes(state.phase)) return;
      let [x, y] = this.screen(this.maze.goal); const take = state.phase === 'taking' ? state.takeProgress : state.phase === 'done' ? 1 : 0;
      x += s * .22; y -= s * (.10 + take * .55);
      c.save(); c.globalAlpha = 1 - take;
      const light = c.createRadialGradient(x, y, 0, x, y, s * .48); light.addColorStop(0, '#d0e8d02a'); light.addColorStop(1, '#d0e8d000'); c.fillStyle = light; c.fillRect(x - s / 2, y - s / 2, s, s);
      if (this.shell.complete && this.shell.naturalWidth) c.drawImage(this.shell, x - s * .20, y - s * .18, s * .40, s * .36);
      c.restore();
    };
    if (state.phase === 'playing') {
      const origin = this.maze.nodeOf(state.point);
      for (const next of this.maze.neighbors(origin)) {
        const p = [origin[0] + (next[0] - origin[0]) * .48, origin[1] + (next[1] - origin[1]) * .48];
        const alpha = visibilityAt(Math.hypot(p[0] - state.point[0], p[1] - state.point[1]), this.config.clear, this.config.fade);
        const [x, y] = this.screen(p); c.strokeStyle = `rgba(176,211,218,${alpha * .33})`; c.lineWidth = 1;
        c.beginPath(); c.arc(x, y, s * .065, 0, Math.PI * 2); c.stroke();
      }
    }
    if (state.ripple && state.rippleRemaining > 0) {
      const [x, y] = this.screen(state.ripple), p = 1 - state.rippleRemaining / 1.2;
      c.strokeStyle = `rgba(194,222,225,${(1 - p) * .65})`; c.lineWidth = 1.4;
      c.beginPath(); c.arc(x, y, s * (.12 + p * .42), 0, Math.PI * 2); c.stroke();
    }
    const light = c.createRadialGradient(px, py, 0, px, py, s * .65); light.addColorStop(0, '#e7bd7333'); light.addColorStop(.4, '#e7bd730b'); light.addColorStop(1, '#e7bd7300'); c.fillStyle = light; c.fillRect(px - s, py - s, s * 2, s * 2);
    c.save(); c.imageSmoothingEnabled = true;
    const bob = state.dragging ? 0 : Math.sin(time * 1.8) * Math.min(1.6, s * .02);
    if (this.taka.complete && this.taka.naturalWidth) c.drawImage(this.taka, px - s * .47, py - s * .47 + bob, s * .94, s * .94);
    else { c.fillStyle = '#aab8c2'; c.fillRect(px - s * .19, py - s * .24, s * .38, s * .48); c.fillStyle = '#e6bf75'; c.fillRect(px - s * .07, py - s * .09, s * .14, s * .14); }
    c.restore();
    if (state.takeProgress > 0 && state.takeProgress < 1) {
      const [gx, gy] = this.screen(this.maze.goal); c.strokeStyle = '#a9b8c0'; c.lineWidth = s * .035; c.setLineDash([s * .035, s * .025]);
      this.path(c, state.point, [this.maze.goal[0], this.maze.goal[1] - state.takeProgress * .5]); c.setLineDash([]);
    }
    drawGoal(); // Keep the shell visible in front of Taka at the narrow endpoint.
    if (state.phase === 'playing' && state.visualTime < 7 && !state.hasMoved) {
      c.strokeStyle = '#d8d1ae75'; c.lineWidth = 1; c.setLineDash([3, 5]); c.beginPath(); c.arc(px, py, s * .46, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
    }
    if (all) {
      const [x, y] = this.screen(this.maze.start); c.fillStyle = '#b5cbd18a'; c.font = '10px "PingFang SC",sans-serif'; c.textAlign = 'center'; c.fillText(this.lang==='en'?'Entrance':'入口', x, y + s * .5);
    }
    if (this.config.debug) {
      c.strokeStyle = '#dda78b40'; c.lineWidth = .7;
      for (const [x1, y1, x2, y2] of this.maze.solids) { const [x, y] = this.screen([x1, y1]); c.strokeRect(x, y, (x2 - x1) * s, (y2 - y1) * s); }
      c.strokeStyle = '#f4d393'; c.beginPath(); c.arc(px, py, this.maze.radius * s, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#a3bdca'; c.font = '9px monospace'; c.textAlign = 'center';
      for (const p of this.maze.nodes) { const [x, y] = this.screen(p); c.fillText(`${String.fromCharCode(65 + p[0])}${p[1] + 1}`, x, y - s * .24); }
    }
  }
}

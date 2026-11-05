export const defaults = Object.freeze({ clear: 1, fade: 2, speed: 4.5, volume: .65, wall: .7, target: 1, showAll: false, showRoute: false, debug: false });
export const directionName = (a, b) => Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? (b[0] > a[0] ? '向右' : '向左') : (b[1] > a[1] ? '向下' : '向上');
export const distanceBand = n => n <= 3 ? 'near' : n <= 8 ? 'mid' : 'far';
export function visibilityAt(distance, clear = 1, fade = 2) {
  if (distance <= clear) return 1;
  if (distance >= fade) return 0;
  const t = (distance - clear) / (fade - clear);
  return 1 - t * t * (3 - 2 * t);
}
export class ActivityClock {
  elapsed = 0;
  invited = false;
  tick(seconds, suspended = false) { if (!suspended) this.elapsed += Math.max(0, seconds); }
  progress() { this.elapsed = 0; }
  invite() { this.invited = true; }
  get due() { return !this.invited && this.elapsed >= 15; }
}
export class Maze {
  halfWidth = .36;
  radius = .20;
  constructor(data) {
    this.data = data;
    this.start = [...data.start]; this.goal = [...data.goal];
    this.cols = data.columns; this.rows = data.rows;
    this.graph = new Map();
    for (const [a, b] of data.openEdges) {
      for (const [u, v] of [[a, b], [b, a]]) {
        if (!this.graph.has(this.key(u))) this.graph.set(this.key(u), []);
        this.graph.get(this.key(u)).push(v);
      }
    }
    this.nodes = [...this.graph.keys()].map(key => key.split(',').map(Number));
    this.dist = new Map([[this.key(this.goal), 0]]);
    const queue = [this.goal];
    for (let i = 0; i < queue.length; i++) for (const v of this.neighbors(queue[i])) {
      if (!this.dist.has(this.key(v))) { this.dist.set(this.key(v), this.distance(queue[i]) + 1); queue.push(v); }
    }
    // Derive the one main route from actual connections, never from the drawing.
    this.mainRoute = this.path(this.start);
    this.mainEdges = new Set(this.mainRoute.slice(1).map((p, i) => this.edgeKey(this.mainRoute[i], p)));
    const h = this.halfWidth;
    this.free = data.openEdges.map(([a, b]) => [Math.min(a[0], b[0]) - h, Math.min(a[1], b[1]) - h, Math.max(a[0], b[0]) + h, Math.max(a[1], b[1]) + h]);
    // Partition the complement of the corridor union into exact solid rectangles.
    // Circle-vs-solid tests prevent diagonal corner clipping, including pointer jumps.
    const xs = [...new Set([-.5, this.cols - .5, ...this.free.flatMap(r => [r[0], r[2]])])].sort((a, b) => a - b);
    const ys = [...new Set([-.5, this.rows - .5, ...this.free.flatMap(r => [r[1], r[3]])])].sort((a, b) => a - b);
    this.solids = [];
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
      const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
      if (!this.free.some(r => mx > r[0] && mx < r[2] && my > r[1] && my < r[3])) this.solids.push([xs[i], ys[j], xs[i + 1], ys[j + 1]]);
    }
  }
  key(p) { return p.join(','); }
  edgeKey(a, b) { return [this.key(a), this.key(b)].sort().join('|'); }
  wallFeedbackAt(p) {
    let bestDistance = Infinity, onMain = true;
    for (const [a, b] of this.data.openEdges) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      const main = this.mainEdges.has(this.edgeKey(a, b));
      // At the shared fork itself prefer the main route; inside a branch use
      // the nearest edge, even before its first separate grid node is reached.
      if (distance < bestDistance - 1e-8 || Math.abs(distance - bestDistance) < 1e-8 && main) {
        bestDistance = distance; onMain = main;
      }
    }
    return { onMain, quality: onMain ? 'clear' : 'dull' };
  }
  neighbors(p) { return this.graph.get(this.key(p)) || []; }
  distance(p) { return this.dist.get(this.key(p)) ?? Infinity; }
  nodeOf(p) {
    return this.nodes.reduce((best, v) => Math.hypot(v[0] - p[0], v[1] - p[1]) < Math.hypot(best[0] - p[0], best[1] - p[1]) ? v : best);
  }
  hint(p) {
    const node = this.nodeOf(p);
    if (this.key(node) === this.key(this.goal)) return null;
    return this.neighbors(node).reduce((a, b) => this.distance(a) <= this.distance(b) ? a : b);
  }
  path(p) {
    const out = [p];
    while (this.key(out.at(-1)) !== this.key(this.goal)) out.push(this.hint(out.at(-1)));
    return out;
  }
  echo(origin, next) {
    const available = this.neighbors(origin).some(p => this.key(p) === this.key(next));
    return { available, correct: available && this.distance(next) < this.distance(origin), band: distanceBand(this.distance(next)) };
  }
  canOccupy(p) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) return false;
    const [x, y] = p, r = this.radius;
    if (x - r < -.5 || x + r > this.cols - .5 || y - r < -.5 || y + r > this.rows - .5) return false;
    for (const [x1, y1, x2, y2] of this.solids) {
      const dx = x - Math.max(x1, Math.min(x2, x)), dy = y - Math.max(y1, Math.min(y2, y));
      if (dx * dx + dy * dy < r * r - 1e-9) return false;
    }
    return true;
  }
  sweep(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / .035));
    let p = [...from], collided = false;
    for (let i = 0; i < steps; i++) {
      const a = dx / steps, b = dy / steps;
      if (this.canOccupy([p[0] + a, p[1] + b])) { p = [p[0] + a, p[1] + b]; continue; }
      collided = true;
      if (this.canOccupy([p[0] + a, p[1]])) p[0] += a;
      if (this.canOccupy([p[0], p[1] + b])) p[1] += b;
    }
    return { point: p, collided };
  }
  restorePoint(p) { return this.canOccupy(p) ? [...p] : [...this.start]; }
}

export class MazeAudio {
  constructor(config) { this.config = config; this.enabled = true; this.active = new Set(); this.events = []; this.lastWall = -Infinity; }
  async unlock() {
    try {
      const Constructor = window.AudioContext || window.webkitAudioContext;
      if (!Constructor) return false;
      this.context ??= new Constructor();
      await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }
  record(type, detail = {}) { this.events.push({ type, at: performance.now(), ...detail }); if (this.events.length > 100) this.events.shift(); }
  voice(frequency, at, duration, gain, type = 'sine', endFrequency = frequency, cutoff = 0) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const c = this.context, osc = c.createOscillator(), env = c.createGain();
    osc.type = type; osc.frequency.setValueAtTime(frequency, at); osc.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), at + duration);
    env.gain.setValueAtTime(0, at); env.gain.linearRampToValueAtTime(gain * this.config.volume * .55, at + .006); env.gain.exponentialRampToValueAtTime(.00001, at + duration);
    let filter;
    if (cutoff) { filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = cutoff; osc.connect(filter); filter.connect(env); } else osc.connect(env);
    env.connect(c.destination); const handle = { osc, env, filter }; this.active.add(handle);
    osc.onended = () => { this.active.delete(handle); osc.disconnect(); env.disconnect(); filter?.disconnect(); };
    osc.start(at); osc.stop(at + duration + .02);
  }
  wall(feedback = { onMain: true, quality: 'clear' }) {
    if (performance.now() - this.lastWall < 300) return false;
    this.lastWall = performance.now(); this.stop(); this.record('wall', feedback);
    if (!this.context) return true;
    const t = this.context.currentTime + .008;
    if (feedback.onMain) {
      // One bright glass strike: simultaneous inharmonic partials, no double ding.
      this.voice(1760, t, .52, .36 * this.config.wall, 'sine', 1756);
      this.voice(2860, t, .24, .14 * this.config.wall, 'sine', 2850);
      this.voice(4190, t, .10, .06 * this.config.wall, 'sine', 4160);
    } else {
      // The same contact in a side branch: short, low and heavily damped.
      this.voice(205, t, .19, .48 * this.config.wall, 'triangle', 105, 460);
      this.voice(390, t, .10, .12 * this.config.wall, 'sine', 240, 600);
    }
    return true;
  }
  target(band, delay = 0) {
    this.record('target', { band });
    if (!this.context) return;
    const t = this.context.currentTime + delay + .01, amp = { far: .18, mid: .28, near: .40 }[band];
    const cutoff = { far: 1500, mid: 2400, near: 7000 }[band];
    this.voice(1620, t, .72, amp * this.config.target, 'sine', 1615, cutoff);
    this.voice(2480, t, .40, amp * .28 * this.config.target, 'sine', 2470, cutoff);
  }
  knock(echo) {
    this.stop(); this.record('knock', { correct: echo.correct, band: echo.band });
    if (this.context) {
      const t = this.context.currentTime + .008;
      for (const [offset, amp] of [[0, .32], [.17, .25], [.34, .08]]) this.voice(180, t + offset, .16, amp, 'triangle', 72, 480);
    }
    if (echo.correct) this.target(echo.band, .43);
  }
  step() { if (this.context) this.voice(290, this.context.currentTime + .005, .05, .06, 'triangle', 155, 1400); }
  found() { this.stop(); this.target('near'); }
  stop() {
    for (const handle of this.active) { try { handle.env.gain.cancelScheduledValues(0); handle.env.gain.value = 0; handle.osc.stop(); } catch {} }
    this.active.clear();
  }
  setEnabled(value) { this.enabled = value; if (!value) this.stop(); }
}

// Approved sound study v6. Short decorative cues never acquire story/codex audio focus.
import waterUrl from '../../../assets/audio/taka-bubbles.wav';
import clickUrl from '../../../assets/audio/taka-key-click.wav';
import confirmUrl from '../../../assets/audio/taka-confirm.wav';

type Cue = 'water' | 'click' | 'confirm';
const KEY = 'taka_sfx';
let enabled = true;
try { enabled = JSON.parse(localStorage.getItem(KEY) || '{}').on !== false; } catch { /* defaults */ }
let volume = () => 1;
let narrating = () => false;
let context: AudioContext | null = null;
let resuming: Promise<void> | null = null;
let initialized = false, foreground = true, blocked = 0, epoch = 0, waterRun = 0;
let lastClick = -Infinity, lastConfirm = -Infinity;
const buffers = new Map<Cue, Promise<AudioBuffer | null>>();
const bytes = new Map<Cue, Promise<ArrayBuffer | null>>();
const active = new Map<Cue, { source: AudioBufferSourceNode; gain: GainNode }>();
const tickets: Record<Cue, number> = { water: 0, click: 0, confirm: 0 };
const level: Record<Cue, number> = { water: .65 * .65 * .75, click: .65 * .8, confirm: .65 };

export function soundEffectsOn(): boolean { return enabled; }
export function setSoundEffects(on: boolean): void {
    enabled = on;
    try { localStorage.setItem(KEY, JSON.stringify({ on })); } catch { /* private mode */ }
    if (!on) stopSoundEffects();
    document.dispatchEvent(new Event('taka-sfx-change'));
}
function canPlay(): boolean { return enabled && foreground && !document.hidden && !blocked && volume() > 0; }
function cueVolume(cue: Cue): number { return level[cue] * volume() * (narrating() ? .45 : 1); }
function stopCue(cue: Cue): void {
    tickets[cue]++;
    const voice = active.get(cue);
    if (!voice || !context) return;
    active.delete(cue);
    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + .025);
    try { voice.source.stop(now + .03); } catch { /* already ended */ }
}
export function stopSoundEffects(): void {
    epoch++; waterRun++;
    (['water', 'click', 'confirm'] as const).forEach(stopCue);
}
/** Call in a genuine gesture. Cold resource loading remains silent. */
export function unlockSoundEffects(): void {
    if (!canPlay()) return;
    try {
        const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Constructor) return;
        context ??= new Constructor();
        resuming = context.resume().catch(() => {});
        // Decode behind the gesture so later clicks do not wait for a network fetch.
        for (const cue of ['water', 'click', 'confirm'] as const) void decoded(cue);
    } catch { /* no sound must never block a control */ }
}
function decoded(cue: Cue): Promise<AudioBuffer | null> {
    if (!context) return Promise.resolve(null);
    let pending = buffers.get(cue);
    if (!pending) {
        const ctx = context;
        pending = (bytes.get(cue) || Promise.resolve(null)).then(data => data ? ctx.decodeAudioData(data.slice(0)) : null).catch(() => null);
        buffers.set(cue, pending);
    }
    return pending;
}
async function play(cue: Cue): Promise<void> {
    if (!canPlay() || !context) return;
    const now = performance.now();
    if (cue === 'click') {
        if (now - lastClick < 110 || active.has('confirm')) return;
        lastClick = now;
    } else if (cue === 'confirm') {
        if (now - lastConfirm < 350) return;
        lastConfirm = now; stopCue('click');
    }
    stopCue(cue);
    const ticket = tickets[cue], generation = epoch;
    await resuming;
    const buffer = await decoded(cue);
    if (!buffer || generation !== epoch || ticket !== tickets[cue] || (cue !== 'water' && performance.now() - now > 350) || !canPlay() || context.state !== 'running') return;
    try {
        const source = context.createBufferSource(), gain = context.createGain();
        source.buffer = buffer; gain.gain.value = cueVolume(cue);
        source.connect(gain); gain.connect(context.destination);
        const voice = { source, gain }; active.set(cue, voice);
        source.onended = () => { if (active.get(cue) === voice) active.delete(cue); source.disconnect(); gain.disconnect(); };
        source.start();
    } catch { /* rejected playback leaves the story untouched */ }
}
export function playClick(): void { void play('click'); }
export function playConfirm(): void { void play('confirm'); }
/** Paired token: stale recognition callbacks cannot unmute a newer recording. */
export function suppressSoundEffects(): () => void {
    blocked++; stopSoundEffects();
    let released = false;
    return () => { if (!released) { released = true; blocked--; } };
}
/** Cancelable loading cue: short loads stay silent; long waits have natural gaps. */
export function loadingSound(delay = 300, repeat = true): () => void {
    stopCue('water');
    const run = ++waterRun;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
        if (run !== waterRun || !canPlay() || !context) return;
        void play('water');
        if (repeat) timer = setTimeout(tick, 4100);
    };
    timer = setTimeout(tick, delay);
    return () => { clearTimeout(timer); if (run === waterRun) { waterRun++; stopCue('water'); } };
}

// Explicit action inventory: decorative art, text completion, typing and mic controls stay silent.
const CLICK_ACTIONS = [
    '#settings-btn', '#settings-close', '#reader-back', '#lang-toggle', '#speech-btn', '#sfx-btn', '#sp-toshelf', '#sp-logout',
    '.shell-tools > summary', '.rd-advanced > summary', '.shell-tool-menu button', '.shell-collections button',
    '.st-actions [data-act="parent"]', '.rd-library button', '.shelf-card', '#shelf-child-btn', '#shelf-child-menu button',
    '.theme-trigger', '[data-theme-option]', '[data-select-option]', '.choice-btn', '.hotspot:not(.mic-hotspot)',
    '.cp-tile', '.cc-tts', '.cc-close', '.codex-link',
    '.aw-tab', '#aw-close', '.ar-row-main', '.ar-dl', '.ar-back', '.pg-export', '#archive-close', '.jd-close',
    '#pm-close', '#pm-guest', '#pm-send', '#pm-login', '#pm-add', '#pm-logout', '.pm-child',
].join(',');
export function initSoundEffects(options: { volume: () => number; narrating: () => boolean }): void {
    volume = options.volume; narrating = options.narrating;
    if (initialized) return;
    initialized = true;
    for (const [cue, url] of Object.entries({ water: waterUrl, click: clickUrl, confirm: confirmUrl })) {
        bytes.set(cue as Cue, fetch(url).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null));
    }
    const gesture = (e: Event) => { if (e.isTrusted) { foreground = true; unlockSoundEffects(); } };
    document.addEventListener('pointerdown', gesture, true);
    document.addEventListener('keydown', gesture, true);
    document.addEventListener('click', e => {
        // App adapters relay .click() to hidden controls; never double-sound those relays.
        if (!e.isTrusted || !(e.target instanceof Element)) return;
        gesture(e);
        const target = e.target.closest<HTMLElement>(CLICK_ACTIONS);
        if (target && !target.matches(':disabled,[aria-disabled="true"]') && !target.closest('[inert]')) playClick();
    }, true);
    const refresh = () => { active.forEach((v, cue) => v.gain.gain.setTargetAtTime(cueVolume(cue), context!.currentTime, .02)); };
    document.addEventListener('taka-volume-change', refresh);
    document.addEventListener('taka-narration-change', refresh);
    window.addEventListener('blur', () => { foreground = false; stopSoundEffects(); });
    window.addEventListener('focus', () => { foreground = true; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopSoundEffects(); });
    window.addEventListener('pagehide', e => {
        stopSoundEffects();
        // A cached page keeps its JS instance. Suspend so the next real touch can resume it.
        if (e.persisted) void context?.suspend().catch(() => {});
        else void context?.close().catch(() => {});
    });
    window.addEventListener('pageshow', () => { foreground = !document.hidden; });
}

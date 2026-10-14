import { t } from './i18n';
import { speechPref } from './settings';
import { themeControl } from './theme';
import './shell.css';
import './opening.css';
import nameplate from '../../../assets/brand/taka-nameplate.svg?raw';
import bootSoundUrl from '../../../assets/audio/taka-boot.wav';

/** Gate owns only presentation. Story, progress and child state remain in the player. */
export function initShell(onEnter: () => void | Promise<void>, onWake: () => void = () => {}): void {
    const cover = document.getElementById('start-gate')!;
    const button = document.getElementById('gate-btn') as HTMLButtonElement;
    const note = cover.querySelector('.wake-note')!;
    const torch = cover.querySelector<HTMLElement>('.torch-overlay')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const fine = matchMedia('(hover: hover) and (pointer: fine) and (min-width:769px)');
    let stage: 'sleeping' | 'waking' | 'opening' | 'gone' = 'sleeping';
    let frame = 0;
    let audio: HTMLAudioElement | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
        timers.add(timer);
    };
    function text(): void {
        note.textContent = t(stage === 'waking' ? 'shell.opening' : 'shell.dark');
        button.setAttribute('aria-label', t('shell.wake'));
        cover.querySelector('.opening-title-label')!.textContent = t('gate.title');
    }
    function stopTorch(): void {
        cancelAnimationFrame(frame); frame = 0;
        cover.classList.remove('torch-active');
        ['--near-x','--near-y','--mid-x','--mid-y','--far-x','--far-y','--taka-reveal','--title-light'].forEach(k => cover.style.removeProperty(k));
        cover.querySelectorAll('.torch-clue').forEach(c => c.classList.remove('is-lit'));
    }
    function stopSound(): void { if (audio) { audio.pause(); audio.currentTime = 0; } }
    function pulseSound(): void {
        if (!speechPref.on) return;
        try {
            audio ??= new Audio(bootSoundUrl);
            audio.volume = speechPref.volume;
            audio.currentTime = 0;
            void audio.play().catch(() => {}); // Sound never blocks the story.
        } catch { /* unavailable audio keeps the same visual entrance */ }
    }
    function pointer(e: PointerEvent): void {
        if (!fine.matches || reduced.matches || stage !== 'sleeping' || !document.getElementById('parent-overlay')!.hidden) return;
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = 0;
            const r = cover.getBoundingClientRect(), x = e.clientX-r.left, y = e.clientY-r.top;
            cover.classList.add('torch-active');
            torch.style.setProperty('--mouse-x',x+'px');torch.style.setProperty('--mouse-y',y+'px');
            const nx=x/r.width-.5, ny=y/r.height-.5;
            [['near',22,18],['mid',7,6],['far',2,2]].forEach(([name,dx,dy])=>{
                cover.style.setProperty(`--${name}-x`,(-nx*Number(dx)).toFixed(2)+'px');
                cover.style.setProperty(`--${name}-y`,(-ny*Number(dy)).toFixed(2)+'px');
            });
            const distance=(el:Element)=>{const b=el.getBoundingClientRect();return Math.hypot(b.left+b.width/2-e.clientX,b.top+b.height/2-e.clientY);};
            cover.style.setProperty('--taka-reveal',Math.max(.06,.48*(1-distance(cover.querySelector('.eyeGlow')!)/200)).toFixed(3));
            cover.style.setProperty('--title-light',(.5+.46*Math.max(0,1-distance(cover.querySelector('h1')!)/210)).toFixed(3));
            cover.querySelectorAll('.torch-clue').forEach(c=>c.classList.toggle('is-lit',distance(c)<120));
        });
    }
    function enter(): void {
        stage = 'gone'; stopTorch();
        timers.forEach(clearTimeout); timers.clear();
        cover.removeEventListener('pointermove',pointer);
        window.removeEventListener('blur',stopTorch);
        fine.removeEventListener('change',stopTorch); reduced.removeEventListener('change',stopTorch);
        stopSound();
        window.removeEventListener('blur',stopSound);
        document.removeEventListener('visibilitychange',visibility);
        if (audio) { audio.removeAttribute('src'); audio.load(); }
        cover.remove(); document.body.classList.remove('on-gate');
    }
    function visibility(): void { if (document.hidden) stopSound(); }
    cover.hidden = false; cover.classList.add('bubble-opening','intro-light','intro-ready'); document.body.classList.add('on-gate');
    cover.querySelector('h1')!.insertAdjacentHTML('beforeend',nameplate);
    cover.insertAdjacentHTML('beforeend',`<div class="opening-cone" aria-hidden="true"></div><div class="wake-bubbles" aria-hidden="true">${Array.from({length:7},(_,i)=>`<i style="--bx:${20+(i*17)%65}%;--size:${3+i%3*2}px;--delay:${i*.065}s;--drift:${i%2?8:-7}px"></i>`).join('')}</div>`);
    if (speechPref.on) { audio = new Audio(bootSoundUrl); audio.preload = 'auto'; }
    cover.querySelector('.cover-header')!.insertAdjacentHTML('afterbegin',themeControl());
    cover.querySelector('.depth-motes')!.innerHTML = Array.from({length:15},(_,i)=>`<i class="depth-mote${i%4===0?' near':''}" style="--mx:${5+(i*37)%90}%;--my:${15+(i*29)%80}%;--ms:${i%4===0?5:2}px;--mb:${i%4===0?1.2:0}px;--md:${10+i%7}s;--delay:-${i%9}s"></i>`).join('');
    cover.querySelectorAll('.torch-clue').forEach((c,i)=>c.textContent=t(i?'shell.curious':'shell.light_moves'));
    button.disabled = false; text();
    button.onclick = () => {
        if (stage !== 'sleeping') return;
        stage='waking';button.disabled=true;stopTorch();onWake();pulseSound();cover.classList.add('is-awakening');
        text();
        // Build the destination beneath the opaque cover; preserve the lettering and wake sequence.
        const destination = Promise.resolve().then(onEnter).then(() => true, () => false);
        later(()=>cover.classList.add('is-illuminating'),reduced.matches?50:430);
        later(()=>cover.classList.add('is-revealed'),reduced.matches?100:480);
        later(async ()=>{
            if (!await destination) {
                stage='sleeping';button.disabled=false;stopSound();
                cover.classList.remove('is-awakening','is-illuminating','is-revealed');
                text();return;
            }
            stage='opening';cover.classList.add('is-ready','is-opening');
            later(enter,reduced.matches?150:350);
        },reduced.matches?300:1900);
    };
    cover.addEventListener('pointermove',pointer);
    cover.addEventListener('pointerleave',stopTorch);
    cover.addEventListener('keydown',e=>{if(e.key==='Tab')stopTorch();});
    window.addEventListener('blur',stopTorch);
    window.addEventListener('blur',stopSound);
    document.addEventListener('visibilitychange',visibility);
    fine.addEventListener('change',stopTorch);reduced.addEventListener('change',stopTorch);
}

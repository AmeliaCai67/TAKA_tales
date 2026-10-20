// Collect dialogs own their media element and cancel every pending playback on exit.
import { acquireAudio } from '../audioPriority';
import { prefetchTts, revokeBlobUrl } from '../audio-cache';
import { splitTtsUrls } from '../speech';
import { speechPref } from '../settings';
import { pack } from '../pack';
import { lang } from '../i18n';

let generation = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentNarration = false;
let finishCurrent: (() => void) | null = null;
let releaseAudio: (() => void) | null = null;

export function stopCollectAudio(): void {
    generation++;
    finishCurrent?.();
    finishCurrent = null;
    releaseAudio?.();
    releaseAudio = null;
}
export function audioBase(): string {
    return pack().baseUrl + (lang === 'en' ? 'audio-en/' : 'audio/');
}
export function playSrc(src: string, narration = true): Promise<void> {
    finishCurrent?.();
    releaseAudio?.();
    const audio = new Audio(src);
    currentAudio = audio;
    currentNarration = narration;
    audio.volume = speechPref.volume;
    audio.playbackRate = narration ? speechPref.rate : 1;
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.onended = audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            if (finishCurrent === finish) finishCurrent = null;
            if (currentAudio === audio) currentAudio = null;
            resolve();
        };
        const timer = setTimeout(finish, 120000);
        finishCurrent = finish;
        audio.onended = audio.onerror = finish;
        releaseAudio = acquireAudio('codex', () => audio.pause(), () => void audio.play().catch(finish));
        void audio.play().catch(finish);
    });
}
export async function playTts(text: string): Promise<void> {
    const current = generation;
    const promises = prefetchTts(splitTtsUrls(text, 'console'));
    // Pending fetches still settle after exit. Each URL must then be revoked as well.
    promises.forEach(p => void p.then(url => { if (url && current !== generation) revokeBlobUrl(url); }));
    for (const pending of promises) {
        const url = await pending;
        if (current !== generation) return;
        if (!url) continue;
        try { await playSrc(url); }
        finally { revokeBlobUrl(url); }
    }
}

document.addEventListener('taka-volume-change', () => { if (currentAudio) currentAudio.volume = speechPref.volume; });
document.addEventListener('taka-rate-change', () => { if (currentAudio && currentNarration) currentAudio.playbackRate = speechPref.rate; });

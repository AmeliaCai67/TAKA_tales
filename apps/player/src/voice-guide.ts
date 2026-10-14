/** Keep the voice tutorial on the art page without covering choices or the microphone. */
export function positionVoiceGuide(bubble: HTMLElement): () => void {
    let disposed = false, frame = 0;
    const observed = new Set<Element>();
    const observer = new ResizeObserver(() => schedule());
    function schedule() {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(place); });
    }
    function place() {
        if (disposed || !bubble.isConnected) return;
        const mic = [...document.querySelectorAll<HTMLElement>('.mic-hotspot')]
            .find(el => !el.closest('.spread')?.classList.contains('turned') && getComputedStyle(el).visibility === 'visible');
        const left = mic?.closest<HTMLElement>('.page-scene');
        if (!mic || !left) return;
        for (const target of [bubble, left, ...left.querySelectorAll('.hotspot')]) {
            if (!observed.has(target)) { observed.add(target); observer.observe(target); }
        }
        const bounds = left.getBoundingClientRect(), anchor = mic.getBoundingClientRect();
        const obstacles = [...left.querySelectorAll<HTMLElement>('.hotspot, .taka-figure')]
            .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
        const gap = 12;
        bubble.style.right = 'auto';bubble.style.bottom = 'auto';
        bubble.hidden = false;
        for (const compact of [false, true]) {
            bubble.classList.toggle('guide-compact', compact);
            const w=bubble.offsetWidth,h=bubble.offsetHeight;
            if (w > bounds.width-gap*2 || h > bounds.height-gap*2) continue;
            const cx=anchor.left+anchor.width/2,cy=anchor.top+anchor.height/2;
            const xs=[cx-w+26, anchor.left-w-gap, anchor.right+gap, bounds.left+gap, bounds.right-w-gap, bounds.left+(bounds.width-w)/2];
            const ys=[anchor.top-h-gap,cy-h/2,anchor.bottom+gap,bounds.top+gap,bounds.bottom-h-gap,bounds.top+(bounds.height-h)/2];
            let best: {x:number;y:number;distance:number}|null=null;
            for (const rawX of xs) for (const rawY of ys) {
                const x=Math.max(bounds.left+gap,Math.min(bounds.right-w-gap,rawX));
                const y=Math.max(bounds.top+gap,Math.min(bounds.bottom-h-gap,rawY));
                if (obstacles.some(r=>x<r.right+gap && x+w>r.left-gap && y<r.bottom+gap && y+h>r.top-gap)) continue;
                const distance=(x+w/2-cx)**2+(y+h/2-cy)**2;
                if(!best || distance<best.distance)best={x,y,distance};
            }
            if(!best)continue;
            bubble.style.left=best.x+'px';bubble.style.top=best.y+'px';
            const side=best.y+h<=anchor.top?'above':best.y>=anchor.bottom?'below':best.x+w<=anchor.left?'left':best.x>=anchor.right?'right':'none';
            bubble.dataset.guideSide=side;
            bubble.style.setProperty('--guide-arrow-x',Math.max(12,Math.min(w-12,cx-best.x))+'px');
            bubble.style.setProperty('--guide-arrow-y',Math.max(12,Math.min(h-12,cy-best.y))+'px');
            bubble.style.visibility='visible';return;
        }
        // Very small layouts keep the pulsing mic and spoken onboarding; never obscure a choice.
        bubble.hidden=true;
    }
    bubble.style.visibility='hidden';
    window.addEventListener('resize', schedule);document.fonts.ready.then(()=>{if(!disposed)schedule();});schedule();
    return ()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',schedule);};
}

import {InteractionAudio,type InteractionSound} from './interaction-audio';
import {speechPref} from '../settings';
import type {Scene} from '../story';
export interface SceneSound{id:string;kind:InteractionSound;match:string;}
/** Narration-aligned accents: metadata from the existing audio manifest, no fixed timers. */
export function mountSceneSounds(scene:Scene,key:string){
 let disposed=false;const played=new Set<string>(),life=new AbortController();
 const active=()=>!disposed&&!document.hidden;
 const sound=new InteractionAudio(active);
 const play=(cue:SceneSound)=>{if(!played.has(cue.id)){played.add(cue.id);sound.play(cue.kind);}};
 document.addEventListener('taka-narration-line',event=>{
  const detail=(event as CustomEvent<{scene:string;text:string}>).detail;if(detail.scene!==key)return;
  for(const cue of scene.sounds||[])if(detail.text.toLowerCase().includes(cue.match.toLowerCase()))play(cue);
 },{signal:life.signal});
 return {read(){if(!speechPref.on){const first=scene.sounds?.[0];if(first)play(first);}},cleanup(){disposed=true;life.abort();sound.cleanup();}};
}

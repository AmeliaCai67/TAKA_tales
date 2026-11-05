// Story × child state. Scene progress stays in progress.ts; variables and local
// mechanic checkpoints survive refresh, language switches and layout remounts.
import {pack} from './pack';
import {session} from './session';
import {lang} from './i18n';
const key=()=>`taka_vars_${pack().id}_${session.childId??'guest'}`;
export function storyState():Record<string,unknown>{try{const value=JSON.parse(localStorage.getItem(key())||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
export function updateStoryState(patch:Record<string,unknown>):void{try{localStorage.setItem(key(),JSON.stringify({...storyState(),...patch}));}catch{}}
export function clearStoryState():void{try{localStorage.removeItem(key());}catch{}}
export function storyVariables():Record<string,string>{const state=storyState();return {'用户输入的小海獭名字':typeof state.otterName==='string'?state.otterName:lang==='en'?'Tata':'塔塔'};}
export function resolveStoryText(text:string):string{return text.replace(/\{\{([^{}]+)\}\}/g,(all,key)=>storyVariables()[key]??all);}

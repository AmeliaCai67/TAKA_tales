import {pack} from './pack';
import {lang} from './i18n';
export function storyAudioDisabled():boolean{return pack().audioPolicy?.disabledLanguages.includes(lang)??false;}

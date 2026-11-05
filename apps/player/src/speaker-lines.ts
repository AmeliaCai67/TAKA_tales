import type {Seg} from './tts-segments';

/** Opt-in script format: a speaker label at the start of a line owns that line.
 * Prose mentioning a character remains narration. Existing book parsing stays unchanged. */
export function parseSpeakerLines(text:string, speakers:Record<string,string>, overrides?:Record<string,string>):Seg[] {
    const names=Object.keys(speakers).sort((a,b)=>b.length-a.length);
    return text.split(/[\r\n\u2028\u2029]+/).map(line=>line.trim()).filter(Boolean).map(line=>{
        for(const name of names){
            if(!line.startsWith(name))continue;
            const match=/^(?:说|小声说道|小声地说|（[^）]*）|\([^)]*\))?\s*[：:]\s*(.+)$/.exec(line.slice(name.length));
            if(match)return {who:overrides?.[name]||speakers[name],text:match[1]};
        }
        return {who:'narrator',text:line};
    });
}

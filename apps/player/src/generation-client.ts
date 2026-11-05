// All story input entries share account/guest identity and API configuration.
import {api, ApiError, type DialogueContext} from './api';
import {ensureAnonId} from './anon';
import {session} from './session';
import {pack} from './pack';
import {storyState} from './story-state';
import {lang, t} from './i18n';

export async function requestStoryReply(nextKey:string, previous:string, input:string,
                                        sceneKey:string, context?:DialogueContext) {
    const childId=session.token&&session.childId?session.childId:null;
    const anonId=childId?undefined:(await ensureAnonId())||undefined;
    const name=storyState().otterName;
    const dialogue=pack().id==='ch05-lost-otter'
        ? {...context,otter_name:typeof name==='string'?name:lang==='en'?'Tata':'塔塔'}:undefined;
    return api.generate(childId,pack().id,nextKey,previous.slice(-500),input,sceneKey,anonId,lang,dialogue);
}

export function generationError(error:unknown):string {
    const status=error instanceof ApiError?error.status:0;
    return t(status===401?'engine.err_401':status===429?'engine.err_429':status===503?'engine.err_503':'engine.err_network');
}

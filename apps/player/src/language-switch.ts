import { setLang, lang, t, applyStatic } from './i18n';
import { pack, setPack } from './pack';
import { loadStoryPack } from './story';
import { initAudioAssets } from './speech';

let refreshPresentation: () => void = () => {};
export function setLanguageRefreshHandler(handler: () => void): void { refreshPresentation = handler; }

/** 语言切换后重载当前包 + 原地重渲（spec §2：scene_key 语言无关，进度/成就零迁移） */
export async function switchLang(l: "zh" | "en"): Promise<void> {
    setLang(l);
    const currentId = pack().id;
    try {
        setPack(await loadStoryPack("stories/" + currentId + "/", lang));
        // 音频 manifest 按语言分（audio/ vs audio-en/）；切语言后必须重载，
        // 否则 audioManifest 还是上一语言的（用旧 manifest 段名去新语言目录找文件会 404→被吞）
        await Promise.race([initAudioAssets(), new Promise(r => setTimeout(r, 3000))]);
        // 说话人标签从包里取（zh=塔卡 / en=TAKA）
        const sp = document.getElementById("speaker-label");
        if (sp) {
            const tk = Object.entries(pack().speakers).find(([, v]) => v === "taka");
            sp.textContent = tk ? tk[0] : t("misc.doc_title");
        }
        applyStatic(); // 静态 DOM 换文案
        document.title = t("misc.doc_title") + " - " + pack().title;
        refreshPresentation(); // Shell injects current presentation; no entry-module import cycle.
    } catch { /* 网络异常时保持现状 */ }
}

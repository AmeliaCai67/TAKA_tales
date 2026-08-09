// 运行时配置（构建期可注入）
// VITE_TTS_ENDPOINT：动态 TTS 服务端点（edge-tts 服务）。默认与站点同源（infra/nginx 反代 /api/）
export const TTS_ENDPOINT: string =
    (import.meta.env?.VITE_TTS_ENDPOINT as string | undefined) || "/api/tts";

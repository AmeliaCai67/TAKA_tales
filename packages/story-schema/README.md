# story-schema — 故事包格式契约与作者指南

故事 = `content/stories/<故事id>/` 一个目录。**内容即数据**：加新故事不需要改任何代码。

```
content/stories/ch01-wind/
├── story.json          # 全部叙事内容（唯一事实源）
├── cover.jpg           # 书架封面（可选，建议 960px 宽 jpg）
└── audio/              # 语音包（tts-pipeline 生成）
    ├── manifest.json
    ├── 风声.mp3         # isSpecialListen 场景的环境音（可选）
    └── <场景key>/
        ├── 01_narrator.mp3
        ├── 02_taka.mp3
        └── choices.mp3  # 选项朗读
```

## 导入新故事：5 步

```bash
# 1. 建目录写 story.json（可复制 ch01-wind 改）
mkdir content/stories/ch02-xxx

# 2. 结构校验（分支闭合 / 可达性 / 音频覆盖 / 封面存在）
python3 packages/story-schema/validate_story.py content/stories/ch02-xxx

# 3. 渲染语音包（增量；--list 先看要渲哪些）
python3 -m tts_pipeline content/stories/ch02-xxx          # 需 .venv 或 Docker

# 4. 放封面 cover.jpg（story.json 里 cover 字段指过去）

# 5. 同步进播放器 + 重新构建
cd apps/player && node scripts/sync-content.mjs   # 自动重新生成书架 index.json
VITE_API_BASE=http://localhost:8000 VITE_TTS_ENDPOINT=http://localhost:8000/api/tts npm run build
```

书架自动出现新卡片。**排序 = 目录名字典序**（ch01-wind < ch02-xxx），播放器启动包 = index.json 第一个故事。

## story.json 根字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 故事 id，**与目录名一致**（进度/成就/会话的存储 key 都用它） |
| `title` | ✓ | 标题，书架卡片与页面标题展示 |
| `version` | ✓ | 整数，内容版本号（改内容递增） |
| `startScene` | ✓ | 首次进入的场景 key（通常是 prologue） |
| `restartScene` | ✓ | 「重新开始」目标场景；**进入时电量回满、路径清空、计一次新会话** |
| `depletedScene` | ✓ | 非结局场景电量耗尽时强制跳转的被动结局 |
| `speakers` | ✓ | 台词归属表：`{"塔卡": "taka", "海鸥": "seagull", ...}`，值为声线 id |
| `achievements` | ✓ | 成就数组，可为空 `[]` |
| `scenes` | ✓ | 场景表：key → 场景对象 |
| `cover` | | 书架封面图（相对包根，如 `"cover.jpg"`） |
| `summary` | | 书架一句话简介 |
| `ttsAliases` | | 读音别名：`{"757": "七五七"}`——显示文本不动，只改喂给 TTS 的文案（管线 + 播放器统一生效） |
| `characters` | | 绘本模式角色 SVG 注册表：`{"seagull": "characters/seagull.svg"}`（相对包根）。hotspot 的 `actor` 引用这里的键 |

## 绘本模式（横屏书页布局，2026-08-31）

视口宽度 ≥768px 自动进入（设置面板可强制开关）。场景不写 `book` 字段也能玩：左页 = `background` 图 + 塔卡默认位，选项退化为右页气泡按钮。`book` 字段只是构图微调，**全部可选**：

```jsonc
"book": {
  "art": "backgrounds/xxx.jpg",   // 左页画面；缺省 = scene.background
  "taka": { "x": 14, "y": 34, "rotate": 0 },  // 塔卡在左页的位置（%）与旋转
  "decor": ["waves", "sun"],      // 氛围件：waves 波纹 / sun 太阳 / bubbles 气泡
  "hotspots": [                    // 选项物化：长在画面里的发光可点物
    { "choice": 0, "actor": "seagull", "x": 70, "y": 20, "size": 15 }
  ]
}
```

- `hotspot.choice` 对齐 `choices` 下标；`actor` 用 `characters` 注册名或内置件 `light`（光斑）/ `coral` / `deep`（回海底）/ `shell` / `sun` / `waves`
- **叙事自洽红线**：hotspot 物化对象必须在该场景「在场」（例：海底场景不得出现海鸥）
- 未物化的选项自动在右页出气泡按钮兑底；自由输入（选项 C）在右页为虚线气泡，两种布局行为一致
- 译文包（story.en.json）的 `book` / `characters` 与中文包**深一致**（校验器强制——构图无文案，原样复制）

## 场景字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `text` | **必填** | 展示文本。台词用引号包裹（`「」`/`""`/`『』`均可），管线按 speakers 表归属声线 |
| `choices` | 无 | `[{text, next}]`，打字机完 + 眼睛闪三下后浮出；`next` 必须是存在的场景 key |
| `cost` | 10 | 进入本场景耗的电量 |
| `sun` | 无 | 太阳事件回电量（先扣后回；救不了已耗尽的电量） |
| `setBattery` | 无 | **结局标记**：进入时强制电量值。有此字段 = 结局场景 → 会话收尾、进度归位、出现「回到书架」按钮 |
| `eyeState` | standby | 场景灯光：`st-standby / st-thinking / st-listening / st-low / st-off`（低电量会自动把 standby 压成挣扎闪） |
| `endState` | 同 eyeState | 打字机结束后的灯光（如结局 B 关机 `st-off`） |
| `ending` | false | 结局标记（不动电量版）：会话收尾 + 出现「回到书架」；`setBattery` 场景天然是结局 |
| `voiceOverrides` | 无 | 场景级声线覆盖：`{"小钉": "rivet-calm"}`——显示文本不动，只改该场景该角色的朗读者（结局声音转变） |
| `mode` | land | `swim` = 收腿悬浮（水下）/ `land` = 伸腿站立 |
| `freeInput` | false | 本场景开放**选项 C**（自由输入，服务端 LLM 承接） |
| `beats` | 无 | **选项 C 必填**：该场景的叙事节拍数组，服务端用它组 prompt + 软命中审计。无 beats 的场景请求生成会 400 |
| `isSpecialListen` | false | 聆听条场景：风声 BGM 起、人声 duck 到 0.55、4 秒聆听条 |
| `listenLabel` | 「睁开眼睛，太阳升起来了」 | 聆听条结束按钮文案（**写管线会渲成 choices.mp3**，不写则静默回退浏览器 TTS） |
| `next` | 无 | 聆听条场景的跳转目标 |
| `ai` | — | ⚠️ 历史遗留字段，**无任何代码读取**，新故事不要写 |

## 成就

```json
{ "id": "listen_to_wind", "name": "且听风吟", "icon": "🌬️", "desc": "什么都不做，只听。", "unlockScene": "just_listen" }
```

- `unlockScene`：进入该场景即解锁（含电量耗尽被动跳入）
- id 全库唯一（多故事共存时建议带故事前缀，如 `ch02_xxx`）
- 书架卡片自动显示「🏅 已解锁/总数」

## 文本与声线规范（tts-pipeline）

- 正文按**空行分段**，每段一句或短句组；管线逐段渲染 `01_<声线>.mp3`
- 台词归属：**先解析引号归属，再清理引号**（"值了" bug 的教训）；无引号段落归 narrator
- **中文归属窗口**：`角色名 + ≤8 字引语 + 冒号 + 引号台词` 才认（如 `757："…"`、`塔卡小声说："…"`）。引语超过 8 字（如 `757 沉默了三秒，才说："…"`）整段掉回 narrator——**长引语请拆两行**：叙述一行（`757 沉默了三秒。`）+ 台词一行（`757："…"`），节奏也更好
- **插话式台词（中英均支持，2026-09-07）**：`757："而且，"757 的声音变得很轻，"我会看着你……"` 一行内「台词+叙述插条+续台词」会自动拆三段，续台词归同一说话人。注意引号必须成对；插条里不要再出现「名+冒号+引号」
- **英文归属**：必须名字锚定（`757 said: "…"` / `757: "…"`），**代词不认**（`Then it said:` 会掉回 narrator）；长引语同样建议拆行
- 声线 id 定义在 `packages/tts-pipeline/tts_pipeline/voices.py`（narrator / taka / seagull / oldmachine……新角色在那里登记）
- 声线可带 `fx` 后期链（ffmpeg 滤镜，如小钉的机械感：7bit 压碎 + 窄带 + 颤音）——管线与服务器动态 TTS 走同一条链，Docker 镜像已装 ffmpeg
- 选项朗读：`choices.mp3` 由场景 `choices[].text` 顺序拼接生成；聆听条场景由 `listenLabel` 生成

## 校验器检查项（validate_story.py）

1. JSON Schema 字段形状
2. cover 声明了就必须在包内
3. **分支闭合**：所有 `choices[].next` / `next` / `startScene` / `restartScene` / `depletedScene` 指向存在的场景
4. **可达性**：从 startScene 出发所有场景可达（死场景报错）
5. **音频覆盖**：每个场景 manifest 有条目、文本段与 mp3 段数一致（防"值了"式漏句）

## 内容红线（私有）

写作约束不在本包——见 `packages/prompts/redlines.json`（**私有库，永不公开**）：禁牺牲叙事/性别刻板/听话教育/天选之人/宗教词汇。作者定稿制：内置 A/B 路径永远是定稿文本，LLM 只在选项 C 介入。

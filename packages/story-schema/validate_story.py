#!/usr/bin/env python3
"""TAKA 故事包结构校验器（零依赖，stdlib only）。

用法：python3 packages/story-schema/validate_story.py content/stories/ch01-wind

检查项（schema.json 管字段形状，本脚本管结构完整性）：
  1. story.json 可解析、必填字段齐全、枚举值合法
  2. 分支闭合：所有 choices[].next / scene.next 指向存在的场景
  3. 可达性：从 startScene 出发能到达所有场景；至少一条路径到达结局（setBattery 或 ending:true 场景）
  4. freeInput 场景必须有 beats（服务端按 beats 判断能否生成，ai 字段已废弃）
  5. 成就 unlockScene 指向存在的场景；speakers 非空
  6. 音频覆盖：audio/manifest.json 存在；其场景键与 story.json 场景一致；
     manifest 引用的每个 mp3 文件存在于磁盘
退出码：0 通过 / 1 有错误。
"""
import json
import os
import sys

EYE_STATES = {"st-standby", "st-thinking", "st-listening", "st-low", "st-off"}
MODES = {"swim", "land"}


def validate(pack_dir: str) -> list[str]:
    errors: list[str] = []
    warn: list[str] = []

    story_path = os.path.join(pack_dir, "story.json")
    try:
        with open(story_path, encoding="utf-8") as f:
            pack = json.load(f)
    except Exception as e:
        return [f"story.json 解析失败: {e}"]

    # --- 1. 顶层必填 ---
    for field in ["id", "title", "version", "startScene", "restartScene", "speakers", "achievements", "scenes"]:
        if field not in pack:
            errors.append(f"缺少顶层字段: {field}")
    if errors:
        return errors
    scenes = pack["scenes"]
    characters = pack.get("characters", {})  # 绘本模式角色 SVG 注册表（第 8/9 节共用）

    # --- 2/3. 场景字段 + 分支闭合 + 可达性 ---
    for sid, sc in scenes.items():
        if not sc.get("text"):
            errors.append(f"{sid}: 缺少 text")
        if "mode" in sc and sc["mode"] not in MODES:
            errors.append(f"{sid}: mode 非法: {sc['mode']}")
        if "eyeState" in sc and sc["eyeState"] not in EYE_STATES:
            errors.append(f"{sid}: eyeState 非法: {sc['eyeState']}")
        if "endState" in sc and sc["endState"] not in EYE_STATES:
            errors.append(f"{sid}: endState 非法: {sc['endState']}")
        if sc.get("freeInput") and not sc.get("beats"):
            errors.append(f"{sid}: freeInput=true 但缺少 beats（选项 C 会被服务端 400）")
        for ov in (sc.get("voiceOverrides") or {}):
            if ov not in pack.get("speakers", {}):
                warn.append(f"{sid}: voiceOverrides 的角色「{ov}」不在 speakers 表（不会生效）")
        if sc.get("ai") is not None:
            warn.append(f"{sid}: ai 字段已废弃（无任何代码读取），请删除；选项 C 由 freeInput+beats 决定")
        if sc.get("isSpecialListen"):
            if not sc.get("next"):
                errors.append(f"{sid}: isSpecialListen 场景缺少 next")
            if sc.get("choices"):
                errors.append(f"{sid}: isSpecialListen 场景不应有 choices（聆听条结束后走 next）")
            if not sc.get("listenLabel"):
                warn.append(f"{sid}: isSpecialListen 场景缺少 listenLabel（聆听条按钮将用引擎默认文案且无预渲染语音）")
        for c in sc.get("choices", []):
            if c.get("next") not in scenes:
                errors.append(f"{sid}: 选项「{c.get('text')}」指向不存在的场景 {c.get('next')}")
        if sc.get("next") and sc["next"] not in scenes:
            errors.append(f"{sid}: next 指向不存在的场景 {sc['next']}")
        if sc.get("freeInputNext") and sc["freeInputNext"] not in scenes:
            errors.append(f"{sid}: freeInputNext 指向不存在的场景 {sc['freeInputNext']}")

    # 可达性（BFS）
    start = pack["startScene"]
    if start not in scenes:
        errors.append(f"startScene 不存在: {start}")
    else:
        seen, queue = set(), [start]
        while queue:
            cur = queue.pop()
            if cur in seen:
                continue
            seen.add(cur)
            sc = scenes.get(cur, {})
            queue.extend(c["next"] for c in sc.get("choices", []) if c.get("next") in scenes)
            if sc.get("next") in scenes:
                queue.append(sc["next"])
            cn = sc.get("collect", {}).get("next")   # 收集小游戏节点（2026-09 第四章）：集满后跳转也构成边
            if cn in scenes:
                queue.append(cn)
        depleted = pack.get("depletedScene")
        for sid in scenes:
            if sid not in seen and sid != depleted:  # depletedScene 由引擎电量机制跳入，无需剧情边
                errors.append(f"场景不可达: {sid}")
        if not any(scenes[s].get("setBattery") is not None or scenes[s].get("ending") for s in seen):
            errors.append("从 startScene 出发无法到达任何结局场景（setBattery 或 ending:true）")

    if pack["restartScene"] not in scenes:
        errors.append(f"restartScene 不存在: {pack['restartScene']}")
    if pack.get("depletedScene") not in scenes:
        errors.append(f"depletedScene 不存在: {pack.get('depletedScene')}")
    elif scenes[pack["depletedScene"]].get("setBattery") != 0:
        warn.append(f"depletedScene 的 setBattery 应为 0: {pack['depletedScene']}")

    # --- 5. 成就 / 角色表 ---
    for a in pack["achievements"]:
        for f in ["id", "name", "icon", "desc", "unlockScene"]:
            if f not in a:
                errors.append(f"成就缺少字段 {f}: {a}")
        if a.get("unlockScene") not in scenes:
            errors.append(f"成就 {a.get('id')} 的 unlockScene 不存在: {a.get('unlockScene')}")
    if not pack["speakers"]:
        errors.append("speakers 为空（台词归属表至少要叙述者外的角色）")

    # --- 6. 音频覆盖 ---
    manifest_path = os.path.join(pack_dir, "audio", "manifest.json")
    if not os.path.exists(manifest_path):
        warn.append("audio/manifest.json 不存在（该故事包将全程回退浏览器 TTS）")
    else:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        for sid in scenes:
            if sid not in manifest:
                errors.append(f"manifest 缺少场景: {sid}")
        for sid in manifest:
            if sid not in scenes:
                errors.append(f"manifest 多出未知场景: {sid}")
        for sid, entry in manifest.items():
            files = [s["file"] for s in entry.get("segments", [])]
            if entry.get("choices"):
                files.append(entry["choices"]["file"])
            if not files:
                errors.append(f"manifest {sid}: 没有任何音频段")
            for rel in files:
                if not os.path.exists(os.path.join(pack_dir, "audio", rel)):
                    errors.append(f"manifest {sid}: 音频文件缺失 {rel}")
        # 有 choices 的场景应有 choices 音频（否则家长开了「朗读选项」会静默）
        for sid, sc in scenes.items():
            if sc.get("choices") and sid in manifest and not manifest[sid].get("choices"):
                warn.append(f"manifest {sid}: 场景有选项但无 choices 音频（将走浏览器 TTS 兜底）")

    # --- 7. 记忆库（codex，2026-08-25）---
    entries = pack.get("codex", {}).get("entries", [])
    entry_ids = set()
    for e in entries:
        for f in ["id", "name", "image", "science", "takaSays", "source"]:
            if f not in e:
                errors.append(f"词条缺少字段 {f}: {e.get('id', e)}")
        eid = e.get("id")
        if eid in entry_ids:
            errors.append(f"词条 id 重复: {eid}")
        entry_ids.add(eid)
        if e.get("image") and not os.path.exists(os.path.join(pack_dir, e["image"])):
            errors.append(f"词条 {eid}: 图片不存在 {e.get('image')}")
        src = e.get("source", {})
        for f in ["title", "author", "license", "url"]:
            if not src.get(f):
                errors.append(f"词条 {eid}: source 缺 {f}（图片许可四元组必须齐全）")
        if not e.get("science") or not e.get("takaSays"):
            errors.append(f"词条 {eid}: science/takaSays 不能为空")
    for sid, sc in scenes.items():
        for link in sc.get("codex", []):
            if link.get("entry") not in entry_ids:
                errors.append(f"场景 {sid}: codex 引用了不存在的词条 {link.get('entry')}")
            elif link.get("word") not in sc.get("text", ""):
                errors.append(f"场景 {sid}: 关键词「{link.get('word')}」不在场景文本里")
    for e in entries:
        linked = any(l.get("entry") == e["id"] for sc in scenes.values() for l in sc.get("codex", []))
        # 收集闭环 codexId 也是发现路径（2026-09-07 海底农场：录入即解锁，不走场景关键词标注）
        collected = any(it.get("codexId") == e["id"] for sc in scenes.values() for it in (sc.get("collect") or {}).get("items", []))
        if not linked and not collected:
            warn.append(f"词条 {e['id']} 没有被任何场景标注（永远不会被发现）")

    # --- 7.5 记忆库词条音频覆盖（2026-08-28）：词条卡「听一听」预渲染进包 ---
    for e in entries:
        for suffix in ("science", "taka"):
            rel = f"codex/{e['id']}.{suffix}.mp3"
            for adir in ["audio", "audio-en"]:
                aroot = os.path.join(pack_dir, adir)
                if os.path.isdir(aroot) and not os.path.exists(os.path.join(aroot, rel)):
                    warn.append(f"{adir}/{rel} 缺失（词条卡将回退实时 TTS）")

    # --- 8. 译文包 parity（2026-08-28 i18n spec §7）：story.<lang>.json 必须与基准包同骨架 ---
    import glob
    for tp in glob.glob(os.path.join(pack_dir, "story.*.json")):
        lang = os.path.basename(tp)[len("story."):-len(".json")]
        try:
            with open(tp, encoding="utf-8") as f:
                tr = json.load(f)
        except Exception as e:
            errors.append(f"{os.path.basename(tp)} 解析失败: {e}")
            continue
        tscenes = tr.get("scenes", {})
        # 场景键一致
        if set(tscenes) != set(scenes):
            errors.append(f"[{lang}] 场景键不一致：多 {sorted(set(tscenes)-set(scenes))} / 缺 {sorted(set(scenes)-set(tscenes))}")
        for sid, sc in scenes.items():
            ts = tscenes.get(sid)
            if not ts:
                continue
            # 选项图一致（数量 + next 目标）
            zc, tc = sc.get("choices", []), ts.get("choices", [])
            if len(zc) != len(tc):
                errors.append(f"[{lang}] {sid}: choices 数量不一致 zh={len(zc)} {lang}={len(tc)}")
            elif [c.get("next") for c in zc] != [c.get("next") for c in tc]:
                errors.append(f"[{lang}] {sid}: choices.next 序列不一致")
            if sc.get("next") != ts.get("next"):
                errors.append(f"[{lang}] {sid}: next 不一致")
            # 结构标记一致
            for flag in ["freeInput", "isSpecialListen", "setBattery", "ending", "mode", "outputMaxLength", "background"]:
                if sc.get(flag) != ts.get(flag):
                    errors.append(f"[{lang}] {sid}: 结构标记 {flag} 不一致（zh={sc.get(flag)} {lang}={ts.get(flag)}）")
            # codex 标注：entry 引用一致，word 必须真的出现在译文文本里
            zlinks = {l["entry"]: l for l in sc.get("codex", [])}
            tlinks = {l["entry"]: l for l in ts.get("codex", [])}
            if set(zlinks) != set(tlinks):
                errors.append(f"[{lang}] {sid}: codex 标注不一致 zh={sorted(zlinks)} {lang}={sorted(tlinks)}")
            for l in ts.get("codex", []):
                if l.get("word") not in ts.get("text", ""):
                    errors.append(f"[{lang}] {sid}: 关键词「{l.get('word')}」不在译文文本里")
            # book 构图无本地化文案（label 取自 choices），要求与基准包深一致
            if sc.get("book") != ts.get("book"):
                errors.append(f"[{lang}] {sid}: book 构图不一致（book 字段不含文案，译文包应原样复制）")
            # collect 闭环字段 parity（2026-09-07）：几何/机制一致，文案条数一致
            zc2, tc2 = sc.get("collect"), ts.get("collect")
            if (zc2 is None) != (tc2 is None):
                errors.append(f"[{lang}] {sid}: collect 字段有无不一致")
            elif zc2:
                if zc2.get("required") != tc2.get("required") or zc2.get("next") != tc2.get("next") or zc2.get("achievement") != tc2.get("achievement"):
                    errors.append(f"[{lang}] {sid}: collect required/next/achievement 不一致")
                zi, ti = zc2.get("items", []), tc2.get("items", [])
                if [i.get("id") for i in zi] != [i.get("id") for i in ti]:
                    errors.append(f"[{lang}] {sid}: collect.items id 序列不一致")
                else:
                    for a, b in zip(zi, ti):
                        for geo in ("actor", "x", "y", "size", "codexId", "meowSfx"):
                            if a.get(geo) != b.get(geo):
                                errors.append(f"[{lang}] {sid}: 收集物「{a.get('id')}」{geo} 不一致")
                        if len(a.get("observe", [])) != len(b.get("observe", [])):
                            errors.append(f"[{lang}] {sid}: 收集物「{a.get('id')}」observe 条数不一致")
                        elif [o["who"] for o in a["observe"]] != [o["who"] for o in b["observe"]]:
                            errors.append(f"[{lang}] {sid}: 收集物「{a.get('id')}」observe 声线序列不一致")
                        if len(a.get("facts", [])) != len(b.get("facts", [])):
                            errors.append(f"[{lang}] {sid}: 收集物「{a.get('id')}」facts 条数不一致")
                        zt, tt = a.get("tags", {}), b.get("tags", {})
                        if zt.get("pick") != tt.get("pick") or len(zt.get("pool", [])) != len(tt.get("pool", [])) or len(zt.get("correct", [])) != len(tt.get("correct", [])):
                            errors.append(f"[{lang}] {sid}: 收集物「{a.get('id')}」tags 结构不一致")
        if tr.get("characters", {}) != characters:
            errors.append(f"[{lang}] characters 注册表不一致")
        # 成就/词条 id 集合一致
        if {a["id"] for a in tr.get("achievements", [])} != {a["id"] for a in pack["achievements"]}:
            errors.append(f"[{lang}] 成就 id 集合不一致")
        zids = {e["id"] for e in pack.get("codex", {}).get("entries", [])}
        tids = {e["id"] for e in tr.get("codex", {}).get("entries", [])}
        if zids != tids:
            errors.append(f"[{lang}] codex 词条 id 不一致 zh={sorted(zids)} {lang}={sorted(tids)}")
        else:
            for te in tr.get("codex", {}).get("entries", []):
                ze = next(e for e in pack["codex"]["entries"] if e["id"] == te["id"])
                if te.get("image") != ze.get("image"):
                    errors.append(f"[{lang}] 词条 {te['id']} 图片路径不一致")
        # 声线 id 值集合一致（键是角色显示名，允许不同语言）
        if set(tr.get("speakers", {}).values()) != set(pack["speakers"].values()):
            errors.append(f"[{lang}] speakers 声线值集合不一致")
        # 长文本软告警：译文超中文 2.5 倍（打字机/排版风险）
        for sid, ts in tscenes.items():
            zl = len(scenes.get(sid, {}).get("text", ""))
            if zl and len(ts.get("text", "")) > zl * 2.5:
                warn.append(f"[{lang}] {sid}: 译文长度 {len(ts['text'])} 超中文 {zl} 的 2.5 倍")

    # --- 9. 绘本模式 book 字段（2026-08-31）---
    BUILTIN_ACTORS = {"light", "coral", "deep", "shell", "sun", "waves", "screen", "green", "door",
                      "grass", "cat", "bee", "butterfly"}  # 引擎内置 hotspot/收集件（2026-09 第四章收集物）
    for actor, rel in characters.items():
        if not rel.endswith(".svg"):
            errors.append(f"characters.{actor}: 只支持 .svg（{rel}）")
        elif not os.path.exists(os.path.join(pack_dir, rel)):
            errors.append(f"characters.{actor}: 文件不存在 {rel}")
    for sid, sc in scenes.items():
        book = sc.get("book")
        if not book:
            continue
        n_choices = len(sc.get("choices", []))
        art = book.get("art")
        if art and not os.path.exists(os.path.join(pack_dir, art)):
            errors.append(f"{sid}: book.art 文件不存在 {art}")
        seen_choice = set()
        for h in book.get("hotspots", []):
            ci = h.get("choice")
            if ci is None or not isinstance(ci, int) or ci < 0 or ci >= n_choices:
                errors.append(f"{sid}: hotspot.choice={ci} 越界（本场景只有 {n_choices} 个选项）")
            elif ci in seen_choice:
                errors.append(f"{sid}: hotspot.choice={ci} 重复")
            else:
                seen_choice.add(ci)
            actor = h.get("actor", "")
            if actor not in characters and actor not in BUILTIN_ACTORS:
                errors.append(f"{sid}: hotspot actor「{actor}」未在 characters 注册，也不是内置件 {sorted(BUILTIN_ACTORS)}")
        # 常驻角色（非交互演出件）：actor 注册检查，与 hotspot 同一套规则
        for a in book.get("actors", []):
            actor = a.get("actor", "")
            if actor not in characters and actor not in BUILTIN_ACTORS:
                errors.append(f"{sid}: 常驻角色 actor「{actor}」未在 characters 注册，也不是内置件 {sorted(BUILTIN_ACTORS)}")
            for k in ("x", "y"):
                if not isinstance(a.get(k), (int, float)):
                    errors.append(f"{sid}: 常驻角色「{actor}」缺 {k} 坐标")

    # --- 9.5 收集小游戏节点（collect，2026-09 第四章）---
    ach_ids = {a["id"] for a in pack["achievements"]}
    for sid, sc in scenes.items():
        col = sc.get("collect")
        if not col:
            continue
        items = col.get("items") or []
        if not items:
            errors.append(f"{sid}: collect 缺少 items")
        if not isinstance(col.get("required", 0), int) or col["required"] < 1:
            errors.append(f"{sid}: collect.required 必须 >=1")
        if col.get("next") not in scenes:
            errors.append(f"{sid}: collect.next 指向不存在的场景 {col.get('next')}")
        ach = col.get("achievement")
        if ach and ach not in ach_ids:
            errors.append(f"{sid}: collect.achievement「{ach}」不在成就表")
        if sc.get("choices"):
            errors.append(f"{sid}: collect 节点不应有普通 choices（收集是唯一推进）")
        col_ids: set[str] = set()
        for it in items:
            if not it.get("id") or it.get("id") in col_ids:
                errors.append(f"{sid}: 收集物 id 缺失或重复: {it.get('id')}")
            col_ids.add(it.get("id"))
            actor = it.get("actor", "")
            if actor not in characters and actor not in BUILTIN_ACTORS:
                errors.append(f"{sid}: 收集物 actor「{actor}」未在 characters 注册，也不是内置件 {sorted(BUILTIN_ACTORS)}")
            for k in ("x", "y"):
                if not isinstance(it.get(k), (int, float)):
                    errors.append(f"{sid}: 收集物「{it.get('id')}」缺 {k} 坐标")
            # --- 海底农场闭环字段（2026-09-07 spec）---
            obs = it.get("observe") or []
            if not obs or any(not o.get("who") or not o.get("line") for o in obs):
                errors.append(f"{sid}: 收集物「{it.get('id')}」observe 缺失或缺 who/line")
            else:
                voice_ids = set(pack.get("speakers", {}).values())
                for o in obs:
                    if o["who"] not in voice_ids and o["who"] not in BUILTIN_ACTORS:
                        errors.append(f"{sid}: 收集物「{it.get('id')}」observe.who「{o['who']}」不在 speakers 声线表/内置件")
            if not it.get("facts") or any(not f.strip() for f in it["facts"]):
                errors.append(f"{sid}: 收集物「{it.get('id')}」facts 缺失或为空")
            tags = it.get("tags") or {}
            pool, correct, pick = tags.get("pool") or [], tags.get("correct") or [], tags.get("pick", 0)
            if len(pool) < 3:
                errors.append(f"{sid}: 收集物「{it.get('id')}」tags.pool 至少 3 枚")
            if not correct or not set(correct) <= set(pool):
                errors.append(f"{sid}: 收集物「{it.get('id')}」tags.correct 必须非空且 ⊆ pool")
            if not isinstance(pick, int) or pick < 1 or pick > len(correct):
                errors.append(f"{sid}: 收集物「{it.get('id')}」tags.pick 必须在 1..len(correct) 内")
            cxid = it.get("codexId")
            codex_entry_ids = {e["id"] for e in (pack.get("codex") or {}).get("entries", [])}
            if not cxid or cxid not in codex_entry_ids:
                errors.append(f"{sid}: 收集物「{it.get('id')}」codexId「{cxid}」不在 codex.entries")

    for w in warn:
        print("WARN:", w)
    return errors


def main():
    pack_dir = sys.argv[1] if len(sys.argv) > 1 else "content/stories/ch01-wind"
    errors = validate(pack_dir)
    if errors:
        for e in errors:
            print("ERR :", e)
        print(f"✗ {len(errors)} 个错误")
        sys.exit(1)
    print(f"✓ 故事包校验通过: {pack_dir}")


if __name__ == "__main__":
    main()

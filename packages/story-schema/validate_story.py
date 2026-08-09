#!/usr/bin/env python3
"""TAKA 故事包结构校验器（零依赖，stdlib only）。

用法：python3 packages/story-schema/validate_story.py content/stories/ch01-wind

检查项（schema.json 管字段形状，本脚本管结构完整性）：
  1. story.json 可解析、必填字段齐全、枚举值合法
  2. 分支闭合：所有 choices[].next / scene.next 指向存在的场景
  3. 可达性：从 startScene 出发能到达所有场景；至少一条路径到达结局（setBattery 场景）
  4. ai 场景必须有 beats；isSpecialListen 场景必须有 next 且无 choices
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
        if sc.get("ai") and not sc.get("beats"):
            errors.append(f"{sid}: ai=true 但缺少 beats")
        if not sc.get("ai") and sc.get("beats"):
            warn.append(f"{sid}: 有 beats 但 ai 未标记（beats 不会生效）")
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
        for sid in scenes:
            if sid not in seen:
                errors.append(f"场景不可达: {sid}")
        if not any(scenes[s].get("setBattery") is not None for s in seen):
            errors.append("从 startScene 出发无法到达任何结局场景（setBattery）")

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

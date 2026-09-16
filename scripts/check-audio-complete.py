#!/usr/bin/env python3
"""校验中英文语音包完整性。

两层校验：
  1) 文件级：manifest.json 每个段引用的 mp3 都存在；故事里每个场景都被 manifest 覆盖。
  2) 深度一致性：用 tts-pipeline 的分段器从当前 story.json / story.en.json 重算"应有段"，
     逐场景逐段（text/who/choices）与磁盘 manifest 对比——捕捉"文本改了但没重渲"的隐性缺漏。

用法：
  python3 scripts/check-audio-complete.py                 # 全部故事 × 中/英
  python3 scripts/check-audio-complete.py --story ch02-whale
  python3 scripts/check-audio-complete.py --lang en
  python3 scripts/check-audio-complete.py --list          # 只看文件级摘要（不跑深度对比）

注：脚本复用 tts_pipeline；若提示找不到模块，请用项目 venv 或设 PYTHONPATH=packages/tts-pipeline。
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

# 让脚本能 import packages/tts-pipeline
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "tts-pipeline"))

STORIES = ["ch01-wind", "ch02-whale", "ch03-rivet", "ch04-hello757"]  # 加新故事记得登记，否则这份校验会静默漏掉（2026-09-15 补 ch04）
BASE = ROOT / "content" / "stories"


def check_files(sid: str, lang: str):
    """文件级：manifest 引用的 mp3 存在 + 场景覆盖。返回 (问题列表, 段数)。"""
    pack_dir = BASE / sid
    audio_dir = pack_dir / ("audio-en" if lang == "en" else "audio")
    story_file = pack_dir / ("story.en.json" if lang == "en" else "story.json")
    story = json.load(open(story_file, encoding="utf-8"))
    manifest = json.load(open(audio_dir / "manifest.json", encoding="utf-8"))

    scene_ids = set(story["scenes"].keys())
    m_scenes = set(manifest.keys())
    problems = []

    # 场景覆盖
    for sc in sorted(scene_ids - m_scenes):
        problems.append(f"故事场景未被 manifest 覆盖: {sc}")
    for sc in sorted(m_scenes - scene_ids):
        problems.append(f"manifest 含故事外场景: {sc}")

    # 文件存在性
    missing = 0
    total = 0
    for sc, info in manifest.items():
        for seg in (info.get("segments") or []):
            total += 1
            if not (audio_dir / seg["file"]).exists():
                missing += 1
                if missing <= 10:
                    problems.append(f"缺失文件: {sc}/{seg['file']}")
        ch = info.get("choices")
        if isinstance(ch, str) and not (audio_dir / ch).exists():
            missing += 1
            problems.append(f"缺失文件: {sc}/choices [{ch}]")
    if missing > 10:
        problems.append(f"…共缺失 {missing} 个文件（仅列出前 10 个）")
    return problems, total


async def check_consistency(sid: str, lang: str):
    """深度一致性：文本应有段 == 磁盘 manifest。返回问题列表。"""
    from tts_pipeline.segments import load_pack, plan_pack
    from tts_pipeline.render import render_pack

    pack_dir = BASE / sid
    audio_dir = pack_dir / ("audio-en" if lang == "en" else "audio")
    pack = load_pack(pack_dir, lang)
    plan = plan_pack(pack)
    exp = await render_pack(pack, plan, audio_dir, dry_run=True, lang=lang)
    disk = json.load(open(audio_dir / "manifest.json", encoding="utf-8"))

    problems = []
    for sc in sorted(set(exp) | set(disk)):
        e = exp.get(sc) or {}
        d = disk.get(sc) or {}
        e_segs = [(s["file"], s["text"], s["who"]) for s in (e.get("segments") or [])]
        d_segs = [(s["file"], s["text"], s["who"]) for s in (d.get("segments") or [])]
        if e_segs != d_segs:
            problems.append(f"场景 {sc}: 磁盘段 {len(d_segs)} ≠ 应有段 {len(e_segs)}")
        if (e.get("choices") is None) != (d.get("choices") is None):
            problems.append(f"场景 {sc}: choices 存在性不一致")
    return problems


async def main():
    ap = argparse.ArgumentParser(description="校验中英文语音包完整性")
    ap.add_argument("--story", help="只校验某故事（如 ch02-whale）")
    ap.add_argument("--lang", choices=["zh", "en"], help="只校验某语言")
    ap.add_argument("--list", action="store_true", help="只跑文件级摘要（不做深度对比）")
    args = ap.parse_args()

    stories = [args.story] if args.story else STORIES
    langs = [args.lang] if args.lang else ["zh", "en"]

    print("=" * 60)
    any_fail = False
    for sid in stories:
        for lang in langs:
            problems, total = check_files(sid, lang)
            head = f"{sid} [{lang}]  段数={total}"
            if problems:
                any_fail = True
                print(f"❌ {head}  — 文件级问题 {len(problems)}:")
                for p in problems:
                    print("   -", p)
            else:
                print(f"✅ {head}  — 文件级完整")

            # 深度一致性（除非只 --list）
            if not args.list:
                print(f"   {sid} [{lang}] 深度一致性: ", end="")
                cons = await check_consistency(sid, lang)
                if cons:
                    any_fail = True
                    print(f"❌ {len(cons)} 处不一致")
                    for p in cons[:15]:
                        print("   -", p)
                else:
                    print("✅ 与当前故事文本一致")

        print("-" * 60)

    print("=" * 60)
    print("结果:", "❌ 有问题" if any_fail else "✅ 中英文语音包完整")
    sys.exit(1 if any_fail else 0)


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""把 redlines.json 的 max_length / max_paragraphs 同步到 system_prompt.md。

规则：
  prompt 字数软目标 = max_length × 0.6（取整到十位）。200→120，300→180。
  prompt 段落软目标 = 3 到 (max_paragraphs - 3) 段。8→「3-5 段」，12→「3-9 段」。

改完 packages/prompts/redlines.json 后跑一下即可：
  python3 scripts/sync-prompt-length.py
"""
import json
import re
from pathlib import Path

PROMPTS = Path(__file__).resolve().parent.parent / "packages" / "prompts"
RATIO = 0.5  # 软目标 / 硬上限（2026-08-14 从 0.6 下调：模型普遍超写 ~1.7 倍，压目标治超长）


def main():
    rules = json.loads((PROMPTS / "redlines.json").read_text(encoding="utf-8"))
    max_len = int(rules["max_length"])
    target = round(max_len * RATIO / 10) * 10
    max_para = int(rules["max_paragraphs"])
    para_hi = max_para - 3

    sp = PROMPTS / "system_prompt.md"
    text = sp.read_text(encoding="utf-8")
    new, n1 = re.subn(r"全文不超过 \d+ 字", f"全文不超过 {target} 字", text)
    new, n2 = re.subn(r"（\d+-\d+ 段）", f"（3-{para_hi} 段）", new)
    if n1 != 1 or n2 != 1:
        raise SystemExit(f"✗ system_prompt.md 匹配异常（字数行 {n1} 处 / 段落行 {n2} 处），未改动")
    if new == text:
        print(f"✓ 无需改动：prompt 已是 {target} 字 / 3-{para_hi} 段")
        return
    sp.write_text(new, encoding="utf-8")
    print(f"✓ 已同步：max_length={max_len} → {target} 字；max_paragraphs={max_para} → 3-{para_hi} 段")
    print("  注意：API 服务有 lru_cache，重启后生效（lsof -ti :8000 | xargs kill && bash scripts/dev-up.sh）")


if __name__ == "__main__":
    main()

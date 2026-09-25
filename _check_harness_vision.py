#!/usr/bin/env python3
"""Kiểm tra settings.yaml của Harness: mỗi model có id hợp lệ và modality đúng
tên khóa theo từng plugin. Chỉ đọc file, không sửa.

Tên khóa modality KHÁC NHAU giữa hai plugin:
  - Khối `llm-deepseek`  → `inputModalities`  (dsh-llm-deepseek)
  - Khối `llm-pi-ai`     → `input`            (dsh-llm-pi-ai)
Dùng nhầm tên khóa thì khóa bị bỏ qua và modality rơi về mặc định ["text"],
nên model không nhận được ảnh (lỗi UNSUPPORTED_CONTENT khi gửi ảnh).
"""
from __future__ import annotations

import re
from pathlib import Path

try:
    import yaml
except ImportError:
    raise SystemExit("Cần pyyaml: pip install pyyaml")

SETTINGS = Path(r"C:\Users\khang\.dsh\settings.yaml")
DSH = Path(r"C:\Users\khang\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai")

# Khối cấu hình → (plugin, tên khóa modality đúng)
BLOCKS = {
    "llm-deepseek": ("dsh-llm-deepseek", "inputModalities"),
    "llm-pi-ai": ("dsh-llm-pi-ai", "input"),
}

problems: list[str] = []


def check_block(block_name: str, models: list[dict], correct_key: str, path: str) -> None:
    wrong = "input" if correct_key == "inputModalities" else "inputModalities"
    print(f"\n[{block_name}] ← {path}")
    print(f"  Khóa modality đúng: `{correct_key}`")
    if not models:
        problems.append(f"{block_name}: không có model nào")
        print("  !! Không có model nào")
        return
    for i, model in enumerate(models):
        if not isinstance(model, dict) or "id" not in model:
            problems.append(f"{block_name}.models[{i}]: thiếu `id`")
            print(f"  !! [{i}] thiếu `id` → {model}")
            continue
        mods = model.get(correct_key)
        has_wrong = wrong in model
        tag = "OK " if mods else "!! "
        note = ""
        if has_wrong:
            note = f"  ← dùng sai khóa `{wrong}`"
            problems.append(f"{block_name}/{model['id']}: dùng sai khóa `{wrong}`")
        elif not mods:
            note = "  ← thiếu khai báo modality"
        print(f"  {tag}[{i}] id={model['id']:<26} {correct_key}={mods}{note}")


raw = SETTINGS.read_text(encoding="utf-8")
doc = yaml.safe_load(raw)

print("=" * 78)
print("KIỂM TRA settings.yaml — modality của model")
print("=" * 78)

for block_name, (plugin, key) in BLOCKS.items():
    if block_name == "llm-pi-ai":
        providers = (doc.get(block_name) or {}).get("providers") or {}
        for pname, pconf in providers.items():
            check_block(f"{block_name}.{pname}", (pconf or {}).get("models") or [], key, f"{plugin} / providers.{pname}")
    else:
        check_block(block_name, (doc.get(block_name) or {}).get("models") or [], key, plugin)

print("\n" + "=" * 78)
if problems:
    print(f"KẾT QUẢ: {len(problems)} vấn đề")
    for p in problems:
        print("  -", p)
    raise SystemExit(1)
print("KẾT QUẢ: mọi model đều có `id` và khai báo modality ĐÚNG tên khóa.")

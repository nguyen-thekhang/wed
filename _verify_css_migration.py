#!/usr/bin/env python3
"""Đối chiếu migration CSS: mọi selector trong khối <style> cũ phải còn tồn tại
trong app.css hoặc pages.css. Dùng một lần sau _extract_css.py, chỉ đọc.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
TEMP = Path(r"C:\Users\khang\AppData\Local\Temp")

backups = sorted(TEMP.glob("wed-backup-*"))
BAK = backups[-1] / "public"
print(f"Bản đối chiếu: {BAK}\n")


def sels(css: str) -> set[str]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out: set[str] = set()
    buf = ""
    depth = 0
    for ch in css:
        if ch == "{":
            if depth == 0:
                for part in buf.split(","):
                    part = re.sub(r"\s+", " ", part).strip()
                    if part and not part.startswith("@"):
                        out.add(part)
            depth += 1
            buf = ""
        elif ch == "}":
            depth -= 1
            buf = ""
        elif depth == 0:
            buf += ch
    return out


def blocks_of(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    return "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", text, re.S))


new_all = sels((PUBLIC / "css" / "app.css").read_text(encoding="utf-8")) | sels(
    (PUBLIC / "css" / "pages.css").read_text(encoding="utf-8")
)

missing_total = 0
for page in ["index.html", "logs.html", "images.html", "uid.html", "tickxanh.html", "login.html"]:
    old = blocks_of(BAK / page)
    old_sels = sels(old)
    missing = sorted(old_sels - new_all)
    extra = sorted(sels(blocks_of(PUBLIC / page)))  # phải rỗng
    missing_total += len(missing)
    print(f"{page}: {len(old_sels)} selector cũ · thiếu {len(missing)} · style còn lại {len(extra)}")
    for m in missing[:20]:
        print("    THIẾU:", m)
    for e in extra[:5]:
        print("    CÒN <style>:", e)

print(f"\nTỔNG SELECTOR BỊ THIẾU: {missing_total}")

for name in ["app.css", "pages.css"]:
    text = re.sub(r"/\*.*?\*/", "", (PUBLIC / "css" / name).read_text(encoding="utf-8"), flags=re.S)
    ok = text.count("{") == text.count("}")
    print(f"{name}: {{ = {text.count('{')}, }} = {text.count('}')} → {'cân bằng' if ok else 'LỆCH!'}")

"""Doi chieu id giua HTML va JS sau khi 20 agent sua song song.

Rui ro: agent sua HTML doi id, nhung agent sua JS khong chay -> JS goi id khong ton tai.
"""

import re
import os
from pathlib import Path

ROOT = Path(r"C:\Users\khang\OneDrive\Desktop\wed\public")

# Cap (html, js) can doi chieu
PAIRS = [
    ("index.html", ["js/dashboard.js", "js/chart.js"]),
    ("logs.html", ["js/logs.js"]),
    ("images.html", ["js/images.js"]),
    ("uid.html", ["js/uid.js"]),
    ("tickxanh.html", ["js/tickxanh.js"]),
    ("login.html", ["js/login.js"]),
]

# id he thong do Worker/asset sinh ra, khong nam trong HTML
IGNORE = {"app", "preloader-num", "preloader-fill", "preloader"}


def ids_in_html(p: Path) -> set:
    t = p.read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r'\bid="([^"]+)"', t))


def ids_used_in_js(p: Path) -> set:
    t = p.read_text(encoding="utf-8", errors="replace")
    out = set()
    # $("x"), getElementById("x"), setText("x", ...), querySelector("#x")
    for m in re.finditer(r'(?:\$|getElementById|setText|byId)\s*\(\s*["\']([A-Za-z0-9_\-]+)["\']', t):
        out.add(m.group(1))
    for m in re.finditer(r'querySelector(?:All)?\s*\(\s*["\']#([A-Za-z0-9_\-]+)["\']', t):
        out.add(m.group(1))
    return out - IGNORE


print("=" * 84)
print("DOI CHIEU ID: HTML <-> JS")
print("=" * 84)
total_missing = 0
for html_name, js_list in PAIRS:
    hp = ROOT / html_name
    if not hp.exists():
        print(f"\n[{html_name}] KHONG TON TAI")
        continue
    hid = ids_in_html(hp)
    print(f"\n[{html_name}]  co {len(hid)} id")
    for js_name in js_list:
        jp = ROOT / js_name
        if not jp.exists():
            print(f"   {js_name:<20} KHONG TON TAI")
            continue
        jid = ids_used_in_js(jp)
        missing = sorted(jid - hid)
        extra = sorted(hid - jid)
        if missing:
            total_missing += len(missing)
            print(f"   {js_name:<20} [!] JS GOI {len(missing)} ID KHONG CO TRONG HTML:")
            for m in missing[:14]:
                print(f"        - {m}")
        else:
            print(f"   {js_name:<20} OK ({len(jid)} id khop)")
        if extra and len(extra) <= 6:
            print(f"        (HTML co, JS khong dung: {', '.join(extra)})")

print("\n" + "=" * 84)
print(f"TONG ID BI THIEU: {total_missing}")

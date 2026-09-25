#!/usr/bin/env python3
"""Chuyển CSS nội tuyến trong các trang HTML ra stylesheet dùng chung.

- Giữ nguyên thứ tự khai báo để không đổi tầng cascade (pages.css nạp sau app.css).
- Chỉ bỏ những rule TRÙNG HOÀN TOÀN (cùng ngữ cảnh @media, cùng selector,
  cùng khai báo) với app.css — không bỏ rule có khai báo khác.
- login.html không nạp được pages.css (trang công khai), nên rule của nó
  được thêm vào cuối app.css.

Chạy một lần:  python _extract_css.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
APP_CSS = PUBLIC / "css" / "app.css"
PAGES_CSS = PUBLIC / "css" / "pages.css"
PAGES_FILE_LINK = '    <link rel="stylesheet" href="/css/pages.css" />\n'

STYLE_RE = re.compile(r"[ \t]*<style[^>]*>(.*?)</style>\n?", re.S)

# Thứ tự trang trong pages.css (theo menu điều hướng)
PAGE_ORDER = ["index.html", "logs.html", "images.html", "uid.html", "tickxanh.html"]
LOGIN_PAGE = "login.html"


class Rule:
    __slots__ = ("context", "selector", "body", "raw")

    def __init__(self, context: tuple[str, ...], selector: str, body: str):
        self.context = context
        self.selector = selector
        self.body = body

    @property
    def key(self) -> tuple:
        return (self.context, norm(self.selector), norm(self.body))

    def text(self, indent: str = "") -> str:
        s = f"{indent}{self.selector} {{{norm(self.body)}}}\n"
        return s


def norm(text: str) -> str:
    """Chuẩn hoá để so sánh: gộp khoảng trắng, bỏ dấu ; cuối."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s*;\s*", "; ", text).strip()
    return text.rstrip("; ")


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def parse(css: str) -> list[Rule]:
    """Bóc CSS thành danh sách rule phẳng, giữ ngữ cảnh @media lồng nhau."""
    css = strip_comments(css)
    rules: list[Rule] = []
    stack: list[str] = []
    buf = ""
    i = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            head = buf.strip()
            buf = ""
            if head.startswith("@"):
                stack.append(norm(head))
            else:
                # thân rule: đọc tới } tương ứng
                j = find_close(css, i)
                body = css[i + 1 : j]
                for sel in split_selectors(head):
                    rules.append(Rule(tuple(stack), sel, body))
                i = j
        elif ch == "}":
            if stack:
                stack.pop()
            buf = ""
        else:
            buf += ch
        i += 1
    return rules


def find_close(css: str, open_index: int) -> int:
    depth = 0
    i = open_index
    while i < len(css):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(css)


def split_selectors(head: str) -> list[str]:
    head = head.strip()
    if not head:
        return []
    return [re.sub(r"\s+", " ", p).strip() for p in head.split(",") if p.strip()]


def emit(rules: list[Rule]) -> str:
    """Xuất rule theo thứ tự gốc, mở/đóng khối @media khi ngữ cảnh đổi."""
    out: list[str] = []
    current: tuple[str, ...] = ()
    open_depth = 0
    for rule in rules:
        if rule.context != current:
            while open_depth:
                out.append("  " * (open_depth - 1) + "}")
                open_depth -= 1
            for depth, ctx in enumerate(rule.context):
                out.append(f"{'  ' * depth}{ctx} {{")
                open_depth = depth + 1
            current = rule.context
        indent = "  " * open_depth
        out.append(rule.text(indent).rstrip("\n"))
    while open_depth:
        out.append("  " * (open_depth - 1) + "}")
        open_depth -= 1
    return "\n".join(out) + "\n"


def main() -> int:
    app_css_text = APP_CSS.read_text(encoding="utf-8")
    app_keys = {r.key for r in parse(app_css_text)}

    login_rules: list[Rule] = []
    page_rules: dict[str, list[Rule]] = {}
    report: list[str] = []
    total_kept = 0
    total_dropped = 0

    for page in PAGE_ORDER + [LOGIN_PAGE]:
        path = PUBLIC / page
        html = path.read_text(encoding="utf-8")
        blocks = STYLE_RE.findall(html)
        if not blocks:
            report.append(f"{page}: không có <style>")
            continue
        rules = parse("\n".join(blocks))
        kept = [r for r in rules if r.key not in app_keys]
        dropped = len(rules) - len(kept)
        total_kept += len(kept)
        total_dropped += dropped

        if page == LOGIN_PAGE:
            login_rules = kept
        else:
            page_rules[page] = kept

        new_html = STYLE_RE.sub("", html)
        if page != LOGIN_PAGE and "/css/pages.css" not in new_html:
            new_html = new_html.replace("  </head>", PAGES_FILE_LINK + "  </head>", 1)
        path.write_text(new_html, encoding="utf-8")

        report.append(
            f"{page}: {len(rules)} rule → giữ {len(kept)}, bỏ {dropped} trùng app.css"
        )

    # pages.css
    parts = [
        "/* =============================================================================",
        "   pages.css — bố cục riêng của từng trang, nạp SAU app.css.",
        "",
        "   Quy ước: file này chỉ chứa phần bố cục đặc thù của một trang. Mọi token,",
        "   primitive và component dùng chung phải nằm trong app.css. Không khai báo",
        "   lại ở đây những gì app.css đã có.",
        "   ========================================================================== */",
        "",
    ]
    for page in PAGE_ORDER:
        rules = page_rules.get(page)
        if not rules:
            continue
        parts.append(f"/* ---------- Trang: {page} ---------- */")
        parts.append("")
        parts.append(emit(rules).rstrip("\n"))
        parts.append("")
    PAGES_CSS.write_text("\n".join(parts) + "\n", encoding="utf-8")

    # rule của login.html vào cuối app.css
    if login_rules:
        app_new = app_css_text.rstrip("\n")
        app_new += "\n\n/* ---------- Trang đăng nhập (trang công khai, không nạp pages.css) ---------- */\n\n"
        app_new += emit(login_rules)
        APP_CSS.write_text(app_new, encoding="utf-8")

    print("\n".join(report))
    print(f"\nTổng rule giữ lại: {total_kept}, đã bỏ (trùng hoàn toàn): {total_dropped}")
    print(f"pages.css: {PAGES_CSS.stat().st_size:,} B")
    print(f"app.css  : {APP_CSS.stat().st_size:,} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

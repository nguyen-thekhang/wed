#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kiểm thử offline cho bluecheck_watcher.py.

Chạy: python test/watcher-test.py

Bộ kiểm thử này không mở trang Facebook, không gọi Worker và không cần Playwright.
Nó nạp đúng module đang chạy, kiểm tra các hằng số và khóa hồi quy thứ tự kiểm tra
MARKER trước CometErrorRoot.
"""

from __future__ import annotations

import ast
import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType

# Windows có thể mặc định cp1258; bộ kiểm thử phải in được tiếng Việt có dấu.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WATCHER_PATH = ROOT / "bluecheck_watcher.py"
MODULE_NAME = "bluecheck_watcher_under_test"

passed = 0
failed = 0
failures: list[str] = []


def ok(name: str, condition: bool, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        failures.append(name + (f" — {detail}" if detail else ""))
        print(f"  ✗ {name}{f' — {detail}' if detail else ''}")


def section(title: str) -> None:
    print(f"\n{title}")


def load_watcher() -> ModuleType | None:
    """Nạp file bằng đường dẫn cụ thể, không phụ thuộc thư mục làm việc hiện tại."""
    if not WATCHER_PATH.is_file():
        return None
    spec = importlib.util.spec_from_file_location(MODULE_NAME, WATCHER_PATH)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def remove_docstrings(tree: ast.AST) -> ast.AST:
    """Bỏ docstring để quét cookie/login chỉ nhìn vào mã thực thi."""

    class DocstringRemover(ast.NodeTransformer):
        def _strip(self, node: ast.AST) -> ast.AST:
            body = getattr(node, "body", None)
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                node.body = body[1:]  # type: ignore[attr-defined]
            return self.generic_visit(node)

        def visit_Module(self, node: ast.Module) -> ast.AST:
            return self._strip(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> ast.AST:
            return self._strip(node)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
            return self._strip(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
            return self._strip(node)

    return DocstringRemover().visit(tree)


def runtime_source(tree: ast.AST) -> str:
    """Chuyển AST thành mã đã bỏ docstring; comment tự biến mất theo cú pháp."""
    return ast.unparse(remove_docstrings(tree))


def has_cookie_or_login_api(tree: ast.AST, code: str) -> bool:
    """Phát hiện cookie/session hoặc lời gọi đăng nhập trong mã thực thi."""
    if re.search(r"\bcookies?\b", code, flags=re.IGNORECASE):
        return True

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                call_name = func.id
            elif isinstance(func, ast.Attribute):
                call_name = func.attr
            else:
                call_name = ""

            if re.search(r"(?:login|signin|sign_in|authenticate)", call_name, flags=re.IGNORECASE):
                return True

            # storage_state và cookies là hai cách nạp phiên vào browser context.
            if any(keyword.arg in {"storage_state", "cookies"} for keyword in node.keywords):
                return True

            # URL đăng nhập nằm trong lời gọi là API đăng nhập; hằng LOGIN_HOSTS
            # chỉ dùng để nhận diện trình duyệt bị chuyển tới login không nằm ở đây.
            for argument in [*node.args, *(keyword.value for keyword in node.keywords)]:
                for literal in ast.walk(argument):
                    if isinstance(literal, ast.Constant) and isinstance(literal.value, str):
                        if re.search(r"facebook\.com/(?:login|checkpoint)(?:[/?#]|$)", literal.value, re.I):
                            return True

    return False


section("1. NẠP VÀ KIỂM TRA LOGIC WATCHER")
watcher = load_watcher()
ok("Import được bluecheck_watcher.py", watcher is not None)
ok(
    "MARKER bằng đúng show_verified_badge_on_profile",
    watcher is not None and watcher.MARKER == "show_verified_badge_on_profile",
    f"thực tế: {getattr(watcher, 'MARKER', '(không có)')!r}",
)
ok(
    "MAX_PER_ROUND không vượt quá 25",
    isinstance(getattr(watcher, "MAX_PER_ROUND", None), int)
    and not isinstance(getattr(watcher, "MAX_PER_ROUND", None), bool)
    and watcher.MAX_PER_ROUND <= 25,
    f"thực tế: {getattr(watcher, 'MAX_PER_ROUND', '(không có)')!r}",
)
ok(
    "DELAY_MIN không nhỏ hơn 5 giây",
    isinstance(getattr(watcher, "DELAY_MIN", None), (int, float))
    and not isinstance(getattr(watcher, "DELAY_MIN", None), bool)
    and watcher.DELAY_MIN >= 5,
    f"thực tế: {getattr(watcher, 'DELAY_MIN', '(không có)')!r}",
)

try:
    watcher_tree = ast.parse(WATCHER_PATH.read_text(encoding="utf-8"), filename=str(WATCHER_PATH))
    ast_error = ""
except (OSError, SyntaxError) as error:
    watcher_tree = ast.Module(body=[], type_ignores=[])
    ast_error = str(error)

watcher_code = runtime_source(watcher_tree) if not ast_error else ""
marker_probe = watcher_code.find("idx = html.find(MARKER)")
comet_probe = watcher_code.find("CometErrorRoot", marker_probe + 1)
ok(
    "Kiểm tra MARKER xuất hiện trước kiểm tra CometErrorRoot",
    not ast_error and marker_probe >= 0 and comet_probe > marker_probe,
    ast_error
    or f"marker={marker_probe}, CometErrorRoot={comet_probe}",
)
ok(
    "Watcher không chứa cookie, storage state hay login API",
    not ast_error and not has_cookie_or_login_api(watcher_tree, watcher_code),
    ast_error or "phát hiện thao tác cookie/login trong mã thực thi",
)

print(f"\n{'-' * 60}")
print(f"ĐẠT: {passed}   KHÔNG ĐẠT: {failed}")
if failures:
    print("\nCác mục không đạt:")
    for failure in failures:
        print(f"  - {failure}")
print("-" * 60)

sys.exit(1 if failed else 0)

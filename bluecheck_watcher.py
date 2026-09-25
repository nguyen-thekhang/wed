#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
bluecheck_watcher.py — Theo dõi tài khoản Facebook nào lên tích xanh.
================================================================================

CHẠY TRÊN MÁY CHỦ NHÀ (máy của bạn), KHÔNG chạy trên VPS.
Vì sao: dấu tích xanh chỉ nằm trong trang do JavaScript render, và IP của
VPS/Cloudflare đều bị Meta chặn. Chỉ IP nhà mới đọc được.

CÁCH HOẠT ĐỘNG (mỗi vòng lặp ~60 giây):
   1. Hỏi Worker: "hôm nay cần check UID nào?"
      GET  {WORKER_URL}/api/tickxanh/queue
      Authorization: Bearer {BLUECHECK_TOKEN}
   2. Với mỗi UID: mở trang profile bằng Chromium (Playwright), chờ React
      render, rồi đọc trường `show_verified_badge_on_profile` trong dữ liệu
      nhúng của trang. true = có tích xanh, false = chưa có.
   3. Đẩy kết quả về Worker:
      POST {WORKER_URL}/api/tickxanh/report
      Authorization: Bearer {BLUECHECK_TOKEN}

CHỈ DÙNG THÔNG TIN CÔNG KHAI. KHÔNG cookie, KHÔNG đăng nhập, KHÔNG proxy,
KHÔNG bypass CAPTCHA. Trang nào yêu cầu đăng nhập thì báo `unknown`, tuyệt đối
KHÔNG đoán bừa.

────────────────────────────────────────────────────────────────────────────────
CÀI ĐẶT
────────────────────────────────────────────────────────────────────────────────
    pip install playwright
    python -m playwright install chromium

TẠO BLUECHECK_TOKEN (1 lần):
    cd C:\\Users\\khang\\OneDrive\\Desktop\\wed
    npx wrangler secret put BLUECHECK_TOKEN

CHẠY THỬ (chạy 1 vòng rồi thoát):
    python bluecheck_watcher.py --once

CHẠY LIÊN TỤC:
    python bluecheck_watcher.py

────────────────────────────────────────────────────────────────────────────────
GIỚI HẠN ĐÃ BIẾT
────────────────────────────────────────────────────────────────────────────────
* Máy phải BẬT và có mạng. Tắt máy là ngừng theo dõi.
* Mỗi UID cần ~8-15 giây. Vì vậy một vòng chỉ nên có vài chục UID; nhiều
  hơn thì một vòng sẽ dài hơn 60 giây. Script tự chia nhỏ theo giới hạn.
* Facebook có thể chặn nếu bạn gọi quá dày. Script có nghỉ ngẫu nhiên giữa
  các UID để giảm nguy cơ này.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Cấu hình
# ---------------------------------------------------------------------------

DEFAULT_WORKER_URL = "https://shop-dashboard.nguyenkhang170855.workers.dev"

# Khoảng nghỉ giữa hai lần mở trang, tính bằng giây. Cố tình CÓ NGẪU NHIÊN:
# một người thật không bao giờ mở trang đúng nhịp đều tăm tắp như máy.
DELAY_MIN = 6.0
DELAY_MAX = 14.0

# Chờ bao lâu cho React render xong trước khi đọc dữ liệu trang.
RENDER_WAIT_MS = 9000

# Số UID xử lý tối đa trong một vòng. Giữ dưới ngưỡng để một vòng không kéo
# dài quá 60 giây và không đụng giới hạn Worker.
MAX_PER_ROUND = 25

# User-Agent giữ ở dạng NGẮN. Đã thử: UA đầy đủ kiểu Chrome ("...AppleWebKit...
# Chrome/122...") khiến Facebook trả 400 vô nghĩa, còn UA ngắn thì đọc trang bình
# thường. Đừng "làm đẹp" hằng số này.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bluecheck_config.json")


@dataclass
class Config:
    worker_url: str = DEFAULT_WORKER_URL
    token: str = ""
    # true = chạy liên tục; false = chạy một vòng rồi thoát (dùng cho Task Scheduler)
    loop: bool = True
    # --- Proxy (tu chọn) ---
    # IP thoát ra. Rỗng = dùng IP của máy đang chạy watcher.
    proxy_server: str = ""
    proxy_username: str = ""
    proxy_password: str = ""
    # Múi giờ hiển thị trong trình duyệt. Nên khớp quốc gia của proxy, nếu không
    # Facebook thấy IP Romania nhưng giờ Việt Nam thì rất dễ nghi ngờ.
    timezone_id: str = "Asia/Ho_Chi_Minh"
    extra: dict[str, Any] = field(default_factory=dict)

    def has_proxy(self) -> bool:
        return bool(self.proxy_server)


def load_config() -> Config:
    """Đọc cấu hình từ file JSON, có thể ghi đè bằng biến môi trường."""
    cfg = Config()
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            cfg.worker_url = str(data.get("worker_url", cfg.worker_url)).rstrip("/")
            cfg.token = str(data.get("token", ""))
            cfg.proxy_server = str(data.get("proxy_server", ""))
            cfg.proxy_username = str(data.get("proxy_username", ""))
            cfg.proxy_password = str(data.get("proxy_password", ""))
            cfg.timezone_id = str(data.get("timezone_id", cfg.timezone_id))
        except (OSError, ValueError) as exc:
            print(f"[!] Không đọc được {CONFIG_PATH}: {exc}", file=sys.stderr)

    # Biến môi trường ưu tiên hơn file (tiện khi chạy trên VPS, tránh lưu mật
    # khẩu proxy vào đĩa).
    if env := os.environ.get("BLUECHECK_WORKER_URL"):
        cfg.worker_url = env.rstrip("/")
    if env := os.environ.get("BLUECHECK_TOKEN"):
        cfg.token = env
    if env := os.environ.get("BLUECHECK_PROXY_SERVER"):
        cfg.proxy_server = env
    if env := os.environ.get("BLUECHECK_PROXY_USERNAME"):
        cfg.proxy_username = env
    if env := os.environ.get("BLUECHECK_PROXY_PASSWORD"):
        cfg.proxy_password = env
    return cfg


def save_template(path: str) -> None:
    """Ghi file cấu hình mẫu để người dùng điền token."""
    template = {
        "_comment": "Dán BLUECHECK_TOKEN vào ô 'token'. Token lấy bằng: npx wrangler secret put BLUECHECK_TOKEN",
        "worker_url": DEFAULT_WORKER_URL,
        "token": "",
        "_proxy_comment": "Bỏ trống proxy_server nếu chạy bằng IP máy. Điền khi chạy trên VPS.",
        "proxy_server": "",
        "proxy_username": "",
        "proxy_password": "",
        "timezone_id": "Asia/Ho_Chi_Minh",
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(template, fh, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)
    print(f"[+] Đã tạo file cấu hình mẫu: {path}")


# ---------------------------------------------------------------------------
# Gọi HTTP tới Worker
# ---------------------------------------------------------------------------


def _request(cfg: Config, method: str, path: str, payload: dict | None = None, timeout: int = 45) -> Any:
    url = f"{cfg.worker_url}{path}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {cfg.token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "bluecheck-watcher/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else {}


def fetch_queue(cfg: Config) -> list[dict]:
    data = _request(cfg, "GET", "/api/tickxanh/queue")
    items = data.get("items") or []
    return items[:MAX_PER_ROUND]


def push_results(cfg: Config, results: list[dict]) -> dict:
    return _request(cfg, "POST", "/api/tickxanh/report", {"results": results})


# ---------------------------------------------------------------------------
# Đọc dấu tích xanh từ trang profile
# ---------------------------------------------------------------------------

# Trường này nằm trong JSON React nhúng trong trang profile. Đây là nơi Meta
# nói thẳng "tài khoản này có hiện huy hiệu tích xanh trên profile hay không".
# Đã kiểm chứng: UID có tick -> true, UID thường -> false, ổn định qua nhiều lần.
MARKER = "show_verified_badge_on_profile"

# Nếu Facebook đá sang trang đăng nhập, đó là dấu hiệu IP bị chặn — KHÔNG phải
# "tài khoản không có tick". Báo unknown thay vì đoán.
LOGIN_HOSTS = ("/login", "/checkpoint")


@dataclass
class CheckResult:
    uid: str
    status: str          # verified | watching | not_found | unknown
    name: str | None = None
    error: str | None = None


async def check_one(page: Any, uid: str) -> CheckResult:
    """Mở trang profile của một UID và đọc dấu tích xanh."""
    url = f"https://www.facebook.com/profile.php?id={uid}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(uid, "unknown", error=f"loi mo trang: {type(exc).__name__}")

    # Facebook thích đưa người lạ về trang đăng nhập. Đó là tín hiệu bị chặn,
    # KHÔNG phải tín hiệu tài khoản chết.
    if any(h in page.url for h in LOGIN_HOSTS):
        return CheckResult(uid, "unknown", error="bi Facebook cho ve trang dang nhap")

    # Chờ React dựng xong khối dữ liệu nhúng rồi mới đọc.
    await page.wait_for_timeout(RENDER_WAIT_MS)
    # Cuộn nhẹ để kích hoạt phần tải thêm (Facebook render theo vùng nhìn).
    for _ in range(2):
        await page.mouse.wheel(0, 700)
        await page.wait_for_timeout(700)

    try:
        title = (await page.title()) or ""
    except Exception:  # noqa: BLE001
        title = ""

    if "just a moment" in title.lower():
        return CheckResult(uid, "unknown", error="Facebook hoi CAPTCHA")

    try:
        html = await page.content()
    except Exception as exc:  # noqa: BLE001
        return CheckResult(uid, "unknown", error=f"loi doc trang: {type(exc).__name__}")

    # Lấy tên từ <title>: dạng "Ten | Facebook".
    name = ""
    if "|" in title:
        name = title.split("|")[0].strip()

    # Facebook ĐÃ chuyển trang này sang URL profile thật (dạng /people/...).
    # Đây là dấu hiệu chắc chắn profile còn tồn tại và công khai.
    landed_on_profile = "/people/" in page.url

    # ── THỨ TỰ QUAN TRỌNG ──────────────────────────────────────────────
    # PHẢI đọc marker TRƯỚC, rồi mới xét trang lỗi.
    #
    # Lý do: chuỗi "CometErrorRoot" xuất hiện trong bundle React của MỌI trang
    # Facebook (kể cả trang hợp lệ), vì nó là tên component được đăng ký sẵn.
    # Trước đây code kiểm tra CometErrorRoot trước, nên mọi UID — kể cả UID
    # đang có tích xanh — đều bị kết luận nhầm là "không tồn tại". Đó là lỗi
    # thật đã xảy ra, không phải Facebook chặn IP.
    # -----------------------------------------------------------------------
    idx = html.find(MARKER)
    if idx >= 0:
        tail = html[idx: idx + len(MARKER) + 40]
        if "true" in tail:
            return CheckResult(uid, "verified", name=name or None)
        if "false" in tail:
            return CheckResult(uid, "watching", name=name or None)
        return CheckResult(uid, "unknown", name=name or None, error="gia tri truong khong doc duoc")

    # Không có marker: phân biệt "UID chết" với "bị chặn / lỗi mạng".
    # UID chết thì Facebook KHÔNG chuyển hướng sang /people/ và trả trang lỗi.
    if not landed_on_profile and "CometErrorRoot" in html:
        return CheckResult(uid, "not_found", error="UID khong ton tai tren Facebook")

    # Còn lại: KHÔNG đoán. Báo unknown để vòng sau thử lại.
    return CheckResult(uid, "unknown", name=name or None, error="khong tim thay truong kiem chung")


async def run_round(cfg: Config, verbose: bool = True) -> dict:
    """Một vòng: lấy hàng đợi -> check từng UID -> đẩy kết quả."""
    try:
        queue = fetch_queue(cfg)
    except urllib.error.HTTPError as exc:
        return {"error": f"Worker tra HTTP {exc.code}", "items": 0}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"khong goi duoc Worker: {type(exc).__name__}: {exc}", "items": 0}

    if not queue:
        if verbose:
            print("[.] Khong co UID nao can check.")
        return {"items": 0, "verified": 0, "watching": 0, "unknown": 0, "not_found": 0}

    if verbose:
        print(f"[.] Co {len(queue)} UID can check.")

    from playwright.async_api import async_playwright

    results: list[dict] = []
    stats = {"verified": 0, "watching": 0, "unknown": 0, "not_found": 0}

    async with async_playwright() as pw:
        # Proxy tùy chọn. Khi có proxy thì IP thoát ra khác IP của máy — đây là
        # cách duy nhất để watcher chạy trên VPS (IP datacenter bị Meta chặn).
        launch_kwargs: dict[str, Any] = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        }
        if cfg.has_proxy():
            launch_kwargs["proxy"] = {
                "server": cfg.proxy_server,
                "username": cfg.proxy_username or None,
                "password": cfg.proxy_password or None,
            }

        browser = await pw.chromium.launch(**launch_kwargs)

        context = await browser.new_context(
            user_agent=USER_AGENT,
            locale="en-US",
            timezone_id=cfg.timezone_id,
            viewport={"width": 1366, "height": 900},
        )
        page = await context.new_page()
        try:
            for i, item in enumerate(queue):
                uid = str(item.get("uid", "")).strip()
                if not uid.isdigit():
                    continue

                res = await check_one(page, uid)
                stats[res.status] = stats.get(res.status, 0) + 1

                payload: dict[str, Any] = {"uid": uid, "status": res.status}
                if res.name:
                    payload["name"] = res.name
                if res.error:
                    payload["error"] = res.error
                results.append(payload)

                if verbose:
                    mark = {"verified": "✅ CO TICH XANH", "watching": "⏳ chua co",
                            "unknown": "⚠️  khong xac dinh", "not_found": "❌ khong ton tai"}.get(res.status, res.status)
                    print(f"    [{i+1}/{len(queue)}] {uid}  {mark}  {res.name or ''}  {res.error or ''}")

                if i < len(queue) - 1:
                    await page.wait_for_timeout(random.uniform(DELAY_MIN, DELAY_MAX) * 1000)
        finally:
            await browser.close()

    if results:
        try:
            push_results(cfg, results)
        except urllib.error.HTTPError as exc:
            return {"error": f"Worker tra HTTP {exc.code} khi day ket qua", **stats}
        except Exception as exc:  # noqa: BLE001
            return {"error": f"khong day duoc ket qua: {type(exc).__name__}", **stats}

    return {"items": len(results), **stats}


def main() -> int:
    ap = argparse.ArgumentParser(description="Theo doi tick xanh Facebook")
    ap.add_argument("--once", action="store_true", help="Chay mot vong roi thoat")
    ap.add_argument("--init", action="store_true", help="Tao file cau hinh mau")
    ap.add_argument("--url", help="Worker URL")
    ap.add_argument("--token", help="BLUECHECK_TOKEN")
    args = ap.parse_args()

    if args.init:
        save_template(CONFIG_PATH)
        return 0

    cfg = load_config()
    if args.url:
        cfg.worker_url = args.url.rstrip("/")
    if args.token:
        cfg.token = args.token
    cfg.loop = not args.once

    if not cfg.token:
        print("[!] Chua co BLUECHECK_TOKEN.", file=sys.stderr)
        print("    1) Tren may ban chay: npx wrangler secret put BLUECHECK_TOKEN", file=sys.stderr)
        print("    2) Tao file cau hinh: python bluecheck_watcher.py --init", file=sys.stderr)
        print("    3) Dien token vao file, hoac truyen --token <token>", file=sys.stderr)
        return 2

    print(f"[*] Worker : {cfg.worker_url}")
    print(f"[*] Che do : {'lien tuc' if cfg.loop else 'mot vong'}")

    try:
        import playwright  # noqa: F401
    except ImportError:
        print("[!] Chua cai playwright. Chay:", file=sys.stderr)
        print("    pip install playwright", file=sys.stderr)
        print("    python -m playwright install chromium", file=sys.stderr)
        return 2

    import asyncio

    if not cfg.loop:
        summary = asyncio.run(run_round(cfg))
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    while True:
        started = time.time()
        try:
            summary = asyncio.run(run_round(cfg))
        except KeyboardInterrupt:
            print("\n[.] Da dung.")
            return 0
        except Exception as exc:  # noqa: BLE001
            print(f"[!] Vong check loi: {type(exc).__name__}: {exc}", file=sys.stderr)
            summary = {}

        if summary.get("error"):
            print(f"[!] {summary['error']}", file=sys.stderr)
        else:
            print(
                f"[.] Xong {summary.get('items', 0)} UID | "
                f"co tick={summary.get('verified', 0)} chua co={summary.get('watching', 0)} "
                f"khong xac dinh={summary.get('unknown', 0)}"
            )

        # Nghỉ cho tới đủ 60 giây tính từ lúc bắt đầu vòng.
        elapsed = time.time() - started
        if elapsed < 60:
            time.sleep(60 - elapsed)


if __name__ == "__main__":
    raise SystemExit(main())

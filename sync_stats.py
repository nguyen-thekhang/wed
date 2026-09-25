#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_stats.py — Đồng bộ số liệu TỔNG HỢP từ DB bán hàng (VPS) lên Cloudflare Worker.

NGUYÊN TẮC BẤT DI BẤT DỊCH
--------------------------
Bảng `stock` trong DB bán hàng có một cột chứa tài khoản|mật khẩu thật đang bán.
Script này TUYỆT ĐỐI KHÔNG đọc, không in, không log, không gửi cột đó đi đâu cả.

  * KHÔNG bao giờ SELECT cột đó.
  * KHÔNG bao giờ SELECT * trên bảng `stock` (sẽ vô tình kéo theo cột đó).
  * Trên `stock` chỉ dùng COUNT(*) / COUNT(CASE ...) và GROUP BY.
  * Không có truy vấn nào trong file này được ghép bằng f-string hay phép cộng chuỗi;
    mọi câu SQL là hằng số literal với placeholder `?`.

Tự kiểm tra:
    grep -n "<tên cột bị cấm>" sync_stats.py    # phải KHÔNG có kết quả nào

Nếu bạn thấy mình đang cần đọc cột đó → DỪNG LẠI và báo cho người thiết kế.

CHỈ DÙNG THƯ VIỆN CHUẨN (Python 3.9+), không cần pip install gì cả.
Chạy thử:  python3 sync_stats.py --dry-run
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import ssl
import sys
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

# =====================================================================
# 1. HẰNG SỐ CẤU HÌNH
# =====================================================================

#: Múi giờ Việt Nam (UTC+7) — created_at trong DB là giờ VN nhưng KHÔNG ghi offset.
VN_TZ = timezone(timedelta(hours=7))

#: Giá trị mặc định khi không truyền qua CLI / biến môi trường.
DEFAULT_DB_PATH = "shop.db"
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_DAYS = 30
MAX_DAYS = 400  # hợp đồng: by_day <= 400 phần tử

#: Giới hạn của hợp đồng payload.
MAX_BY_PRODUCT_ROWS = 500
MAX_NAME_LENGTH = 200
MAX_MONEY = 10 ** 12

#: Timeout khoá SQLite: chờ tối đa 5 giây nếu bot đang ghi.
BUSY_TIMEOUT_MS = 5000

#: `stock.status` là opaque — không biết chắc shopbot dùng giá trị nào.
#: => Dùng danh sách ĐEN (đã bán/hết) + danh sách TRẮNG (còn hàng) đều chỉnh được ở đây.
#:    available = tổng số dòng TRỪ ĐI các dòng khớp danh sách đen.
#:    Giá trị lạ (NULL, rỗng, status mới) được coi là CÒN HÀNG — thà báo thừa còn hơn báo thiếu.
#:    sold = số dòng có order_id IS NOT NULL HOẶC status nằm trong danh sách bán.
STOCK_SOLD_STATUSES = ("sold", "used", "delivered")
STOCK_AVAILABLE_STATUSES = ("available", "in_stock", "stock", "ready", "new")

#: Trạng thái đơn hàng theo hợp đồng (status lạ vẫn được giữ nguyên tên, không bao giờ bị bỏ).
KNOWN_ORDER_STATUSES = ("delivered", "cancelled", "expired", "preorder")

#: Nhóm phương thức thanh toán; mọi giá trị không nhận diện được đều gom vào "khác".
FALLBACK_METHOD_LABEL = "khác"
KNOWN_METHODS = ("bank", "wallet")
METHOD_LABELS = {"bank": "bank", "wallet": "wallet"}

#: Nhãn chuỗi cho log tóm tắt (không chứa số liệu nhạy cảm, chỉ số tổng hợp).
LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"

logger = logging.getLogger("shop-sync")

# =====================================================================
# 2. CÁC CÂU SQL — TẤT CẢ ĐỀU LÀ HẰNG SỐ LITERAL VỚI PLACEHOLDER `?`
#    Không có câu nào được ghép chuỗi / f-string.
# =====================================================================

#: Doanh thu & số đơn đã giao.
SQL_TOTALS_DELIVERED = """
SELECT
    COALESCE(SUM(total), 0) AS revenue_delivered,
    COUNT(*)                AS orders_delivered
FROM orders
WHERE status = 'delivered'
"""

#: Tổng số đơn ở mọi trạng thái.
SQL_TOTALS_ORDERS_ALL = """
SELECT COUNT(*) AS orders_all
FROM orders
"""

#: Số người dùng và tổng số dư ví.
SQL_TOTALS_USERS = """
SELECT
    COUNT(*)                     AS users_total,
    COALESCE(SUM(balance), 0)    AS wallet_balance_sum
FROM users
"""

#: Số lệnh nạp đã xác nhận.
SQL_TOTALS_DEPOSITS = """
SELECT COUNT(*) AS deposits_confirmed
FROM deposits
WHERE status = 'confirmed'
"""

#: Doanh thu / số đơn đã giao theo NGÀY, gom bằng substr(created_at, 1, 10).
#: created_at đã là giờ VN nên 10 ký tự đầu chính là ngày VN; chỉ lấy các ngày >= ?.
SQL_BY_DAY = """
SELECT
    substr(created_at, 1, 10)   AS day,
    COALESCE(SUM(total), 0)     AS revenue,
    COUNT(*)                    AS orders
FROM orders
WHERE status = 'delivered'
  AND substr(created_at, 1, 10) >= ?
GROUP BY day
"""

#: Theo sản phẩm: chỉ lấy id/tên (KHÔNG lấy mô tả), số lượng bán và doanh thu đã giao.
SQL_BY_PRODUCT_SALES = """
SELECT
    o.product_id                    AS product_id,
    COALESCE(SUM(o.qty), 0)         AS sold,
    COALESCE(SUM(o.total), 0)       AS revenue
FROM orders o
WHERE o.status = 'delivered'
GROUP BY o.product_id
"""

#: Nguồn thứ hai cho by_product: sản phẩm CÓ stock (dù chưa bán được đơn nào).
#: Chỉ dùng COUNT(*) trên stock — không bao giờ chạm tới cột chứa tài khoản.
SQL_PRODUCTS_WITH_STOCK = """
SELECT product_id
FROM stock
GROUP BY product_id
"""

#: Tên sản phẩm — chỉ id, name, active. Không lấy cột mô tả.
SQL_PRODUCT_NAMES = """
SELECT id, name, active
FROM products
"""

#: Theo phương thức thanh toán (chỉ đơn đã giao).
SQL_BY_METHOD = """
SELECT
    method                      AS method,
    COUNT(*)                    AS orders,
    COALESCE(SUM(total), 0)     AS revenue
FROM orders
WHERE status = 'delivered'
GROUP BY method
"""

#: Theo trạng thái — TẤT CẢ đơn, mọi giá trị status đều được giữ riêng.
SQL_BY_STATUS = """
SELECT
    status      AS status,
    COUNT(*)    AS count
FROM orders
GROUP BY status
"""

#: Tồn kho theo sản phẩm. Chỉ COUNT — available là phần bù của danh sách trạng thái đã bán.
SQL_STOCK_BY_PRODUCT = """
SELECT
    product_id                                          AS product_id,
    COUNT(*)                                            AS total_rows,
    SUM(CASE WHEN status IN ('sold', 'used', 'delivered') THEN 1 ELSE 0 END) AS sold_status_rows,
    SUM(CASE WHEN order_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_rows
FROM stock
GROUP BY product_id
"""


# =====================================================================
# 3. TIỆN ÍCH CHUNG
# =====================================================================
def to_int(value) -> int:
    """Ép mọi giá trị DB về số nguyên an toàn (None/str/float đều chịu được)."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


def clamp_money(value: int) -> int:
    """Kẹp tiền vào [0, 1e12] cho đúng hợp đồng validate của Worker."""
    if value < 0:
        return 0
    if value > MAX_MONEY:
        return MAX_MONEY
    return value


def safe_name(value) -> str:
    """Tên sản phẩm: luôn là chuỗi, cắt còn tối đa 200 ký tự, không xuống dòng."""
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:MAX_NAME_LENGTH]


def _is_missing_schema(error: sqlite3.Error) -> bool:
    """True nếu lỗi là do thiếu bảng / thiếu cột (schema trôi), không phải lỗi logic."""
    message = str(error).lower()
    return "no such table" in message or "no such column" in message


def _run_query(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list:
    """
    Chạy một câu SELECT và trả về list các sqlite3.Row.

    Lỗi ở đây KHÔNG bao giờ được ném ra ngoài: schema shopbot có thể trôi (thiếu bảng,
    thiếu cột, DB cũ chưa migrate). Một bảng thiếu chỉ làm phần số liệu đó bằng 0/[] kèm
    cảnh báo WARNING, chứ không được làm chết cả lần đồng bộ.
    """
    try:
        cursor = conn.execute(sql, params)
        return cursor.fetchall()
    except sqlite3.Error as exc:
        if _is_missing_schema(exc) or isinstance(exc, sqlite3.OperationalError):
            logger.warning("bỏ qua truy vấn lỗi (schema có thể đã đổi): %s", exc)
        else:
            logger.warning("lỗi SQL không mong đợi, coi như rỗng: %s", exc)
        return []


@contextmanager
def open_shop_db(path: str):
    """
    Mở DB bán hàng ở chế độ CHỈ ĐỌC.

    Hai lớp bảo vệ cùng lúc, để chắc chắn không thể sửa DB đang bán hàng:
      1. URI `file:...?mode=ro` — SQLite từ chối mọi câu ghi.
      2. `PRAGMA query_only = ON` — chặn ghi ở tầng kết nối dù URI có bị mở nhầm.
    `busy_timeout` để chờ nếu bot đang ghi, thay vì chết vì "database is locked".
    """
    uri = "file:{}?mode=ro".format(path)
    conn = sqlite3.connect(uri, uri=True, timeout=BUSY_TIMEOUT_MS / 1000.0)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        yield conn
    finally:
        # Luôn đóng kết nối, kể cả khi có exception ở giữa.
        conn.close()


# =====================================================================
# 4. CÁC HÀM TÍNH TOÁN
# =====================================================================
def compute_totals(conn: sqlite3.Connection) -> dict:
    """Sáu con số tổng hợp cho thẻ KPI trên dashboard."""
    totals = {
        "revenue_delivered": 0,
        "orders_delivered": 0,
        "orders_all": 0,
        "users_total": 0,
        "deposits_confirmed": 0,
        "wallet_balance_sum": 0,
    }

    rows = _run_query(conn, SQL_TOTALS_DELIVERED)
    if rows:
        totals["revenue_delivered"] = clamp_money(to_int(rows[0]["revenue_delivered"]))
        totals["orders_delivered"] = max(0, to_int(rows[0]["orders_delivered"]))

    rows = _run_query(conn, SQL_TOTALS_ORDERS_ALL)
    if rows:
        totals["orders_all"] = max(0, to_int(rows[0]["orders_all"]))

    rows = _run_query(conn, SQL_TOTALS_USERS)
    if rows:
        totals["users_total"] = max(0, to_int(rows[0]["users_total"]))
        totals["wallet_balance_sum"] = clamp_money(to_int(rows[0]["wallet_balance_sum"]))

    rows = _run_query(conn, SQL_TOTALS_DEPOSITS)
    if rows:
        totals["deposits_confirmed"] = max(0, to_int(rows[0]["deposits_confirmed"]))

    return totals


def compute_by_day(conn: sqlite3.Connection, days: int) -> list:
    """
    Doanh thu / số đơn đã giao cho N ngày gần nhất (tính cả ngày không có đơn).

    Ngày lấy theo giờ VN (UTC+7). Danh sách ngày được dựng trong Python để trục biểu đồ
    liên tục, ngày trắng được điền 0 thay vì bị bỏ khỏi mảng.
    """
    days = max(1, min(int(days), MAX_DAYS))
    today_vn = datetime.now(VN_TZ).date()
    # Cửa sổ ngày: từ (hôm nay - N + 1) đến hôm nay.
    day_list = [today_vn - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    buckets = {day.isoformat(): {"revenue": 0, "orders": 0} for day in day_list}

    threshold = day_list[0].isoformat()
    for row in _run_query(conn, SQL_BY_DAY, (threshold,)):
        key = str(row["day"] or "")[:10]
        if key in buckets:
            buckets[key]["revenue"] = clamp_money(to_int(row["revenue"]))
            buckets[key]["orders"] = max(0, to_int(row["orders"]))
        elif key:
            # Dữ liệu ngoài cửa sổ (hoặc created_at dị dạng) thì bỏ qua, nhưng vẫn ghi log.
            logger.debug("bỏ qua ngày ngoài cửa sổ: %s", key)

    return [
        {"date": day.isoformat(), "revenue": buckets[day.isoformat()]["revenue"],
         "orders": buckets[day.isoformat()]["orders"]}
        for day in day_list
    ]


def compute_by_product(conn: sqlite3.Connection) -> list:
    """
    Theo sản phẩm: sold (tổng qty của đơn đã giao) và revenue (tổng total đã giao).

    Chỉ lấy id + name của products — KHÔNG lấy cột mô tả.
    Chỉ giữ sản phẩm có stock hoặc có bán được; tối đa 500 dòng, sắp theo doanh thu giảm dần.
    """
    sales = {}
    for row in _run_query(conn, SQL_BY_PRODUCT_SALES):
        pid = to_int(row["product_id"])
        sales[pid] = {
            "sold": max(0, to_int(row["sold"])),
            "revenue": clamp_money(to_int(row["revenue"])),
        }

    with_stock = set()
    for row in _run_query(conn, SQL_PRODUCTS_WITH_STOCK):
        with_stock.add(to_int(row["product_id"]))

    names = {}
    for row in _run_query(conn, SQL_PRODUCT_NAMES):
        names[to_int(row["id"])] = safe_name(row["name"])

    product_ids = set(sales) | with_stock
    product_ids.discard(0)  # product_id = 0 là dữ liệu rác

    result = []
    for pid in product_ids:
        entry = sales.get(pid, {"sold": 0, "revenue": 0})
        result.append({
            "product_id": pid,
            "name": names.get(pid, "") or "SP #{}".format(pid),
            "sold": entry["sold"],
            "revenue": entry["revenue"],
        })

    # Doanh thu giảm dần, cùng doanh thu thì sold giảm dần, cuối cùng theo id cho ổn định.
    result.sort(key=lambda item: (-item["revenue"], -item["sold"], item["product_id"]))
    if len(result) > MAX_BY_PRODUCT_ROWS:
        logger.warning("by_product vượt %d dòng, cắt bớt", MAX_BY_PRODUCT_ROWS)
        result = result[:MAX_BY_PRODUCT_ROWS]
    return result


def compute_by_method(conn: sqlite3.Connection) -> list:
    """
    Nhóm đơn ĐÃ GIAO theo phương thức thanh toán.

    `bank`, `wallet` giữ nguyên; chuỗi rỗng, NULL và mọi giá trị lạ đều gom vào "khác"
    — không một đơn nào bị bỏ im lặng.
    """
    groups = {}
    for row in _run_query(conn, SQL_BY_METHOD):
        raw = row["method"]
        if raw is None:
            label = FALLBACK_METHOD_LABEL
        else:
            label = METHOD_LABELS.get(str(raw).strip(), FALLBACK_METHOD_LABEL)
        bucket = groups.setdefault(label, {"orders": 0, "revenue": 0})
        bucket["orders"] += max(0, to_int(row["orders"]))
        bucket["revenue"] += clamp_money(to_int(row["revenue"]))

    # Giữ thứ tự ổn định: bank, wallet rồi tới khác.
    preferred = list(KNOWN_METHODS) + [FALLBACK_METHOD_LABEL]
    ordered = [label for label in preferred if label in groups]
    ordered += sorted(label for label in groups if label not in preferred)

    return [
        {"method": label,
         "orders": groups[label]["orders"],
         "revenue": clamp_money(groups[label]["revenue"])}
        for label in ordered
    ]


def compute_by_status(conn: sqlite3.Connection) -> list:
    """
    Đếm TẤT CẢ đơn theo status.

    Status lạ (bot thêm giá trị mới) vẫn được trả về dưới đúng tên của nó, không gộp,
    không bỏ — vì hợp đồng cho phép Worker tự quyết định phần hiển thị.
    """
    rows = []
    for row in _run_query(conn, SQL_BY_STATUS):
        raw = row["status"]
        status = "" if raw is None else str(raw)
        rows.append({"status": status, "count": max(0, to_int(row["count"]))})

    known_order = {name: index for index, name in enumerate(KNOWN_ORDER_STATUSES)}
    rows.sort(key=lambda item: (known_order.get(item["status"], len(known_order)), item["status"]))
    return rows


def compute_stock(conn: sqlite3.Connection) -> list:
    """
    Tồn kho theo sản phẩm — CHỈ dùng COUNT, tuyệt đối không đọc cột chứa tài khoản.

    available (còn bán được) = tổng dòng trừ đi các dòng mang trạng thái đã bán.
    sold                      = dòng đã gắn order_id HOẶC trạng thái nằm trong nhóm đã bán.
    Giá trị status lạ vẫn được tính là còn hàng để không báo thiếu tồn kho.
    """
    result = []
    for row in _run_query(conn, SQL_STOCK_BY_PRODUCT):
        pid = to_int(row["product_id"])
        if pid == 0:
            continue
        total_rows = max(0, to_int(row["total_rows"]))
        sold_status_rows = max(0, to_int(row["sold_status_rows"]))
        linked_rows = max(0, to_int(row["linked_rows"]))
        sold = min(total_rows, max(sold_status_rows, linked_rows))
        available = max(0, total_rows - sold)
        result.append({"product_id": pid, "available": available, "sold": sold})

    result.sort(key=lambda item: item["product_id"])
    return result[:MAX_BY_PRODUCT_ROWS]


def build_payload(conn: sqlite3.Connection, days: int) -> dict:
    """
    Ghép toàn bộ payload theo CONTRACT.md mục 2.

    `synced_at` PHẢI kèm offset +07:00: created_at trong DB là giờ VN nhưng không ghi
    offset, nên nếu gửi chuỗi trần thì Cloudflare sẽ hiểu nhầm thành UTC và lệch 7 tiếng.
    Ghi rõ +07:00 để Worker so sánh "quá 1 giờ chưa sync" cho đúng.
    """
    payload = {
        "synced_at": datetime.now(VN_TZ).replace(microsecond=0).isoformat(),
        "totals": compute_totals(conn),
        "by_day": compute_by_day(conn, days),
        "by_product": compute_by_product(conn),
        "by_method": compute_by_method(conn),
        "by_status": compute_by_status(conn),
        "stock": compute_stock(conn),
    }
    return payload


# =====================================================================
# 5. GỬI LÊN CLOUDFLARE
# =====================================================================
def post_payload(url: str, token: str, payload: dict, timeout: float) -> int:
    """
    POST snapshot lên Worker. Trả về mã thoát của tiến trình.

    KHÔNG BAO GIỜ in token (kể cả -v), KHÔNG BAO GIỜ in dữ liệu thô từ DB.
    Chỉ in mã HTTP và tối đa 300 ký tự đầu của body lỗi để còn debug.
    """
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Authorization": "Bearer {}".format(token),
            "User-Agent": "shop-dashboard-sync/1.0",
            "Content-Length": str(len(body)),
        },
    )

    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            status = int(getattr(response, "status", 200) or 200)
            if 200 <= status < 300:
                logger.info("gửi thành công (HTTP %s), %d byte", status, len(body))
                return 0
            logger.warning("Worker trả về HTTP %s", status)
            return 0
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        if status in (401, 403):
            logger.error("token sai hoặc thiếu (HTTP %s)", status)
            return 3
        if 400 <= status < 500:
            # Worker không bao giờ trả dữ liệu tài khoản, nhưng vẫn chỉ in 300 ký tự đầu.
            detail = ""
            try:
                detail = exc.read(300).decode("utf-8", "replace")
            except Exception:  # pragma: no cover - chỉ để không chết vì lỗi đọc body
                detail = ""
            logger.error("Worker từ chối payload: HTTP %s | %s", status, detail)
            return 4
        logger.warning("Worker lỗi phía server (HTTP %s), bỏ qua lần này", status)
        return 0
    except (urllib.error.URLError, TimeoutError, OSError, ssl.SSLError) as exc:
        # Mạng lỗi thì thoát êm, lần sau chạy lại: cron 15 phút một lần nên không nên spam log lỗi.
        logger.warning("không gửi được (lỗi mạng/timeout): %s", exc.__class__.__name__)
        return 0


# =====================================================================
# 6. CLI
# =====================================================================
def parse_args(argv=None) -> argparse.Namespace:
    # Đổi console sang UTF-8 TRƯỚC khi argparse in help, vì phần mô tả có tiếng Việt.
    _force_utf8(sys.stdout)
    _force_utf8(sys.stderr)
    parser = argparse.ArgumentParser(
        prog="sync_stats.py",
        description=(
            "Đọc DB bán hàng ở chế độ chỉ-đọc, tính số liệu tổng hợp và "
            "POST snapshot JSON lên Cloudflare Worker (/api/sync)."
        ),
        epilog=(
            "Script chỉ ĐỌC DB và chỉ gửi số tổng hợp. "
            "Chạy thử không gửi gì: sync_stats.py --dry-run"
        ),
    )
    parser.add_argument(
        "--db", default=None,
        help="đường dẫn file SQLite của shop (mặc định: $SHOP_DB_PATH, sau đó ./shop.db)",
    )
    parser.add_argument(
        "--url", default=None,
        help="URL endpoint sync, ví dụ https://.../api/sync (mặc định: $SYNC_URL)",
    )
    parser.add_argument(
        "--token", default=None,
        help="Bearer token (mặc định: $SYNC_TOKEN). Token KHÔNG BAO GIỜ được in ra.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="chỉ tính và in JSON ra stdout, không gửi lên mạng",
    )
    parser.add_argument(
        "--timeout", type=float, default=None,
        help="timeout HTTP tính bằng giây (mặc định: %g)" % DEFAULT_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--days", type=int, default=None,
        help="số ngày cho by_day (mặc định: %d, tối đa %d)" % (DEFAULT_DAYS, MAX_DAYS),
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="bật log DEBUG (vẫn không bao giờ in token)",
    )
    parser.add_argument(
        "--print-token-hint", action="store_true",
        help="chỉ cho biết đã cấu hình token hay chưa (không in giá trị token)",
    )
    return parser.parse_args(argv)


def _force_utf8(stream):
    """
    Ép stdout/stderr sang UTF-8 nếu nền tảng cho phép.

    Log và JSON ở đây có tiếng Việt; trên console Windows mặc định là cp1258 nên sẽ
    ném UnicodeEncodeError. Trên Linux/VPS thì không cần, nhưng để nguyên cho an toàn.
    """
    if stream is None:
        return
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(encoding="utf-8")
    except (ValueError, OSError):  # pragma: no cover - vài stream không cho đổi
        pass


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format=LOG_FORMAT,
        stream=sys.stderr,
    )


def resolve_db_path(value) -> str:
    if value:
        return value
    return os.environ.get("SHOP_DB_PATH") or DEFAULT_DB_PATH


def resolve_url(value) -> str:
    if value:
        return value
    return os.environ.get("SYNC_URL") or ""


def resolve_token(value) -> str:
    if value:
        return value
    return os.environ.get("SYNC_TOKEN") or ""


def resolve_timeout(value) -> float:
    if value is None:
        return DEFAULT_TIMEOUT_SECONDS
    return max(1.0, min(float(value), 300.0))


def resolve_days(value) -> int:
    if value is None:
        return DEFAULT_DAYS
    return max(1, min(int(value), MAX_DAYS))


def summarize(payload: dict) -> str:
    """
    Một dòng log tóm tắt cuối mỗi lần chạy. Chỉ chứa SỐ TỔNG HỢP
    (doanh thu, số đơn, số sản phẩm, số ngày) — không có dữ liệu thô, không có token.
    """
    totals = payload.get("totals", {})
    return "đã đồng bộ: doanh thu={} đơn={} sản phẩm={} ngày={}".format(
        to_int(totals.get("revenue_delivered")),
        to_int(totals.get("orders_all")),
        len(payload.get("by_product", [])),
        len(payload.get("by_day", [])),
    )


# =====================================================================
# 7. ĐIỂM VÀO
# =====================================================================
def main(argv=None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    db_path = resolve_db_path(args.db)
    url = resolve_url(args.url)
    token = resolve_token(args.token)
    timeout = resolve_timeout(args.timeout)
    days = resolve_days(args.days)

    if args.print_token_hint:
        # Chỉ nói CÓ hay KHÔNG, tuyệt đối không in giá trị.
        logger.info("token: %s", "đã cấu hình" if token else "CHƯA cấu hình")
        if args.dry_run:
            return 0

    if not args.dry_run:
        if not token:
            logger.error("thiếu SYNC_TOKEN (hoặc --token) — không gửi gì cả")
            return 2
        if not url:
            logger.error("thiếu SYNC_URL (hoặc --url) — không gửi gì cả")
            return 2

    if not os.path.exists(db_path):
        logger.error("không thấy file DB: %s", db_path)
        return 1

    logger.debug("mở DB chỉ-đọc: %s (days=%d, timeout=%gs)", db_path, days, timeout)

    try:
        # Script chỉ ĐỌC và luôn gửi snapshot đầy đủ đã khoá theo ngày/sản phẩm.
        # Không có bộ đếm delta nào được gửi đi, nên chạy lại bao nhiêu lần cũng cho
        # cùng một con số — Worker chỉ việc upsert, hoàn toàn idempotent.
        with open_shop_db(db_path) as conn:
            payload = build_payload(conn, days)
    except sqlite3.Error as exc:
        logger.error("không mở được DB (chỉ đọc): %s", exc.__class__.__name__)
        return 1

    logger.info(summarize(payload))

    if args.dry_run:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
        sys.stdout.write("\n")
        sys.stdout.flush()
        logger.info("dry-run: không gửi gì lên mạng")
        return 0

    return post_payload(url, token, payload, timeout)


if __name__ == "__main__":
    sys.exit(main())

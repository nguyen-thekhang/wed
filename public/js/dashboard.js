/**
 * =============================================================================
 * public/js/dashboard.js — điều khiển trang Tổng quan
 * =============================================================================
 *
 * Script cổ điển (không module, không framework, không build step).
 * Nhiệm vụ: gọi /api/stats, đổ số liệu vào DOM, vẽ biểu đồ 30 ngày, và
 * QUAN TRỌNG NHẤT: hét lên khi dữ liệu đã cũ.
 *
 * Dashboard im lặng với số liệu cũ là rất nguy hiểm — nếu quá 1 giờ chưa sync,
 * thanh trạng thái phải chuyển đỏ.
 *
 * Không có bất kỳ dữ liệu tài khoản/mật khẩu nào ở đây. Chỉ con số tổng hợp.
 */

(function () {
  "use strict";

  var STALE_AFTER_SECONDS = 3600; // quá 1 giờ chưa sync => cảnh báo đỏ

  /* ---------------------------------------------------------------------- */
  /* Định dạng dùng chung (trang khác dùng lại qua window.ShopFmt)           */
  /* ---------------------------------------------------------------------- */

  /**
   * Tiền: 1.234.567 ₫ — dấu chấm phân cách nghìn, ký hiệu ₫ đặt sau cùng.
   * Không dùng toLocaleString("vi-VN") vì kết quả khác nhau giữa các môi trường.
   */
  function formatVND(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return "—";
    var neg = v < 0;
    var s = String(Math.abs(v));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ".";
      out += s.charAt(i);
    }
    return (neg ? "-" : "") + out + " ₫";
  }

  /** Số nguyên có phân cách nghìn, không kèm ký hiệu tiền. */
  function formatInt(n) {
    var v = Math.round(Number(n));
    if (!isFinite(v)) return "—";
    var s = String(Math.abs(v));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ".";
      out += s.charAt(i);
    }
    return (v < 0 ? "-" : "") + out;
  }

  /**
   * Chống XSS: mọi chuỗi lấy từ API phải đi qua đây trước khi vào innerHTML.
   * Tên sản phẩm là dữ liệu do người khác nhập, không được tin.
   */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Ngày "YYYY-MM-DD" → nhãn thứ + ngày/tháng cho tooltip biểu đồ.
   *
   * Vì sao cần: giá trị thô là chuỗi ISO ("2024-09-23") khó đọc khi đã có cả
   * chuỗi ngày dài trên trục. Tooltip hiện "T2 23/09" để đối chiếu nhanh.
   * Dùng Intl với Asia/Ho_Chi_Minh cho khớp mọi nơi khác trên dashboard.
   */
  function formatDayVN(iso) {
    if (!iso) return "—";
    // Chuỗi chỉ có ngày: gắn giữa ngày để không bị lệch múi giờ khi parse.
    var d = new Date(String(iso).length <= 10 ? iso + "T12:00:00+07:00" : iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
      }).format(d);
    } catch (e) {
      return String(iso);
    }
  }

  /**
   * Thời gian ISO có offset (+07:00) → chuỗi giờ VN dễ đọc.
   * Date tự hiểu offset, chỉ cần format lại theo Asia/Ho_Chi_Minh.
   */
  function formatDateTimeVN(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return new Intl.DateTimeFormat("vi-VN", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    } catch (e) {
      return d.toISOString().replace("T", " ").slice(0, 19);
    }
  }

  /**
   * `received_at` từ D1 có dạng "2026-09-22 10:30:00" và THỰC CHẤT LÀ UTC
   * (sinh bởi datetime('now') của SQLite). Chuỗi không có chữ Z nên phải tự
   * thêm, nếu không trình duyệt sẽ hiểu nhầm thành giờ địa phương.
   */
  function parseSqliteUtc(s) {
    if (!s) return null;
    var t = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)) t = t.replace(" ", "T") + "Z";
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  }

  /** "3 phút trước", "2 giờ 15 phút trước"… */
  function humanAgo(seconds) {
    if (seconds == null || !isFinite(seconds)) return "";
    var s = Math.max(0, Math.floor(seconds));
    if (s < 60) return s + " giây trước";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " phút trước";
    var h = Math.floor(m / 60);
    var rm = m % 60;
    if (h < 24) return h + " giờ" + (rm ? " " + rm + " phút" : "") + " trước";
    var d = Math.floor(h / 24);
    return d + " ngày " + (h % 24) + " giờ trước";
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  /* ---------------------------------------------------------------------- */
  /* Gọi API                                                                */
  /* ---------------------------------------------------------------------- */

  /** GET JSON kèm cookie phiên; 401 → về trang đăng nhập. */
  function getJson(path) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (res.status === 401) {
        window.location.replace("/login.html");
        throw new Error("unauthorized");
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          var msg =
            (body && body.error && body.error.message) || "Lỗi " + res.status + " khi gọi " + path;
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Thanh trạng thái đồng bộ — trái tim của dashboard                       */
  /* ---------------------------------------------------------------------- */

  function renderSyncBar(data) {
    var bar = $("sync-bar");
    var badge = $("sync-badge");
    if (!bar || !badge) return;

    bar.classList.remove("is-fresh", "is-stale", "is-unknown");

    if (!data.synced_at) {
      bar.classList.add("is-unknown");
      badge.textContent = "Chưa có dữ liệu";
      setText("sync-text", "Chưa nhận được lần đồng bộ nào từ VPS.");
      setText("sync-ago", "");
      return;
    }

    var ago = humanAgo(data.stale_seconds);
    var when = formatDateTimeVN(data.synced_at);

    if (data.stale) {
      bar.classList.add("is-stale");
      badge.textContent = "Dữ liệu cũ";
      setText(
        "sync-text",
        "CẢNH BÁO: lần đồng bộ cuối là " + when + " (" + ago + "). Kiểm tra cron trên VPS."
      );
    } else {
      bar.classList.add("is-fresh");
      badge.textContent = "Đang hoạt động";
      setText("sync-text", "Đồng bộ lần cuối: " + when);
    }
    setText("sync-ago", ago);
  }

  function renderSyncCount(data) {
    var el = $("sync-count");
    if (!el) return;
    var n = Array.isArray(data.last_syncs) ? data.last_syncs.length : 0;
    el.textContent = formatInt(n) + " lần đồng bộ gần đây";
  }

  /* ---------------------------------------------------------------------- */
  /* Thẻ số liệu lớn                                                        */
  /* ---------------------------------------------------------------------- */

  function renderKpis(data) {
    var t = data.totals || {};

    // Doanh thu CHỈ tính đơn delivered — đây là con số quan trọng nhất.
    setText("kpi-revenue", formatVND(t.revenue_delivered || 0));
    setText(
      "kpi-revenue-sub",
      formatInt(t.orders_delivered || 0) + " đơn đã giao (status = delivered)"
    );

    setText("kpi-orders", formatInt(t.orders_delivered || 0));
    setText("kpi-orders-all", formatInt(t.orders_all || 0));
    setText("kpi-users", formatInt(t.users_total || 0));
    // KHÔNG hiển thị số dư ví: chủ shop đã yêu cầu bỏ thẻ "Tổng số dư ví" (số dư
    // là thông tin nhạy cảm). Không thêm lại — xem README mục 8.11 và
    // test/acceptance.mjs, nơi có kiểm tra chặn thẻ này quay lại.

    var other = Math.max(0, (t.orders_all || 0) - (t.orders_delivered || 0));
    setText("kpi-orders-all-sub", formatInt(other) + " đơn không tính doanh thu");
    setText("kpi-users-sub", formatInt(t.deposits_confirmed || 0) + " lệnh nạp đã xác nhận");
  }

  /* ---------------------------------------------------------------------- */
  /* Biểu đồ doanh thu 30 ngày (canvas vẽ tay ở chart.js)                    */
  /* ---------------------------------------------------------------------- */

  function renderChart(data) {
    var canvas = $("chart-revenue");
    var empty = $("chart-empty");
    if (!canvas) return;

    var days = Array.isArray(data.by_day) ? data.by_day : [];
    var total = days.reduce(function (acc, d) {
      return acc + (Number(d.revenue) || 0);
    }, 0);

    if (!days.length || total === 0) {
      canvas.classList.add("hidden");
      if (empty) empty.classList.remove("hidden");
      return;
    }

    canvas.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");

    if (window.ShopChart && typeof window.ShopChart.drawLineChart === "function") {
      window.ShopChart.drawLineChart(
        canvas,
        days.map(function (d) {
          return { x: d.date, y: Number(d.revenue) || 0 };
        }),
        {
          ariaLabel: "Doanh thu theo ngày",
          valueFormatter: formatVND,
          shortFormatter: formatInt,
          // Nhãn tooltip: ngày đầy đủ theo giờ Việt Nam, dễ đối chiếu hơn chuỗi ISO.
          labelFormatter: formatDayVN,
        }
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Bảng sản phẩm                                                          */
  /* ---------------------------------------------------------------------- */

  function renderProducts(data) {
    var body = $("products-body");
    if (!body) return;

    var rows = Array.isArray(data.by_product) ? data.by_product : [];
    var stockMap = {};
    (Array.isArray(data.stock) ? data.stock : []).forEach(function (s) {
      stockMap[String(s.product_id)] = s;
    });

    // Gộp: có sản phẩm chỉ nằm trong danh sách tồn kho mà chưa bán được cái nào.
    var byId = {};
    rows.forEach(function (p) {
      byId[String(p.product_id)] = {
        product_id: p.product_id,
        name: p.name,
        sold: Number(p.sold) || 0,
        revenue: Number(p.revenue) || 0,
        available: 0
      };
    });
    Object.keys(stockMap).forEach(function (k) {
      if (!byId[k]) {
        byId[k] = {
          product_id: stockMap[k].product_id,
          name: "SP #" + String(stockMap[k].product_id),
          sold: Number(stockMap[k].sold) || 0,
          revenue: 0,
          available: 0
        };
      }
      byId[k].available = Number(stockMap[k].available) || 0;
    });

    var list = Object.keys(byId).map(function (k) {
      return byId[k];
    });
    list.sort(function (a, b) {
      return b.revenue - a.revenue || b.sold - a.sold;
    });

    if (!list.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">Chưa có sản phẩm nào.</td></tr>';
      return;
    }

    var maxSold = list.reduce(function (m, p) {
      return Math.max(m, p.sold);
    }, 1);

    var html = "";
    list.slice(0, 100).forEach(function (p) {
      var pct = Math.max(2, Math.round((p.sold / maxSold) * 100));
      var barClass =
        p.available <= 0 ? "bar is-danger" : p.available < 5 ? "bar is-warn" : "bar is-ok";
      html +=
        "<tr>" +
        '<td><span class="mono">#' +
        escapeHtml(String(p.product_id)) +
        "</span> " +
        escapeHtml(p.name) +
        "</td>" +
        '<td class="num">' +
        formatInt(p.sold) +
        "</td>" +
        '<td class="num">' +
        formatVND(p.revenue) +
        "</td>" +
        '<td class="num"><span class="pill ' +
        (p.available > 0 ? "is-ok" : "is-danger") +
        '">' +
        formatInt(p.available) +
        "</span> " +
        '<span class="' +
        barClass +
        '"><span style="width:' +
        pct +
        '%"></span></span>' +
        "</td>" +
        "</tr>";
    });
    body.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /* Phân chia theo phương thức & trạng thái                                 */
  /* ---------------------------------------------------------------------- */

  function renderMethods(data) {
    var body = $("methods-body");
    if (!body) return;

    var rows = Array.isArray(data.by_method) ? data.by_method.slice() : [];
    var order = { bank: 0, wallet: 1, "khác": 2 };

    // Đơn có method = '' đã được server gom vào "khác". Ở đây chỉ hiển thị,
    // tuyệt đối không lọc bỏ nhóm nào.
    rows.sort(function (a, b) {
      var ia = order[a.method];
      var ib = order[b.method];
      return (ia == null ? 9 : ia) - (ib == null ? 9 : ib);
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="3" class="empty">Chưa có dữ liệu.</td></tr>';
      return;
    }

    var totalOrders =
      rows.reduce(function (acc, r) {
        return acc + (Number(r.orders) || 0);
      }, 0) || 1;

    var label = { bank: "Ngân hàng", wallet: "Ví", "khác": "Khác" };

    var html = "";
    rows.forEach(function (r) {
      var pct = Math.max(2, Math.round(((Number(r.orders) || 0) / totalOrders) * 100));
      html +=
        "<tr>" +
        "<td>" +
        escapeHtml(label[r.method] || "Khác") +
        ' <span class="pill">' +
        escapeHtml(r.method) +
        "</span></td>" +
        '<td class="num">' +
        formatInt(r.orders) +
        '<span class="bar" style="margin-top:6px"><span style="width:' +
        pct +
        '%"></span></span></td>' +
        '<td class="num">' +
        formatVND(r.revenue) +
        "</td>" +
        "</tr>";
    });
    body.innerHTML = html;
  }

  function renderStatus(data) {
    var body = $("status-body");
    if (!body) return;

    var rows = Array.isArray(data.by_status) ? data.by_status.slice() : [];
    var ORDER = ["delivered", "cancelled", "expired", "preorder"];
    var LABEL = {
      delivered: "Đã giao",
      cancelled: "Đã huỷ",
      expired: "Hết hạn",
      preorder: "Đặt trước"
    };
    var PILL = {
      delivered: "is-ok",
      cancelled: "is-danger",
      expired: "is-warn",
      preorder: ""
    };

    rows.sort(function (a, b) {
      var ia = ORDER.indexOf(a.status);
      var ib = ORDER.indexOf(b.status);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="2" class="empty">Chưa có dữ liệu.</td></tr>';
      return;
    }

    var total =
      rows.reduce(function (acc, r) {
        return acc + (Number(r.count) || 0);
      }, 0) || 1;

    var html = "";
    rows.forEach(function (r) {
      var pct = Math.max(2, Math.round(((Number(r.count) || 0) / total) * 100));
      html +=
        "<tr>" +
        '<td><span class="pill ' +
        (PILL[r.status] || "") +
        '">' +
        escapeHtml(r.status) +
        "</span> " +
        escapeHtml(LABEL[r.status] || "") +
        "</td>" +
        '<td class="num">' +
        formatInt(r.count) +
        '<span class="bar" style="margin-top:6px"><span style="width:' +
        pct +
        '%"></span></span></td>' +
        "</tr>";
    });
    body.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /* Lịch sử đồng bộ                                                        */
  /* ---------------------------------------------------------------------- */

  function renderSyncHistory(data) {
    var body = $("sync-history-body");
    if (!body) return;

    var list = Array.isArray(data.last_syncs) ? data.last_syncs : [];
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="2" class="empty">Chưa có lần đồng bộ nào.</td></tr>';
      return;
    }

    var html = "";
    list.forEach(function (s) {
      var recv = parseSqliteUtc(s.received_at);
      html +=
        "<tr>" +
        '<td class="mono">' +
        escapeHtml(formatDateTimeVN(s.synced_at)) +
        ' <span class="pill">+07:00</span></td>' +
        '<td class="mono">' +
        escapeHtml(recv ? recv.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—") +
        "</td>" +
        "</tr>";
    });
    body.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- */
  /* Vòng đời                                                               */
  /* ---------------------------------------------------------------------- */

  function showError(msg) {
    var box = $("dash-error");
    if (!box) return;
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  function hideError() {
    var box = $("dash-error");
    if (box) box.classList.add("hidden");
  }

  /**
   * Đặt/tắt tín hiệu "đang tải" cho các vùng bảng.
   *
   * Vì sao cần: lúc đang chờ /api/stats, các ô bảng chỉ có chữ "Đang tải…" —
   * người nhìn hiểu, nhưng trình đọc màn hình không được báo gì. aria-busy là
   * tín hiệu máy đọc được cho đúng trạng thái đó.
   */
  function setTablesBusy(busy) {
    var ids = ["products-body", "methods-body", "status-body", "sync-history-body"];
    for (var i = 0; i < ids.length; i++) {
      var node = $(ids[i]);
      if (!node) continue;
      if (busy) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
    }
  }

  function refresh() {
    var btn = $("sync-refresh");
    if (btn) btn.disabled = true;
    setTablesBusy(true);

    return getJson("/api/stats")
      .then(function (data) {
        hideError();
        renderSyncBar(data);
        renderSyncCount(data);
        renderKpis(data);
        renderChart(data);
        renderProducts(data);
        renderMethods(data);
        renderStatus(data);
        renderSyncHistory(data);
      })
      .catch(function (err) {
        if (err && err.message === "unauthorized") return;
        showError("Không tải được số liệu: " + (err && err.message ? err.message : "lỗi không rõ"));
      })
      .then(function () {
        setTablesBusy(false);
        if (btn) btn.disabled = false;
        // Nội dung vừa render vẫn cần observer bắt để chạy hiệu ứng cuộn.
        if (window.ScrollFX && typeof window.ScrollFX.observe === "function") {
          window.ScrollFX.observe(document.querySelector("main") || document.body);
        }
      });
  }

  function wireLogout() {
    var btn = $("logout-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      fetch("/api/logout", { method: "POST", credentials: "same-origin" })
        .catch(function () {
          /* dù lỗi vẫn đưa về trang đăng nhập */
        })
        .then(function () {
          window.location.replace("/login.html");
        });
    });
  }

  function init() {
    wireLogout();

    var btn = $("sync-refresh");
    if (btn) btn.addEventListener("click", refresh);

    refresh();

    // Tự cập nhật mỗi 5 phút: mở tab lâu mà không refresh thì cảnh báo
    // "quá 1 giờ chưa sync" sẽ không bao giờ bật nếu không có vòng này.
    window.setInterval(refresh, 5 * 60 * 1000);

    // Vẽ lại biểu đồ khi đổi kích thước cửa sổ (canvas phải vẽ theo CSS px).
    var timer = null;
    window.addEventListener("resize", function () {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        if (window.ShopChart && typeof window.ShopChart.redraw === "function") {
          window.ShopChart.redraw();
        }
      }, 150);
    });
  }

  // Xuất cho các trang khác dùng lại (logs.js, images.js).
  window.ShopFmt = {
    STALE_AFTER_SECONDS: STALE_AFTER_SECONDS,
    formatVND: formatVND,
    formatInt: formatInt,
    escapeHtml: escapeHtml,
    formatDateTimeVN: formatDateTimeVN,
    parseSqliteUtc: parseSqliteUtc,
    humanAgo: humanAgo
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* =====================================================================
   logs.js — trang "Nhật ký" của shop-dashboard.

   Script CỔ ĐIỂN: không import/export, không build step, không thư viện ngoài.

   QUY TẮC BẤT DI BẤT DỊCH (CONTRACT.md mục 0):
   Bảng `stock` của shop có cột `content` chứa cặp acc|pass thật. File này
   KHÔNG đọc, KHÔNG nhận, KHÔNG render bất kỳ trường nào như vậy. Nó chỉ hiển
   thị metadata kiểm toán (thời điểm / hành động / mô tả ngắn / IP) và số liệu
   tổng hợp của các lần đồng bộ. Nếu bạn định thêm một trường có thể chứa dữ
   liệu tài khoản → DỪNG LẠI, đó là lỗi bảo mật.

   API dùng ở đây (CONTRACT.md mục 4):
     GET /api/logs?limit=N[&date=YYYY-MM-DD]  → 200 { admin_log, syncs }
     GET /api/logs/syncs?limit=50             → 200 { syncs }
     401 → phiên hết hạn → chuyển về /login.html
   ===================================================================== */
(function () {
  "use strict";

  /* =====================================================================
     PHẦN 1 — TIỆN ÍCH DÙNG CHUNG

     Ưu tiên dùng window.ShopFmt / window.ShopApi do dashboard.js công bố.
     Nhưng dashboard.js là file của agent khác, có thể chưa tải, tải lỗi,
     hoặc chạy sau file này → LUÔN kiểm tra sự tồn tại, thiếu thì rơi về bản
     sao cục bộ ngay trong file này. Không bao giờ giả định API bên ngoài có.
     ===================================================================== */

  /** Lấy window.ShopFmt nếu nó thật sự có đủ hàm mình cần. */
  function shopFmt() {
    var f = window.ShopFmt;
    if (f && typeof f === "object") return f;
    return null;
  }

  /**
   * Lấy window.ShopApi nếu có.
   * Lưu ý: bản dashboard.js hiện tại chỉ công bố window.ShopFmt, KHÔNG có
   * ShopApi — nên trên thực tế mọi request ở đây đi bằng fetch thuần. Nhánh
   * ShopApi chỉ để dành nếu sau này hợp đồng được bổ sung.
   */
  function shopApi() {
    var a = window.ShopApi;
    if (a && typeof a === "object") return a;
    return null;
  }

  /** true nếu object có hàm dùng được. */
  function hasFn(obj, name) {
    return !!obj && typeof obj[name] === "function";
  }

  /* ---------------------- Bản sao cục bộ (fallback) --------------------- */

  /**
   * escapeHtml — chỉ dùng để BỌC chuỗi khi buộc phải chèn vào HTML.
   * Nguyên tắc của file này vẫn là: dựng DOM bằng createElement + textContent.
   * Nếu textContent được dùng thì không cần escape; hàm này là lưới an toàn
   * cho trường hợp ai đó sau này đổi sang template string.
   */
  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** formatVND(1234567) === "1.234.567 ₫" (CONTRACT.md mục 6 — không dùng ở trang này). */
  function formatVND(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    v = Math.round(v);
    var neg = v < 0;
    var digits = String(Math.abs(v));
    var out = "";
    var count = 0;
    for (var i = digits.length - 1; i >= 0; i--) {
      out = digits.charAt(i) + out;
      count++;
      if (count % 3 === 0 && i > 0) out = "." + out;
    }
    return (neg ? "-" : "") + out + " ₫";
  }

  var FALLBACK = {
    escapeHtml: escapeHtml,
    formatVND: formatVND,
    formatDateTime: formatVN // cùng chữ ký (nhận chuỗi UTC) → dùng thẳng
  };

  /** Gọi hàm từ ShopFmt, thiếu thì rơi về bản cục bộ. */
  function useFmt(name) {
    var f = shopFmt();
    if (f && typeof f[name] === "function") {
      return function () {
        return f[name].apply(f, arguments);
      };
    }
    return FALLBACK[name];
  }

  var fmtEscapeHtml = useFmt("escapeHtml");
  var fmtVND = useFmt("formatVND");
  var fmtDateTime = useFmt("formatDateTime");

  /* ------------------------------ DOM nhỏ gọn --------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  /** Tạo phần tử với textContent (KHÔNG bao giờ innerHTML cho dữ liệu server). */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, text) {
    if (!node) return;
    node.textContent = text || "";
    node.classList.remove("hidden");
  }

  function hide(node) {
    if (!node) return;
    node.textContent = "";
    node.classList.add("hidden");
  }

  /* =====================================================================
     PHẦN 2 — THỜI GIAN: UTC vs GIỜ VIỆT NAM (UTC+7)

     ĐÂY LÀ CHỖ DỄ SAI NHẤT TRONG CẢ TRANG. Đọc kỹ trước khi sửa.

     * Cột `received_at` và `created_at` trong D1 sinh bằng datetime('now')
       → chuỗi dạng "2026-09-22 10:30:00", KHÔNG kèm timezone, và thực chất
       là GIỜ UTC. Nếu để nguyên cho new Date() thì trình duyệt sẽ hiểu sai.
       Cách xử lý: thay dấu cách bằng "T" rồi THÊM "Z" → new Date() hiểu là UTC.
     * Tham số lọc `date=YYYY-MM-DD` cũng được server so theo UTC (substr trên
       cột UTC), nên khi người dùng chọn "ngày VN" mình phải tự quy đổi.

     Quy tắc hiển thị trên trang:
       - "Lần đồng bộ (VN)"  : giờ VN, vì đó là thời điểm bot chạy (đã có +07:00).
       - "Nhận lúc (UTC)"    : giờ UTC, LUÔN kèm hậu tố "UTC" cho khỏi lẫn.
       - Nhật ký hệ thống    : giờ VN (đã quy đổi từ UTC) + hậu tố "UTC+7".
     ===================================================================== */

  var VN_OFFSET_MINUTES = 7 * 60; // Việt Nam = UTC+7, không có giờ mùa hè.
  var SIXTY_MINUTES_MS = 60 * 60 * 1000;

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function pad3(n) {
    if (n < 10) return "00" + n;
    if (n < 100) return "0" + n;
    return String(n);
  }

  /**
   * Chuẩn hoá chuỗi thời gian bất kỳ thành số mili-giây.
   *
   * CẠM BẪY ĐÃ KIỂM CHỨNG: chuỗi kiểu D1 "2026-09-22 10:30:00" (thiếu timezone)
   * KHÔNG được đưa thẳng cho Date.parse(). V8/Chrome/Node coi dạng đó là GIỜ ĐỊA
   * PHƯƠNG của máy — thử trên máy UTC+7 sẽ ra đúng 10:30, nhưng máy UTC+0 lại
   * cho ra kết quả khác hẳn, và như vậy cùng một dữ liệu lại hiển thị khác nhau
   * tuỳ máy. Vì vậy phải NHẬN DIỆN chuỗi thiếu timezone TRƯỚC rồi tự gắn "Z"
   * (nói rõ "đây là UTC") mới đưa cho Date.parse().
   *
   *   "2026-09-22 10:30:00"        (D1, thực chất là UTC) → hiểu là UTC
   *   "2026-09-22T10:30:00"        (thiếu tz)             → hiểu là UTC
   *   "2026-09-22T10:30:00Z"                              → UTC
   *   "2026-09-22T17:30:00+07:00"                         → tôn trọng offset
   */
  function toMillis(value) {
    if (value === null || value === undefined || value === "") return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && isFinite(value)) return value;

    var s = String(value).trim();
    if (!s) return NaN;

    // 1) "YYYY-MM-DD HH:MM[:SS[.mmm]]" hoặc "YYYY-MM-DDTHH:MM[:SS[.mmm]]"
    //    KHÔNG kèm timezone → đây là UTC (cách D1 lưu). Thay dấu cách bằng "T"
    //    rồi gắn "Z" để buộc Date.parse() hiểu là UTC.
    var naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    if (naive) {
      var withZ = Date.parse(naive[1] + "T" + naive[2] + "Z");
      if (!isNaN(withZ)) return withZ;
    }

    // 2) "YYYY-MM-DD" trần → nửa đêm UTC.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      var dayOnly = Date.parse(s + "T00:00:00Z");
      if (!isNaN(dayOnly)) return dayOnly;
    }

    // 3) Còn lại: chuỗi đã có timezone ("Z" hoặc ±HH:MM) hoặc dạng ISO đầy đủ.
    var direct = Date.parse(s);
    if (!isNaN(direct)) return direct;

    return NaN;
  }

  /**
   * Định dạng một mốc thời gian theo giờ VN (UTC+7), tính thủ công bằng
   * getUTC* + cộng 7 giờ. Cách này KHÔNG phụ thuộc timezone của máy người
   * dùng: chủ shop mở dashboard từ nước ngoài vẫn thấy đúng giờ VN.
   */
  function formatVN(value) {
    var ms = toMillis(value);
    if (isNaN(ms)) return "—";
    var d = new Date(ms + VN_OFFSET_MINUTES * 60 * 1000);
    return (
      d.getUTCFullYear() +
      "-" +
      pad2(d.getUTCMonth() + 1) +
      "-" +
      pad2(d.getUTCDate()) +
      " " +
      pad2(d.getUTCHours()) +
      ":" +
      pad2(d.getUTCMinutes()) +
      ":" +
      pad2(d.getUTCSeconds())
    );
  }

  /** Giờ VN có hậu tố, dùng cho danh sách nhật ký. */
  function formatVNLabel(value) {
    var s = formatVN(value);
    return s === "—" ? s : s + " UTC+7";
  }

  /**
   * Định dạng theo giờ UTC, LUÔN kèm hậu tố "UTC".
   * Dùng cho cột "Nhận lúc (UTC)" — received_at từ D1.
   */
  function formatUTC(value) {
    var ms = toMillis(value);
    if (isNaN(ms)) {
      // Không parse được: vẫn hiển thị nguyên văn + nhãn UTC để không mất dữ liệu.
      if (value === null || value === undefined || value === "") return "—";
      return String(value) + " UTC";
    }
    var d = new Date(ms);
    return (
      d.getUTCFullYear() +
      "-" +
      pad2(d.getUTCMonth() + 1) +
      "-" +
      pad2(d.getUTCDate()) +
      " " +
      pad2(d.getUTCHours()) +
      ":" +
      pad2(d.getUTCMinutes()) +
      ":" +
      pad2(d.getUTCSeconds()) +
      " UTC"
    );
  }

  /** Chuỗi thời gian đầy đủ cho thuộc tính title (tooltip). */
  function formatFullUTC(value) {
    var ms = toMillis(value);
    if (isNaN(ms)) return "";
    var d = new Date(ms);
    return (
      d.getUTCFullYear() +
      "-" +
      pad2(d.getUTCMonth() + 1) +
      "-" +
      pad2(d.getUTCDate()) +
      " " +
      pad2(d.getUTCHours()) +
      ":" +
      pad2(d.getUTCMinutes()) +
      ":" +
      pad2(d.getUTCSeconds()) +
      "." +
      pad3(d.getUTCMilliseconds()) +
      " UTC"
    );
  }

  /**
   * Quy đổi "ngày VN" (YYYY-MM-DD người dùng chọn) thành khoảng UTC tương ứng
   * rồi trả về CHÍNH chuỗi ngày UTC mà server hiểu.
   *
   * Máy chủ lọc `date` theo UTC, còn người dùng nghĩ theo ngày VN. Nếu gửi
   * thẳng ngày VN xuống server thì các dòng từ 00:00–07:00 giờ VN sẽ bị lệch
   * sang ngày hôm trước. Vì API chỉ nhận MỘT tham số `date` (một ngày UTC),
   * trang này chọn ngày UTC chứa phần LỚN của ngày VN đó, đồng thời nói rõ
   * điều đó trong ghi chú dưới bảng lọc để chủ shop không bị bất ngờ.
   *
   * Giờ VN 00:00 ngày D  =  UTC 17:00 ngày D-1
   * Giờ VN 23:59 ngày D  =  UTC 16:59 ngày D
   * → ngày VN D nằm vắt qua ngày UTC D-1 (7 giờ) và D (17 giờ).
   * → chọn ngày UTC = D (chứa 17/24 giờ của ngày VN).
   */
  function vnDateToUtcFilterDate(vnDate) {
    return vnDate; // xem giải thích ở trên: chọn ngày UTC trùng số với ngày VN
  }

  /** Hôm nay theo giờ VN, dạng YYYY-MM-DD (không phụ thuộc timezone máy). */
  function vnToday() {
    return formatVN(Date.now()).slice(0, 10);
  }

  /** Độ lệch (phút) giữa một mốc và hiện tại, tính từ chuỗi UTC của D1. */
  function minutesSince(value) {
    var ms = toMillis(value);
    if (isNaN(ms)) return NaN;
    return (Date.now() - ms) / 60000;
  }

  /* =====================================================================
     PHẦN 3 — TẢI DỮ LIỆU
     ===================================================================== */

  var state = {
    loading: false,
    lastLoadedAt: 0
  };

  /**
   * Gọi API. Dùng window.ShopApi.getJson NẾU nó tồn tại (hợp đồng dự kiến có,
   * nhưng bản dashboard.js hiện tại chỉ công bố window.ShopFmt), không thì
   * fetch thuần — đường chạy thực tế là fetch thuần.
   *
   * credentials:"same-origin" để trình duyệt tự gửi cookie phiên (HttpOnly —
   * JS KHÔNG đọc được cookie, và cũng không cần đọc: chỉ cần gửi kèm).
   *
   * Trả về { status, body } và KHÔNG ném lỗi mạng ra ngoài. getJson của
   * dashboard.js ném new Error(message) sau khi đã tự chuyển hướng khi 401,
   * nên ở đây chỉ cần bắt lỗi và coi như "không tải được" — không chuyển
   * hướng lần hai.
   */
  function apiGet(path) {
    var api = shopApi();

    if (api) {
      return Promise.resolve()
        .then(function () {
          return api.getJson(path);
        })
        .then(function (body) {
          return { status: 200, body: body };
        })
        .catch(function (err) {
          return { status: 0, body: null, failed: true, message: err && err.message };
        });
    }

    return fetch(path, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store"
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { status: res.status, body: body };
          });
      })
      .catch(function () {
        return { status: 0, body: null, networkError: true };
      });
  }

  /** Rút thông điệp lỗi từ body theo chuẩn { error: { code, message } }. */
  function errorMessage(body, fallback) {
    if (body && body.error && typeof body.error.message === "string" && body.error.message) {
      return body.error.message;
    }
    return fallback;
  }

  /**
   * Xử lý 401 ở MỘT chỗ duy nhất: phiên hết hạn → về trang đăng nhập.
   * Trả true nếu đã chuyển hướng (nơi gọi phải dừng ngay).
   */
  function handleUnauthorized(status) {
    if (status !== 401) return false;
    window.location.replace("/login.html");
    return true;
  }

  /* =====================================================================
     PHẦN 4 — RENDER: NHẬT KÝ HỆ THỐNG
     ===================================================================== */

  /**
   * Bảng màu pill theo hành động (theo đúng yêu cầu thiết kế):
   *   sync, login                → is-ok
   *   login_failed, login_blocked→ is-danger
   *   upload                     → is-warn
   *   delete                     → is-danger
   *   unlock                     → is-warn
   *   còn lại                    → trung tính (không thêm class màu)
   */
  var ACTION_PILL = {
    sync: "is-ok",
    login: "is-ok",
    login_failed: "is-danger",
    login_blocked: "is-danger",
    upload: "is-warn",
    delete: "is-danger",
    unlock: "is-warn"
  };

  /** Nhãn tiếng Việt cho từng hành động — chỉ là chữ hiển thị, không phải dữ liệu. */
  var ACTION_LABEL = {
    sync: "Đồng bộ",
    login: "Đăng nhập",
    login_failed: "Đăng nhập sai",
    login_blocked: "Bị khoá",
    logout: "Đăng xuất",
    upload: "Tải ảnh lên",
    delete: "Xoá ảnh",
    unlock: "Mở khoá"
  };

  function actionLabel(action) {
    var key = String(action || "");
    if (ACTION_LABEL[key]) return ACTION_LABEL[key];
    return key || "(không rõ)";
  }

  function actionPillClass(action) {
    var key = String(action || "");
    return ACTION_PILL[key] || "";
  }

  /**
   * Chuẩn hoá body của /api/logs về mảng dòng nhật ký.
   * API trả { admin_log, syncs }, nhưng vẫn chấp nhận vài biến thể để trang
   * không vỡ trắng nếu server đổi nhẹ.
   */
  function extractLogRows(body) {
    if (!body) return [];
    if (Object.prototype.toString.call(body.admin_log) === "[object Array]") return body.admin_log;
    if (Object.prototype.toString.call(body.logs) === "[object Array]") return body.logs;
    if (Object.prototype.toString.call(body) === "[object Array]") return body;
    return [];
  }

  function extractSyncRows(body) {
    if (!body) return [];
    if (Object.prototype.toString.call(body.syncs) === "[object Array]") return body.syncs;
    return [];
  }

  /**
   * Dựng một dòng nhật ký bằng DOM node — KHÔNG dùng innerHTML với dữ liệu
   * server. `detail` là văn bản tự do do server sinh ra, nên nó chỉ được đưa
   * vào qua textContent; trình duyệt sẽ luôn coi nó là chữ, không bao giờ là HTML.
   */
  function buildLogLine(row) {
    var action = row && row.action ? String(row.action) : "";
    var line = el("div", "log-line");

    // Thời điểm: created_at của D1 là UTC → hiển thị giờ VN cho dễ đọc.
    var t = el("span", "t", formatVNLabel(row ? row.created_at : null));
    var full = formatFullUTC(row ? row.created_at : null);
    if (full) t.title = "Thời điểm gốc (UTC): " + full + " — hiển thị theo giờ VN (UTC+7)";
    line.appendChild(t);

    // Hành động: chữ + màu pill theo bảng ACTION_PILL.
    var a = el("span", "a");
    var pill = el("span", "pill " + actionPillClass(action), actionLabel(action));
    pill.title = "Mã hành động gốc: " + (action || "(trống)");
    a.appendChild(pill);
    line.appendChild(a);

    // Mô tả ngắn (metadata kiểm toán, không phải dữ liệu nghiệp vụ).
    var detail = row && row.detail !== null && row.detail !== undefined && row.detail !== ""
      ? String(row.detail)
      : "—";
    line.appendChild(el("span", "d", detail));

    // IP nguồn.
    var ip = row && row.ip ? String(row.ip) : "—";
    line.appendChild(el("span", "pill", ip));

    return line;
  }

  function renderAudit(rows) {
    var box = $("audit-list");
    if (!box) return;

    clear(box);
    box.removeAttribute("aria-busy");

    if (!rows.length) {
      // Chỉ dùng khối rỗng chữ trần để quy tắc :has() trong pages.css quyết định
      // hiện .empty-state bên dưới. Không dựng thêm khối rỗng thứ hai ở đây.
      box.appendChild(el("div", "empty", "Không có dòng nhật ký nào khớp bộ lọc."));
      return;
    }

    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      frag.appendChild(buildLogLine(rows[i]));
    }
    box.appendChild(frag);
  }

  /* =====================================================================
     PHẦN 5 — RENDER: LỊCH SỬ ĐỒNG BỘ
     ===================================================================== */

  /**
   * "Tình trạng" chỉ áp cho dòng MỚI NHẤT (index 0):
   *   < 60 phút  → "Mới"  (pill is-ok)
   *   >= 60 phút → "Cũ"   (pill is-danger)
   * Các dòng cũ hơn không gắn nhãn để bảng không rối.
   */
  function freshnessOf(sync, isNewest) {
    if (!isNewest) return null;

    var mins = minutesSince(sync && sync.received_at);
    if (isNaN(mins)) {
      return { label: "Không rõ", cls: "is-warn", title: "Không đọc được received_at từ server." };
    }
    if (mins < 0) {
      // Đồng hồ server chạy trước đồng hồ máy này — nói thẳng thay vì đoán bừa.
      return {
        label: "Mới",
        cls: "is-ok",
        title: "received_at nằm ở tương lai so với đồng hồ máy này; nhiều khả năng đồng hồ máy bị chậm."
      };
    }

    var rounded = Math.floor(mins);
    if (mins < 60) {
      return {
        label: "Mới",
        cls: "is-ok",
        title: "Lần đồng bộ gần nhất cách đây " + rounded + " phút (ngưỡng 60 phút)."
      };
    }
    return {
      label: "Cũ",
      cls: "is-danger",
      title: "Lần đồng bộ gần nhất đã " + rounded + " phút trước (quá ngưỡng 60 phút) — kiểm tra VPS."
    };
  }

  function emptyRow(text) {
    var tr = document.createElement("tr");
    var td = el("td", "empty", text);
    td.colSpan = 3;
    td.setAttribute("colspan", "3");
    tr.appendChild(td);
    return tr;
  }

  function renderSyncs(rows) {
    var tbody = $("sync-body");
    if (!tbody) return;

    clear(tbody);

    if (!rows.length) {
      tbody.appendChild(emptyRow("Chưa có lần đồng bộ nào."));
      return;
    }

    var frag = document.createDocumentFragment();

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var tr = document.createElement("tr");

      // Cột 1 — giờ VN (synced_at do bot gửi lên, đã có offset +07:00).
      var tdVn = el("td", null, formatVN(row.synced_at));
      // Lưu ý: KHÔNG đặt title bằng giá trị thô ở đây. Với chuỗi ISO có offset
      // thì title cũng là giờ VN (trùng nội dung ô), còn với chuỗi UTC không
      // offset thì title sẽ ghi "UTC" — rất dễ bị đọc nhầm thành giờ VN.
      // Thời điểm UTC đã có cột riêng ngay bên cạnh nên không cần lặp lại.
      tr.appendChild(tdVn);

      // Cột 2 — giờ UTC của lúc Worker nhận (received_at từ datetime('now')).
      var tdUtc = el("td", "mono", formatUTC(row.received_at));
      tr.appendChild(tdUtc);

      // Cột 3 — tình trạng, chỉ tính cho dòng mới nhất.
      var tdState = document.createElement("td");
      var fresh = freshnessOf(row, i === 0);
      if (fresh) {
        var pill = el("span", "pill " + fresh.cls, fresh.label);
        if (fresh.title) pill.title = fresh.title;
        tdState.appendChild(pill);
      } else {
        tdState.appendChild(el("span", "hint", "—"));
      }
      tr.appendChild(tdState);

      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
  }

  /* =====================================================================
     PHẦN 6 — ĐỌC CẤU HÌNH TỪ BỘ LỌC VÀ TẢI TRANG
     ===================================================================== */

  var ALLOWED_LIMITS = [50, 100, 200, 500];

  function readLimit() {
    var sel = $("log-limit");
    var raw = sel ? String(sel.value) : "200";
    var n = parseInt(raw, 10);
    for (var i = 0; i < ALLOWED_LIMITS.length; i++) {
      if (ALLOWED_LIMITS[i] === n) return n;
    }
    return 200; // mặc định theo thiết kế
  }

  function readDate() {
    var input = $("log-date");
    if (!input) return "";
    var v = String(input.value || "").trim();
    // Chỉ chấp nhận đúng định dạng YYYY-MM-DD; giá trị lạ thì bỏ qua.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "";
    return v;
  }

  function buildLogsPath() {
    var path = "/api/logs?limit=" + readLimit();
    var date = readDate();
    if (date) {
      // Tham số `date` mà server nhận là NGÀY UTC. Ngày người dùng chọn là ngày
      // VN; xem vnDateToUtcFilterDate() để biết vì sao quy đổi như vậy.
      path += "&date=" + encodeURIComponent(vnDateToUtcFilterDate(date));
    }
    return path;
  }

  /** Bật/tắt trạng thái "đang tải" cho nút Lọc. */
  /**
   * Bật/tắt trạng thái "đang tải" cho nút Lọc.
   *
   * LƯU Ý THỨ TỰ: phải bật lại nút TRƯỚC khi hạ cờ state.loading. Nếu hạ cờ
   * trước, một sự kiện do chính việc bật lại nút phát ra (ví dụ trình duyệt
   * bắn `change` khi giá trị select bị chỉnh) có thể gọi load() ngay giữa chừng
   * và bị chặn bởi cờ cũ — kết quả là nút kẹt ở "Đang lọc…".
   */
  function setBusy(busy) {
    var btn = $("log-apply");
    if (btn) {
      btn.disabled = !!busy;
      btn.textContent = busy ? "Đang lọc…" : "Lọc";
    }
    state.loading = !!busy;
  }

  /**
   * Khối "Đang tải…" trong lúc chờ mạng, kèm aria-busy để trình đọc màn hình
   * biết vùng dữ liệu đang cập nhật (trước đây chỉ có chữ, thiếu tín hiệu máy đọc).
   */
  function showLoading() {
    var box = $("audit-list");
    if (box) {
      clear(box);
      box.setAttribute("aria-busy", "true");
      box.appendChild(el("div", "empty is-loading", "Đang tải nhật ký…"));
    }

    var tbody = $("sync-body");
    if (tbody) {
      clear(tbody);
      tbody.setAttribute("aria-busy", "true");
      tbody.appendChild(emptyRow("Đang tải…"));
    }
  }

  /** Gỡ tín hiệu đang tải sau khi dữ liệu (hoặc lỗi) về. */
  function clearLoading() {
    var box = $("audit-list");
    if (box) box.removeAttribute("aria-busy");
    var tbody = $("sync-body");
    if (tbody) tbody.removeAttribute("aria-busy");
  }

  /**
   * Tải cả hai nguồn dữ liệu. Hai request chạy song song; chỉ cần một cái 401
   * là chuyển hướng và bỏ qua phần còn lại.
   */
  function load() {
    if (state.loading) return;
    setBusy(true);
    hide($("logs-msg"));
    showLoading();

    var logsPromise = apiGet(buildLogsPath());
    var syncsPromise = apiGet("/api/logs/syncs?limit=50");

    logsPromise
      .then(function (res) {
        if (handleUnauthorized(res.status)) return null;

        if (res.status === 0) {
          renderAudit([]);
          renderSyncs([]);
          show(
            $("logs-msg"),
            "Không kết nối được tới server. Kiểm tra mạng rồi thử lại."
          );
          return null;
        }

        if (res.status !== 200) {
          renderAudit([]);
          renderSyncs([]);
          show(
            $("logs-msg"),
            errorMessage(
              res.body,
              "Không tải được nhật ký (HTTP " + res.status + ")."
            )
          );
          return null;
        }

        // Thành công: vẽ nhật ký hệ thống.
        renderAudit(extractLogRows(res.body));

        // /api/logs cũng trả kèm `syncs` — dùng luôn để bảng có dữ liệu ngay,
        // sau đó request /api/logs/syncs (song song) sẽ ghi đè bằng bản đầy đủ.
        var inline = extractSyncRows(res.body);
        if (inline.length) renderSyncs(inline);

        // Đã vẽ xong DOM mới → bảo lớp hiệu ứng cuộn quét lại để các dòng
        // vừa tạo có thể animate mà không cần tải lại trang.
        if (window.ScrollFX && typeof window.ScrollFX.observe === "function") {
          window.ScrollFX.observe(document.querySelector("main"));
        }
        return true;
      })
      .catch(function () {
        renderAudit([]);
        renderSyncs([]);
        show($("logs-msg"), "Có lỗi không mong đợi khi tải nhật ký.");
      });

    syncsPromise
      .then(function (res) {
        if (handleUnauthorized(res.status)) return;
        if (res.status !== 200) return; // lỗi riêng của bảng sync không chặn phần nhật ký

        var rows = extractSyncRows(res.body);
        renderSyncs(rows);

        if (window.ScrollFX && typeof window.ScrollFX.observe === "function") {
          window.ScrollFX.observe(document.querySelector("main"));
        }
      })
      .catch(function () {
        /* đã có thông báo lỗi chung từ request chính */
      })
      .then(function () {
        state.lastLoadedAt = Date.now();
        clearLoading();
        setBusy(false);
      });
  }

  /* =====================================================================
     PHẦN 7 — SỰ KIỆN
     ===================================================================== */

  function applyFilter() {
    load();
  }

  function useToday() {
    var input = $("log-date");
    if (input) input.value = vnToday();
    load();
  }

  function wireFilter() {
    var applyBtn = $("log-apply");
    if (applyBtn) applyBtn.addEventListener("click", applyFilter);

    var todayBtn = $("log-today");
    if (todayBtn) todayBtn.addEventListener("click", useToday);

    var dateInput = $("log-date");
    if (dateInput) {
      // Enter trong ô ngày cũng là "Lọc" — thao tác quen thuộc của người dùng.
      dateInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          applyFilter();
        }
      });
    }

    var limitSel = $("log-limit");
    if (limitSel) {
      limitSel.addEventListener("change", function () {
        load();
      });
    }
  }

  /**
   * Đăng xuất: POST /api/logout (server xoá cookie phiên), rồi về /login.html.
   * Cookie phiên là HttpOnly nên JS không thể — và không cần — tự xoá;
   * việc vô hiệu hoá phiên phải do server làm.
   */
  function wireLogout() {
    var btn = $("logout-btn");
    if (!btn) return;

    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.textContent = "Đang thoát…";

      var api = shopApi();
      var request = hasFn(api, "postJson")
        ? Promise.resolve()
            .then(function () {
              return api.postJson("/api/logout", {});
            })
            .catch(function () {
              /* Lỗi ở đây không quan trọng: bên dưới vẫn đưa về trang đăng nhập. */
            })
        : fetch("/api/logout", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });

      Promise.resolve(request)
        .catch(function () {
          /* Dù server lỗi hay mất mạng, vẫn đưa người dùng về trang đăng nhập:
             phiên sẽ hết hạn ở phía server, không để họ kẹt ở màn hình này. */
        })
        .then(function () {
          window.location.replace("/login.html");
        });
    });
  }

  /* =====================================================================
     PHẦN 8 — KHỞI ĐỘNG
     ===================================================================== */

  function init() {
    wireFilter();
    wireLogout();

    // Mặc định: không lọc ngày (xem các dòng mới nhất). Ô ngày để trống.
    var dateInput = $("log-date");
    if (dateInput) dateInput.value = "";

    var limitSel = $("log-limit");
    if (limitSel) limitSel.value = "200";

    load();

    // Nếu tab bị treo rồi quay lại sau hơn 5 phút, tải lại cho khỏi nhìn số cũ.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      if (!state.lastLoadedAt) return;
      if (state.loading) return;
      if (Date.now() - state.lastLoadedAt > 5 * 60 * 1000) load();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // Script có defer nên bình thường đã qua "loading"; vẫn xử lý cả hai.
    init();
  }

  /* Chỉ công bố những gì thật sự hữu ích cho việc gỡ lỗi; KHÔNG công bố
     escapeHtml ra ngoài vì không cần thiết. */
  window.ShopLogs = {
    reload: load,
    formatVN: formatVN,
    formatUTC: formatUTC,
    vnToday: vnToday
  };

  // Ghi chú: các hàm dưới đây lấy từ window.ShopFmt khi dashboard.js có mặt,
  // không thì dùng bản cục bộ ngay trong file này. Hiện tại toàn bộ render đi
  // qua textContent nên không phải escape; hai hàm kia vẫn được giữ để dùng khi
  // cần chèn chuỗi vào HTML hoặc định dạng tiền.
  void fmtEscapeHtml;
  void fmtVND;
  void fmtDateTime;
})();

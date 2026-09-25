/* =====================================================================
   images.js — trang "Ảnh" của shop-dashboard.

   Script CỔ ĐIỂN: không import/export, không build step, không thư viện ngoài.

   QUY TẮC BẤT DI BẤT DỊCH (CONTRACT.md mục 0):
   Bảng `stock` của shop có cột `content` chứa cặp acc|pass thật. Trang này chỉ
   làm việc với ẢNH do chủ shop tự tải lên (r2_key, note, mime, size_bytes,
   sha256, created_at, url — đúng kiểu ImageRow trong CONTRACT.md mục 3).
   Không có trường nào của bảng stock được đọc, truyền hay render ở đây.

   BẢO MẬT ẢNH (IMAGES_DESIGN.md):
     * Bucket R2 là RIÊNG TƯ. Ảnh chỉ xem được qua /api/images/<key> kèm cookie
       phiên; Worker gọi requireAuth TRƯỚC khi chạm R2.
     * KHÔNG dùng URL R2 trực tiếp, KHÔNG tạo presigned URL công khai.
     * Kiểm tra phía client chỉ là UX. Server đọc magic bytes và kiểm tra lại
       toàn bộ — client KHÔNG phải là lớp bảo vệ và không được tin.

   API dùng ở đây (CONTRACT.md mục 4):
     GET    /api/images?limit=50   → 200 { images: ImageRow[] }
     POST   /api/images            → 201 { ok:true, image: ImageRow }  (400/401/413)
     DELETE /api/images/<key>      → 200 { ok:true }                    (401/404)
     401 → phiên hết hạn → chuyển về /login.html
   ===================================================================== */
(function () {
  "use strict";

  /* =====================================================================
     PHẦN 1 — TIỆN ÍCH DÙNG CHUNG

     Ưu tiên window.ShopFmt / window.ShopApi do dashboard.js công bố, nhưng
     dashboard.js là file của agent khác: có thể chưa tải, tải lỗi, hoặc chạy
     sau file này. Vì vậy LUÔN kiểm tra tồn tại và rơi về bản sao cục bộ.
     ===================================================================== */

  function shopFmt() {
    var f = window.ShopFmt;
    if (f && typeof f === "object") return f;
    return null;
  }

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
   * escapeHtml — lưới an toàn cho trường hợp buộc phải chèn chuỗi vào HTML.
   * Toàn bộ render trong file này dùng createElement + textContent, nên dữ
   * liệu server (note, r2_key, sha256) không bao giờ được hiểu là HTML.
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

  /** formatVND(1234567) === "1.234.567 ₫" (CONTRACT.md mục 6). */
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
    formatDateTime: formatVNDateTime // cùng chữ ký (nhận chuỗi UTC) → dùng thẳng
  };

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

  function showError(text) {
    var ok = $("images-ok");
    if (ok) {
      ok.textContent = "";
      ok.classList.add("hidden");
    }
    var box = $("images-msg");
    if (!box) return;
    box.textContent = text || "";
    box.classList.remove("hidden");
  }

  function showOk(text) {
    var err = $("images-msg");
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
    var box = $("images-ok");
    if (!box) return;
    box.textContent = text || "";
    box.classList.remove("hidden");
  }

  function clearMessages() {
    var err = $("images-msg");
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
    var ok = $("images-ok");
    if (ok) {
      ok.textContent = "";
      ok.classList.add("hidden");
    }
  }

  /* =====================================================================
     PHẦN 2 — THỜI GIAN & KÍCH THƯỚC

     created_at của D1 sinh bằng datetime('now') → chuỗi "2026-09-22 10:30:00"
     KHÔNG kèm timezone, và thực chất là GIỜ UTC. Muốn hiển thị giờ VN thì phải
     nói rõ nó là UTC (thêm "Z") rồi cộng 7 giờ — nếu để new Date() tự đoán,
     trình duyệt sẽ hiểu theo múi giờ máy và lệch tới 7 tiếng.
     ===================================================================== */

  var VN_OFFSET_MINUTES = 7 * 60;

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /**
   * Chuẩn hoá chuỗi thời gian thành mili-giây.
   *
   * CẠM BẪY ĐÃ KIỂM CHỨNG: chuỗi "2026-09-22 10:30:00" (thiếu timezone) mà đưa
   * thẳng cho Date.parse() sẽ bị V8/Chrome/Node hiểu là GIỜ ĐỊA PHƯƠNG của máy,
   * nên kết quả đổi theo múi giờ của người xem. Phải nhận diện chuỗi thiếu
   * timezone TRƯỚC, tự gắn "Z" để nói rõ "đây là UTC" rồi mới parse.
   */
  function toMillis(value) {
    if (value === null || value === undefined || value === "") return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && isFinite(value)) return value;

    var s = String(value).trim();
    if (!s) return NaN;

    // 1) Chuỗi thiếu timezone (cách D1 lưu) → hiểu là UTC.
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

    // 3) Chuỗi đã kèm timezone ("Z" hoặc ±HH:MM) → tôn trọng nguyên văn.
    var direct = Date.parse(s);
    if (!isNaN(direct)) return direct;

    return NaN;
  }

  /** Giờ VN (UTC+7) dạng "YYYY-MM-DD HH:MM", tính thủ công nên không phụ thuộc máy. */
  function formatVNDateTime(value) {
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
      pad2(d.getUTCMinutes())
    );
  }

  /** Kích thước tệp cho người đọc: "312 KB", "1,4 MB". */
  function formatSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return "không rõ dung lượng";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    var mb = n / (1024 * 1024);
    var rounded = Math.round(mb * 10) / 10;
    // Dấu phẩy thập phân theo tiếng Việt.
    return String(rounded).replace(".", ",") + " MB";
  }

  /** sha256 rút gọn để hiển thị; bản đầy đủ vẫn nằm trong title. */
  function shortHash(hash) {
    var h = String(hash || "");
    if (!h) return "—";
    if (h.length <= 16) return h;
    return h.slice(0, 8) + "…" + h.slice(-8);
  }

  /* =====================================================================
     PHẦN 3 — GỌI API
     ===================================================================== */

  /**
   * Gọi API kèm cookie phiên. Cookie phiên là HttpOnly: JavaScript KHÔNG đọc
   * được nó (và không cần đọc) — chỉ cần credentials:"same-origin" để trình
   * duyệt tự động gửi kèm. Đó cũng là lý do ảnh <img src="/api/images/<key>">
   * hiển thị được: trình duyệt tự gắn cookie vào request tải ảnh.
   */
  function apiFetch(path, options) {
    var opts = options || {};
    opts.credentials = "same-origin";
    opts.cache = "no-store";

    return fetch(path, opts)
      .then(function (res) {
        if (res.status === 204) return { status: 204, body: null };
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

  function errorMessage(body, fallback) {
    if (body && body.error && typeof body.error.message === "string" && body.error.message) {
      return body.error.message;
    }
    return fallback;
  }

  /** 401 ở mọi nơi → về trang đăng nhập, dừng xử lý. */
  function handleUnauthorized(status) {
    if (status !== 401) return false;
    window.location.replace("/login.html");
    return true;
  }

  /* =====================================================================
     PHẦN 4 — THƯ VIỆN ẢNH
     ===================================================================== */

  var state = {
    images: [],
    loading: false,
    uploading: false,
    selectedFile: null,
    lastLoadedAt: 0
  };

  var LIST_LIMIT = 60;

  /** Lấy mảng ảnh từ body { images: [...] }, chấp nhận vài biến thể nhỏ. */
  function extractImages(body) {
    if (!body) return [];
    if (Object.prototype.toString.call(body.images) === "[object Array]") return body.images;
    if (Object.prototype.toString.call(body) === "[object Array]") return body;
    return [];
  }

  /**
   * Đường dẫn xem ảnh.
   * TUYỆT ĐỐI KHÔNG dùng URL R2 trực tiếp và KHÔNG tạo presigned URL công khai:
   * bucket là riêng tư, mọi lượt xem phải đi qua Worker để còn kiểm tra phiên.
   * Server trả sẵn `url` (theo hợp đồng luôn là /api/images/<key>). Chỉ nhận
   * đúng dạng đường dẫn nội bộ đó — nếu vì lý do nào khác mà `url` trỏ ra host
   * ngoài (R2 công khai, presigned URL…), BỎ QUA và dựng lại từ r2_key. Đây
   * không phải chuyện thẩm mỹ: đó là chốt chặn để không bao giờ render một
   * đường dẫn vòng qua Worker.
   */
  function imageSrc(row) {
    if (row && typeof row.url === "string" && row.url.indexOf("/api/images/") === 0) {
      return row.url;
    }
    if (row && typeof row.r2_key === "string" && row.r2_key) {
      return "/api/images/" + encodeURIComponent(row.r2_key);
    }
    return "";
  }

  function imageKey(row) {
    if (row && typeof row.r2_key === "string" && row.r2_key) return row.r2_key;
    return "";
  }

  /** Xây một thẻ ảnh. Mọi chữ đều đi qua textContent, không có innerHTML. */
  function buildCard(row) {
    var key = imageKey(row);

    var card = el("article", "image-card reveal");
    card.setAttribute("data-key", key);
    card.setAttribute("data-reveal", "fade");

    var img = document.createElement("img");
    img.className = "thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "Ảnh đã tải lên";
    img.referrerPolicy = "no-referrer";
    var src = imageSrc(row);
    if (src) {
      img.src = src;
    } else {
      img.alt = "Không xác định được đường dẫn ảnh";
    }
    // Nếu phiên hết hạn giữa chừng, ảnh sẽ 401 → báo cho người dùng biết
    // thay vì để một khung vỡ im lặng.
    img.addEventListener("error", function () {
      img.alt = "Không tải được ảnh (có thể phiên đã hết hạn)";
      card.classList.add("is-broken");
    });
    card.appendChild(img);

    var meta = el("div", "meta");

    var noteText = row && row.note !== null && row.note !== undefined && String(row.note) !== ""
      ? String(row.note)
      : "Không có ghi chú";
    var note = el("div", "note", noteText);
    if (noteText === "Không có ghi chú") note.style.color = "var(--text-faint)";
    meta.appendChild(note);

    // Dòng phụ: dung lượng + thời điểm tạo (giờ VN) + sha256 rút gọn.
    var sub = el(
      "div",
      "sub",
      formatSize(row ? row.size_bytes : null) +
        " · " +
        formatVNDateTime(row ? row.created_at : null) +
        " (VN) · sha256 " +
        shortHash(row ? row.sha256 : "")
    );
    var fullHash = row && row.sha256 ? String(row.sha256) : "";
    if (fullHash) sub.title = "sha256 đầy đủ: " + fullHash;
    meta.appendChild(sub);

    var actions = el("div", "actions");

    // "Mở": mở ảnh ở tab mới. Vẫn là URL nội bộ /api/images/<key>, nên tab mới
    // cũng phải có cookie phiên mới xem được — đúng như thiết kế bucket riêng tư.
    var openBtn = el("button", "btn btn-sm", "Mở");
    openBtn.type = "button";
    openBtn.setAttribute("aria-label", "Mở ảnh trong tab mới");
    openBtn.addEventListener("click", function () {
      var url = imageSrc(row);
      if (!url) {
        showError("Không xác định được đường dẫn của ảnh này.");
        return;
      }
      window.open(url, "_blank", "noopener");
    });
    actions.appendChild(openBtn);

    var delBtn = el("button", "btn btn-sm btn-danger", "Xoá");
    delBtn.type = "button";
    delBtn.setAttribute("aria-label", "Xoá ảnh này");
    delBtn.addEventListener("click", function () {
      removeImage(row, card, delBtn);
    });
    actions.appendChild(delBtn);

    meta.appendChild(actions);
    card.appendChild(meta);

    return card;
  }

  /**
   * Bật/tắt khối trạng thái rỗng của thư viện.
   *
   * Trước đây khối này hiện/ẩn bằng CSS `:has()`, nên ngay khi trang vừa mở
   * (lưới chưa có .image-card) người dùng đã thấy "Thư viện đang trống" trong
   * lúc dữ liệu còn đang tải. Nay images.js điều khiển trực tiếp.
   */
  function setLibraryEmpty(visible) {
    var box = $("library-empty");
    if (box) box.hidden = !visible;
  }

  function renderImages(rows) {
    var grid = $("image-grid");
    if (!grid) return;

    clear(grid);
    grid.removeAttribute("aria-busy");

    var count = $("images-count");
    if (count) {
      count.textContent = rows.length ? rows.length + " ảnh" : "";
    }

    if (!rows.length) {
      setLibraryEmpty(true);
      return;
    }

    setLibraryEmpty(false);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length; i++) {
      frag.appendChild(buildCard(rows[i]));
    }
    grid.appendChild(frag);
  }

  /**
   * Lỗi khi tải danh sách: KHÔNG hiện khối "thư viện đang trống" (dễ bị hiểu là
   * chưa có ảnh nào) mà hiện đúng thông báo lỗi ngay trong lưới.
   */
  function renderLoadError(message) {
    var grid = $("image-grid");
    if (!grid) return;
    clear(grid);
    grid.removeAttribute("aria-busy");
    grid.appendChild(el("div", "empty is-error", message));
    setLibraryEmpty(false);
  }

  /**
   * Khung xương khi đang tải: giữ chỗ sẵn cho lưới ảnh nên bố cục không nhảy
   * khi dữ liệu về. Khung xương là trang trí (aria-hidden) và đi kèm một dòng
   * thông báo ẩn cho trình đọc màn hình.
   */
  function setGridLoading() {
    var grid = $("image-grid");
    if (!grid) return;

    setLibraryEmpty(false);
    clear(grid);
    grid.setAttribute("aria-busy", "true");
    grid.appendChild(el("span", "visually-hidden", "Đang tải danh sách ảnh…"));

    var frag = document.createDocumentFragment();
    for (var i = 0; i < 4; i++) {
      var card = el("div", "card image-card is-skeleton");
      card.setAttribute("aria-hidden", "true");

      var thumb = el("div", "skeleton thumb");
      var meta = el("div", "skeleton-stack");
      meta.appendChild(el("div", "skeleton skeleton-line"));
      meta.appendChild(el("div", "skeleton skeleton-line"));

      card.appendChild(thumb);
      card.appendChild(meta);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function scrollScan() {
    if (window.ScrollFX && typeof window.ScrollFX.observe === "function") {
      window.ScrollFX.observe($("image-grid") || document.querySelector("main"));
    }
  }

  /* =====================================================================
     PHẦN 5 — TẢI DANH SÁCH ẢNH
     ===================================================================== */

  function setRefreshBusy(busy) {
    var btn = $("images-refresh");
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? "Đang tải…" : "Tải lại thư viện";
  }

  function load(silent) {
    if (state.loading) return;
    state.loading = true;
    setRefreshBusy(true);
    if (!silent) clearMessages();
    setGridLoading();

    apiFetch("/api/images?limit=" + LIST_LIMIT, { method: "GET", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (handleUnauthorized(res.status)) return;

        if (res.status === 0) {
          state.images = [];
          renderLoadError("Không kết nối được tới server. Kiểm tra mạng rồi thử lại.");
          showError("Không kết nối được tới server. Kiểm tra mạng rồi thử lại.");
          return;
        }

        if (res.status !== 200) {
          state.images = [];
          renderLoadError(errorMessage(res.body, "Không tải được thư viện ảnh (HTTP " + res.status + ")."));
          showError(errorMessage(res.body, "Không tải được thư viện ảnh (HTTP " + res.status + ")."));
          return;
        }

        state.images = extractImages(res.body);
        renderImages(state.images);
        state.lastLoadedAt = Date.now();
        scrollScan();
      })
      .catch(function () {
        state.images = [];
        renderLoadError("Có lỗi không mong đợi khi tải thư viện ảnh.");
        showError("Có lỗi không mong đợi khi tải thư viện ảnh.");
      })
      .then(function () {
        state.loading = false;
        setRefreshBusy(false);
      });
  }

  /* =====================================================================
     PHẦN 6 — TẢI ẢNH LÊN

     Kiểm tra phía client (loại tệp + dung lượng) CHỈ LÀ UX: giúp người dùng
     biết ngay mình chọn sai thay vì chờ upload xong mới nhận lỗi. Nó KHÔNG
     phải là bảo mật và không được tin: file.type do trình duyệt suy ra từ phần
     mở rộng, kẻ tấn công sửa được. Server mới là nơi quyết định — nó đọc magic
     bytes (FF D8 FF / 89 50 4E 47… / RIFF….WEBP), kiểm tra lại dung lượng và
     trả 400/413. Vì vậy client không bao giờ được phép bỏ qua bước server.
     ===================================================================== */

  var ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
  var MAX_BYTES = 5 * 1024 * 1024; // 5 MB, khớp IMAGES_DESIGN.md

  function mimeAllowed(type) {
    for (var i = 0; i < ALLOWED_MIME.length; i++) {
      if (ALLOWED_MIME[i] === type) return true;
    }
    return false;
  }

  /** Trả về chuỗi lỗi tiếng Việt, hoặc "" nếu tệp qua được vòng kiểm tra UX. */
  function precheckFile(file) {
    if (!file) return "Chưa chọn tệp nào.";

    if (!mimeAllowed(String(file.type || ""))) {
      return (
        "Chỉ nhận ảnh JPEG, PNG hoặc WebP. Tệp bạn chọn có định dạng \"" +
        (file.type || "không xác định") +
        "\". Lưu ý: đổi đuôi tệp không giúp được gì — server kiểm tra nội dung tệp."
      );
    }

    if (typeof file.size === "number" && file.size > MAX_BYTES) {
      return (
        "Ảnh vượt quá 5 MB (ảnh của bạn: " +
        formatSize(file.size) +
        "). Hãy nén hoặc cắt nhỏ ảnh rồi thử lại."
      );
    }

    if (typeof file.size === "number" && file.size === 0) {
      return "Tệp rỗng (0 byte). Hãy chọn tệp khác.";
    }

    return "";
  }

  function setSelectedFile(file) {
    state.selectedFile = file || null;

    var nameBox = $("file-name");
    var btn = $("upload-btn");

    if (!file) {
      if (nameBox) nameBox.textContent = "Chưa chọn tệp nào.";
      if (btn) btn.disabled = true;
      return;
    }

    if (nameBox) {
      nameBox.textContent =
        "Đã chọn: " + file.name + " (" + formatSize(file.size) + ")";
    }
    if (btn) btn.disabled = false;

    // Kiểm tra sớm để cảnh báo ngay lúc chọn tệp, không đợi bấm "Tải lên".
    var problem = precheckFile(file);
    if (problem) showError(problem);
    else clearMessages();
  }

  function showProgress(on, statusText) {
    var box = $("upload-progress");
    if (!box) return;
    if (on) box.classList.remove("hidden");
    else box.classList.add("hidden");

    var status = $("upload-status");
    if (status && statusText) status.textContent = statusText;
  }

  function setUploadBusy(busy) {
    state.uploading = !!busy;
    var btn = $("upload-btn");
    if (!btn) return;
    btn.disabled = !!busy || !state.selectedFile;
    btn.textContent = busy ? "Đang tải…" : "Tải lên";
  }

  /**
   * Upload bằng fetch + FormData (field `file` và `note`).
   * fetch() KHÔNG cho biết đã gửi được bao nhiêu byte, nên thanh tiến trình ở
   * đây là trạng thái "đang chạy" (không xác định), KHÔNG hiển thị phần trăm
   * — thà không có số còn hơn một con số bịa.
   */
  function upload() {
    if (state.uploading) return;

    var file = state.selectedFile;
    var problem = precheckFile(file);
    if (problem) {
      showError(problem);
      return;
    }

    var noteInput = $("note-input");
    var note = noteInput ? String(noteInput.value || "") : "";
    if (note.length > 200) note = note.slice(0, 200);

    var form = new FormData();
    form.append("file", file, file.name);
    form.append("note", note);

    clearMessages();
    setUploadBusy(true);
    showProgress(true, "Đang tải ảnh lên… Vui lòng không đóng tab.");

    var bar = $("upload-bar");
    if (bar) bar.style.width = "35%";

    apiFetch("/api/images", {
      method: "POST",
      body: form
      // Không tự đặt Content-Type: trình duyệt phải tự thêm boundary của
      // multipart/form-data, đặt tay sẽ làm hỏng body.
    })
      .then(function (res) {
        if (handleUnauthorized(res.status)) return;

        if (res.status === 0) {
          showError("Không kết nối được tới server. Ảnh chưa được tải lên.");
          return;
        }

        if (res.status === 201 || res.status === 200) {
          var created = res.body && res.body.image ? res.body.image : null;

          if (state.selectedFile === file) setSelectedFile(null);
          if (noteInput) noteInput.value = "";
          var input = $("file-input");
          if (input) input.value = "";

          // Thêm ngay vào thư viện để không phải tải lại cả danh sách.
          if (created) prependCard(created);

          showOk(
            "Đã tải ảnh lên thành công" +
              (created && created.r2_key ? " (" + shortHash(created.sha256) + ")" : "") +
              ". Ảnh chỉ xem được khi đăng nhập."
          );
          return;
        }

        if (res.status === 413) {
          showError(
            errorMessage(res.body, "Ảnh vượt quá giới hạn 5 MB nên server đã từ chối.")
          );
          return;
        }

        if (res.status === 400) {
          showError(
            errorMessage(
              res.body,
              "Server từ chối tệp này. Ảnh phải là JPEG, PNG hoặc WebP thật (nội dung tệp không khớp định dạng)."
            )
          );
          return;
        }

        showError(errorMessage(res.body, "Tải ảnh lên thất bại (HTTP " + res.status + ")."));
      })
      .catch(function () {
        showError("Có lỗi không mong đợi khi tải ảnh lên.");
      })
      .then(function () {
        setUploadBusy(false);
        showProgress(false);
        if (bar) bar.style.width = "30%";
      });
  }

  /** Chèn ảnh vừa upload lên đầu lưới (server trả ảnh mới nhất trước). */
  function prependCard(row) {
    var grid = $("image-grid");
    if (!grid) return;

    // Ảnh mới xuất hiện: thư viện không còn rỗng.
    setLibraryEmpty(false);

    var card = buildCard(row);
    card.classList.add("is-visible"); // ảnh mới: hiện ngay, không chờ cuộn
    grid.insertBefore(card, grid.firstChild);

    state.images = [row].concat(state.images);
    var count = $("images-count");
    if (count) count.textContent = state.images.length + " ảnh";

    if (window.ScrollFX && typeof window.ScrollFX.observe === "function") {
      window.ScrollFX.observe(grid);
    }
  }

  /* =====================================================================
     PHẦN 7 — XOÁ ẢNH
     ===================================================================== */

  function removeImage(row, card, button) {
    var key = imageKey(row);
    if (!key) {
      showError("Không xác định được ảnh cần xoá.");
      return;
    }

    // Hộp thoại xác nhận dùng chung (public/js/confirm.js) thay cho
    // window.confirm: theo design system, đặt được nhãn nút và trả focus về
    // nút gọi sau khi đóng. Nếu script xác nhận không tải được, vẫn lùi về
    // window.confirm để thao tác xoá không bị chặn.
    askConfirm({
      title: "Xoá ảnh này?",
      message: "Ảnh sẽ bị xoá khỏi kho R2 và không khôi phục được.",
      confirmLabel: "Xoá ảnh",
    }).then(function (confirmed) {
      if (confirmed) performRemoveImage(key, card, button);
    });
  }

  function askConfirm(options) {
    if (window.ShopConfirm && typeof window.ShopConfirm.ask === "function") {
      return window.ShopConfirm.ask(options);
    }
    return Promise.resolve(window.confirm(options.title + "\n\n" + options.message));
  }

  function performRemoveImage(key, card, button) {
    if (button) {
      button.disabled = true;
      button.textContent = "Đang xoá…";
    }
    clearMessages();

    var api = shopApi();
    var request = hasFn(api, "del")
      ? Promise.resolve()
          .then(function () {
            return api.del("/api/images/" + encodeURIComponent(key));
          })
          // getJson/del của dashboard.js ném Error khi server trả lỗi (và tự
          // chuyển hướng khi 401). Quy về status 0 để nhánh xử lý bên dưới vẫn
          // nói đúng "chưa xoá được" thay vì im lặng coi như thành công.
          .catch(function () {
            return { status: 0, body: null };
          })
      : apiFetch("/api/images/" + encodeURIComponent(key), { method: "DELETE" });

    Promise.resolve(request)
      .then(function (res) {
        // ShopApi.del có thể trả body trực tiếp thay vì { status, body }.
        var status = res && typeof res.status === "number" ? res.status : 200;

        if (handleUnauthorized(status)) return;

        if (status === 0) {
          showError("Không kết nối được tới server. Ảnh chưa bị xoá.");
          if (button) {
            button.disabled = false;
            button.textContent = "Xoá";
          }
          return;
        }

        if (status === 404) {
          // Ảnh đã biến mất ở server (có thể do tab khác xoá) → vẫn gỡ khỏi DOM.
          detachCard(card, key);
          showError("Ảnh này không còn tồn tại trên server; đã gỡ khỏi danh sách.");
          return;
        }

        if (status !== 200 && status !== 204) {
          showError(
            errorMessage(res && res.body, "Xoá ảnh thất bại (HTTP " + status + ").")
          );
          if (button) {
            button.disabled = false;
            button.textContent = "Xoá";
          }
          return;
        }

        detachCard(card, key);
        showOk("Đã xoá ảnh khỏi kho R2.");
      })
      .catch(function () {
        showError("Có lỗi không mong đợi khi xoá ảnh.");
        if (button) {
          button.disabled = false;
          button.textContent = "Xoá";
        }
      });
  }

  function detachCard(card, key) {
    if (card && card.parentNode) card.parentNode.removeChild(card);

    var kept = [];
    for (var i = 0; i < state.images.length; i++) {
      if (imageKey(state.images[i]) !== key) kept.push(state.images[i]);
    }
    state.images = kept;

    var grid = $("image-grid");
    var count = $("images-count");
    if (count) count.textContent = state.images.length ? state.images.length + " ảnh" : "";

    if (grid && !state.images.length) {
      setLibraryEmpty(true);
    }
  }

  /* =====================================================================
     PHẦN 8 — CHỌN TỆP: BẤM, BÀN PHÍM, KÉO & THẢ
     ===================================================================== */

  function wireDropZone() {
    var zone = $("drop-zone");
    var input = $("file-input");
    if (!zone || !input) return;

    // Bấm vào vùng thả → mở hộp chọn tệp. Bấm vào chính input hoặc nhãn
    // <label for="file-input"> thì để trình duyệt tự lo, tránh mở hai lần.
    zone.addEventListener("click", function (ev) {
      var target = ev.target;
      if (target === input) return;
      if (target && target.tagName === "LABEL") return;
      if (target && target.closest && target.closest("label")) return;
      input.click();
    });

    zone.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
        ev.preventDefault();
        input.click();
      }
    });

    input.addEventListener("change", function () {
      var file = input.files && input.files.length ? input.files[0] : null;
      setSelectedFile(file);
    });

    // --- Kéo & thả ---
    // dragover PHẢI preventDefault, nếu không trình duyệt sẽ không bắn `drop`
    // (hành vi mặc định của dragover là "không cho thả").
    var depth = 0; // đếm enter/leave để không nhấp nháy khi rê qua phần tử con

    zone.addEventListener("dragenter", function (ev) {
      ev.preventDefault();
      depth++;
      zone.classList.add("is-over");
    });

    zone.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-over");
    });

    zone.addEventListener("dragleave", function (ev) {
      ev.preventDefault();
      depth--;
      if (depth <= 0) {
        depth = 0;
        zone.classList.remove("is-over");
      }
    });

    zone.addEventListener("drop", function (ev) {
      ev.preventDefault();
      depth = 0;
      zone.classList.remove("is-over");

      var files = ev.dataTransfer ? ev.dataTransfer.files : null;
      if (!files || !files.length) {
        showError("Không đọc được tệp vừa thả. Hãy thử lại hoặc bấm \"Chọn ảnh\".");
        return;
      }
      if (files.length > 1) {
        showError("Mỗi lần chỉ tải lên một ảnh. Đã dùng ảnh đầu tiên trong nhóm bạn thả.");
      }
      setSelectedFile(files[0]);
    });

    // Chặn trình duyệt mở ảnh khi người dùng thả lệch ra ngoài khung.
    ["dragover", "drop"].forEach(function (name) {
      window.addEventListener(name, function (ev) {
        if (zone.contains(ev.target)) return;
        ev.preventDefault();
      });
    });

    var btn = $("upload-btn");
    if (btn) btn.addEventListener("click", upload);
  }

  /* =====================================================================
     PHẦN 9 — ĐĂNG XUẤT
     ===================================================================== */

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
        : apiFetch("/api/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });

      Promise.resolve(request)
        .catch(function () {
          /* Mất mạng hay server lỗi thì vẫn đưa về trang đăng nhập: phiên sẽ
             hết hạn phía server, không để người dùng kẹt ở màn hình này. */
        })
        .then(function () {
          window.location.replace("/login.html");
        });
    });
  }

  /* =====================================================================
     PHẦN 10 — KHỞI ĐỘNG
     ===================================================================== */

  function init() {
    wireDropZone();
    wireLogout();

    // Nút "Tải lên" chỉ bật khi đã có tệp hợp lệ (xem setSelectedFile).
    setUploadBusy(false);

    var refresh = $("images-refresh");
    if (refresh) {
      refresh.addEventListener("click", function () {
        load(false);
      });
    }

    // Ghi chú: không tự upload khi bấm Enter trong ô ghi chú — tránh việc
    // vô tình gửi ảnh lên chỉ vì đang gõ dở.
    load(false);

    // Quay lại tab sau hơn 5 phút thì làm mới danh sách cho khỏi nhìn dữ liệu cũ.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      if (!state.lastLoadedAt) return;
      if (state.loading || state.uploading) return;
      if (Date.now() - state.lastLoadedAt > 5 * 60 * 1000) load(true);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* API nhỏ phục vụ gỡ lỗi / kiểm thử; không công bố escapeHtml ra ngoài. */
  window.ShopImages = {
    reload: function () {
      load(false);
    },
    precheckFile: precheckFile,
    formatSize: formatSize,
    imageSrc: imageSrc
  };

  // Giữ tham chiếu để các hàm lấy từ window.ShopFmt (hoặc bản cục bộ) không bị
  // coi là thừa; toàn bộ render hiện tại đi qua textContent nên không cần escape.
  void fmtEscapeHtml;
  void fmtVND;
  void fmtDateTime;
})();

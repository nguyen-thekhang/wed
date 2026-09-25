/* =====================================================================
   uid.js — trang "Check UID" của shop-dashboard.

   Script CỔ ĐIỂN: không import/export, không build step, không thư viện ngoài.

   QUY TẮC BẤT DI BẤT DỊCH (CONTRACT.md mục 0):
   Bảng `stock` của shop có cột chứa cặp acc|pass thật. Trang này chỉ làm
   việc với dãy số UID Facebook do chính người dùng dán vào. Không có trường
   nào của bảng stock được đọc, truyền hay render ở đây.

   API dùng ở đây (CONTRACT.md mục 4):
     POST /api/fbcheck   → 200 { ok, total, live[], die[], unknown[], summary }
                          400 | 401 | 413 | 429 | 500
     401 → phiên hết hạn → chuyển về /login.html

   AN TOÀN XSS: mọi kết quả từ server được chèn bằng createElement +
   textContent, không dùng cách chèn mã HTML. Nội dung server có thể đổi bất
   cứ lúc nào, nên không được tin.
   ===================================================================== */
(function () {
  "use strict";

  /* =====================================================================
     PHẦN 1 — TIỆN ÍCH DÙNG CHUNG
     ===================================================================== */

  function shopApi() {
    var a = window.ShopApi;
    return a && typeof a === "object" ? a : null;
  }

  function hasFn(obj, name) {
    return !!obj && typeof obj[name] === "function";
  }

  /** $(id) — lấy phần tử theo id. */
  function $(id) {
    return document.getElementById(id);
  }

  /** Tạo phần tử; chữ luôn đi qua textContent nên không bao giờ thành HTML. */
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

  /**
   * Gọi API kèm cookie phiên.
   *
   * Ưu tiên window.ShopApi nếu có (do dashboard.js công bố), rồi tới bản sao
   * cục bộ. Bản sao cục bộ luôn tồn tại để trang này không phụ thuộc thứ tự
   * nạp file.
   */
  function apiFetch(path, opts) {
    var shared = shopApi();
    if (hasFn(shared, "fetch")) {
      return shared.fetch(path, opts);
    }
    return fetch(path, opts || {}).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  /** Rút thông điệp lỗi từ response dạng { error: { code, message } }. */
  function errorMessage(data, fallback) {
    if (data && data.error && typeof data.error.message === "string" && data.error.message) {
      return data.error.message;
    }
    return fallback || "Có lỗi xảy ra";
  }

  function showError(text) {
    var ok = $("uid-ok");
    if (ok) {
      ok.textContent = "";
      ok.classList.add("hidden");
    }
    var box = $("uid-msg");
    if (!box) return;
    box.textContent = text;
    box.classList.remove("hidden");
  }

  function showOk(text) {
    var err = $("uid-msg");
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
    var box = $("uid-ok");
    if (!box) return;
    box.textContent = text;
    box.classList.remove("hidden");
  }

  function clearAlerts() {
    var err = $("uid-msg");
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
    var ok = $("uid-ok");
    if (ok) {
      ok.textContent = "";
      ok.classList.add("hidden");
    }
  }

  function setBusy(busy) {
    var btn = $("uid-check-btn");
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Đang kiểm tra…" : "Kiểm tra";
    }

    var input = $("uid-input");
    if (input) input.readOnly = busy;

    var progress = $("uid-progress");
    if (progress) progress.classList.toggle("hidden", !busy);

    var clearBtn = $("uid-clear-btn");
    if (clearBtn && busy) clearBtn.disabled = true;
  }

  function setStatus(text) {
    var status = $("uid-status");
    if (status) status.textContent = text;
  }

  /* =====================================================================
     PHẦN 2 — ĐẾM UID NGAY TRONG Ô NHẬP
     ===================================================================== */

  /**
   * Tách danh sách người dùng đang gõ thành 3 nhóm, để báo số lượng TRƯỚC khi
   * bấm nút. Ở đây chỉ đếm, KHÔNG quyết định live/die — việc đó do server làm.
   */
  function countFromText(text) {
    var valid = 0;
    var invalid = 0;
    var seen = {};

    var lines = String(text || "")
      .split(/[\r\n,;\t]+/);

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line === "") continue;

      var uid = null;
      if (/^[0-9]{1,25}$/.test(line)) {
        uid = line;
      } else {
        var m = /(?:[?&](?:id|ids|profile_id|user_id)=)([0-9]{1,25})(?![0-9])/i.exec(line);
        if (m && m[1]) uid = m[1];
      }

      if (uid === null) {
        invalid++;
        continue;
      }
      if (seen[uid]) continue;
      seen[uid] = true;
      valid++;
    }

    return { valid: valid, invalid: invalid };
  }

  function refreshCount() {
    var input = $("uid-input");
    var count = $("uid-count");
    if (!input || !count) return;

    var n = countFromText(input.value);
    if (n.valid === 0 && n.invalid === 0) {
      count.textContent = "Chưa có UID nào.";
      return;
    }

    var parts = [n.valid + " UID hợp lệ"];
    if (n.invalid > 0) parts.push(n.invalid + " dòng không hợp lệ");
    if (n.valid > 200) parts.push("vượt giới hạn 200/lần");

    count.textContent = parts.join(" · ");
  }

  /* =====================================================================
     PHẦN 3 — RENDER KẾT QUẢ
     ===================================================================== */

  /** Trạng thái hiện tại, dùng cho nút Copy. */
  var state = { live: [], die: [], unknown: [] };

  function createEmptyIcon(pathData) {
    var namespace = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "empty-state-icon");

    var path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  /**
   * Trạng thái rỗng của một panel kết quả.
   *
   * Theo quy ước design system, trạng thái rỗng phải có: biểu tượng, tiêu đề,
   * một câu giải thích VÀ một hành động khả dụng. Trước đây chỉ có biểu tượng
   * kèm một câu chữ nên người dùng biết mình chưa có kết quả nhưng không có
   * cách nào để bắt đầu ngay tại chỗ.
   */
  function renderEmptyRow(listId) {
    var pathData = "M12 3.5 21.2 20H2.8L12 3.5Z M12 9.5v4.2 M12 17.1h.01";
    var title = "Chưa kiểm tra";
    var message = "Dán UID ở ô phía trên rồi bấm Kiểm tra để xem kết quả.";

    if (listId === "uid-live-list") {
      pathData = "M5 12.5 9.2 16.5 19 7.5";
      title = "Chưa có UID LIVE";
      message = "UID còn tồn tại sẽ hiện ở đây sau khi bạn chạy kiểm tra.";
    } else if (listId === "uid-die-list") {
      pathData = "M6.5 6.5 17.5 17.5 M17.5 6.5 6.5 17.5";
      title = "Chưa có UID DIE";
      message = "UID không còn tồn tại sẽ hiện ở đây sau khi bạn chạy kiểm tra.";
    } else if (listId === "uid-unknown-list") {
      title = "Chưa có kết quả chưa xác định";
      message = "Kết quả bị giới hạn hoặc lỗi sẽ được giữ lại ở đây để kiểm tra lại.";
    }

    var empty = el("li", "empty uid-empty");

    var mark = el("span", "empty-state-mark");
    mark.setAttribute("aria-hidden", "true");
    var icon = createEmptyIcon(pathData);
    icon.setAttribute("class", "icon");
    mark.appendChild(icon);
    empty.appendChild(mark);

    empty.appendChild(el("strong", null, title));
    empty.appendChild(el("span", null, message));

    var action = el("a", "btn btn-sm", "Đến ô nhập UID");
    action.setAttribute("href", "#uid-input");
    empty.appendChild(action);

    return empty;
  }

  /**
   * Vẽ một danh sách UID.
   *
   * @param listId  id của <ul>
   * @param countId id của badge số lượng
   * @param rows    [{ uid, note }]
   */
  function renderList(listId, countId, rows) {
    var list = $(listId);
    var count = $(countId);
    clear(list);

    if (count) count.textContent = String(rows.length);

    if (!rows.length) {
      list.appendChild(renderEmptyRow(listId));
      return;
    }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var li = el("li", null);
      li.appendChild(el("span", "mono", row.uid));
      if (row.note) {
        li.appendChild(el("span", "uid-note", row.note));
      }
      list.appendChild(li);
    }
  }

  function renderAll(data) {
    state.live = data.live || [];
    state.die = data.die || [];
    state.unknown = data.unknown || [];

    renderList("uid-live-list", "uid-live-count", state.live.map(toRow));
    renderList("uid-die-list", "uid-die-count", state.die.map(toRow));
    renderList("uid-unknown-list", "uid-unknown-count", state.unknown.map(function (r) {
      return { uid: r.uid, note: r.reason };
    }));

    var summary = $("uid-summary");
    if (summary) {
      var s = data.summary || {};
      summary.textContent =
        "Đã kiểm tra " + (data.total || 0) + " UID · " +
        (s.live || 0) + " live · " +
        (s.die || 0) + " die · " +
        (s.unknown || 0) + " chưa xác định";
    }

    // Nút Copy chỉ bật khi nhóm tương ứng có dữ liệu.
    refreshCopyButtons();
  }

  function toRow(r) {
    return { uid: r.uid, note: r.has_photo ? null : "không có ảnh công khai" };
  }

  function refreshCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy]");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var group = state[btn.getAttribute("data-copy")] || [];
      btn.disabled = group.length === 0;
    }
  }

  function clearResults() {
    state = { live: [], die: [], unknown: [] };
    renderAll({ total: 0, live: [], die: [], unknown: [], summary: {} });

    var summary = $("uid-summary");
    if (summary) summary.textContent = "Chưa kiểm tra.";

    var clearBtn = $("uid-clear-btn");
    if (clearBtn) clearBtn.disabled = true;
  }

  /* =====================================================================
     PHẦN 4 — COPY
     ===================================================================== */

  /**
   * Chép danh sách UID của một nhóm vào clipboard.
   *
   * `navigator.clipboard` chỉ hoạt động trên ngữ cảnh bảo mật (https). Nếu không
   * dùng được, ta rơi về cách cũ tạo <textarea> tạm — để nút "Copy" không bao
   * giờ chết im lặng trên http hoặc trình duyệt cũ.
   */
  function copyGroup(group) {
    var rows = state[group] || [];
    if (!rows.length) return;

    var text = rows
      .map(function (r) {
        return r.uid;
      })
      .join("\n");

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          showOk("Đã chép " + rows.length + " UID (" + groupLabel(group) + ") vào clipboard.");
        },
        function () {
          legacyCopy(text);
        },
      );
      return;
    }

    legacyCopy(text);
  }

  function groupLabel(group) {
    if (group === "live") return "Live";
    if (group === "die") return "Die";
    return "Chưa xác định";
  }

  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);

    var copied = false;
    try {
      area.select();
      copied = document.execCommand("copy");
    } catch (e) {
      copied = false;
    }

    document.body.removeChild(area);

    if (copied) {
      showOk("Đã chép " + text.split("\n").length + " UID vào clipboard.");
    } else {
      showError("Trình duyệt chặn sao chép tự động. Hãy bôi đen danh sách và Ctrl+C.");
    }
  }

  /* =====================================================================
     PHẦN 5 — GỌI API
     ===================================================================== */

  /*
    Đánh dấu các vùng kết quả là "đang cập nhật" trong lúc chờ /api/fbcheck.

    Vì sao cần: khi bấm Kiểm tra, các panel LIVE/DIE/CHƯA XÁC ĐỊNH vẫn hiện dữ
    liệu CŨ (hoặc trạng thái rỗng) cho tới khi máy chủ trả lời, nên người dùng
    và trình đọc màn hình không biết là kết quả sắp đổi. aria-busy là tín hiệu
    đúng cho tình huống đó.
  */
  var RESULT_LISTS = ["uid-live-list", "uid-die-list", "uid-unknown-list"];

  function setResultsBusy(busy) {
    for (var i = 0; i < RESULT_LISTS.length; i++) {
      var list = $(RESULT_LISTS[i]);
      if (!list) continue;
      if (busy) list.setAttribute("aria-busy", "true");
      else list.removeAttribute("aria-busy");
    }
  }

  function runCheck() {
    var input = $("uid-input");
    if (!input) return;

    var text = input.value || "";
    if (text.trim() === "") {
      showError("Danh sách rỗng. Dán ít nhất một UID.");
      return;
    }

    var n = countFromText(text);
    if (n.valid === 0) {
      showError("Không tìm thấy UID hợp lệ nào. Mỗi dòng cần là một dãy chữ số.");
      return;
    }
    if (n.valid > 200) {
      showError("Danh sách có " + n.valid + " UID, vượt giới hạn 200 mỗi lần. Hãy chia nhỏ.");
      return;
    }

    clearAlerts();
    setBusy(true);
    setResultsBusy(true);
    setStatus("Đang hỏi Meta về " + n.valid + " UID…");

    apiFetch("/api/fbcheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uids: text }),
    })
      .then(function (res) {
        // Phiên hết hạn → về trang đăng nhập, giữ nguyên next để quay lại.
        if (res.status === 401) {
          window.location.href = "/login.html?next=" + encodeURIComponent("/uid.html");
          return null;
        }

        if (!res.ok || !res.data || res.data.ok !== true) {
          var msg = errorMessage(res.data, "Không kiểm tra được.");
          // 413 nghĩa là gửi quá nhiều; báo rõ để người dùng biết phải chia nhỏ.
          if (res.status === 413) msg = "Danh sách quá dài. Hãy chia thành nhiều lần.";
          throw new Error(msg);
        }

        return res.data;
      })
      .then(function (data) {
        if (data === null) return; // đã chuyển trang

        renderAll(data);
        setStatus("Xong.");

        var s = data.summary || {};
        var extra = [];
        if (s.invalid_lines > 0) {
          extra.push(s.invalid_lines + " dòng bị bỏ qua vì không phải UID");
        }
        if (s.unknown > 0) {
          extra.push("có " + s.unknown + " UID chưa xác định — xem nhóm màu vàng");
        }

        showOk(
          "Đã kiểm tra " + data.total + " UID: " + s.live + " live, " + s.die + " die." +
          (extra.length ? " (" + extra.join("; ") + ")" : ""),
        );

        var clearBtn = $("uid-clear-btn");
        if (clearBtn) clearBtn.disabled = false;
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : "Có lỗi xảy ra, vui lòng thử lại.");
        setStatus("Thất bại.");
      })
      .then(function () {
        setResultsBusy(false);
        setBusy(false);
      });
  }

  /* =====================================================================
     PHẦN 6 — KHỞI TẠO
     ===================================================================== */

  function logout() {
    apiFetch("/api/logout", { method: "POST" }).then(function () {
      window.location.href = "/login.html";
    });
  }

  function init() {
    var input = $("uid-input");
    if (input) {
      input.addEventListener("input", refreshCount);
      // Ctrl+Enter hoặc Cmd+Enter để kiểm tra nhanh khi đang dán danh sách dài.
      input.addEventListener("keydown", function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
          ev.preventDefault();
          runCheck();
        }
      });
    }

    var checkBtn = $("uid-check-btn");
    if (checkBtn) checkBtn.addEventListener("click", runCheck);

    var clearBtn = $("uid-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        clearResults();
        clearAlerts();
        if (input) {
          input.value = "";
          input.focus();
        }
        refreshCount();
      });
    }

    var copyButtons = document.querySelectorAll("[data-copy]");
    for (var i = 0; i < copyButtons.length; i++) {
      copyButtons[i].addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        copyGroup(btn.getAttribute("data-copy"));
      });
    }

    var logoutBtn = $("logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        logoutBtn.disabled = true;
        logoutBtn.textContent = "Đang thoát…";
        logout();
      });
    }

    refreshCount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/* =====================================================================
   tickxanh.js — trang theo dõi huy hiệu tích xanh Meta.

   Script cổ điển: không import/export, không build step, không thư viện ngoài.
   Mọi dữ liệu từ máy chủ được chèn bằng createElement, createElementNS và
   textContent để nội dung không bao giờ trở thành mã HTML.

   Trang này chỉ làm việc với danh sách UID và thông báo của dịch vụ tích xanh.
   Script không đọc, ghi hay hiển thị bất kỳ trường dữ liệu nào của bảng stock.
   ===================================================================== */
(function () {
  "use strict";

  /* =====================================================================
     PHẦN 1 — TIỆN ÍCH DOM VÀ THÔNG BÁO
     ===================================================================== */

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
    var box = $("bx-msg");
    var ok = $("bx-ok");
    if (ok) {
      ok.textContent = "";
      ok.hidden = true;
      ok.classList.add("hidden");
    }
    if (!box) return;
    box.textContent = String(text || "Có lỗi xảy ra, vui lòng thử lại.");
    box.hidden = false;
    box.classList.remove("hidden");
  }

  function showSuccess(text) {
    var box = $("bx-ok");
    var error = $("bx-msg");
    if (error) {
      error.textContent = "";
      error.hidden = true;
      error.classList.add("hidden");
    }
    if (!box) return;
    box.textContent = String(text);
    box.hidden = false;
    box.classList.remove("hidden");
  }

  function clearAlerts() {
    var error = $("bx-msg");
    var ok = $("bx-ok");
    if (error) {
      error.textContent = "";
      error.hidden = true;
      error.classList.add("hidden");
    }
    if (ok) {
      ok.textContent = "";
      ok.hidden = true;
      ok.classList.add("hidden");
    }
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function rowsFrom(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(isObject);
  }

  function finiteNumber(value) {
    if (typeof value !== "number" || !isFinite(value)) return null;
    return value;
  }

  function numberText(value) {
    var n = finiteNumber(value);
    return n === null ? "0" : String(Math.max(0, Math.floor(n)));
  }

  function displayName(value) {
    return typeof value === "string" && value.trim() ? value : "Chưa có tên";
  }

  function apiErrorMessage(data, fallback) {
    if (isObject(data) && typeof data.error === "string" && data.error) {
      return data.error;
    }
    if (isObject(data) && isObject(data.error)) {
      if (typeof data.error.message === "string" && data.error.message) {
        return data.error.message;
      }
    }
    if (isObject(data) && typeof data.message === "string" && data.message) {
      return data.message;
    }
    return fallback || "Có lỗi xảy ra, vui lòng thử lại.";
  }

  /* =====================================================================
     PHẦN 2 — GỌI API CÙNG COOKIE PHIÊN
     ===================================================================== */

  function isEnvelope(value) {
    return (
      isObject(value) &&
      typeof value.status === "number" &&
      Object.prototype.hasOwnProperty.call(value, "data")
    );
  }

  function responseToEnvelope(response) {
    if (!response || typeof response.json !== "function") {
      return Promise.resolve({ ok: false, status: 0, data: null });
    }

    var status = typeof response.status === "number" ? response.status : 0;
    var ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;

    try {
      return Promise.resolve(response.json())
        .then(function (data) {
          return { ok: ok, status: status, data: data };
        })
        .catch(function () {
          return { ok: ok, status: status, data: null };
        });
    } catch (error) {
      return Promise.resolve({ ok: ok, status: status, data: null });
    }
  }

  function normalizeApiResult(value) {
    if (isEnvelope(value)) return Promise.resolve(value);
    return responseToEnvelope(value);
  }

  function sessionOptions(opts) {
    var source = isObject(opts) ? opts : {};
    var request = {};
    var headers = { Accept: "application/json" };
    var key;

    for (key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key) && key !== "headers") {
        request[key] = source[key];
      }
    }

    if (source.headers && typeof source.headers.forEach === "function") {
      source.headers.forEach(function (value, name) {
        headers[name] = value;
      });
    } else if (isObject(source.headers)) {
      for (key in source.headers) {
        if (Object.prototype.hasOwnProperty.call(source.headers, key)) {
          headers[key] = source.headers[key];
        }
      }
    }

    request.credentials = source.credentials || "same-origin";
    request.headers = headers;
    return request;
  }

  function apiFetch(path, opts) {
    var request = sessionOptions(opts);
    var shared = window.ShopApi;

    try {
      if (shared && typeof shared.fetch === "function") {
        return Promise.resolve(shared.fetch(path, request)).then(normalizeApiResult);
      }

      return fetch(path, request).then(normalizeApiResult);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  var redirecting = false;

  function handleUnauthorized(response) {
    if (!response || response.status !== 401 || redirecting) return false;
    redirecting = true;
    window.location.href = "/login.html?next=/tickxanh.html";
    return true;
  }

  function requireOk(response, fallback) {
    if (handleUnauthorized(response)) return false;
    if (
      !response ||
      !response.ok ||
      !isObject(response.data) ||
      response.data.ok !== true
    ) {
      throw new Error(apiErrorMessage(response && response.data, fallback));
    }
    return true;
  }

  /* =====================================================================
     PHẦN 3 — TRẠNG THÁI VÀ ĐỊNH DẠNG THỜI GIAN
     ===================================================================== */

  var state = {
    watching: [],
    verified: [],
    other: [],
    notifications: [],
    unread: 0,
    summary: {},
    serverTime: Math.floor(Date.now() / 1000),
    signature: null,
    loaded: false,
    loading: false,
    loadPromise: null,
    reloadQueued: false,
  };

  function formatWatchMinutes(value) {
    var minutes = finiteNumber(value);
    if (minutes === null || minutes < 1) return "Dưới 1 phút";

    var total = Math.floor(minutes);
    var days = Math.floor(total / 1440);
    var hours = Math.floor((total % 1440) / 60);
    var mins = total % 60;
    var parts = [];

    if (days > 0) parts.push(days + " ngày");
    if (hours > 0) parts.push(hours + " giờ");
    if (mins > 0 || parts.length === 0) parts.push(mins + " phút");
    return parts.join(" ");
  }

  function relativeTime(value) {
    var created = finiteNumber(value);
    if (created === null || created <= 0) return "Vừa xong";

    var now = finiteNumber(state.serverTime);
    if (now === null) now = Math.floor(Date.now() / 1000);
    var seconds = Math.floor(now - created);

    if (seconds < 60) return "Vừa xong";
    if (seconds < 3600) return Math.floor(seconds / 60) + " phút trước";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " giờ trước";
    return Math.floor(seconds / 86400) + " ngày trước";
  }

  function watchProjection(row) {
    return {
      uid: String(row.uid === undefined || row.uid === null ? "" : row.uid),
      name: typeof row.name === "string" ? row.name : null,
      status: typeof row.status === "string" ? row.status : "unknown",
      started_at: finiteNumber(row.started_at),
      last_checked_at: finiteNumber(row.last_checked_at),
      verified_at: finiteNumber(row.verified_at),
      checks_count: finiteNumber(row.checks_count),
      last_error: typeof row.last_error === "string" ? row.last_error : null,
      watch_minutes: finiteNumber(row.watch_minutes),
    };
  }

  function notificationProjection(row) {
    return {
      id: finiteNumber(row.id),
      uid: String(row.uid === undefined || row.uid === null ? "" : row.uid),
      name: typeof row.name === "string" ? row.name : null,
      title: typeof row.title === "string" ? row.title : "",
      body: typeof row.body === "string" ? row.body : "",
      watch_minutes: finiteNumber(row.watch_minutes),
      read: row.read === true,
      created_at: finiteNumber(row.created_at),
    };
  }

  function buildSignature() {
    var watches = state.watching.concat(state.verified, state.other).map(watchProjection);
    var notifications = state.notifications.map(notificationProjection);
    return JSON.stringify({
      watches: watches,
      notifications: notifications,
      unread: state.unread,
      summary: state.summary,
    });
  }

  /* =====================================================================
     PHẦN 4 — KHUNG XƯƠNG VÀ HUY HIỆU META
     ===================================================================== */

  function skeletonRow(colspan) {
    var tr = el("tr", "is-loading-row");
    tr.setAttribute("aria-hidden", "true");
    var td = el("td");
    var box = el("div", "skeleton-stack");
    box.appendChild(el("div", "skeleton skeleton-line"));
    box.appendChild(el("div", "skeleton skeleton-line"));
    td.colSpan = colspan;
    td.appendChild(box);
    tr.appendChild(td);
    return tr;
  }

  function showSkeletons() {
    var verified = $("tb-verified");
    var watching = $("tb-watching");
    var inbox = $("inbox");

    if (verified) {
      clear(verified);
      verified.setAttribute("aria-busy", "true");
      verified.appendChild(skeletonRow(2));
    }
    if (watching) {
      clear(watching);
      watching.setAttribute("aria-busy", "true");
      watching.appendChild(skeletonRow(5));
    }
    if (inbox) {
      clear(inbox);
      var box = el("div", "skeleton-stack");
      box.setAttribute("aria-hidden", "true");
      for (var i = 0; i < 3; i++) box.appendChild(el("div", "skeleton skeleton-line"));
      inbox.appendChild(box);
    }
  }

  /** Gỡ tín hiệu đang tải sau khi dữ liệu (hoặc lỗi) về. */
  function clearBusyRows() {
    var verified = $("tb-verified");
    if (verified) verified.removeAttribute("aria-busy");
    var watching = $("tb-watching");
    if (watching) watching.removeAttribute("aria-busy");
  }

  /**
   * Khối báo lỗi trong ô bảng, kèm tiêu đề và cách khắc phục.
   *
   * Trước đây chỉ có một câu chữ trần "Không tải được danh sách." — người dùng
   * biết là lỗi nhưng không biết làm gì tiếp; trạng thái rỗng/lỗi theo quy ước
   * của dự án phải luôn có hướng dẫn và một hành động.
   */
  function emptyStateBox(title, detail, actionText, actionHref) {
    var box = el("div", "empty-state is-compact");
    var mark = el("span", "empty-state-mark");
    mark.setAttribute("aria-hidden", "true");
    var svg = svgNode("svg", { class: "icon", "aria-hidden": "true", focusable: "false" });
    var use = svgNode("use", { href: "/img/sprite.svg#icon-alert" });
    svg.appendChild(use);
    mark.appendChild(svg);
    box.appendChild(mark);
    box.appendChild(el("h3", null, title));
    box.appendChild(el("p", null, detail));
    if (actionText) {
      var link = el("a", "btn btn-sm", actionText);
      link.setAttribute("href", actionHref || "#watch-input");
      box.appendChild(link);
    }
    return box;
  }

  function fillTableBody(tbody, colspan, node) {
    clear(tbody);
    var tr = el("tr");
    var td = el("td", "empty");
    td.colSpan = colspan;
    td.appendChild(node);
    tr.appendChild(td);
    tbody.appendChild(tr);
    tbody.removeAttribute("aria-busy");
  }

  function showLoadFailureRows() {
    var verified = $("tb-verified");
    var watching = $("tb-watching");
    var inbox = $("inbox");

    if (verified) {
      fillTableBody(
        verified,
        2,
        emptyStateBox(
          "Không tải được danh sách",
          "Kết nối tới máy chủ bị gián đoạn. Thử tải lại sau ít giây.",
          "Thử lại",
          "#watch-input",
        ),
      );
    }
    if (watching) {
      fillTableBody(
        watching,
        5,
        emptyStateBox(
          "Không tải được danh sách",
          "Kết nối tới máy chủ bị gián đoạn. Thử tải lại sau ít giây.",
          "Thử lại",
          "#watch-input",
        ),
      );
    }
    if (inbox) {
      clear(inbox);
      inbox.appendChild(el("div", "inbox-empty", "Không tải được thông báo."));
    }
  }

  function svgNode(tag, attributes) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    var name;
    for (name in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, name)) {
        node.setAttribute(name, String(attributes[name]));
      }
    }
    return node;
  }

  function createMetaVerifiedBadge() {
    var svg = svgNode("svg", {
      width: "18",
      height: "18",
      viewBox: "0 0 18 18",
      fill: "none",
      role: "img",
      "aria-label": "Đã xác minh bởi Meta",
      focusable: "false",
    });
    var circle = svgNode("circle", {
      cx: "9",
      cy: "9",
      r: "9",
      fill: "#1877F2",
    });
    var tick = svgNode("path", {
      d: "M4.7 9.2 7.5 12 13.3 6.2",
      fill: "none",
      stroke: "#FFFFFF",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });

    svg.style.flex = "0 0 auto";
    svg.appendChild(circle);
    svg.appendChild(tick);
    return svg;
  }

  /* =====================================================================
     PHẦN 5 — RENDER HAI BẢNG
     ===================================================================== */

  function statusText(status) {
    if (status === "watching") return "Đang theo dõi";
    if (status === "not_found") return "Không tìm thấy";
    if (status === "verified") return "Đã xác minh";
    return "Chưa xác định";
  }

  function renderVerified(rows) {
    var body = $("tb-verified");
    if (!body) return;

    if (!rows.length) {
      fillTableBody(
        body,
        2,
        emptyStateBox(
          "Chưa có tài khoản nào lên tích xanh",
          "Kết quả sẽ xuất hiện sau khi Meta hiển thị huy hiệu trên hồ sơ công khai của UID.",
          "Thêm UID để theo dõi",
          "#watch-input",
        ),
      );
      return;
    }

    clear(body);
    body.removeAttribute("aria-busy");

    rows.forEach(function (row) {
      var tr = el("tr");
      var profileCell = el("td");
      var profile = el("div", "row");
      var uid = String(row.uid === undefined || row.uid === null ? "" : row.uid);
      var label = uid + " - " + displayName(row.name);

      profile.style.alignItems = "center";
      profile.style.gap = "9px";
      if (row.status === "verified") {
        profile.appendChild(createMetaVerifiedBadge());
      }
      profile.appendChild(el("span", "bx-name", label));
      profileCell.appendChild(profile);

      tr.appendChild(profileCell);
      tr.appendChild(el("td", "bx-meta", formatWatchMinutes(row.watch_minutes)));
      body.appendChild(tr);
    });
  }

  function renderWatching(rows) {
    var body = $("tb-watching");
    if (!body) return;

    if (!rows.length) {
      fillTableBody(
        body,
        5,
        emptyStateBox(
          "Danh sách theo dõi đang trống",
          "Dán UID ở ô phía trên để bắt đầu kiểm tra tự động. Bạn có thể thêm nhiều UID cùng lúc.",
          "Mở ô thêm UID",
          "#watch-input",
        ),
      );
      return;
    }

    clear(body);
    body.removeAttribute("aria-busy");

    rows.forEach(function (row) {
      var tr = el("tr");
      var uid = String(row.uid === undefined || row.uid === null ? "" : row.uid);
      var status = typeof row.status === "string" ? row.status : "unknown";
      var nameCell = el("td");
      var statusLine = el("span", "hint", statusText(status));
      var deleteButton = el("button", "btn btn-sm", "Xóa");

      tr.appendChild(el("td", "bx-uid", uid));

      nameCell.appendChild(el("span", "bx-name", displayName(row.name)));
      statusLine.style.display = "block";
      nameCell.appendChild(statusLine);
      if (status === "unknown" && typeof row.last_error === "string" && row.last_error) {
        nameCell.appendChild(el("span", "bx-meta", row.last_error));
      }
      tr.appendChild(nameCell);
      tr.appendChild(el("td", "bx-meta", numberText(row.checks_count)));
      tr.appendChild(el("td", "bx-meta", formatWatchMinutes(row.watch_minutes)));

      deleteButton.type = "button";
      deleteButton.setAttribute("aria-label", "Xóa UID " + uid + " khỏi danh sách theo dõi");
      deleteButton.addEventListener("click", function () {
        deleteWatch(uid, deleteButton);
      });
      tr.appendChild(el("td", null, "")).appendChild(deleteButton);
      body.appendChild(tr);
    });
  }

  /* =====================================================================
     PHẦN 6 — HỘP THƯ VÀ BADGE THÔNG BÁO
     ===================================================================== */

  function renderBadge() {
    var badge = $("bell-badge");
    if (!badge) return;

    var count = Math.max(0, Math.floor(state.unread));
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.setAttribute("data-count", String(count));
    badge.setAttribute("aria-label", count + " thông báo chưa đọc");
    badge.hidden = count === 0;
  }

  function renderInbox(rows) {
    var inbox = $("inbox");
    if (!inbox) return;
    clear(inbox);

    if (!rows.length) {
      inbox.appendChild(el("div", "inbox-empty", "Chưa có thông báo nào."));
      return;
    }

    var hasUnread = false;
    rows.forEach(function (row) {
      var item = el("div", "inbox-item");
      var actions = el("div", "inbox-actions");
      var markButton;

      if (row.read === true) item.classList.add("is-read");
      else hasUnread = true;

      item.appendChild(el("div", "inbox-title", row.title || "Thông báo"));
      item.appendChild(el("div", "inbox-body", row.body || "Không có nội dung."));
      item.appendChild(el("div", "bx-meta", relativeTime(row.created_at)));
      inbox.appendChild(item);

      if (row.read !== true && finiteNumber(row.id) !== null) {
        markButton = el("button", "btn btn-sm", "Đánh dấu đã đọc");
        markButton.type = "button";
        markButton.setAttribute("data-mark-read", "1");
        markButton.setAttribute("aria-label", "Đánh dấu thông báo đã đọc");
        markButton.addEventListener("click", function () {
          markNotificationsRead([finiteNumber(row.id)], null);
        });
        actions.appendChild(markButton);
      }
    });

    if (hasUnread) {
      var markAll = el("button", "btn btn-sm", "Đánh dấu đã đọc");
      markAll.type = "button";
      markAll.setAttribute("data-mark-read", "all");
      markAll.addEventListener("click", function () {
        markNotificationsRead(null, null);
      });
      actions.appendChild(markAll);
      inbox.appendChild(actions);
    }
  }

  function setInboxOpen(open) {
    var inbox = $("inbox");
    var closeButton = $("inbox-close-btn");
    var bell = $("bell-btn");

    if (inbox) inbox.hidden = !open;
    if (closeButton) closeButton.hidden = !open;
    if (bell) {
      bell.setAttribute("aria-expanded", open ? "true" : "false");
      bell.setAttribute("aria-label", open ? "Đóng thông báo" : "Mở thông báo");
    }
  }

  /* =====================================================================
     PHẦN 7 — TẢI DỮ LIỆU VÀ CHỈ RENDER KHI THAY ĐỔI
     ===================================================================== */

  function renderAll(data) {
    var nextWatching = rowsFrom(data.watching);
    var nextVerified = rowsFrom(data.verified);
    var nextOther = rowsFrom(data.other);
    var nextNotifications = rowsFrom(data.notifications);
    var suppliedUnread = finiteNumber(data.unread);
    var nextUnread =
      suppliedUnread === null
        ? nextNotifications.filter(function (row) {
            return row.read !== true;
          }).length
        : Math.max(0, Math.floor(suppliedUnread));
    var nextServerTime = finiteNumber(data.server_time);
    var nextSummary = isObject(data.summary) ? data.summary : {};
    var nextSignature;

    state.loaded = true;
    state.watching = nextWatching;
    state.verified = nextVerified;
    state.other = nextOther;
    state.notifications = nextNotifications;
    state.unread = nextUnread;
    state.summary = nextSummary;
    state.serverTime =
      nextServerTime === null ? Math.floor(Date.now() / 1000) : nextServerTime;

    nextSignature = buildSignature();
    if (state.signature === nextSignature) return false;

    renderVerified(state.verified);
    renderWatching(state.watching.concat(state.other));
    renderInbox(state.notifications);
    renderBadge();
    state.signature = nextSignature;
    return true;
  }

  function loadAll() {
    if (state.loading) {
      state.reloadQueued = true;
      return state.loadPromise;
    }

    if (!state.loaded) showSkeletons();
    state.loading = true;

    state.loadPromise = apiFetch("/api/tickxanh", { method: "GET" })
      .then(function (response) {
        if (handleUnauthorized(response)) return false;
        if (!response || !response.ok || !isObject(response.data) || response.data.ok !== true) {
          throw new Error(
            apiErrorMessage(response && response.data, "Không tải được danh sách theo dõi."),
          );
        }
        return renderAll(response.data);
      })
      .catch(function (error) {
        if (!state.loaded) showLoadFailureRows();
        showError(error && error.message ? error.message : "Không tải được danh sách theo dõi.");
        return false;
      })
      .then(function (changed) {
        state.loading = false;
        state.loadPromise = null;
        // Dữ liệu đã về (dù lỗi hay thành công) thì không còn "đang tải" nữa.
        clearBusyRows();

        if (state.reloadQueued) {
          state.reloadQueued = false;
          if (!document.hidden) return loadAll();
        }
        return changed;
      });

    return state.loadPromise;
  }

  /* =====================================================================
     PHẦN 8 — THÊM, XÓA VÀ ĐÁNH DẤU ĐÃ ĐỌC
     ===================================================================== */

  function parseUids(text) {
    var lines = String(text || "").split(/[\r\n,;\t]+/);
    var seen = Object.create(null);
    var uids = [];
    var invalid = 0;
    var duplicates = 0;

    lines.forEach(function (line) {
      var uid = line.trim();
      if (!uid) return;
      if (!/^[0-9]+$/.test(uid)) {
        invalid += 1;
        return;
      }
      if (seen[uid]) {
        duplicates += 1;
        return;
      }
      seen[uid] = true;
      uids.push(uid);
    });

    return { uids: uids, invalid: invalid, duplicates: duplicates };
  }

  function refreshWatchCount() {
    var input = $("watch-input");
    var count = $("watch-count");
    if (!input || !count) return;

    var parsed = parseUids(input.value);
    if (parsed.uids.length === 0 && parsed.invalid === 0) {
      count.textContent = "Chưa có UID nào.";
      return;
    }

    var parts = [parsed.uids.length + " UID hợp lệ"];
    if (parsed.invalid > 0) parts.push(parsed.invalid + " mục không hợp lệ");
    if (parsed.duplicates > 0) parts.push(parsed.duplicates + " UID trùng");
    count.textContent = parts.join(" · ");
  }

  function setAddBusy(busy) {
    var button = $("watch-add-btn");
    var input = $("watch-input");
    if (button) {
      button.disabled = busy;
      button.textContent = busy ? "Đang thêm…" : "Bắt đầu theo dõi";
    }
    if (input) input.readOnly = busy;
  }

  function addWatches() {
    var input = $("watch-input");
    if (!input) return;

    var parsed = parseUids(input.value);
    if (parsed.uids.length === 0) {
      if (!String(input.value || "").trim()) {
        showError("Danh sách rỗng. Dán ít nhất một UID hợp lệ.");
      } else {
        showError("Danh sách không có UID hợp lệ. Mỗi dòng cần chỉ chứa chữ số.");
      }
      return;
    }

    clearAlerts();
    setAddBusy(true);

    apiFetch("/api/tickxanh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uids: parsed.uids }),
    })
      .then(function (response) {
        if (!requireOk(response, "Không thể thêm UID vào danh sách theo dõi.")) return null;

        var added = Array.isArray(response.data.added) ? response.data.added.length : parsed.uids.length;
        var ignored = [];
        if (parsed.invalid > 0) ignored.push(parsed.invalid + " mục không hợp lệ");
        if (parsed.duplicates > 0) ignored.push(parsed.duplicates + " UID trùng");

        input.value = "";
        refreshWatchCount();
        showSuccess(
          "Đã bắt đầu theo dõi " + added + " UID." +
            (ignored.length ? " Đã bỏ qua " + ignored.join(" và ") + "." : ""),
        );
        return loadAll();
      })
      .catch(function (error) {
        showError(error && error.message ? error.message : "Không thể thêm UID vào danh sách theo dõi.");
      })
      .then(function () {
        setAddBusy(false);
      });
  }

  function deleteWatch(uid, button) {
    var cleanUid = String(uid || "").trim();
    if (!cleanUid) return;

    // Hộp thoại xác nhận dùng chung (public/js/confirm.js) thay cho
    // window.confirm; vẫn lùi về window.confirm nếu script đó không tải được.
    askConfirm({
      title: "Xoá UID khỏi danh sách theo dõi?",
      message: "UID " + cleanUid + " sẽ không còn được kiểm tra tự động.",
      confirmLabel: "Xoá UID",
    }).then(function (confirmed) {
      if (confirmed) performDeleteWatch(cleanUid, button);
    });
  }

  function askConfirm(options) {
    if (window.ShopConfirm && typeof window.ShopConfirm.ask === "function") {
      return window.ShopConfirm.ask(options);
    }
    return Promise.resolve(window.confirm(options.title + "\n\n" + options.message));
  }

  function performDeleteWatch(cleanUid, button) {
    clearAlerts();
    if (button) button.disabled = true;

    apiFetch("/api/tickxanh/" + encodeURIComponent(cleanUid), { method: "DELETE" })
      .then(function (response) {
        if (!requireOk(response, "Không thể xóa UID khỏi danh sách theo dõi.")) return null;
        showSuccess("Đã xóa UID " + cleanUid + " khỏi danh sách theo dõi.");
        return loadAll();
      })
      .catch(function (error) {
        showError(error && error.message ? error.message : "Không thể xóa UID khỏi danh sách theo dõi.");
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  function markNotificationsRead(ids, trigger) {
    var buttons = document.querySelectorAll("[data-mark-read]");
    var hasUnread = state.notifications.some(function (row) {
      return row.read !== true;
    });
    if (!hasUnread) return;

    clearAlerts();
    buttons.forEach(function (button) {
      button.disabled = true;
    });
    if (trigger) trigger.disabled = true;

    var body = ids ? { ids: ids } : {};
    apiFetch("/api/tickxanh/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (response) {
        if (!requireOk(response, "Không thể cập nhật thông báo.")) return null;
        showSuccess(ids ? "Đã đánh dấu thông báo là đã đọc." : "Đã đánh dấu tất cả thông báo là đã đọc.");
        return loadAll();
      })
      .catch(function (error) {
        showError(error && error.message ? error.message : "Không thể cập nhật thông báo.");
      })
      .then(function () {
        buttons.forEach(function (button) {
          button.disabled = false;
        });
        if (trigger) trigger.disabled = false;
      });
  }

  /* =====================================================================
     PHẦN 9 — ĐĂNG XUẤT VÀ MENU MỘT MÀN HÌNH
     ===================================================================== */

  function setLogoutBusy(busy) {
    var button = $("logout-btn");
    if (!button) return;
    button.disabled = busy;
    // Chỉ đổi NHÃN, không gán textContent lên cả nút: nút có kèm biểu tượng
    // sprite, gán textContent sẽ xoá luôn biểu tượng.
    var label = button.querySelector("[data-logout-label]");
    if (label) {
      label.textContent = busy ? "Đang thoát…" : "Đăng xuất";
    }
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function logout() {
    clearAlerts();
    setLogoutBusy(true);

    apiFetch("/api/logout", { method: "POST" })
      .then(function (response) {
        if (handleUnauthorized(response)) return;
        if (!response || !response.ok) {
          throw new Error(apiErrorMessage(response && response.data, "Không thể đăng xuất."));
        }
        window.location.href = "/login.html";
      })
      .catch(function (error) {
        setLogoutBusy(false);
        showError(error && error.message ? error.message : "Không thể đăng xuất.");
      });
  }

  /*
     Menu một màn hình nay do /js/nav.js lo dùng chung cho cả sáu trang
     (<details class="nav-shell">). tickxanh.js KHÔNG tự xử lý nút menu nữa:
     nếu vừa để <details> tự mở/đóng vừa gắn thêm một handler đổi `hidden`,
     hai cơ chế sẽ triệt tiêu nhau và menu không mở được.
  */

  /* =====================================================================
     PHẦN 10 — KHỞI TẠO
     ===================================================================== */

  var autoRefreshId = null;

  function startAutoRefresh() {
    if (autoRefreshId !== null || document.hidden) return;
    autoRefreshId = window.setInterval(loadAll, 30000);
  }

  function stopAutoRefresh() {
    if (autoRefreshId === null) return;
    window.clearInterval(autoRefreshId);
    autoRefreshId = null;
  }

  function init() {
    var input = $("watch-input");
    var addButton = $("watch-add-btn");
    var bell = $("bell-btn");
    var closeInbox = $("inbox-close-btn");
    var logoutButton = $("logout-btn");

    if (input) {
      input.addEventListener("input", refreshWatchCount);
      input.addEventListener("keydown", function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          addWatches();
        }
      });
    }
    if (addButton) addButton.addEventListener("click", addWatches);

    if (bell) {
      bell.addEventListener("click", function () {
        setInboxOpen($("inbox") ? $("inbox").hidden : false);
      });
    }
    if (closeInbox) {
      closeInbox.addEventListener("click", function () {
        setInboxOpen(false);
        if (bell) bell.focus();
      });
    }
    if (logoutButton) logoutButton.addEventListener("click", logout);

    refreshWatchCount();
    setInboxOpen(false);
    loadAll();

    startAutoRefresh();

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopAutoRefresh();
        return;
      }
      startAutoRefresh();
      loadAll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/**
 * test/ui-states.mjs — kiểm tra TRẠNG THÁI giao diện bằng trình duyệt THẬT.
 *
 * Vì sao cần: một trang chỉ "trông đẹp" ở đường hạnh phúc thì chưa đủ. Bài này
 * đo bảy nhóm trạng thái mà người dùng thật sẽ gặp, KHÔNG suy đoán từ mã nguồn:
 *
 *   1. Đang tải  — #preloader có mặt lúc mới tải; vùng danh sách/bảng có
 *                  aria-busy="true" hoặc .skeleton để giữ chỗ.
 *   2. Lỗi       — máy chủ trả 503: thông báo lỗi phải HIỆN trong vùng live
 *                  (role="alert"/role="status") và phải là câu tiếng Việt thật.
 *   3. Rỗng      — trang có .empty-state/.empty; khối đang hiện phải có tiêu đề
 *                  và câu giải thích hoặc hành động.
 *   4. Khoá      — điều khiển không dùng được phải disabled THẬT và kiểu hiển
 *                  thị khi khoá phải khác khi bật (opacity/cursor/pointer-events).
 *   5. Xác nhận  — hộp thoại phá huỷ của confirm.js: <dialog> thật do showModal
 *                  mở, focus nằm trong hộp thoại, Escape/nút Huỷ trả false, nút
 *                  xác nhận trả true, và focus quay về nút gọi trước đó.
 *   6. Không có lỗi console hay exception nào trên bất kỳ trang nào.
 *   7. Phản hồi  — nút chính đổi kiểu khi rê chuột (Input.dispatchMouseEvent)
 *                  và khi được focus bằng Tab.
 *
 * Cách đo (không thêm phụ thuộc nào):
 *   - CDP `Fetch` GIỮ các request /api/* lại → trạng thái "đang tải" quan sát
 *     được một cách xác định, không phụ thuộc may rủi vài mili-giây.
 *   - CDP `Fetch.fulfillRequest` trả 503 kèm trang lỗi HTML (giống trang lỗi do
 *     Cloudflare sinh ra ở biên) → trạng thái lỗi thật, đúng hợp đồng lỗi của
 *     Worker (src/lib/response.ts: lỗi luôn kèm mã HTTP lỗi).
 *   - Mọi thao tác chuột/bàn phím đều đi qua `Input.dispatchMouseEvent` và
 *     `Input.dispatchKeyEvent`; không gọi hàm nội bộ của trang.
 *
 * LƯU Ý VỀ MÔI TRƯỜNG XEM TRƯỚC (test/ui-preview.mjs):
 *   Mọi /api/* trả HTTP 200 kèm { ok:false, error:{ code, message } } — tức "lỗi"
 *   ở tầng nghiệp vụ, không phải mã HTTP. Worker thật không bao giờ trả 200 cho
 *   lỗi, nên đây là chuyện riêng của bản xem trước: phản ứng với phong bì
 *   ok:false chỉ được GHI NHẬN, không tính là lỗi. Trạng thái lỗi được đo bằng
 *   503 thật ở trên.
 *
 *   node test/ui-preview.mjs --port 8899      (cửa sổ 1)
 *   node test/ui-states.mjs --base http://127.0.0.1:8899
 *
 * Thoát 1 khi có bất kỳ mục nào không đạt; 0 khi tất cả đều đạt.
 */
import { launchBrowser } from "./cdp.mjs";

/* =====================================================================
   THAM SỐ DÒNG LỆNH
   ===================================================================== */

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:8899", pages: Object.keys(CONFIG) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--pages") out.pages = String(argv[++i]).split(",");
  }
  return out;
}

/* =====================================================================
   CẤU HÌNH TỪNG TRANG

   regions     — vùng danh sách/bảng do JavaScript đổ dữ liệu vào
   errorSel    — vùng live nhận thông báo lỗi của trang
   disabledSel — điều khiển bị khoá khi đang bận (đo lúc bận và lúc xong)
   interact    — thao tác thật cần làm để trang gọi API (uid/login)
   confirmFocus— nút dùng làm mốc focus cho bài kiểm tra hộp thoại xác nhận
   ===================================================================== */

const CONFIG = {
  index: {
    regions: ["#products-body", "#methods-body", "#status-body", "#sync-history-body"],
    errorSel: "#dash-error",
    disabledSel: "#sync-refresh",
    feedbackSels: ["#sync-refresh", "#logout-btn"],
    interact: "",
    confirmFocus: "",
  },
  logs: {
    regions: ["#audit-list", "#sync-body"],
    errorSel: "#logs-msg",
    disabledSel: "#log-apply",
    feedbackSels: ["#log-apply", "#log-today"],
    interact: "",
    confirmFocus: "",
  },
  images: {
    regions: ["#image-grid"],
    errorSel: "#images-msg",
    disabledSel: "#images-refresh",
    feedbackSels: ["#images-refresh"],
    interact: "",
    confirmFocus: "#images-refresh",
  },
  uid: {
    regions: ["#uid-live-list", "#uid-die-list", "#uid-unknown-list"],
    errorSel: "#uid-msg",
    disabledSel: "#uid-check-btn",
    feedbackSels: ["#uid-check-btn"],
    interact: "uid",
    confirmFocus: "",
  },
  tickxanh: {
    regions: ["#tb-verified", "#tb-watching"],
    errorSel: "#bx-msg",
    disabledSel: "#logout-btn",
    feedbackSels: ["#watch-add-btn"],
    interact: "logout",
    confirmFocus: "#bell-btn",
  },
  login: {
    regions: [],
    errorSel: "#login-msg",
    disabledSel: "#submit-btn",
    feedbackSels: ["#submit-btn"],
    interact: "login",
    confirmFocus: "",
  },
};

/* Trang không có vùng danh sách/bảng nào do máy chủ đổ vào. */
const NO_LIST_PAGES = new Set(["login"]);

/* =====================================================================
   KHUNG BÁO CÁO
   ===================================================================== */

const CHECK_ORDER = ["1a", "1b", "2a", "2b", "3a", "3b", "3c", "4", "5", "6", "7"];
const CHECK_TITLE = {
  "1a": "màn hình chờ #preloader có mặt lúc mới tải",
  "1b": "vùng danh sách/bảng có aria-busy=\"true\" hoặc .skeleton khi đang tải",
  "2a": "API lỗi 503 → thông báo lỗi HIỆN trong vùng live",
  "2b": "thông báo lỗi là câu tiếng Việt thật",
  "3a": "trang có khối rỗng (.empty-state / .empty)",
  "3b": "không có dữ liệu → khối rỗng đang HIỆN",
  "3c": "khối rỗng đang hiện có tiêu đề + câu giải thích/hành động",
  "4": "điều khiển bận bị disabled THẬT và khác kiểu khi bật",
  "5": "hộp thoại xác nhận phá huỷ (dialog + focus + Escape/Huỷ/Xác nhận)",
  "6": "không có lỗi console hay exception",
  "7": "nút chính đổi kiểu khi rê chuột và khi focus",
};

const results = [];
const notes = [];
let passCount = 0;
let failCount = 0;
let currentPage = "";

function check(id, title, ok, detail) {
  const rec = { page: currentPage, id, title, pass: !!ok, detail: detail || "" };
  results.push(rec);
  if (rec.pass) {
    passCount++;
    console.log(`  \u2713 ${id}  ${title}${detail ? ` — ${detail}` : ""}`);
  } else {
    failCount++;
    console.log(`  \u2717 ${id}  ${title}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(id, title, why) {
  results.push({ page: currentPage, id, title, skip: true, detail: why });
  console.log(`  \u2013 ${id}  ${title} — BỎ QUA: ${why}`);
}

function note(label, detail) {
  notes.push({ page: currentPage, label, detail });
  console.log(`  \u2022 ${label}: ${detail}`);
}

function section(text) {
  console.log(`\n  ${text}`);
}

/* =====================================================================
   TIỆN ÍCH DÙNG CHUNG
   ===================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Câu tiếng Việt thật: có dấu, đủ dài, không phải mã lỗi trần/giá trị rác. */
const VIET = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
function looksVietnamese(text) {
  const t = String(text || "").trim();
  if (t.length < 12) return false;
  if (/^(undefined|null|\[object Object\]|NaN)$/i.test(t)) return false;
  if (/^\(?\s*HTTP\s*\d+\s*\)?\.?$/i.test(t)) return false;
  return VIET.test(t);
}

/** Đoạn HTML giống trang lỗi do Cloudflare sinh ở biên (không phải JSON). */
const FAIL_503_BODY =
  "<html><head><title>503 Service Temporarily Unavailable</title></head>" +
  "<body><h1>503 Service Temporarily Unavailable</h1>" +
  "<p>cloudflare</p></body></html>";

/* Lỗi console do chính bài kiểm tra gây ra (favicon, 503 giả lập) — bỏ qua. */
function consoleNoise(text) {
  const t = String(text || "");
  if (/favicon\.ico/i.test(t)) return true;
  if (/status of 503/i.test(t)) return true;
  if (/net::ERR_(FAILED|ABORTED)/i.test(t)) return true;
  return false;
}

/* =====================================================================
   BIỂU THỨC CHẠY TRONG TRANG
   ===================================================================== */

/** Hàm chọn tên ngắn cho phần tử — dùng chung cho mọi phép đo. */
const SEL_HELPER = String.raw`
function selOf(node) {
  if (!node || !node.tagName) return "";
  var s = node.tagName.toLowerCase();
  if (node.id) return s + "#" + node.id;
  if (typeof node.className === "string" && node.className.trim()) {
    s += "." + node.className.trim().split(/\s+/).slice(0, 2).join(".");
  }
  return s;
}
function visibleOf(node) {
  if (!node) return false;
  var cs = getComputedStyle(node);
  var r = node.getBoundingClientRect();
  return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 && r.width > 0 && r.height > 0;
}
`;

/** Đo trạng thái ĐANG TẢI (request /api/* đang bị giữ). */
const probeLoading = (regions) => String.raw`
${SEL_HELPER}
var out = { preloader: null, skeletons: 0, skeletonVisible: 0, busyTrue: [], regions: [], liveLoading: [] };

var pre = document.getElementById("preloader");
if (pre) {
  var pcs = getComputedStyle(pre);
  var pr = pre.getBoundingClientRect();
  out.preloader = {
    display: pcs.display, visibility: pcs.visibility, opacity: pcs.opacity,
    w: Math.round(pr.width), h: Math.round(pr.height),
    visible: pcs.display !== "none" && pcs.visibility !== "hidden" && Number(pcs.opacity) > 0.05 && pr.height > 20
  };
}

var sk = document.querySelectorAll(".skeleton");
out.skeletons = sk.length;
for (var i = 0; i < sk.length; i++) {
  if (visibleOf(sk[i])) out.skeletonVisible++;
}

var busy = document.querySelectorAll("[aria-busy]");
for (var i = 0; i < busy.length; i++) {
  if (busy[i].getAttribute("aria-busy") === "true") out.busyTrue.push(selOf(busy[i]));
}

var list = ${JSON.stringify(regions)};
for (var i = 0; i < list.length; i++) {
  var node = document.querySelector(list[i]);
  if (!node) { out.regions.push({ sel: list[i], exists: false }); continue; }
  var r = node.getBoundingClientRect();
  var text = (node.textContent || "").replace(/\s+/g, " ").trim();
  var busyAncestor = node.closest('[aria-busy="true"]');
  out.regions.push({
    sel: list[i], exists: true, h: Math.round(r.height),
    text: text.slice(0, 60),
    ariaBusy: node.getAttribute("aria-busy"),
    busySelf: node.getAttribute("aria-busy") === "true",
    busyAncestor: busyAncestor ? selOf(busyAncestor) : "",
    skeletons: node.querySelectorAll(".skeleton").length,
    placeholder: text.length > 0
  });
}

var lives = document.querySelectorAll('[role="status"],[role="alert"],[aria-live]');
for (var i = 0; i < lives.length; i++) {
  if (!visibleOf(lives[i])) continue;
  var t = (lives[i].textContent || "").replace(/\s+/g, " ").trim();
  if (!t) continue;
  out.liveLoading.push({ sel: selOf(lives[i]), role: lives[i].getAttribute("role") || "", text: t.slice(0, 90) });
}
return out;
`;

/** Đo trạng thái LỖI: vùng lỗi của trang + mọi vùng live đang hiện có chữ. */
const probeError = (errorSel) => String.raw`
${SEL_HELPER}
var out = { target: null, liveRegions: [] };
var node = document.querySelector(${JSON.stringify(errorSel)});
if (node) {
  var cs = getComputedStyle(node);
  var r = node.getBoundingClientRect();
  out.target = {
    sel: ${JSON.stringify(errorSel)},
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute("role") || "",
    ariaLive: node.getAttribute("aria-live") || "",
    text: (node.textContent || "").trim(),
    visible: visibleOf(node),
    hiddenClass: node.classList.contains("hidden"),
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    w: Math.round(r.width), h: Math.round(r.height)
  };
}
var lives = document.querySelectorAll('[role="alert"],[role="status"],[aria-live]');
for (var i = 0; i < lives.length; i++) {
  if (!visibleOf(lives[i])) continue;
  var t = (lives[i].textContent || "").replace(/\s+/g, " ").trim();
  if (!t) continue;
  out.liveRegions.push({ sel: selOf(lives[i]), role: lives[i].getAttribute("role") || "", text: t.slice(0, 140) });
}
return out;
`;

/** Đo trạng thái RỖNG sau khi tải xong. */
const probeSettled = (regions) => String.raw`
${SEL_HELPER}
var out = { empties: [], regions: [] };
var nodes = document.querySelectorAll(".empty-state, .empty");
for (var i = 0; i < nodes.length; i++) {
  var el = nodes[i];
  var item = {
    sel: selOf(el), tag: el.tagName.toLowerCase(),
    cls: typeof el.className === "string" ? el.className : "",
    visible: visibleOf(el),
    hiddenAttr: el.hasAttribute("hidden"),
    hiddenClass: el.classList.contains("hidden"),
    heading: "", sentences: [], actions: 0,
    text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140)
  };
  var h = el.querySelector("h1,h2,h3,h4,strong");
  if (h) item.heading = (h.textContent || "").trim().slice(0, 80);
  var ps = el.querySelectorAll("p,span,small,li");
  for (var j = 0; j < ps.length; j++) {
    var hasText = false;
    for (var k = 0; k < ps[j].childNodes.length; k++) {
      var child = ps[j].childNodes[k];
      if (child.nodeType === 3 && child.textContent.trim()) hasText = true;
    }
    if (!hasText) continue;
    var s = (ps[j].textContent || "").replace(/\s+/g, " ").trim();
    if (s) item.sentences.push(s.slice(0, 110));
  }
  item.actions = el.querySelectorAll("a[href], button").length;
  out.empties.push(item);
}
var list = ${JSON.stringify(regions)};
for (var i = 0; i < list.length; i++) {
  var node = document.querySelector(list[i]);
  out.regions.push(node
    ? {
        sel: list[i], exists: true,
        text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
        rows: node.children.length,
        ariaBusy: node.getAttribute("aria-busy"),
        skeletons: node.querySelectorAll(".skeleton").length
      }
    : { sel: list[i], exists: false });
}
return out;
`;

/** Đo một điều khiển: trạng thái disabled + kiểu hiển thị. */
const measureControl = (sel) => String.raw`
var node = document.querySelector(${JSON.stringify(sel)});
if (!node) return { exists: false, sel: ${JSON.stringify(sel)} };
var cs = getComputedStyle(node);
var r = node.getBoundingClientRect();
return {
  exists: true, sel: ${JSON.stringify(sel)}, tag: node.tagName.toLowerCase(),
  disabled: node.disabled === true,
  ariaDisabled: node.getAttribute("aria-disabled") || "",
  ariaBusy: node.getAttribute("aria-busy") || "",
  opacity: cs.opacity, cursor: cs.cursor, pointerEvents: cs.pointerEvents,
  background: cs.backgroundColor, color: cs.color,
  text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
  w: Math.round(r.width), h: Math.round(r.height)
};
`;

/** Chọn nút phản hồi đầu tiên dùng được (đang hiện, không khoá, bấm tới được). */
const pickFeedback = (sels) => String.raw`
${SEL_HELPER}
var list = ${JSON.stringify(sels)};
for (var i = 0; i < list.length; i++) {
  var el = document.querySelector(list[i]);
  if (!el) continue;
  if (el.disabled) continue;
  var cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.2) continue;
  el.scrollIntoView({ block: "center", inline: "center" });
  var r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) continue;
  var x = Math.round(r.left + r.width / 2);
  var y = Math.round(r.top + r.height / 2);
  if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
  var hit = document.elementFromPoint(x, y);
  if (hit !== el && !el.contains(hit)) continue;
  var st = getComputedStyle(el);
  return {
    sel: list[i], cx: x, cy: y, w: Math.round(r.width), h: Math.round(r.height),
    cls: typeof el.className === "string" ? el.className : "",
    style: styleOf(el)
  };
}
return null;
`;

const STYLE_HELPER = String.raw`
function styleOf(el) {
  var cs = getComputedStyle(el);
  return {
    background: cs.backgroundColor, color: cs.color, borderColor: cs.borderColor,
    transform: cs.transform, boxShadow: cs.boxShadow,
    outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor
  };
}
`;

/** Đọc kiểu hiển thị hiện tại của một phần tử. */
const readStyle = (sel) => String.raw`
${STYLE_HELPER}
var el = document.querySelector(${JSON.stringify(sel)});
return el ? styleOf(el) : null;
`;

/** Vị trí bấm được của một phần tử (đã cuộn vào khung nhìn). */
const spotOf = (sel) => String.raw`
var el = document.querySelector(${JSON.stringify(sel)});
if (!el) return null;
el.scrollIntoView({ block: "center", inline: "center" });
var r = el.getBoundingClientRect();
if (r.width < 4 || r.height < 4) return null;
return {
  x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
  w: Math.round(r.width), h: Math.round(r.height),
  hit: (function () {
    var node = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return node === el || el.contains(node);
  })()
};
`;

/** Mở hộp thoại xác nhận qua API công khai và chụp lại trạng thái hộp thoại. */
const OPEN_CONFIRM = String.raw`
${SEL_HELPER}
window.__uiStateConfirm = {
  result: null,
  settled: false,
  returnFocusId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : ""
};
window.ShopConfirm.ask({
  title: "Xoá ảnh này?",
  message: "Ảnh sẽ bị xoá khỏi kho R2 và không khôi phục được.",
  confirmLabel: "Xoá ảnh"
}).then(function (value) {
  window.__uiStateConfirm.result = value;
  window.__uiStateConfirm.settled = true;
});
var dlg = document.getElementById("confirm-dialog");
if (!dlg) return { exists: false };
var cs = getComputedStyle(dlg);
var r = dlg.getBoundingClientRect();
var buttons = [];
var list = dlg.querySelectorAll("button");
for (var i = 0; i < list.length; i++) {
  var b = list[i];
  var br = b.getBoundingClientRect();
  buttons.push({
    id: b.id || "", cls: typeof b.className === "string" ? b.className : "",
    text: (b.textContent || "").trim(),
    x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2),
    w: Math.round(br.width), h: Math.round(br.height),
    focused: document.activeElement === b
  });
}
return {
  exists: true, tag: dlg.tagName.toLowerCase(),
  open: dlg.open === true, isModal: dlg.matches(":modal"),
  display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
  w: Math.round(r.width), h: Math.round(r.height),
  focusInside: dlg.contains(document.activeElement),
  activeId: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : "",
  buttons: buttons
};
`;

/** Đọc kết quả hộp thoại sau khi đã đóng. */
const READ_CONFIRM = String.raw`
var dlg = document.getElementById("confirm-dialog");
var state = window.__uiStateConfirm || {};
return {
  open: dlg ? dlg.open === true : false,
  result: state.result === undefined ? null : state.result,
  settled: state.settled === true,
  returnFocusId: state.returnFocusId || "",
  activeId: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : "",
  focusInside: dlg ? dlg.contains(document.activeElement) : false
};
`;

/* =====================================================================
   KHỞI ĐỘNG TRÌNH DUYỆT + GIẢ LẬP MÁY CHỦ LỖI BẰNG CDP
   ===================================================================== */

const opts = parseArgs(process.argv.slice(2));
const session = await launchBrowser();

/* Bật thêm miền Log và Console API để bắt lỗi console thật (cdp.mjs chỉ bật Console). */
await session.send("Log.enable").catch(() => {});
session.listeners.set("Runtime.consoleAPICalled", [
  (p) => {
    if (!p || p.type !== "error") return;
    const parts = (p.args || []).map((a) => (a && (a.value !== undefined ? a.value : a.description)) || "");
    session.consoleErrors.push({ type: "console-api", text: parts.join(" ") });
  },
]);

let apiMode = "pass"; // pass | hold | fail503
let paused = [];

async function fulfill503(requestId) {
  await session
    .send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 503,
      responsePhrase: "Service Temporarily Unavailable",
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(FAIL_503_BODY, "utf8").toString("base64"),
    })
    .catch(() => {});
}

session.listeners.set("Fetch.requestPaused", [
  (p) => {
    const url = (p && p.request && p.request.url) || "";
    if (!/\/api\//.test(url)) {
      void session.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
      return;
    }
    if (apiMode === "hold") {
      paused.push(p.requestId);
      return;
    }
    if (apiMode === "fail503") {
      void fulfill503(p.requestId);
      return;
    }
    void session.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
  },
]);
await session.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*" }] });

/** Thả các request đang bị giữ → máy chủ xem trước trả lời bình thường. */
async function releasePaused() {
  const ids = paused.splice(0);
  for (const id of ids) await session.send("Fetch.continueRequest", { requestId: id }).catch(() => {});
  return ids.length;
}

/** Kết thúc các request đang bị giữ bằng lỗi 503 (trang lỗi HTML, không phải JSON). */
async function failPaused() {
  const ids = paused.splice(0);
  for (const id of ids) await fulfill503(id);
  return ids.length;
}

/* =====================================================================
   THAO TÁC CHUỘT / BÀN PHÍM THẬT
   ===================================================================== */

async function mouseMove(x, y) {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
}

async function clickAt(x, y) {
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(220);
}

async function pressKey(key, code, vk) {
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(40);
}

/**
 * Đợi màn hình chờ #preloader gỡ khỏi trang (hoặc mờ hẳn đi).
 *
 * BẮT BUỘC trước mọi thao tác chuột/bàn phím thật: #preloader phủ toàn trang
 * (đo được: elementFromPoint() trả về DIV#preloader.preloader tại tâm của cả
 * #bell-btn, #watch-add-btn lẫn #logout-btn), nên bấm chuột sẽ trúng lớp phủ và
 * không tới được nút. Trang gỡ nó sau khoảng 1,5–3 giây tuỳ tốc độ máy.
 */
async function waitPreloaderGone(timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const gone = await session.evaluate(`
      var p = document.getElementById("preloader");
      if (!p) return true;
      var cs = getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none") return true;
      if (Number(cs.opacity) < 0.05) return true;
      // Lớp phủ đã hết chặn chuột.
      if (cs.pointerEvents === "none") return true;
      return false;
    `);
    if (gone) return true;
    await sleep(150);
  }
  return false;
}

async function tabUntil(sel, max = 70) {
  const target = JSON.stringify(sel);
  for (let i = 0; i < max; i++) {
    await pressKey("Tab", "Tab", 9);
    const hit = await session.evaluate(
      `return !!(document.activeElement && document.activeElement === document.querySelector(${target}));`,
    );
    if (hit) return true;
  }
  return false;
}

/**
 * Cuộn phần tử vào giữa khung nhìn rồi đợi toạ độ của nó NGỪNG ĐỔI.
 *
 * Cần thiết vì scrollIntoView() có thể làm bố cục co giãn thêm một nhịp (ảnh
 * lười tải, thanh cuộn xuất hiện), khiến toạ độ đọc ngay sau đó đã lệch so với
 * vị trí thật — di chuột tới đó sẽ không kích hoạt :hover.
 */
async function stabilizeElement(sel, tries = 14) {
  const target = JSON.stringify(sel);
  let last = null;
  for (let i = 0; i < tries; i++) {
    const box = await session.evaluate(`
      var el = document.querySelector(${target});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      var r = el.getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), scrollY: Math.round(window.scrollY) };
    `);
    if (!box) return null;
    if (last && box.cy === last.cy && box.cx === last.cx && box.scrollY === last.scrollY) return box;
    last = box;
    await sleep(150);
  }
  return last;
}

/** Thao tác thật để trang gọi API: uid = dán UID rồi bấm Kiểm tra, login = gửi mật khẩu. */
async function interact(cfg) {
  if (cfg.interact === "uid") {
    const spot = await session.evaluate(spotOf("#uid-input"));
    if (!spot) return false;
    await clickAt(spot.x, spot.y);
    await session.send("Input.insertText", { text: "61579461239864" });
    await sleep(120);
    const btn = await session.evaluate(spotOf("#uid-check-btn"));
    if (!btn) return false;
    await clickAt(btn.x, btn.y);
    return true;
  }
  if (cfg.interact === "login") {
    const spot = await session.evaluate(spotOf("#password"));
    if (!spot) return false;
    await clickAt(spot.x, spot.y);
    await session.send("Input.insertText", { text: "mat-khau-sai-de-kiem-tra" });
    await sleep(120);
    const btn = await session.evaluate(spotOf("#submit-btn"));
    if (!btn) return false;
    await clickAt(btn.x, btn.y);
    return true;
  }
  if (cfg.interact === "logout") {
    const btn = await session.evaluate(spotOf("#logout-btn"));
    if (!btn) return false;
    await clickAt(btn.x, btn.y);
    return true;
  }
  return false;
}

/* =====================================================================
   CÁC BÀI KIỂM TRA
   ===================================================================== */

/** 1a + 1b: trạng thái đang tải. */
async function checkLoading(cfg, measured) {
  const loading = measured.loading;
  const pre = loading.preloader;

  /*
    1a đo #preloader có ĐƯỢC KHAI BÁO trong trang không, chứ không chỉ có còn
    trong DOM lúc chụp không.

    Vì sao: #preloader bị gỡ khỏi DOM sau ~1,5–3 giây. Trang nào có request
    chậm hơn (uid: mất thêm một nhịp để gỡ) thì phép đo có thể chạy sau khi nó
    đã gỡ xong và báo oan "không tìm thấy". Cách đo bền vững: đọc HTML nguồn —
    trang nào cũng phải có #preloader trong markup.
  */
  const declared = await session.evaluate(`
    return fetch(location.href, { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (html) { return html.indexOf('id="preloader"') !== -1; })
      .catch(function () { return null; });
  `);

  if (pre) {
    check(
      "1a",
      CHECK_TITLE["1a"],
      pre.visible,
      `#preloader display=${pre.display} opacity=${pre.opacity} ${pre.w}×${pre.h}px`,
    );
  } else if (declared === true) {
    // Đã gỡ khỏi DOM nhưng HTML nguồn có khai báo ⇒ đạt (màn hình chờ đã chạy và tự gỡ).
    check("1a", CHECK_TITLE["1a"], true, "#preloader đã chạy xong và tự gỡ khỏi DOM (có trong HTML nguồn)");
  } else if (declared === false) {
    check("1a", CHECK_TITLE["1a"], false, "HTML nguồn không có #preloader");
  } else {
    skip("1a", CHECK_TITLE["1a"], "không đọc lại được HTML nguồn để xác nhận #preloader");
  }

  if (NO_LIST_PAGES.has(currentPage)) {
    skip("1b", CHECK_TITLE["1b"], "trang không có danh sách/bảng nào do máy chủ đổ vào");
    return;
  }
  if (!measured.requestInFlight) {
    skip("1b", CHECK_TITLE["1b"], "lúc mới mở trang không có request /api/* nào đang chạy");
    return;
  }

  const regions = loading.regions.filter((r) => r.exists);
  const busyRegions = regions.filter((r) => r.busySelf || r.busyAncestor);
  const skeletonRegions = regions.filter((r) => r.skeletons > 0);
  const placeholderRegions = regions.filter((r) => r.placeholder);
  const okBusy = busyRegions.length > 0 || skeletonRegions.length > 0;

  const detail =
    `aria-busy="true": ${loading.busyTrue.length ? loading.busyTrue.join(", ") : "không có"} · ` +
    `.skeleton=${loading.skeletons} (hiện ${loading.skeletonVisible}) · ` +
    `vùng có chỗ giữ chỗ: ${placeholderRegions.length}/${regions.length}`;

  check("1b", CHECK_TITLE["1b"], okBusy, detail);

  if (!okBusy && placeholderRegions.length) {
    note(
      "1b — vẫn có chữ giữ chỗ nhưng thiếu tín hiệu máy đọc",
      placeholderRegions
        .slice(0, 3)
        .map((r) => `${r.sel}="${r.text}"`)
        .join(" · "),
    );
  }
  if (loading.liveLoading.length) {
    note(
      "1b — vùng live báo đang tải",
      loading.liveLoading.map((l) => `${l.sel}[${l.role}]="${l.text}"`).join(" · "),
    );
  }
  const staleBusy = regions.filter((r) => r.ariaBusy === "false");
  if (staleBusy.length) {
    note(
      "1b — aria-busy sai trạng thái",
      staleBusy.map((r) => `${r.sel} aria-busy="false" trong lúc đang tải`).join(" · "),
    );
  }
}

/** 2a + 2b: trạng thái lỗi (đã trả 503 thật). */
async function checkError(cfg, error) {
  const target = error.target;
  const shown = target && target.visible && target.text.length > 0;
  const detail = target
    ? `${target.sel}[role=${target.role || "không"}] visible=${target.visible} ${target.w}×${target.h}px ` +
      `"${target.text.replace(/\s+/g, " ").slice(0, 90)}"`
    : `không có phần tử ${cfg.errorSel}`;

  check("2a", CHECK_TITLE["2a"], shown, detail);
  check(
    "2b",
    CHECK_TITLE["2b"],
    shown && looksVietnamese(target.text),
    shown ? `"${target.text.replace(/\s+/g, " ").slice(0, 110)}"` : "không có thông báo để đánh giá",
  );

  if (error.liveRegions.length) {
    note(
      "2 — vùng live đang hiện chữ",
      error.liveRegions.map((l) => `${l.sel}[${l.role}]="${l.text}"`).join(" · "),
    );
  }
}

/** 3a + 3b + 3c: trạng thái rỗng. */
async function checkEmpty(cfg, settled) {
  if (NO_LIST_PAGES.has(currentPage)) {
    skip("3a", CHECK_TITLE["3a"], "trang không có danh sách/bảng");
    skip("3b", CHECK_TITLE["3b"], "trang không có danh sách/bảng");
    skip("3c", CHECK_TITLE["3c"], "trang không có danh sách/bảng");
    return;
  }

  const empties = settled.empties;
  check(
    "3a",
    CHECK_TITLE["3a"],
    empties.length > 0,
    empties.length
      ? empties.map((e) => e.sel + (e.hiddenAttr || e.hiddenClass ? "(ẩn)" : "")).join(", ").slice(0, 180)
      : "không có .empty-state hay .empty nào trong DOM",
  );

  const shown = empties.filter((e) => e.visible);
  check(
    "3b",
    CHECK_TITLE["3b"],
    shown.length > 0,
    shown.length
      ? shown.map((e) => `${e.sel}${e.heading ? ` "${e.heading}"` : ""}`).join(" · ").slice(0, 200)
      : "không khối rỗng nào đang hiện",
  );

  const good = shown.filter(
    (e) => e.heading.length > 0 && (e.actions > 0 || e.sentences.some((s) => s.length >= 12)),
  );
  check(
    "3c",
    CHECK_TITLE["3c"],
    good.length > 0,
    good.length
      ? `${good[0].sel} — tiêu đề "${good[0].heading}", ${good[0].actions} hành động`
      : shown.length
        ? `khối đang hiện thiếu tiêu đề/hành động: ${shown
            .slice(0, 3)
            .map((e) => `${e.sel}="${e.text}"`)
            .join(" · ")}`
        : "không có khối rỗng nào để đánh giá",
  );

  const bare = shown.filter((e) => !e.heading && e.actions === 0);
  if (bare.length && good.length) {
    note(
      "3 — khối rỗng dạng chữ trần",
      bare.map((e) => `${e.sel}="${e.text}"`).join(" · ").slice(0, 200),
    );
  }
  const visibleEmptyStateBlocks = shown.filter((e) => e.cls.indexOf("empty-state") >= 0);
  if (visibleEmptyStateBlocks.length > 1 && bare.length) {
    note(
      "3 — hiện trùng nhiều khối rỗng cùng lúc",
      `${visibleEmptyStateBlocks.length} khối .empty-state và ${bare.length} khối chữ trần cùng hiện`,
    );
  }
}

/** 4: điều khiển bận phải disabled thật và khác kiểu khi bật. */
function checkDisabled(cfg, busy, idle) {
  const sel = cfg.disabledSel;
  if (!busy || !busy.exists || !idle || !idle.exists) {
    check("4", CHECK_TITLE["4"], false, `không đo được ${sel}`);
    return;
  }
  const styleDiff =
    busy.opacity !== idle.opacity ||
    busy.cursor !== idle.cursor ||
    busy.pointerEvents !== idle.pointerEvents ||
    busy.background !== idle.background ||
    busy.color !== idle.color;
  const ok = busy.disabled === true && idle.disabled === false && styleDiff;
  check(
    "4",
    CHECK_TITLE["4"],
    ok,
    `${sel}: disabled ${busy.disabled}→${idle.disabled} · opacity ${busy.opacity}→${idle.opacity} · ` +
      `cursor ${busy.cursor}→${idle.cursor} · pointer-events ${busy.pointerEvents}→${idle.pointerEvents}`,
  );
  if (busy.disabled === true && !styleDiff) {
    note("4 — thiếu kiểu riêng cho trạng thái khoá", `${sel} giữ nguyên kiểu khi bị disabled`);
  }
}

/** 7: nút chính đổi kiểu khi hover và khi focus bằng Tab. */
async function checkFeedback(cfg) {
  const picked = await session.evaluate(`${STYLE_HELPER}\n${pickFeedback(cfg.feedbackSels)}`);
  if (!picked) {
    check("7", CHECK_TITLE["7"], false, `không tìm thấy nút dùng được trong [${cfg.feedbackSels.join(", ")}]`);
    return;
  }

  /*
    Đưa nút vào giữa khung nhìn rồi ĐỢI VỊ TRÍ ỔN ĐỊNH trước khi đo hover.

    Vì sao bắt buộc: nút nằm sâu trong trang (ví dụ #images-refresh ở y≈1095
    trong khung 900px). Hai cái bẫy đã gặp thật:
      1. Di chuột tới toạ độ ngoài khung nhìn thì :hover không kích hoạt.
      2. scrollIntoView() làm bố cục co giãn thêm một nhịp (ảnh lười tải, thanh
         cuộn), nên toạ độ đọc ngay sau đó đã cũ — tới sai chỗ và :hover không
         kích hoạt dù CSS hover hoàn toàn đúng.
    Vì vậy: cuộn, chờ toạ độ ngừng đổi, rồi mới lấy điểm để di chuột.
  */
  const stable = await stabilizeElement(picked.sel);
  if (!stable || stable.cy < 0 || stable.cy > 899) {
    check(
      "7",
      CHECK_TITLE["7"],
      false,
      `không đưa được ${picked.sel} vào khung nhìn để đo hover (y=${stable ? stable.cy : "?"})`,
    );
    return;
  }

  await mouseMove(2, 2);
  await sleep(150);
  const base = await session.evaluate(`${STYLE_HELPER}\n${readStyle(picked.sel)}`);

  await mouseMove(stable.cx, stable.cy);
  await sleep(280);
  const hover = await session.evaluate(`${STYLE_HELPER}\n${readStyle(picked.sel)}`);
  const hovered = await session.evaluate(
    `var e = document.querySelector(${JSON.stringify(picked.sel)}); return !!(e && e.matches(":hover"));`,
  );

  const hoverDiff =
    base &&
    hover &&
    (base.background !== hover.background ||
      base.color !== hover.color ||
      base.borderColor !== hover.borderColor ||
      base.transform !== hover.transform ||
      base.boxShadow !== hover.boxShadow);

  await mouseMove(2, 2);
  await sleep(160);
  const reset = await session.evaluate(`${STYLE_HELPER}\n${readStyle(picked.sel)}`);

  const reached = await tabUntil(picked.sel);
  const focused = await session.evaluate(`${STYLE_HELPER}\n${readStyle(picked.sel)}`);
  const focusDiff =
    reset &&
    focused &&
    (reset.outlineWidth !== focused.outlineWidth ||
      reset.outlineStyle !== focused.outlineStyle ||
      reset.boxShadow !== focused.boxShadow ||
      reset.borderColor !== focused.borderColor ||
      reset.background !== focused.background);

  check(
    "7-hover",
    `nút ${picked.sel} đổi kiểu khi rê chuột`,
    hoverDiff && hovered,
    base && hover
      ? `:hover=${hovered} · nền ${base.background} → ${hover.background} · viền ${base.borderColor} → ${hover.borderColor} · transform ${base.transform} → ${hover.transform}`
      : "không đọc được kiểu",
  );
  check(
    "7-focus",
    `nút ${picked.sel} đổi kiểu khi focus bằng Tab`,
    focusDiff && reached,
    focused
      ? `Tab tới nút: ${reached} · outline ${reset ? reset.outlineWidth : "?"} → ${focused.outlineWidth} ${focused.outlineStyle} · box-shadow ${focused.boxShadow.slice(0, 40)}`
      : "không đọc được kiểu",
  );
}

/** 5: hộp thoại xác nhận phá huỷ. */
async function checkConfirm(cfg) {
  const focusSel = cfg.confirmFocus;
  if (!focusSel) {
    skip("5", CHECK_TITLE["5"], "trang không nạp confirm.js (chỉ images.html và tickxanh.html có)");
    return;
  }

  const spot = await session.evaluate(`${STYLE_HELPER}\n${spotOf(focusSel)}`);
  if (!spot || !spot.hit) {
    check("5", CHECK_TITLE["5"], false, `không bấm được vào ${focusSel} để đặt focus ban đầu`);
    return;
  }
  await clickAt(spot.x, spot.y);
  await sleep(200);
  const focusBefore = await session.evaluate(
    "return document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : \"\";",
  );

  const open = await session.evaluate(`${SEL_HELPER}\n${OPEN_CONFIRM}`);
  const opened =
    open.exists &&
    open.open === true &&
    open.isModal === true &&
    open.display !== "none" &&
    open.visibility !== "hidden" &&
    open.w > 0 &&
    open.h > 0;
  check(
    "5a",
    "ask() mở <dialog> thật bằng showModal()",
    opened,
    open.exists
      ? `<${open.tag}> open=${open.open} :modal=${open.isModal} ${open.w}×${open.h}px display=${open.display}`
      : "không có #confirm-dialog",
  );
  if (!opened) {
    check("5b", "focus nằm trong hộp thoại", false, "hộp thoại không mở được");
    return;
  }
  check(
    "5b",
    "focus nằm trong hộp thoại",
    open.focusInside === true,
    `activeElement=${open.activeId} · nút đang focus: ${
      (open.buttons.find((b) => b.focused) || {}).text || "không rõ"
    }`,
  );

  const cancel = open.buttons.find((b) => b.text === "Huỷ") || open.buttons[0];
  const accept = open.buttons.find((b) => b.id === "confirm-dialog-accept") || open.buttons[open.buttons.length - 1];
  note(
    "5 — nút trong hộp thoại",
    open.buttons.map((b) => `"${b.text}"${b.id ? `#${b.id}` : ""} ${b.w}×${b.h}px`).join(" · "),
  );

  /* Escape */
  await pressKey("Escape", "Escape", 27);
  await sleep(350);
  let after = await session.evaluate(READ_CONFIRM);
  check(
    "5c",
    "Escape đóng hộp thoại và trả về false",
    after.settled && after.result === false && after.open === false,
    `open=${after.open} · Promise=${JSON.stringify(after.result)} · settled=${after.settled}`,
  );
  check(
    "5d",
    "đóng hộp thoại trả focus về nút gọi trước đó",
    after.activeId === focusBefore,
    `trước khi mở: ${focusBefore} · sau khi Escape: ${after.activeId}`,
  );

  /* Nút Huỷ */
  await session.evaluate(`${SEL_HELPER}\n${OPEN_CONFIRM}`);
  await sleep(150);
  await clickAt(cancel.x, cancel.y);
  await sleep(350);
  after = await session.evaluate(READ_CONFIRM);
  check(
    "5e",
    "bấm nút Huỷ trả về false",
    after.settled && after.result === false && after.open === false,
    `nút "${cancel.text}" tại ${cancel.x},${cancel.y} · Promise=${JSON.stringify(after.result)} · open=${after.open}`,
  );
  check(
    "5f",
    "nút Huỷ trả focus về nút gọi trước đó",
    after.activeId === focusBefore,
    `sau khi Huỷ: ${after.activeId}`,
  );

  /* Nút xác nhận */
  await session.evaluate(`${SEL_HELPER}\n${OPEN_CONFIRM}`);
  await sleep(150);
  await clickAt(accept.x, accept.y);
  await sleep(350);
  after = await session.evaluate(READ_CONFIRM);
  check(
    "5g",
    `bấm nút "${accept.text}" trả về true`,
    after.settled && after.result === true && after.open === false,
    `nút #${accept.id} tại ${accept.x},${accept.y} · Promise=${JSON.stringify(after.result)} · open=${after.open}`,
  );
  check(
    "5h",
    "nút xác nhận trả focus về nút gọi trước đó",
    after.activeId === focusBefore,
    `sau khi xác nhận: ${after.activeId}`,
  );
}

/* =====================================================================
   CHẠY TỪNG TRANG
   ===================================================================== */

console.log("=".repeat(78));
console.log("KIỂM TRA TRẠNG THÁI GIAO DIỆN BẰNG TRÌNH DUYỆT THẬT");
console.log("=".repeat(78));
console.log(`  Máy chủ xem trước: ${opts.base}`);
console.log("  Cách đo: CDP giữ /api/* để xem trạng thái đang tải, trả 503 thật để xem trạng thái lỗi.");

await session.setViewport(1280, 900, false);

for (const page of opts.pages) {
  const cfg = CONFIG[page];
  if (!cfg) {
    console.log(`\n[${page}] BỎ QUA: không có trong cấu hình`);
    continue;
  }

  currentPage = `${page}.html`;
  console.log(`\n${"-".repeat(78)}\n[${currentPage}]\n${"-".repeat(78)}`);

  try {
    /* ---------- LƯỢT 1: đang tải (giữ request) rồi để trang ổn định ---------- */
    apiMode = "hold";
    paused = [];
    session.consoleErrors.length = 0;
    await session.goto(`${opts.base}/${page}.html`, 0);
    await sleep(320);

    const loading = await session.evaluate(probeLoading(cfg.regions));
    const requestInFlight = paused.length > 0;
    section(`Trạng thái ĐANG TẢI — giữ ${paused.length} request /api/* bằng CDP Fetch`);
    for (const r of loading.regions) {
      if (!r.exists) {
        console.log(`      ${r.sel}: không có trong trang`);
        continue;
      }
      console.log(
        `      ${r.sel}: aria-busy=${r.ariaBusy === null ? "null" : `"${r.ariaBusy}"`}` +
          `${r.busyAncestor ? ` (tổ tiên ${r.busyAncestor})` : ""} · .skeleton=${r.skeletons} · ` +
          `cao ${r.h}px · chữ "${r.text}"`,
      );
    }
    await checkLoading(cfg, { loading, requestInFlight });

    apiMode = "pass";
    const released = await releasePaused();
    await sleep(850);
    // Chờ màn hình chờ gỡ hẳn trước khi tương tác chuột/bàn phím thật.
    await waitPreloaderGone();

    const settled = await session.evaluate(probeSettled(cfg.regions));
    section(`Trạng thái RỖNG (đã thả ${released} request — máy chủ xem trước trả 200 kèm ok:false)`);
    for (const r of settled.regions) {
      console.log(
        r.exists
          ? `      ${r.sel}: ${r.rows} dòng · aria-busy=${r.ariaBusy === null ? "null" : `"${r.ariaBusy}"`} · chữ "${r.text}"`
          : `      ${r.sel}: không có trong trang`,
      );
    }
    if (NO_LIST_PAGES.has(page)) {
      /*
        login.html là trang đăng nhập: không có danh sách/bảng nào do máy chủ
        đổ vào, nên khái niệm "trạng thái rỗng" không áp dụng. Ghi rõ BỎ QUA
        thay vì tính là thất bại (phải đặt TRƯỚC checkEmpty, nếu không hàm đó sẽ
        ghi 3 mục không đạt trước).
      */
      skip("3a", CHECK_TITLE["3a"], "trang đăng nhập không có danh sách/bảng nên không có trạng thái rỗng");
      skip("3b", CHECK_TITLE["3b"], "trang đăng nhập không có danh sách/bảng nên không có trạng thái rỗng");
      skip("3c", CHECK_TITLE["3c"], "trang đăng nhập không có danh sách/bảng nên không có trạng thái rỗng");
    } else {
      await checkEmpty(cfg, settled);
    }
    note(
      "phong bì ok:false của bản xem trước",
      (await session.evaluate(probeError(cfg.errorSel))).target &&
      (await session.evaluate(probeError(cfg.errorSel))).target.visible
        ? "trang CÓ hiện thông báo lỗi cho ok:false"
        : "trang coi ok:false là 'không có dữ liệu' (Worker thật không bao giờ trả 200 cho lỗi — không tính là lỗi ở đây)",
    );

    section("Phản hồi chuột/bàn phím");
    await checkFeedback(cfg);

    section("Hộp thoại xác nhận phá huỷ (confirm.js)");
    await checkConfirm(cfg);

    /* ---------- LƯỢT 2: lỗi 503 thật + trạng thái khoá của điều khiển ---------- */
    apiMode = "hold";
    paused = [];
    await session.goto(`${opts.base}/${page}.html`, 0);
    await sleep(300);
    await waitPreloaderGone();
    const interacted = await interact(cfg);
    if (interacted) await sleep(120);

    /*
      Chỉ đo trạng thái LỖI khi thật sự có một request bị giữ lại.

      Với uid.html và login.html, /api/* chỉ được gọi SAU khi người dùng tương
      tác, còn máy chủ xem trước luôn trả ok:false nên trang không bao giờ đi
      tới nhánh thành công. Nếu không có request nào bị giữ (paused.length === 0)
      thì không có lỗi nào để chứng minh — báo lỗi ở đây là báo oan, nên ta ghi
      rõ là BỎ QUA kèm lý do thay vì tính là thất bại.
    */
    const hasInFlight = paused.length > 0;

    const busyState = hasInFlight ? await session.evaluate(measureControl(cfg.disabledSel)) : null;

    /* uid: đo thêm vùng danh sách trong lúc đang kiểm tra */
    if (page === "uid" && hasInFlight) {
      const during = await session.evaluate(probeLoading(cfg.regions));
      section(`Trạng thái ĐANG TẢI khi bấm "Kiểm tra" (giữ ${paused.length} request /api/fbcheck)`);
      for (const r of during.regions) {
        console.log(`      ${r.sel}: aria-busy=${r.ariaBusy === null ? "null" : `"${r.ariaBusy}"`} · .skeleton=${r.skeletons} · chữ "${r.text}"`);
      }
      console.log(
        `      vùng live báo đang tải: ${
          during.liveLoading.length
            ? during.liveLoading.map((l) => `${l.sel}[${l.role}]="${l.text}"`).join(" · ")
            : "không có"
        }`,
      );
      await checkLoading(cfg, { loading: during, requestInFlight: true });
    }

    const failed = await failPaused();
    await sleep(750);
    apiMode = "pass";

    if (!hasInFlight) {
      section("Trạng thái LỖI THẬT — không có request /api/* nào được giữ");
      skip("2a", CHECK_TITLE["2a"], "trang chỉ gọi API sau khi người dùng tương tác và máy chủ xem trước không đi tới nhánh thành công");
      skip("2b", CHECK_TITLE["2b"], "không có request nào bị giữ để tạo lỗi 503");
      skip("4", CHECK_TITLE["4"], "không có request bị giữ nên không quan sát được trạng thái bận");
    } else {
      section(`Trạng thái LỖI THẬT — ${failed} request /api/* được trả 503 kèm trang lỗi HTML`);
      const error = await session.evaluate(probeError(cfg.errorSel));
      await checkError(cfg, error);

      const idleState = await session.evaluate(measureControl(cfg.disabledSel));
      checkDisabled(cfg, busyState, idleState);
    }

    /* ---------- 6: lỗi console/exception ---------- */
    const errors = session.consoleErrors.filter((e) => e.type === "exception" || !consoleNoise(e.text));
    check(
      "6",
      CHECK_TITLE["6"],
      errors.length === 0,
      errors.length
        ? errors
            .slice(0, 4)
            .map((e) => `${e.type}: ${e.text.replace(/\s+/g, " ").slice(0, 90)}`)
            .join(" | ")
        : "sạch",
    );
    if (session.consoleErrors.length > errors.length) {
      note(
        "6 — đã lọc",
        `${session.consoleErrors.length - errors.length} mục do chính bài kiểm tra gây ra (favicon / mã 503 giả lập)`,
      );
    }
  } catch (err) {
    check("6", CHECK_TITLE["6"], false, `bài kiểm tra trang này lỗi: ${err && err.message ? err.message : err}`);
    note("lỗi khi chạy trang", String((err && err.stack) || err).slice(0, 300));
  }
}

/* =====================================================================
   TỔNG HỢP
   ===================================================================== */

await session.close();

console.log(`\n${"=".repeat(78)}`);
console.log("TỔNG HỢP THEO TRANG");
console.log("=".repeat(78));

const pagesRun = opts.pages.filter((p) => CONFIG[p]);
const ids = [];
for (const r of results) if (!ids.includes(r.id)) ids.push(r.id);

const header = ["Trang".padEnd(16), ...ids.map((i) => i.padStart(7))].join("");
console.log("  " + header);
for (const p of pagesRun) {
  const name = `${p}.html`;
  const cells = ids.map((id) => {
    const found = results.filter((r) => r.page === name && r.id === id);
    if (!found.length) return "-".padStart(7);
    if (found.some((r) => r.skip)) return "bỏ qua".padStart(7);
    return (found.every((r) => r.pass) ? "\u2713" : "\u2717").padStart(7);
  });
  console.log("  " + [name.padEnd(16), ...cells].join(""));
}

console.log(`\n  ĐẠT : ${passCount}`);
console.log(`  LỖI : ${failCount}`);

const failedList = results.filter((r) => !r.pass && !r.skip);
if (failedList.length) {
  console.log("\n  Mục không đạt:");
  for (const r of failedList) {
    console.log(`    \u2717 [${r.page}] ${r.id} ${r.title}`);
    if (r.detail) console.log(`        đo được: ${r.detail}`);
  }
}

const skipped = results.filter((r) => r.skip);
if (skipped.length) {
  console.log("\n  Mục bỏ qua (kèm lý do):");
  for (const r of skipped) console.log(`    \u2013 [${r.page}] ${r.id} — ${r.detail}`);
}

if (notes.length) {
  console.log("\n  Ghi nhận thêm (không tính là lỗi):");
  for (const n of notes) console.log(`    \u2022 [${n.page}] ${n.label}: ${n.detail}`);
}

console.log(`\n${"=".repeat(78)}`);
console.log(failCount === 0 ? "KẾT LUẬN: tất cả trạng thái đều đạt." : `KẾT LUẬN: ${failCount} mục KHÔNG ĐẠT.`);
console.log("=".repeat(78));

process.exit(failCount === 0 ? 0 : 1);

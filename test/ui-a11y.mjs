/**
 * test/ui-a11y.mjs — rà soát KHẢ NĂNG TIẾP CẬN (a11y) bằng trình duyệt THẬT.
 *
 * Dùng Chrome DevTools Protocol (test/cdp.mjs): mở 6 trang ở 375×900 (di động) và
 * 1440×900, rồi ĐO trong DOM đang được trình duyệt vẽ ra — không phán đoán từ
 * việc đọc mã nguồn. Mọi kết luận trong báo cáo đều kèm giá trị đo được.
 *
 * Mười phép kiểm tra theo yêu cầu:
 *    1. Mọi phần tử nhận focus đều có nhãn truy cập (chữ, aria-label,
 *       aria-labelledby trỏ tới phần tử có chữ, hoặc <label for> cho ô nhập).
 *    2. Nút chỉ có biểu tượng phải có aria-label hoặc title.
 *    3. Mọi <img> phải có thuộc tính alt (alt="" là hợp lệ cho ảnh trang trí).
 *    4. Cấu trúc tiêu đề: đúng một <h1>, không nhảy cấp (h1 rồi h3…).
 *    5. Focus bàn phím phải nhìn thấy: so kiểu tính toán trước/sau khi focus.
 *    6. Không có tabindex dương.
 *    7. Nút/liên kết phá huỷ hoặc đổi trạng thái phải công bố trạng thái
 *       (aria-expanded, aria-pressed, hoặc vùng thông báo động).
 *    8. Vùng trạng thái động (role=status/alert/aria-live) cho phản hồi bất đồng bộ.
 *    9. Không có aria-hidden="true" chứa phần tử nhận focus.
 *   10. Không trùng id trên cùng một trang.
 *   RM. Với prefers-reduced-motion: reduce, không phần tử nào bị bỏ mờ/vô hình và
 *       #preloader phải kết thúc ở trạng thái ẩn, nội dung chính vẫn chạm được.
 *
 * Vài lưu ý kỹ thuật đã kiểm chứng trên chính repo này (tránh báo oan):
 *   • `:focus-visible` chỉ khớp khi trình duyệt biết người dùng vừa dùng BÀN PHÍM.
 *     Gọi `element.focus()` trần trong trang vừa tải KHÔNG kích hoạt được
 *     `:focus-visible`, nên trước khi đo focus ta bấm một phím Tab thật qua CDP
 *     (`Input.dispatchKeyEvent`) để đặt lại chế độ bàn phím.
 *   • Phần tử không được vẽ (display:none / visibility:hidden / hộp 0×0) không nằm
 *     trong cây trợ năng nên không tính là lỗi nhãn; riêng `.visually-hidden` và ô
 *     nhập tệp 1×1px là chủ ý của thiết kế nên được bỏ qua khi xét nhãn/focus.
 *   • `#preloader` tự đặt aria-hidden rồi tự gỡ khỏi DOM sau khi tải xong — hợp lệ,
 *     không tính là "vùng thông báo bị ẩn".
 *   • `.skip-link` cố ý để opacity:0 cho tới khi được focus, nên khi so kiểu focus
 *     phải so cả opacity/transform, và không tính nó là "nội dung bị bỏ mờ".
 *
 * Cách chạy:
 *   node test/ui-preview.mjs --port 8899            (cửa sổ 1, máy chủ xem trước)
 *   node test/ui-a11y.mjs --base http://127.0.0.1:8899
 *
 * Thoát 1 khi có ít nhất một LỖI, thoát 0 khi sạch. CẢNH BÁO không làm đổi mã thoát.
 */
import { launchBrowser } from "./cdp.mjs";

const PAGES = ["index", "logs", "images", "uid", "tickxanh", "login"];
const VIEWPORTS = [
  { w: 375, h: 900, mobile: true, label: "375×900 · di động" },
  { w: 1440, h: 900, mobile: false, label: "1440×900 · máy tính" },
];

const SETTLE_MS = 1600; // chờ trang ổn định (preloader tự gỡ ở ~1,2s)
const SETTLE_REDUCED_MS = 1900; // thêm thời gian cho lần tải lại ở chế độ giảm chuyển động
const FOCUS_SAMPLE = 8; // số phần tử lấy mẫu cho phép kiểm tra số 5
const MAX_LINES = 6; // số dòng chi tiết tối đa in cho mỗi nhóm

/** Tên 10 phép kiểm tra + phép kiểm tra giảm chuyển động. */
const CHECK_NAMES = {
  "1": "Nhãn truy cập cho phần tử nhận focus",
  "2": "Nút chỉ có biểu tượng phải có nhãn",
  "3": "Ảnh phải có thuộc tính alt",
  "4": "Cấu trúc tiêu đề (một h1, không nhảy cấp)",
  "5": "Focus bàn phím phải nhìn thấy",
  "6": "Không có tabindex dương",
  "7": "Hành động phá huỷ/đổi trạng thái công bố trạng thái",
  "8": "Vùng trạng thái động cho phản hồi bất đồng bộ",
  "9": "aria-hidden không chứa phần tử nhận focus",
  "10": "Không trùng id trên một trang",
  RM: "Giảm chuyển động (prefers-reduced-motion: reduce)",
};

function parseArgs(argv) {
  const out = {
    base: "http://127.0.0.1:8899",
    pages: PAGES.slice(),
    json: "",
    raw: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--pages") out.pages = argv[++i].split(",");
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--raw") out.raw = true;
  }
  if (!out.base.endsWith("/")) out.base = out.base.replace(/\/+$/, "");
  return out;
}

/* =====================================================================
   PHẦN CHẠY TRONG TRANG — hàm dùng chung cho cả ba phép đo.
   Không dùng template literal hay chuỗi nội suy để tránh xung đột với
   String.raw ở phía Node.
   ===================================================================== */
const PAGE_HELPERS = String.raw`
/* Bộ chọn "có thể nhận focus": dùng chung cho các phép kiểm 1, 2, 5, 7, 9. */
var FOCUSABLE_SEL = 'a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable="true"]';

function sel(el) {
  if (!el || el.nodeType !== 1) return "(không rõ)";
  var parts = [];
  var node = el;
  while (node && node.nodeType === 1 && parts.length < 4) {
    var p = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(p + "#" + node.id);
      break;
    }
    if (typeof node.className === "string" && node.className.trim()) {
      p += "." + node.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    var parent = node.parentElement;
    if (parent) {
      var same = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
      }
      if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(p);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function isRendered(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hasAttribute("hidden")) return false;
  var cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  var r = el.getBoundingClientRect();
  return r.width > 0.5 && r.height > 0.5;
}

function inVisuallyHidden(el) {
  return !!(el.closest && el.closest(".visually-hidden"));
}

function ariaHiddenAncestor(el) {
  var n = el;
  while (n && n.nodeType === 1) {
    if (n.getAttribute("aria-hidden") === "true") return n;
    n = n.parentElement;
  }
  return null;
}

/* Có nằm trong tab order không (tabindex >= 0 hoặc có thể nhận focus gốc). */
function isTabbable(el) {
  if (el.hasAttribute("disabled")) return false;
  if (el.closest && el.closest("[inert]")) return false;
  var ti = el.getAttribute("tabindex");
  if (ti !== null) {
    var n = parseInt(ti, 10);
    if (!isNaN(n)) return n >= 0;
  }
  var tag = el.tagName;
  if (tag === "A" || tag === "AREA") return el.hasAttribute("href");
  if (tag === "INPUT") return el.type !== "hidden";
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "IFRAME" || tag === "SUMMARY") return true;
  if (tag === "AUDIO" || tag === "VIDEO") return el.hasAttribute("controls");
  return el.isContentEditable === true;
}

/* Có thể nhận focus bằng lập trình (gồm tabindex="-1") — dùng cho phép kiểm 9. */
function isFocusableAny(el) {
  if (el.hasAttribute("disabled")) return false;
  if (el.closest && el.closest("[inert]")) return false;
  if (el.hasAttribute("tabindex")) return true;
  var tag = el.tagName;
  if (tag === "A" || tag === "AREA") return el.hasAttribute("href");
  if (tag === "INPUT") return el.type !== "hidden";
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "IFRAME" || tag === "SUMMARY") return true;
  if (tag === "AUDIO" || tag === "VIDEO") return el.hasAttribute("controls");
  return el.isContentEditable === true;
}

/* Chữ dùng để tính tên truy cập: bỏ nhánh aria-hidden, thay <img> bằng alt. */
function textOf(el) {
  var s = "";
  function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType === 3) {
        s += c.textContent;
      } else if (c.nodeType === 1) {
        if (c.getAttribute("aria-hidden") === "true") continue;
        if (c.tagName === "IMG") {
          s += " " + (c.getAttribute("alt") || "");
          continue;
        }
        walk(c);
      }
    }
  }
  walk(el);
  return s.replace(/\s+/g, " ").trim();
}

/* Chữ NGƯỜI DÙNG NHÌN THẤY: bỏ cả nhánh .visually-hidden. */
function visibleTextOf(el) {
  var s = "";
  function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (c.nodeType === 3) {
        s += c.textContent;
      } else if (c.nodeType === 1) {
        if (c.getAttribute("aria-hidden") === "true") continue;
        if (c.classList && c.classList.contains("visually-hidden")) continue;
        if (c.tagName === "IMG") {
          s += " " + (c.getAttribute("alt") || "");
          continue;
        }
        walk(c);
      }
    }
  }
  walk(el);
  return s.replace(/\s+/g, " ").trim();
}

/* Tên truy cập theo thứ tự ưu tiên gần đúng của thông số ARIA. */
function nameOf(el) {
  var byIds = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  if (byIds.length) {
    var fromRefs = [];
    for (var i = 0; i < byIds.length; i++) {
      var t = document.getElementById(byIds[i]);
      if (t) fromRefs.push(textOf(t));
    }
    var joined = fromRefs.join(" ").replace(/\s+/g, " ").trim();
    if (joined) return { name: joined, src: "aria-labelledby" };
  }
  var aria = (el.getAttribute("aria-label") || "").trim();
  if (aria) return { name: aria, src: "aria-label" };
  if (el.matches("input:not([type=hidden]), textarea, select, meter, progress")) {
    if (el.id) {
      var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (lab) {
        var lt = textOf(lab);
        if (lt) return { name: lt, src: "<label for>" };
      }
    }
    var anc = el.closest("label");
    if (anc) {
      var at = textOf(anc);
      if (at) return { name: at, src: "<label> bao ngoài" };
    }
  }
  if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "reset" || el.type === "button")) {
    var v = (el.value || "").trim();
    if (v) return { name: v, src: "value" };
  }
  if (el.tagName === "INPUT" && el.type === "image") {
    var ia = (el.getAttribute("alt") || "").trim();
    if (ia) return { name: ia, src: "alt" };
  }
  var txt = textOf(el);
  if (txt) return { name: txt, src: "nội dung chữ" };
  var title = (el.getAttribute("title") || "").trim();
  if (title) return { name: title, src: "title" };
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    var ph = (el.getAttribute("placeholder") || "").trim();
    if (ph) return { name: ph, src: "placeholder (dự phòng)" };
  }
  return { name: "", src: "không có nguồn nào" };
}

function short(s, n) {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
`;

/* =====================================================================
   PHÉP ĐO TĨNH: kiểm 1, 2, 3, 4, 6, 7, 8, 9, 10.
   ===================================================================== */
const PROBE_STATIC =
  PAGE_HELPERS +
  String.raw`
var out = {
  path: location.pathname,
  title: document.title,
  counts: {},
  c1: { evaluated: 0, failures: [], sources: {}, samples: [] },
  c2: { evaluated: 0, iconOnly: 0, labeled: 0, failures: [], samples: [] },
  c3: { total: 0, emptyAlt: 0, missing: [], imgs: [] },
  c4: { headings: [], h1: 0, failures: [], sequence: "" },
  c5: null,
  c6: { scanned: 0, positive: [] },
  c7: { controls: 0, liveRegionCount: 0, disclosure: [], destructive: [], dangling: [], failures: [] },
  c8: { liveRegions: [], ariaHiddenLive: [], orphans: [], failures: [] },
  c9: { ariaHiddenNodes: 0, failures: [], warnings: [] },
  c10: { ids: 0, duplicates: [] },
  extra: { hiddenButRendered: [] }
};

/* ---------- 1. Nhãn truy cập ---------- */
var allFocusable = document.querySelectorAll(FOCUSABLE_SEL);
var tabbables = [];
for (var i = 0; i < allFocusable.length; i++) {
  var el = allFocusable[i];
  if (!isTabbable(el)) continue;
  if (!isRendered(el)) continue;
  if (inVisuallyHidden(el)) continue;
  if (ariaHiddenAncestor(el)) continue;
  tabbables.push(el);
}
out.counts.focusableInDom = allFocusable.length;
out.counts.testedForName = tabbables.length;
out.counts.skippedNotRendered = 0;
out.counts.skippedVisuallyHiddenOrHidden = 0;
for (var i2 = 0; i2 < allFocusable.length; i2++) {
  var e2 = allFocusable[i2];
  if (!isTabbable(e2)) continue;
  if (!isRendered(e2)) out.counts.skippedNotRendered++;
  else if (inVisuallyHidden(e2) || ariaHiddenAncestor(e2)) out.counts.skippedVisuallyHiddenOrHidden++;
}
for (var i3 = 0; i3 < tabbables.length; i3++) {
  var e3 = tabbables[i3];
  var nm = nameOf(e3);
  if (!nm.name) {
    out.c1.failures.push({
      sel: sel(e3),
      tag: e3.tagName.toLowerCase(),
      type: e3.tagName === "INPUT" ? e3.type : null,
      text: short(e3.textContent, 30),
      why: "không có tên truy cập (" + nm.src + ")",
      evidence: "textContent=\"" + short(e3.textContent, 24) + "\", aria-label=" + (e3.getAttribute("aria-label") === null ? "(không có)" : "\"" + short(e3.getAttribute("aria-label"), 24) + "\"") + ", aria-labelledby=" + (e3.getAttribute("aria-labelledby") === null ? "(không có)" : "\"" + e3.getAttribute("aria-labelledby") + "\"")
    });
  } else {
    out.c1.sources[nm.src] = (out.c1.sources[nm.src] || 0) + 1;
    if (out.c1.samples.length < 4) out.c1.samples.push(sel(e3) + " → \"" + short(nm.name, 34) + "\" [" + nm.src + "]");
  }
}
out.c1.evaluated = tabbables.length;

/* ---------- 2. Nút chỉ có biểu tượng ---------- */
var iconSel = 'button, a[href], [role="button"], summary, [role="switch"], [role="checkbox"]';
var iconControls = document.querySelectorAll(iconSel);
out.c2.evaluated = 0;
for (var j = 0; j < iconControls.length; j++) {
  var c = iconControls[j];
  if (!isTabbable(c) || !isRendered(c)) continue;
  if (inVisuallyHidden(c) || ariaHiddenAncestor(c)) continue;
  out.c2.evaluated++;
  if (visibleTextOf(c)) continue; // có chữ nhìn thấy được → không phải nút chỉ icon
  out.c2.iconOnly++;
  var al = (c.getAttribute("aria-label") || "").trim();
  var tl = (c.getAttribute("title") || "").trim();
  var byRef = "";
  var refs = (c.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  for (var k = 0; k < refs.length; k++) {
    var rt = document.getElementById(refs[k]);
    if (rt) byRef += " " + textOf(rt);
  }
  byRef = byRef.replace(/\s+/g, " ").trim();
  if (al || tl || byRef) {
    out.c2.labeled++;
    if (out.c2.samples.length < 4) out.c2.samples.push(sel(c) + " → \"" + short(al || tl || byRef, 30) + "\"");
  } else {
    out.c2.failures.push({
      sel: sel(c),
      tag: c.tagName.toLowerCase(),
      why: "nút chỉ có biểu tượng nhưng thiếu aria-label và title",
      evidence: "chữ nhìn thấy=\"\", chữ ẩn=\"" + short(c.textContent, 24) + "\", aria-label=(không có), title=(không có), ảnh con=" + c.querySelectorAll("img,svg").length
    });
  }
}

/* ---------- 3. Ảnh phải có alt ---------- */
var imgs = document.querySelectorAll("img");
out.c3.total = imgs.length;
for (var m = 0; m < imgs.length; m++) {
  var img = imgs[m];
  if (!img.hasAttribute("alt")) {
    out.c3.missing.push({
      sel: sel(img),
      src: (img.getAttribute("src") || "").slice(0, 60),
      rendered: isRendered(img),
      why: "thiếu hẳn thuộc tính alt",
      evidence: "src=\"" + (img.getAttribute("src") || "") + "\", width=" + img.getAttribute("width") + ", height=" + img.getAttribute("height") + ", đang vẽ=" + isRendered(img)
    });
  } else if ((img.getAttribute("alt") || "") === "") {
    out.c3.emptyAlt++;
  }
  if (out.c3.imgs.length < 5) out.c3.imgs.push(sel(img) + " alt=" + (img.hasAttribute("alt") ? "\"" + short(img.getAttribute("alt"), 26) + "\"" : "(THIẾU)"));
}

/* ---------- 4. Cấu trúc tiêu đề ---------- */
var heads = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
var renderedHeads = [];
for (var h = 0; h < heads.length; h++) {
  if (!isRendered(heads[h])) continue;
  renderedHeads.push(heads[h]);
}
out.c4.h1 = 0;
out.c4.sequence = "";
var prev = 0;
for (var h2 = 0; h2 < renderedHeads.length; h2++) {
  var hd = renderedHeads[h2];
  var lvl = parseInt(hd.tagName.charAt(1), 10);
  var label = short(textOf(hd), 44);
  if (lvl === 1) out.c4.h1++;
  out.c4.sequence += (out.c4.sequence ? " → " : "") + "h" + lvl;
  out.c4.headings.push({
    level: lvl,
    sel: sel(hd),
    text: label,
    visuallyHidden: inVisuallyHidden(hd)
  });
  if (prev === 0) {
    if (lvl > 1) {
      out.c4.failures.push({
        sel: sel(hd),
        why: "thẻ tiêu đề đầu tiên là h" + lvl + " — bỏ qua cấp 1 (trang phải có <h1> trước)",
        evidence: "tiêu đề=\"" + label + "\", vị trí trong danh sách=1"
      });
    }
  } else if (lvl > prev + 1) {
    out.c4.failures.push({
      sel: sel(hd),
      why: "nhảy cấp tiêu đề: h" + prev + " → h" + lvl,
      evidence: "tiêu đề=\"" + label + "\", cấp trước đó=h" + prev
    });
  }
  prev = lvl;
}
if (out.c4.h1 !== 1) {
  out.c4.failures.unshift({
    sel: "(toàn trang)",
    why: out.c4.h1 === 0 ? "không có thẻ <h1> nào được vẽ" : ("có " + out.c4.h1 + " thẻ <h1> được vẽ, yêu cầu đúng 1"),
    evidence: "số <h1> đang vẽ=" + out.c4.h1 + ", tổng tiêu đề đang vẽ=" + renderedHeads.length + ", chuỗi cấp=" + out.c4.sequence
  });
}

/* ---------- 6. tabindex dương ---------- */
var tiNodes = document.querySelectorAll("[tabindex]");
out.c6.scanned = tiNodes.length;
for (var t = 0; t < tiNodes.length; t++) {
  var tv = parseInt(tiNodes[t].getAttribute("tabindex"), 10);
  if (!isNaN(tv) && tv > 0) {
    out.c6.positive.push({
      sel: sel(tiNodes[t]),
      tabindex: tv,
      rendered: isRendered(tiNodes[t]),
      why: "tabindex=\"" + tv + "\" (số dương) phá thứ tự tab tự nhiên"
    });
  }
}

/* ---------- 7. Công bố trạng thái cho hành động phá huỷ/đổi trạng thái ---------- */
var DESTRUCTIVE = ["xoá", "xóa", "delete", "huỷ", "hủy", "đăng xuất", "logout", "đặt lại", "reset"];
var liveAll = document.querySelectorAll('[role="status"],[role="alert"],[role="log"],[aria-live]');
var effectiveLive = [];
for (var L = 0; L < liveAll.length; L++) {
  var le = liveAll[L];
  if (le.closest("#preloader, .preloader")) continue; // màn tải: tự ẩn rồi tự gỡ, hợp lệ
  if (ariaHiddenAncestor(le)) continue;
  if ((le.getAttribute("aria-live") || "").toLowerCase() === "off") continue;
  effectiveLive.push(le);
}
out.c7.liveRegionCount = effectiveLive.length;
var roleControls = document.querySelectorAll('button, a[href], [role="button"]');
for (var r = 0; r < roleControls.length; r++) {
  var ct = roleControls[r];
  if (!isRendered(ct) || inVisuallyHidden(ct) || ariaHiddenAncestor(ct)) continue;
  out.c7.controls++;
  var nmc = nameOf(ct).name;
  var expanded = ct.getAttribute("aria-expanded");
  var pressed = ct.getAttribute("aria-pressed");
  var haspopup = ct.getAttribute("aria-haspopup");
  var ctrlIds = (ct.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);

  /* 7a. Nút mở/thu gọn phải công bố aria-expanded (hoặc aria-pressed). */
  if (ctrlIds.length || haspopup !== null) {
    var rec = { sel: sel(ct), name: short(nmc, 34), expanded: expanded, haspopup: haspopup, controls: [], mismatches: [] };
    for (var ci = 0; ci < ctrlIds.length; ci++) {
      var target = document.getElementById(ctrlIds[ci]);
      var info = {
        id: ctrlIds[ci],
        exists: !!target,
        rendered: target ? isRendered(target) : false,
        hiddenAttr: target ? target.hasAttribute("hidden") : false
      };
      rec.controls.push(info);
      if (!target) {
        out.c7.dangling.push({ sel: sel(ct), attr: "aria-controls", id: ctrlIds[ci], why: "trỏ tới id không tồn tại" });
      }
    }
    out.c7.disclosure.push(rec);
    var validExpanded = expanded === "true" || expanded === "false";
    var validPressed = pressed === "true" || pressed === "false";
    if (!validExpanded && !validPressed) {
      out.c7.failures.push({
        sel: sel(ct),
        why: "nút điều khiển vùng ẩn/hiện nhưng thiếu aria-expanded/aria-pressed",
        evidence: "aria-expanded=(không có), aria-pressed=" + (pressed === null ? "(không có)" : "\"" + pressed + "\"") + ", aria-controls=\"" + ctrlIds.join(" ") + "\", aria-haspopup=" + (haspopup === null ? "(không có)" : "\"" + haspopup + "\"")
      });
    } else if (validExpanded) {
      for (var cc = 0; cc < rec.controls.length; cc++) {
        var info2 = rec.controls[cc];
        if (!info2.exists) continue;
        var actuallyHidden = info2.hiddenAttr || !info2.rendered;
        if (expanded === "true" && actuallyHidden) {
          out.c7.failures.push({
            sel: sel(ct),
            why: "aria-expanded=\"true\" nhưng vùng được điều khiển đang bị ẩn",
            evidence: "#" + info2.id + ": hidden=" + info2.hiddenAttr + ", đang vẽ=" + info2.rendered
          });
        } else if (expanded === "false" && !actuallyHidden) {
          out.c7.failures.push({
            sel: sel(ct),
            why: "aria-expanded=\"false\" nhưng vùng được điều khiển vẫn hiển thị",
            evidence: "#" + info2.id + ": hidden=" + info2.hiddenAttr + ", đang vẽ=" + info2.rendered
          });
        }
      }
    }
  }

  /* 7b. aria-pressed phải có giá trị hợp lệ. */
  if (pressed !== null && pressed !== "true" && pressed !== "false") {
    out.c7.failures.push({
      sel: sel(ct),
      why: "aria-pressed có giá trị không hợp lệ",
      evidence: "aria-pressed=\"" + pressed + "\""
    });
  }

  /* 7c. Hook bật/tắt do JS dùng nhưng không công bố trạng thái. */
  var hooks = [];
  for (var ai = 0; ai < ct.attributes.length; ai++) {
    var an = ct.attributes[ai].name;
    if (/^data-.*(toggle|switch|expand|collapse)/.test(an) || /^data-.*-toggle$/.test(an)) hooks.push(an);
  }
  if (hooks.length && pressed === null && expanded === null) {
    out.c7.failures.push({
      sel: sel(ct),
      why: "có hook bật/tắt nhưng không công bố trạng thái",
      evidence: "thuộc tính=" + hooks.join(", ") + ", aria-pressed=(không có), aria-expanded=(không có)"
    });
  }

  /* 7d. Hành động phá huỷ/đổi trạng thái phải công bố trạng thái hoặc có vùng thông báo. */
  var low = (nmc || "").toLowerCase();
  var isDestructive = false;
  for (var d = 0; d < DESTRUCTIVE.length; d++) {
    if (low.indexOf(DESTRUCTIVE[d]) !== -1) { isDestructive = true; break; }
  }
  if (isDestructive) {
    var via = null;
    if (pressed !== null) via = "aria-pressed=\"" + pressed + "\"";
    else if (expanded !== null) via = "aria-expanded=\"" + expanded + "\"";
    else if (haspopup !== null) via = "aria-haspopup=\"" + haspopup + "\"";
    else if (ct.hasAttribute("disabled")) via = "disabled (trạng thái gốc của nút)";
    else if (effectiveLive.length) via = "vùng thông báo toàn trang (" + effectiveLive.length + " vùng: " + short(effectiveLive.map(sel).join(", "), 60) + ")";
    out.c7.destructive.push({ sel: sel(ct), name: short(nmc, 30), via: via });
    if (!via) {
      out.c7.failures.push({
        sel: sel(ct),
        why: "hành động phá huỷ/đổi trạng thái nhưng không công bố trạng thái và trang không có vùng thông báo động",
        evidence: "tên=\"" + short(nmc, 30) + "\", aria-expanded/pressed/haspopup=(không có), vùng thông báo=0"
      });
    }
  }

  /* 7e. Tham chiếu ARIA gãy. */
  var attrs = ["aria-labelledby", "aria-describedby", "aria-owns"];
  for (var a2 = 0; a2 < attrs.length; a2++) {
    var ids = (ct.getAttribute(attrs[a2]) || "").split(/\s+/).filter(Boolean);
    for (var a3 = 0; a3 < ids.length; a3++) {
      if (!document.getElementById(ids[a3])) {
        out.c7.dangling.push({ sel: sel(ct), attr: attrs[a2], id: ids[a3], why: "trỏ tới id không tồn tại" });
      }
    }
  }
}

/* ---------- 8. Vùng trạng thái động ---------- */
for (var v = 0; v < liveAll.length; v++) {
  var ve = liveAll[v];
  var inPre = !!ve.closest("#preloader, .preloader");
  out.c8.liveRegions.push({
    sel: sel(ve),
    role: ve.getAttribute("role"),
    live: ve.getAttribute("aria-live"),
    rendered: isRendered(ve),
    hiddenAttr: ve.hasAttribute("hidden"),
    inPreloader: inPre
  });
  if (inPre) continue;
  if (ariaHiddenAncestor(ve)) {
    out.c8.ariaHiddenLive.push({
      sel: sel(ve),
      why: "vùng thông báo nằm trong aria-hidden=\"true\" nên trình đọc màn hình không nhận được",
      evidence: "role=\"" + (ve.getAttribute("role") || "") + "\", aria-live=\"" + (ve.getAttribute("aria-live") || "") + "\""
    });
  }
  if ((ve.getAttribute("aria-live") || "").toLowerCase() === "off") {
    out.c8.ariaHiddenLive.push({
      sel: sel(ve),
      why: "aria-live=\"off\" — cập nhật sẽ không được thông báo",
      evidence: "role=\"" + (ve.getAttribute("role") || "") + "\""
    });
  }
}
if (!effectiveLive.length) {
  out.c8.failures.push({
    sel: "(toàn trang)",
    why: "trang không có vùng thông báo động nào cho phản hồi bất đồng bộ",
    evidence: "số phần tử [role=status|alert|log], [aria-live] đang có=" + liveAll.length
  });
}
/* Vùng dữ liệu bất đồng bộ (aria-busy, tbody do JS đổ dữ liệu) thiếu vùng thông báo gần đó. */
var asyncNodes = document.querySelectorAll('[aria-busy], tbody[id], [id$="-list"], [id$="-grid"]');
for (var q = 0; q < asyncNodes.length; q++) {
  var an2 = asyncNodes[q];
  if (inVisuallyHidden(an2)) continue;
  if (an2.matches('[role="status"],[role="alert"],[role="log"],[aria-live]')) continue;
  var linked = false;
  for (var w = 0; w < effectiveLive.length; w++) {
    var lv = effectiveLive[w];
    if (lv === an2 || an2.contains(lv) || lv.contains(an2)) { linked = true; break; }
    if (lv.id && (an2.getAttribute("aria-controls") || "").split(/\s+/).indexOf(lv.id) !== -1) { linked = true; break; }
    var box = an2.closest("section, article, form, aside, dialog");
    if (box && box.contains(lv)) { linked = true; break; }
  }
  if (!linked) {
    out.c8.orphans.push({
      sel: sel(an2),
      busy: an2.getAttribute("aria-busy"),
      text: short(an2.textContent, 34),
      note: "chưa thấy vùng thông báo nào gắn trực tiếp (cần người đọc xác nhận)"
    });
  }
}

/* ---------- 9. aria-hidden chứa phần tử nhận focus ---------- */
var hiddenNodes = document.querySelectorAll('[aria-hidden="true"]');
out.c9.ariaHiddenNodes = hiddenNodes.length;
for (var z = 0; z < hiddenNodes.length; z++) {
  var node = hiddenNodes[z];
  if (node.closest("#preloader, .preloader")) continue; // màn tải, không chứa phần tử focus được
  var inner = node.querySelectorAll(FOCUSABLE_SEL);
  for (var y = 0; y < inner.length; y++) {
    var fc = inner[y];
    if (!isFocusableAny(fc)) continue;
    if (!isRendered(fc)) continue;
    if (inVisuallyHidden(fc)) continue; // ô nhập tệp 1×1px: chủ ý của thiết kế
    if (isTabbable(fc)) {
      out.c9.failures.push({
        sel: sel(fc),
        container: sel(node),
        why: "phần tử nằm trong tab order nhưng bị aria-hidden=\"true\" che khỏi trình đọc màn hình",
        evidence: "vùng aria-hidden=\"" + sel(node) + "\", tabindex=" + (fc.getAttribute("tabindex") === null ? "(gốc)" : "\"" + fc.getAttribute("tabindex") + "\"")
      });
    } else {
      out.c9.warnings.push({
        sel: sel(fc),
        container: sel(node),
        why: "tabindex=\"-1\" trong vùng aria-hidden (chỉ focus được bằng lập trình)",
        evidence: "vùng aria-hidden=\"" + sel(node) + "\""
      });
    }
  }
}

/* ---------- 10. Trùng id ---------- */
var idMap = {};
var idNodes = document.querySelectorAll("[id]");
out.c10.ids = idNodes.length;
for (var n2 = 0; n2 < idNodes.length; n2++) {
  var theId = idNodes[n2].id;
  if (!theId) continue;
  if (!idMap[theId]) idMap[theId] = [];
  idMap[theId].push(idNodes[n2]);
}
for (var key in idMap) {
  if (!Object.prototype.hasOwnProperty.call(idMap, key)) continue;
  if (idMap[key].length > 1) {
    out.c10.duplicates.push({
      id: key,
      count: idMap[key].length,
      rendered: idMap[key].filter(isRendered).length,
      sels: idMap[key].slice(0, 4).map(sel),
      why: "id=\"" + key + "\" xuất hiện " + idMap[key].length + " lần"
    });
  }
}

/* ---------- Kiểm tra phụ: phần tử có [hidden] nhưng vẫn được vẽ ---------- */
var hiddenAttrNodes = document.querySelectorAll("[hidden]");
for (var hh = 0; hh < hiddenAttrNodes.length; hh++) {
  if (isRendered(hiddenAttrNodes[hh])) {
    out.extra.hiddenButRendered.push({ sel: sel(hiddenAttrNodes[hh]), why: "có thuộc tính hidden nhưng CSS vẫn vẽ ra" });
  }
}

return out;
`;

/* =====================================================================
   PHÉP ĐO FOCUS (kiểm 5) — thay đổi trạng thái focus của trang nên chạy riêng.
   ===================================================================== */
const PROBE_FOCUS =
  PAGE_HELPERS +
  String.raw`
var out = { samples: [], skipped: [], changedProps: {} };
var KEY_PROPS = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "borderColor", "backgroundColor", "color", "opacity", "transform"];

function snapshot(el) {
  var cs = getComputedStyle(el);
  var snap = {};
  for (var i = 0; i < KEY_PROPS.length; i++) snap[KEY_PROPS[i]] = cs[KEY_PROPS[i]];
  return snap;
}

/*
  Trả về danh sách khai báo focus thực sự áp dụng cho phần tử.

  Dùng chính API khớp selector của trình duyệt (el.matches) để hỏi từng quy tắc
  có :focus/:focus-visible khớp với phần tử này không. Nếu trình duyệt không cho
  đọc cssRules (chặn CORS) hoặc không tìm thấy quy tắc nào, trả về mảng rỗng để
  phần tử bị tính là không có kiểu focus.
*/
function authoredFocusStyle(el) {
  var found = [];
  for (var s = 0; s < document.styleSheets.length; s++) {
    var rules;
    try { rules = document.styleSheets[s].cssRules; } catch (err) { continue; }
    if (!rules) continue;
    found = found.concat(scanRules(rules, el));
  }
  return found;
}

function scanRules(rules, el) {
  var out = [];
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var sel = rule.selectorText;
    /*
      QUAN TRỌNG — phải xét selectorText TRƯỚC cssRules.
      Trình duyệt hiện đại gắn thuộc tính cssRules (rỗng) cho CẢ quy tắc thường,
      nên nếu kiểm tra cssRules trước thì mọi quy tắc đều bị coi là nhóm và bị
      đệ quy vào danh sách rỗng — không bao giờ đọc được selectorText.
    */
    if (sel) {
      if (sel.indexOf(":focus") === -1) continue;
      var ok = false;
      try { ok = el.matches(sel); } catch (err) { ok = false; }
      if (!ok) continue;
      var decl = [];
      for (var j = 0; j < rule.style.length; j++) {
        var name = rule.style[j];
        decl.push(name + ": " + rule.style.getPropertyValue(name));
      }
      if (decl.length) out.push("quy tắc " + sel + " → " + decl.join("; "));
      continue;
    }
    if (rule.cssRules) out = out.concat(scanRules(rule.cssRules, el));
  }
  return out;
}
function diff(a, b) {
  var changed = [];
  for (var i = 0; i < KEY_PROPS.length; i++) {
    var k = KEY_PROPS[i];
    if (a[k] !== b[k]) changed.push(k + ": " + a[k] + " → " + b[k]);
  }
  return changed;
}

var cands = [];
var raw = document.querySelectorAll(FOCUSABLE_SEL);
for (var i = 0; i < raw.length; i++) {
  var el = raw[i];
  if (!isTabbable(el)) continue;
  if (!isRendered(el)) continue;
  if (inVisuallyHidden(el)) continue;
  if (ariaHiddenAncestor(el)) continue;
  cands.push(el);
}

/* Lấy mẫu trải đều trên trang để phủ cả thanh trên, nội dung và chân trang. */
var MAXN = __FOCUS_SAMPLE__;
var sample = [];
if (cands.length <= MAXN) {
  sample = cands;
} else {
  for (var s = 0; s < MAXN; s++) {
    var idx = Math.round((s * (cands.length - 1)) / (MAXN - 1));
    if (sample.indexOf(cands[idx]) === -1) sample.push(cands[idx]);
  }
}

for (var m = 0; m < sample.length; m++) {
  var target = sample[m];
  try {
    if (target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "center" });
  } catch (err) { /* bỏ qua */ }
  var prior = document.activeElement;
  if (prior && prior !== document.body && typeof prior.blur === "function") prior.blur();
  var before = snapshot(target);
  try { target.focus(); } catch (err2) { /* bỏ qua */ }
  var isActive = document.activeElement === target;
  var after = snapshot(target);
  var focusVisible = false;
  try { focusVisible = target.matches(":focus-visible"); } catch (err3) { /* bỏ qua */ }
  var changed = diff(before, after);

  /*
    Nhiều phần tử chuyển trạng thái focus bằng transition (ví dụ .skip-link mất
    220ms để opacity đi từ 0 lên 1). Đọc getComputedStyle() ngay sau focus() sẽ
    bắt được giá trị TRUNG GIAN, thậm chí đúng bằng giá trị cũ, và bị kết luận
    oan là "không đổi kiểu". Vì vậy nếu chưa thấy khác biệt, ta hỏi thẳng trình
    duyệt xem có quy tắc :focus/:focus-visible nào thực sự áp dụng không — đó
    mới là bằng chứng về việc CÓ kiểu focus được khai báo.
  */
  if (!changed.length && isActive) {
    var authored = authoredFocusStyle(target);
    if (authored.length) changed = authored;
  }
  var rec = {
    sel: sel(target),
    tag: target.tagName.toLowerCase(),
    focused: isActive,
    focusVisible: focusVisible,
    changed: changed,
    text: short(visibleTextOf(target) || target.getAttribute("aria-label"), 28),
    rect: (function () { var r = target.getBoundingClientRect(); return Math.round(r.width) + "×" + Math.round(r.height); })(),
    why: ""
  };
  if (!isActive) {
    rec.why = "gọi focus() nhưng phần tử không nhận được focus";
    out.skipped.push(rec);
  } else {
    if (!changed.length) {
      rec.why = "kiểu tính toán KHÔNG đổi khi focus";
    } else {
      for (var c = 0; c < changed.length; c++) {
        var pname = changed[c].split(":")[0];
        out.changedProps[pname] = (out.changedProps[pname] || 0) + 1;
      }
    }
    out.samples.push(rec);
  }
  var cur = document.activeElement;
  if (cur && cur !== document.body && typeof cur.blur === "function") cur.blur();
}
window.scrollTo(0, 0);
return out;
`;

/* =====================================================================
   PHÉP ĐO GIẢM CHUYỂN ĐỘNG (RM).
   ===================================================================== */
const PROBE_REDUCED =
  PAGE_HELPERS +
  String.raw`
var out = {
  reduced: false,
  preloader: null,
  preloaderHitIsSelf: false,
  invisible: [],
  invisibleCount: 0,
  hit: []
};
try { out.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (err) { out.reduced = false; }

/* ---- #preloader phải kết thúc ở trạng thái ẩn và không chặn cú nhấp ---- */
var pre = document.getElementById("preloader");
if (!pre) {
  out.preloader = { present: false, blocked: false, why: "đã được preloader.js gỡ khỏi DOM" };
} else {
  var pcs = getComputedStyle(pre);
  var pr = pre.getBoundingClientRect();
  var pVisible = pcs.display !== "none" && pcs.visibility !== "hidden" && parseFloat(pcs.opacity) > 0.01;
  var topHit = null;
  if (pr.width > 0 && pr.height > 0) {
    var px = Math.min(window.innerWidth - 1, Math.max(0, pr.left + pr.width / 2));
    var py = Math.min(window.innerHeight - 1, Math.max(0, pr.top + pr.height / 2));
    var hitEl = document.elementFromPoint(px, py);
    topHit = hitEl ? sel(hitEl) : null;
    out.preloaderHitIsSelf = !!(hitEl && (hitEl === pre || pre.contains(hitEl)));
  }
  out.preloader = {
    present: true,
    display: pcs.display,
    visibility: pcs.visibility,
    opacity: pcs.opacity,
    pointerEvents: pcs.pointerEvents,
    visible: pVisible,
    topElement: topHit,
    blocked: pVisible && pcs.pointerEvents !== "none" && out.preloaderHitIsSelf,
    why: ""
  };
}

/* ---- Không phần tử nội dung nào bị bỏ mờ (trừ thứ cố ý ẩn) ---- */
var all = document.querySelectorAll("body *");
for (var i = 0; i < all.length; i++) {
  var el = all[i];
  if (!isRendered(el)) continue;
  if (el.hasAttribute("hidden")) continue;
  if (el.getAttribute("aria-hidden") === "true") continue;
  if (inVisuallyHidden(el)) continue;
  if (el.closest(".skip-link")) continue;      // liên kết bỏ qua: cố ý trong suốt tới khi focus
  if (el.closest("#preloader, .preloader")) continue; // màn tải: cố ý ẩn khi giảm chuyển động
  var cs = getComputedStyle(el);
  if (parseFloat(cs.opacity) <= 0.01) {
    out.invisibleCount++;
    if (out.invisible.length < 8) {
      out.invisible.push({
        sel: sel(el),
        opacity: cs.opacity,
        cls: short(el.className, 34),
        text: short(el.textContent, 30),
        why: "opacity=" + cs.opacity + " nhưng vẫn chiếm chỗ — nội dung không đọc được khi giảm chuyển động"
      });
    }
  }
}

/* ---- Nội dung chính phải vẫn chạm được ---- */
var main = document.getElementById("main-content") || document.querySelector("main");
var cands = [];
var h1 = document.querySelector("h1");
if (h1) cands.push(h1);
if (main) {
  var inner = main.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex="0"]');
  var usable = [];
  for (var u = 0; u < inner.length; u++) {
    var ie = inner[u];
    if (!isRendered(ie)) continue;
    if (inVisuallyHidden(ie) || ariaHiddenAncestor(ie)) continue;
    usable.push(ie);
  }
  if (usable.length) {
    cands.push(usable[0]);
    cands.push(usable[Math.floor(usable.length / 2)]);
    cands.push(usable[usable.length - 1]);
  }
}
var FRACTIONS = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5], [0.5, 0.1], [0.5, 0.9]];
for (var c = 0; c < cands.length; c++) {
  var target = cands[c];
  try { target.scrollIntoView({ block: "center", inline: "center" }); } catch (e1) { /* bỏ qua */ }
  var r = target.getBoundingClientRect();
  var rec = { sel: sel(target), text: short(visibleTextOf(target), 28), rect: Math.round(r.width) + "×" + Math.round(r.height), ok: false, point: null, hit: null, why: "" };
  for (var f = 0; f < FRACTIONS.length; f++) {
    var x = r.left + r.width * FRACTIONS[f][0];
    var y = r.top + r.height * FRACTIONS[f][1];
    if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
    var got = document.elementFromPoint(x, y);
    if (got && (got === target || target.contains(got) || got.contains(target))) {
      rec.ok = true;
      rec.point = [Math.round(x), Math.round(y)];
      rec.hit = sel(got);
      break;
    }
    if (!rec.hit) {
      rec.hit = got ? sel(got) : "null";
      rec.point = [Math.round(x), Math.round(y)];
    }
  }
  if (!rec.ok) {
    rec.why = "không điểm nào bên trong chạm tới phần tử (điểm thử " + (rec.point ? rec.point.join(",") : "—") + " trả về " + (rec.hit || "null") + ")";
  }
  out.hit.push(rec);
}
window.scrollTo(0, 0);
return out;
`;

/* =====================================================================
   PHÍA NODE — điều khiển trình duyệt, tổng hợp và in báo cáo.
   ===================================================================== */

/** Bấm một phím Tab THẬT để trình duyệt chuyển sang "chế độ bàn phím". */
async function primeKeyboard(session) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await session.send("Input.dispatchKeyEvent", {
      type,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      code: "Tab",
      key: "Tab",
    });
  }
  await session.evaluate("window.scrollTo(0, 0); return true;");
}

async function setReducedMotion(session, reduce) {
  await session.send("Emulation.setEmulatedMedia", {
    features: reduce ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
  });
}

function line(char = "─", n = 78) {
  return char.repeat(n);
}

function printFailures(failures, indent = "      ") {
  const shown = failures.slice(0, MAX_LINES);
  for (const f of shown) {
    console.log(`${indent}✗ [kiểm ${f.check}] ${f.sel || "(toàn trang)"}`);
    console.log(`${indent}    lý do   : ${f.why}`);
    if (f.evidence) console.log(`${indent}    đo được : ${f.evidence}`);
  }
  if (failures.length > shown.length) {
    console.log(`${indent}… còn ${failures.length - shown.length} dòng nữa (dùng --raw để xem đủ)`);
  }
}

function printWarnings(warnings, indent = "      ") {
  const shown = warnings.slice(0, MAX_LINES);
  for (const w of shown) {
    console.log(`${indent}! ${w.sel} — ${w.why}`);
    if (w.evidence) console.log(`${indent}    đo được : ${w.evidence}`);
  }
  if (warnings.length > shown.length) {
    console.log(`${indent}… còn ${warnings.length - shown.length} cảnh báo nữa (dùng --raw để xem đủ)`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const session = await launchBrowser();

/*
  Bật mô phỏng "trang đang được focus".

  BẮT BUỘC: cửa sổ Chrome headless không được coi là đang focus, nên dù
  document.activeElement đã đúng, bộ chọn :focus vẫn KHÔNG khớp. Hệ quả là mọi
  phần tử chỉ tô focus bằng :focus (như .skip-link) bị kết luận oan là "không
  đổi kiểu khi focus". Đã kiểm chứng: trước khi bật, a.matches(".skip-link:focus")
  trả false; sau khi bật trả true.
*/
await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const rows = [];
let totalFailures = 0;
let totalWarnings = 0;

console.log(line("="));
console.log("RÀ SOÁT KHẢ NĂNG TIẾP CẬN (A11Y) BẰNG TRÌNH DUYỆT THẬT");
console.log("Chrome DevTools Protocol · " + opts.pages.length + " trang × " + VIEWPORTS.length + " khung nhìn (375×900, 1440×900)");
console.log("Máy chủ: " + opts.base);
console.log(line("="));

for (const page of opts.pages) {
  const url = `${opts.base}/${page}.html`;
  for (const vp of VIEWPORTS) {
    const idxLabel = `[${page} · ${vp.label}]`;
    console.log("\n" + line());
    console.log(`${idxLabel}`);
    console.log(line());

    await session.setViewport(vp.w, vp.h, vp.mobile);
    await setReducedMotion(session, false);
    session.consoleErrors.length = 0;
    await session.goto(url, SETTLE_MS);

    // Đặt chế độ bàn phím TRƯỚC khi đo focus, nếu không :focus-visible sẽ không khớp.
    await primeKeyboard(session);

    let statik;
    let focus;
    try {
      statik = await session.evaluate(PROBE_STATIC);
    } catch (err) {
      console.log(`  ✗ LỖI ĐO (tĩnh): ${err.message}`);
      rows.push({ page, vp: vp.label, failures: [{ check: "?", sel: "(trang)", why: "không đo được: " + err.message }], warnings: [] });
      totalFailures++;
      continue;
    }
    try {
      focus = await session.evaluate(PROBE_FOCUS.replace("__FOCUS_SAMPLE__", String(FOCUS_SAMPLE)));
    } catch (err) {
      focus = { samples: [], skipped: [], changedProps: {}, error: err.message };
    }

    const failures = [];
    const warnings = [];

    for (const f of statik.c1.failures) failures.push({ check: "1", ...f });
    for (const f of statik.c2.failures) failures.push({ check: "2", ...f });
    for (const f of statik.c3.missing) failures.push({ check: "3", ...f });
    for (const f of statik.c4.failures) failures.push({ check: "4", ...f });
    const focusFailures = (focus.samples || []).filter((s) => !s.changed.length);
    for (const f of focusFailures) {
      failures.push({
        check: "5",
        sel: f.sel,
        why: f.why + (f.focusVisible ? " (khớp :focus-visible nhưng kiểu không đổi)" : ""),
        evidence:
          "kích thước=" + f.rect + ", focus-visible=" + (f.focusVisible ? "có" : "không") +
          ", outline/box-shadow/border/background/color/opacity/transform đều giữ nguyên",
      });
    }
    for (const f of statik.c6.positive) failures.push({ check: "6", ...f });
    for (const f of statik.c7.failures) failures.push({ check: "7", ...f });
    for (const f of statik.c7.dangling) failures.push({ check: "7", why: "tham chiếu ARIA gãy: " + f.why + ' (' + f.attr + '="' + f.id + '")', sel: f.sel, evidence: f.attr + '="' + f.id + '" không có phần tử nào' });
    for (const f of statik.c8.failures) failures.push({ check: "8", ...f });
    for (const f of statik.c8.ariaHiddenLive) failures.push({ check: "8", ...f });
    for (const f of statik.c9.failures) failures.push({ check: "9", ...f });
    for (const d of statik.c10.duplicates) {
      failures.push({ check: "10", sel: d.sels.join("  |  "), why: d.why, evidence: "vị trí: " + d.sels.join(" , ") + " (đang vẽ: " + d.rendered + "/" + d.count + ")" });
    }

    for (const w of statik.c8.orphans) warnings.push({ check: "8", sel: w.sel, why: "vùng dữ liệu bất đồng bộ " + w.note, evidence: "aria-busy=" + (w.busy === null ? "(không có)" : '"' + w.busy + '"') + ", nội dung hiện tại=\"" + w.text + "\"" });
    for (const w of statik.c9.warnings) warnings.push({ check: "9", ...w });
    for (const w of statik.extra.hiddenButRendered) warnings.push({ check: "khác", sel: w.sel, why: w.why, evidence: "thuộc tính [hidden] không có tác dụng" });
    if (focus && focus.skipped && focus.skipped.length) {
      for (const s of focus.skipped) warnings.push({ check: "5", sel: s.sel, why: s.why, evidence: "kích thước=" + s.rect });
    }
    if (focus && focus.error) warnings.push({ check: "5", sel: "(trang)", why: "không đo được focus: " + focus.error });

    // ---- In kết quả từng phép kiểm của lượt đo này ----
    const c1ok = statik.c1.failures.length === 0;
    const srcList = Object.entries(statik.c1.sources).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  ${c1ok ? "✓" : "✗"} 1. Nhãn truy cập       : ${statik.c1.evaluated} phần tử trong tab order, ${statik.c1.failures.length} thiếu nhãn` + (srcList ? ` · nguồn: ${srcList}` : ""));
    if (statik.counts.skippedNotRendered || statik.counts.skippedVisuallyHiddenOrHidden) {
      console.log(`       (bỏ qua: ${statik.counts.skippedNotRendered} không được vẽ — ví dụ menu đóng trên di động, ${statik.counts.skippedVisuallyHiddenOrHidden} trong .visually-hidden/aria-hidden)`);
    }

    console.log(`  ${statik.c2.failures.length === 0 ? "✓" : "✗"} 2. Nút chỉ có icon   : ${statik.c2.iconOnly}/${statik.c2.evaluated} nút không có chữ nhìn thấy, ${statik.c2.labeled} có nhãn, ${statik.c2.failures.length} lỗi`);
    for (const s of statik.c2.samples) console.log(`       nhãn đo được: ${s}`);

    console.log(`  ${statik.c3.missing.length === 0 ? "✓" : "✗"} 3. Ảnh có alt         : ${statik.c3.total} ảnh, ${statik.c3.missing.length} thiếu alt, ${statik.c3.emptyAlt} alt="" (trang trí)`);
    for (const s of statik.c3.imgs) console.log(`       ${s}`);

    console.log(`  ${statik.c4.failures.length === 0 ? "✓" : "✗"} 4. Cấu trúc tiêu đề   : ${statik.c4.h1} thẻ h1, ${statik.c4.headings.length} tiêu đề đang vẽ, ${statik.c4.failures.length} lỗi`);
    console.log(`       chuỗi cấp: ${statik.c4.sequence || "(không có tiêu đề nào)"}`);

    const focusOk = focusFailures.length === 0;
    const changedSummary = Object.entries(focus.changedProps || {}).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  ${focusOk ? "✓" : "✗"} 5. Focus nhìn thấy    : ${focus.samples.length} mẫu, ${focusFailures.length} mẫu không đổi kiểu khi focus${changedSummary ? ` · thuộc tính đã đổi: ${changedSummary}` : ""}`);
    for (const s of focus.samples.slice(0, MAX_LINES)) {
      const mark = s.changed.length ? "✓" : "✗";
      console.log(`       ${mark} ${s.sel} (${s.rect})${s.changed.length ? " → " + s.changed.join("; ") : " → KHÔNG đổi"}`);
    }
    if (focus.samples.length > MAX_LINES) console.log(`       … còn ${focus.samples.length - MAX_LINES} mẫu nữa (--raw để xem đủ)`);

    console.log(`  ${statik.c6.positive.length === 0 ? "✓" : "✗"} 6. tabindex dương     : quét ${statik.c6.scanned} phần tử có tabindex, ${statik.c6.positive.length} số dương`);

    const c7ok = failures.every((f) => f.check !== "7");
    const ctrlDesc = statik.c7.disclosure.map((d) => `${d.sel} aria-expanded=${d.expanded}`).join("; ");
    const destDesc = statik.c7.destructive.map((d) => `"${d.name}" → ${d.via || "KHÔNG công bố"}`).join("; ");
    console.log(`  ${c7ok ? "✓" : "✗"} 7. Trạng thái hành động: ${statik.c7.controls} nút/liên kết, ${statik.c7.disclosure.length} nút mở/thu gọn, ${statik.c7.destructive.length} hành động phá huỷ, ${statik.c7.liveRegionCount} vùng thông báo, ${failures.filter((f) => f.check === "7").length} lỗi`);
    if (ctrlDesc) console.log(`       nút mở/thu gọn: ${ctrlDesc}`);
    if (destDesc) console.log(`       hành động phá huỷ: ${destDesc}`);

    const c8ok = failures.every((f) => f.check !== "8");
    const liveDesc = statik.c8.liveRegions.map((l) => `${l.sel}[${l.role || "aria-live=" + l.live}${l.rendered ? "" : ", ẩn"}]`).join(", ");
    console.log(`  ${c8ok ? "✓" : "✗"} 8. Vùng trạng thái    : ${statik.c8.liveRegions.length} vùng thông báo, ${statik.c8.orphans.length} vùng dữ liệu chưa thấy gắn thông báo`);
    if (liveDesc) console.log(`       vùng: ${liveDesc}`);

    console.log(`  ${statik.c9.failures.length === 0 ? "✓" : "✗"} 9. aria-hidden+focus : ${statik.c9.ariaHiddenNodes} vùng aria-hidden, ${statik.c9.failures.length} lỗi, ${statik.c9.warnings.length} cảnh báo`);
    console.log(`  ${statik.c10.duplicates.length === 0 ? "✓" : "✗"} 10. Trùng id          : ${statik.c10.ids} id, ${statik.c10.duplicates.length} id bị trùng`);

    if (statik.extra.hiddenButRendered.length) {
      console.log(`  ! [hidden] nhưng vẫn vẽ: ${statik.extra.hiddenButRendered.length}`);
    }
    if (session.consoleErrors.length) {
      console.log(`  · ghi chú: ${session.consoleErrors.length} lỗi console khi tải (nền: máy chủ xem trước trả lỗi cho /api/*)`);
    }

    if (failures.length) {
      console.log(`\n    --- LỖI (${failures.length}) ---`);
      printFailures(failures);
    }
    if (warnings.length) {
      console.log(`\n    --- CẢNH BÁO (${warnings.length}) ---`);
      printWarnings(warnings);
    }

    // ---- Lượt đo ở chế độ giảm chuyển động ----
    let rm = null;
    try {
      await setReducedMotion(session, true);
      await session.goto(url, SETTLE_REDUCED_MS);
      rm = await session.evaluate(PROBE_REDUCED);
    } catch (err) {
      console.log(`\n  ✗ RM Giảm chuyển động : LỖI ĐO — ${err.message}`);
      failures.push({ check: "RM", sel: "(trang)", why: "không đo được chế độ giảm chuyển động: " + err.message, evidence: "" });
    }
    if (rm) {
      const preOk = !rm.preloader.blocked;
      const invisOk = rm.invisibleCount === 0;
      const hitFails = rm.hit.filter((h) => !h.ok);
      const hitOk = hitFails.length === 0;
      const preDesc = rm.preloader.present
        ? `còn trong DOM (display=${rm.preloader.display}, visibility=${rm.preloader.visibility}, opacity=${rm.preloader.opacity}, pointer-events=${rm.preloader.pointerEvents})`
        : rm.preloader.why;
      console.log(
        `\n  ${preOk && invisOk && hitOk ? "✓" : "✗"} RM Giảm chuyển động : reduced=${rm.reduced} · #preloader ${preOk ? "ẩn/không chặn" : "VẪN CHẶN"} — ${preDesc}`,
      );
      console.log(`       nội dung bị bỏ mờ: ${rm.invisibleCount} · điểm chạm tới nội dung chính: ${rm.hit.filter((h) => h.ok).length}/${rm.hit.length}`);
      for (const h of rm.hit) {
        console.log(`       ${h.ok ? "✓" : "✗"} ${h.sel} "${h.text}" (${h.rect}) ${h.ok ? "chạm được tại " + h.point.join(",") + " → " + h.hit : h.why}`);
      }
      for (const v of rm.invisible.slice(0, 4)) {
        console.log(`       ✗ vô hình: ${v.sel} (${v.cls}) ${v.why}`);
      }
      if (!preOk) {
        failures.push({
          check: "RM",
          sel: "#preloader",
          why: "#preloader vẫn hiển thị/chặn cú nhấp khi bật giảm chuyển động",
          evidence: `display=${rm.preloader.display}, visibility=${rm.preloader.visibility}, opacity=${rm.preloader.opacity}, pointer-events=${rm.preloader.pointerEvents}, phần tử trên cùng tại tâm=${rm.preloader.topElement}`,
        });
      }
      if (!invisOk) {
        failures.push({
          check: "RM",
          sel: rm.invisible[0] ? rm.invisible[0].sel : "(nhiều phần tử)",
          why: `${rm.invisibleCount} phần tử nội dung bị bỏ mờ khi bật giảm chuyển động`,
          evidence: rm.invisible.map((v) => `${v.sel} opacity=${v.opacity}`).join(" ; "),
        });
      }
      for (const h of hitFails) {
        failures.push({
          check: "RM",
          sel: h.sel,
          why: "nội dung chính không chạm được khi bật giảm chuyển động",
          evidence: h.why,
        });
      }
      warnings.push(...rm.invisible.slice(0, 3).map((v) => ({ check: "RM", sel: v.sel, why: v.why, evidence: "opacity=" + v.opacity })));
    }

    // ---- Ghi nhận lượt đo ----
    const rowFailures = failures;
    totalFailures += rowFailures.length;
    totalWarnings += warnings.length;
    rows.push({
      page,
      vp: vp.label,
      statik,
      focus,
      rm,
      failures: rowFailures,
      warnings,
    });
  }
}

/* ===================== TỔNG HỢP ===================== */
console.log("\n" + line("="));
console.log("TỔNG HỢP");
console.log(line("="));
console.log(`  Lượt đo (trang × khung nhìn) : ${rows.length}`);
console.log(`  Tổng LỖI                     : ${totalFailures}`);
console.log(`  Tổng CẢNH BÁO                : ${totalWarnings}`);
console.log("");

const byPage = new Map();
for (const r of rows) {
  if (!byPage.has(r.page)) byPage.set(r.page, { fail: 0, warn: 0, runs: 0 });
  const b = byPage.get(r.page);
  b.fail += r.failures.length;
  b.warn += r.warnings.length;
  b.runs++;
}
console.log("  Theo trang:");
console.log("    trang        lượt đo   lỗi   cảnh báo");
for (const [page, b] of byPage) {
  console.log(`    ${page.padEnd(12)} ${String(b.runs).padStart(5)} ${String(b.fail).padStart(6)} ${String(b.warn).padStart(9)}`);
}

console.log("");
console.log("  Theo phép kiểm tra:");
const byCheck = new Map();
for (const r of rows) {
  for (const f of r.failures) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
}
for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "RM", "?"]) {
  const n = byCheck.get(key) || 0;
  console.log(`    ${String(key).padStart(2)}. ${CHECK_NAMES[key] || "không đo được"}: ${n} lỗi ${n === 0 ? "✓" : "✗"}`);
}

console.log("");
console.log("  Theo khung nhìn:");
for (const vp of VIEWPORTS) {
  const list = rows.filter((r) => r.vp === vp.label);
  const n = list.reduce((acc, r) => acc + r.failures.length, 0);
  console.log(`    ${vp.label.padEnd(20)} : ${n} lỗi`);
}

if (totalFailures) {
  console.log("\n  DANH SÁCH LỖI (ưu tiên theo số phép kiểm bị vi phạm):");
  const flat = [];
  for (const r of rows) for (const f of r.failures) flat.push({ ...f, page: r.page, vp: r.vp });
  const order = new Map([...byCheck.entries()].sort((a, b) => b[1] - a[1]));
  flat.sort((a, b) => (order.get(b.check) || 0) - (order.get(a.check) || 0));
  let i = 0;
  for (const f of flat) {
    i++;
    console.log(`    ${String(i).padStart(2)}. [${f.page} · ${f.vp}] kiểm ${f.check} — ${f.sel}`);
    console.log(`        ${f.why}`);
    if (f.evidence) console.log(`        đo được: ${f.evidence}`);
  }
}

if (opts.json) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(opts.json, JSON.stringify({ base: opts.base, rows, totals: { failures: totalFailures, warnings: totalWarnings } }, null, 2), "utf8");
  console.log(`\n  Chi tiết JSON: ${opts.json}`);
}

if (opts.raw) {
  console.log("\n" + line("="));
  console.log("DỮ LIỆU THÔ");
  console.log(line("="));
  console.log(JSON.stringify(rows, null, 1));
}

await session.close();

console.log("");
console.log(totalFailures ? `KẾT LUẬN: ${totalFailures} lỗi khả năng tiếp cận — thoát 1.` : "KẾT LUẬN: không có lỗi khả năng tiếp cận — thoát 0.");
process.exit(totalFailures > 0 ? 1 : 0);

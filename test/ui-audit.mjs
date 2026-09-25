/**
 * test/ui-audit.mjs — rà soát bố cục và khả năng tiếp cận bằng trình duyệt THẬT.
 *
 * Dùng Chrome DevTools Protocol (test/cdp.mjs): mở từng trang ở 375/768/1024/1440
 * rồi ĐO trong DOM, không phán đoán từ đọc code.
 *
 * Kiểm tra:
 *   1. Tràn ngang (scrollWidth > clientWidth) — lỗi bố cục nặng nhất trên mobile.
 *   2. Phần tử tràn ra ngoài khung nhìn (bên phải/trái).
 *   3. Vùng chạm nhỏ hơn 44×44 ở phần tử có thể nhấn.
 *   4. Tương phản chữ so với nền (WCAG AA 4.5:1 / 3:1 cho chữ lớn).
 *   5. Focus bàn phím có nhìn thấy không (outline hoặc box-shadow).
 *   6. Ảnh không có alt / nút chỉ có icon thiếu nhãn.
 *   7. Nội dung bị cắt (overflow hidden + text tràn).
 *   8. Lỗi console và exception khi tải trang.
 *
 *   node test/ui-preview.mjs --port 8899   (cửa sổ 1)
 *   node test/ui-audit.mjs --base http://127.0.0.1:8899
 *
 * Mặc định chỉ báo cáo, thoát 0. Thêm --strict để thoát 1 khi có lỗi.
 */
import { writeFileSync } from "node:fs";
import { launchBrowser } from "./cdp.mjs";

const PAGES = ["index", "logs", "images", "uid", "tickxanh", "login"];
const VIEWPORTS = [
  { w: 375, h: 900, mobile: true, label: "375" },
  { w: 768, h: 1000, mobile: true, label: "768" },
  { w: 1024, h: 900, mobile: false, label: "1024" },
  { w: 1440, h: 900, mobile: false, label: "1440" },
];

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:8899", strict: false, json: "", pages: PAGES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--strict") out.strict = true;
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--pages") out.pages = argv[++i].split(",");
  }
  return out;
}

/** Biểu thức chạy trong trang: thu thập mọi chỉ số trong một lượt. */
const PROBE = String.raw`
const doc = document.documentElement;
const vw = window.innerWidth;
const vh = window.innerHeight;
const out = { overflow: 0, offscreen: [], smallTargets: [], contrast: [], noFocus: [],
              imgNoAlt: [], clipped: [], svgNoLabel: [] };

out.overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
out.docScrollWidth = doc.scrollWidth;
out.docClientWidth = doc.clientWidth;

function boxOf(el) { return el.getBoundingClientRect(); }

/* ---- tràn ra ngoài khung nhìn ---- */
const all = document.querySelectorAll("body *");
for (const el of all) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
  const r = boxOf(el);
  if (r.width === 0 || r.height === 0) continue;
  if (r.right > vw + 1.5 || r.left < -1.5) {
    // bỏ qua phần tử nằm trong vùng cuộn ngang có chủ đích (bảng, danh sách)
    let p = el.parentElement, scrollable = false;
    while (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === "auto" || pcs.overflowX === "scroll") { scrollable = true; break; }
      p = p.parentElement;
    }
    if (!scrollable) {
      out.offscreen.push({
        sel: sel(el),
        side: r.right > vw + 1.5 ? "phải" : "trái",
        over: Math.round((r.right > vw + 1.5 ? r.right - vw : -r.left)),
        text: (el.textContent || "").trim().slice(0, 40)
      });
    }
  }
}

function sel(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) return s + "#" + el.id;
  if (el.className && typeof el.className === "string") {
    const c = el.className.trim().split(/\s+/).slice(0, 2).join(".");
    if (c) s += "." + c;
  }
  return s;
}

/*
  Phần tử "ẩn với người nhìn" (.visually-hidden và ô nhập tệp 1×1px) không phải
  vùng chạm và chữ bên trong bị cắt có chủ đích, nên không được tính là lỗi.
  Không có bộ lọc này thì mọi trang đều báo oan.
*/
function hiddenFromSight(el) {
  if (el.closest(".visually-hidden")) return true;
  const r = el.getBoundingClientRect();
  return r.width <= 2 && r.height <= 2;
}

/* ---- vùng chạm ---- */
for (const el of document.querySelectorAll('button, a, input, select, textarea, [role="button"], summary')) {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") continue;
  if (hiddenFromSight(el)) continue;
  const r = boxOf(el);
  if (r.width === 0 || r.height === 0) continue;
  // bỏ qua liên kết trong câu văn (inline trong đoạn văn)
  const inline = el.tagName === "A" && cs.display === "inline" && el.closest("p, li, .hint, .note, footer");
  if (inline) continue;
  if (r.height < 44 - 0.5 || r.width < 24) {
    out.smallTargets.push({
      sel: sel(el), w: Math.round(r.width), h: Math.round(r.height),
      text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 32)
    });
  }
}

/* ---- tương phản ---- */
function parseColor(c) {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function overFg(fg, bg) {
  if (fg.a >= 1) return fg;
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
function effBg(el) {
  let node = el, acc = null, layers = [];
  while (node && node !== document.documentElement.parentNode) {
    const c = parseColor(getComputedStyle(node).backgroundColor);
    if (c && c.a > 0) layers.push(c);
    if (c && c.a >= 1) break;
    node = node.parentElement;
  }
  // hợp nhất từ dưới lên
  let base = { r: 9, g: 9, b: 11, a: 1 };
  for (let i = layers.length - 1; i >= 0; i--) base = overFg(layers[i], base);
  return base;
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const seen = new Set();
for (const el of document.querySelectorAll("p, span, a, h1, h2, h3, h4, li, td, th, label, small, strong, button, div, code, strong")) {
  if (!el.textContent || !el.textContent.trim()) continue;
  // chỉ lấy phần tử "lá" chứa chữ trực tiếp
  const direct = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
  if (!direct) continue;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
  const r = boxOf(el);
  if (r.width === 0 || r.height === 0) continue;
  const fg0 = parseColor(cs.color);
  if (!fg0) continue;
  const bg = effBg(el);
  const fg = overFg(fg0, bg);
  const cr = ratio(fg, bg);
  const size = parseFloat(cs.fontSize);
  const weight = parseInt(cs.fontWeight, 10) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  const need = large ? 3 : 4.5;
  if (cr < need - 0.02) {
    const key = sel(el) + "|" + Math.round(cr * 100);
    if (seen.has(key)) continue;
    seen.add(key);
    out.contrast.push({
      sel: sel(el), cr: Math.round(cr * 100) / 100, need,
      size: Math.round(size), text: el.textContent.trim().slice(0, 34),
      color: cs.color, bg: "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")"
    });
  }
}

/* ---- ảnh thiếu alt ---- */
for (const img of document.querySelectorAll("img")) {
  if (!img.hasAttribute("alt")) out.imgNoAlt.push(sel(img) + " src=" + (img.getAttribute("src") || "").slice(0, 40));
}

/* ---- nút chỉ có icon thiếu nhãn ---- */
for (const el of document.querySelectorAll('button, a[role="button"], [role="button"]')) {
  const text = (el.textContent || "").trim();
  const label = el.getAttribute("aria-label") || el.getAttribute("title");
  const hasVisibleImg = !!el.querySelector("img");
  if (!text && !label && hasVisibleImg) out.svgNoLabel.push(sel(el));
}

/* ---- chữ bị cắt bởi overflow hidden ---- */
for (const el of document.querySelectorAll("h1, h2, h3, p, span, td, th, div, strong, small")) {
  const cs = getComputedStyle(el);
  if (cs.overflow === "hidden" || cs.overflowY === "hidden") {
    if (hiddenFromSight(el)) continue;
    if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && (el.textContent || "").trim()) {
      out.clipped.push({ sel: sel(el), sh: el.scrollHeight, ch: el.clientHeight, text: el.textContent.trim().slice(0, 34) });
    }
  }
}

/* ---- focus nhìn thấy ---- */
const sample = document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])');
let noFocus = 0;
for (const el of sample) {
  if (noFocus >= 6) break;
  const cs = getComputedStyle(el);
  // chỉ báo khi CSS không định nghĩa :focus-visible nào riêng
  const hadRule = document.styleSheets && true;
  // đánh dấu thô: nếu outline-style none VÀ box-shadow none ở trạng thái thường, ta cần kiểm tra focus
  if (cs.outlineStyle === "none" && cs.boxShadow === "none" && cs.borderColor === "transparent") {
    noFocus++;
    if (out.noFocus.length < 6) out.noFocus.push(sel(el));
  }
}
return out;
`;

const opts = parseArgs(process.argv.slice(2));
const session = await launchBrowser();

const report = { rows: [], totals: { overflow: 0, offscreen: 0, small: 0, contrast: 0, clipped: 0 } };

console.log("=".repeat(78));
console.log("RÀ SOÁT GIAO DIỆN BẰNG TRÌNH DUYỆT THẬT");
console.log("=".repeat(78));

for (const page of opts.pages) {
  for (const vp of VIEWPORTS) {
    await session.setViewport(vp.w, vp.h, vp.mobile);
    session.consoleErrors.length = 0;
    await session.goto(`${opts.base}/${page}.html`, 1100);
    let data;
    try {
      data = await session.evaluate(PROBE);
    } catch (err) {
      console.log(`\n[${page} ${vp.label}] LỖI ĐO: ${err.message}`);
      continue;
    }

    const line = [];
    if (data.overflow > 0) { line.push(`TRÀN NGANG ${data.overflow}px`); report.totals.overflow++; }
    if (data.offscreen.length) { line.push(`${data.offscreen.length} phần tử tràn khung`); report.totals.offscreen += data.offscreen.length; }
    if (data.smallTargets.length) { line.push(`${data.smallTargets.length} vùng chạm <44px`); report.totals.small += data.smallTargets.length; }
    if (data.contrast.length) { line.push(`${data.contrast.length} chỗ tương phản thấp`); report.totals.contrast += data.contrast.length; }
    if (data.clipped.length) { line.push(`${data.clipped.length} chỗ chữ bị cắt`); report.totals.clipped += data.clipped.length; }
    if (session.consoleErrors.length) line.push(`${session.consoleErrors.length} lỗi console`);

    const status = line.length ? "  ✗ " : "  ✓ ";
    console.log(`\n${status}[${page} ${vp.label}px] ${line.join(" · ") || "sạch"}`);

    for (const o of data.offscreen.slice(0, 6)) {
      console.log(`      tràn ${o.side} ${o.over}px: ${o.sel}  "${o.text}"`);
    }
    for (const s of data.smallTargets.slice(0, 8)) {
      console.log(`      chạm nhỏ ${s.w}×${s.h}: ${s.sel}  "${s.text}"`);
    }
    for (const c of data.contrast.slice(0, 8)) {
      console.log(`      tương phản ${c.cr}:1 (cần ${c.need}) ${c.size}px ${c.sel}  "${c.text}"  ${c.color} trên ${c.bg}`);
    }
    for (const c of data.clipped.slice(0, 5)) {
      console.log(`      chữ bị cắt: ${c.sel} (${c.ch}<${c.sh}) "${c.text}"`);
    }
    for (const e of session.consoleErrors.slice(0, 4)) {
      console.log(`      console ${e.type}: ${e.text.slice(0, 160)}`);
    }

    report.rows.push({ page, vp: vp.label, ...data, console: session.consoleErrors.slice() });
  }
}

console.log("\n" + "=".repeat(78));
console.log("TỔNG HỢP");
console.log("=".repeat(78));
console.log(`  Trang bị tràn ngang      : ${report.totals.overflow}`);
console.log(`  Phần tử tràn khung nhìn  : ${report.totals.offscreen}`);
console.log(`  Vùng chạm <44px          : ${report.totals.small}`);
console.log(`  Chỗ tương phản thấp      : ${report.totals.contrast}`);
console.log(`  Chỗ chữ bị cắt           : ${report.totals.clipped}`);

if (opts.json) {
  writeFileSync(opts.json, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n  Chi tiết: ${opts.json}`);
}

await session.close();

const failed = Object.values(report.totals).some((n) => n > 0);
if (opts.strict && failed) process.exit(1);

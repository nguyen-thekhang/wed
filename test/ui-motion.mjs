/**
 * =============================================================================
 * test/ui-motion.mjs — bảo vệ lớp chuyển động
 * =============================================================================
 *
 * Chạy: node test/ui-motion.mjs --base http://127.0.0.1:8899
 *
 * Lớp chuyển động rất dễ hỏng mà không ai nhận ra: rule có trong file nhưng
 * không bao giờ chạy. Ba lần thực tế:
 *   1. Hover thẻ không nâng vì .reveal.is-visible trong scroll.css đè (rule có,
 *      không ăn).
 *   2. Đếm số luôn ra 0 vì đánh dấu "đã đếm" trước khi kiểm tra giá trị.
 *   3. Ripple và tooltip không xuất hiện.
 *
 * Vì vậy bài này ĐO HÀNH VI bằng trình duyệt thật, không đọc CSS.
 * Cần: `npm run ui:preview` đang chạy.
 */
import { launchBrowser } from "./cdp.mjs";

const argBase = process.argv.indexOf("--base");
const BASE = argBase >= 0 ? process.argv[argBase + 1] : "http://127.0.0.1:8899";

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
  }
}

/** Đọc translateY từ transform dạng matrix(). */
function tyOf(t) {
  const m = /,\s*(-?[\d.]+)\)$/.exec(String(t));
  return m ? parseFloat(m[1]) : 0;
}

const session = await launchBrowser();

try {
  /* =======================================================================
     1) TẢI TRANG — motion.js phải nạp được
     ===================================================================== */
  console.log("=== 1. SCRIPT VÀ CSS CHUYỂN ĐỘNG ===");
  await session.setViewport(1440, 1000, false);
  await session.goto(`${BASE}/index.html`, 2200);
  await session.evaluate(`
    var p = document.getElementById("preloader");
    if (p && p.parentNode) p.parentNode.removeChild(p);
    return true;
  `);

  const loaded = await session.evaluate(`
    var srcs = [];
    document.querySelectorAll("script[src], link[rel=stylesheet]").forEach(function (e) {
      srcs.push(e.getAttribute("src") || e.getAttribute("href"));
    });
    return {
      motionJs: srcs.some(function (s) { return /motion\.js/.test(s); }),
      motionCss: srcs.some(function (s) { return /motion\.css/.test(s); }),
      api: typeof window.MotionFX === "object" && typeof window.MotionFX.runCounters === "function"
    };
  `);
  ok(loaded.motionJs, "motion.js được nạp trong HTML");
  ok(loaded.motionCss, "motion.css được nạp trong HTML");
  ok(loaded.api, "window.MotionFX.runCounters tồn tại");

  /* =======================================================================
     2) THẺ NÂNG KHI RÊ — đo bằng chuột thật
     ===================================================================== */
  console.log("\n=== 2. THẺ NÂNG KHI RÊ CHUỘT ===");
  await session.evaluate(`
    var c = document.querySelector(".kpi");
    c.scrollIntoView({ block: "center" });
    document.querySelectorAll(".reveal").forEach(function (e) {
      e.style.opacity = "1"; e.style.transform = "none";
    });
    return true;
  `);
  await new Promise((r) => setTimeout(r, 500));

  const kpiBox = await session.evaluate(`
    var c = document.querySelector(".kpi");
    if (!c) return null;
    var r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  ok(kpiBox !== null, "tìm thấy thẻ .kpi");

  if (kpiBox) {
    const readT = () => session.evaluate(`return getComputedStyle(document.querySelector(".kpi")).transform;`);
    const rest = tyOf(await readT());

    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: kpiBox.x, y: kpiBox.y });
    await new Promise((r) => setTimeout(r, 700));
    const on = tyOf(await readT());

    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await new Promise((r) => setTimeout(r, 700));
    const off = tyOf(await readT());

    ok(Math.abs(rest) < 0.5, "nghỉ: thẻ phẳng", `y=${rest}`);
    ok(on < -1, "rê chuột: thẻ nâng lên", `y=${on}`);
    ok(Math.abs(off) < 0.5, "rê ra: thẻ hạ về phẳng", `y=${off}`);

    /*
      Cạm bẫy đã gặp: .reveal.is-visible trong scroll.css khai báo
      transform: translateY(0), cùng độ đặc hiệu với .kpi:hover nhưng nạp SAU
      nên thắng. Test này bắt được đúng lỗi đó — đọc CSS thì không thấy.
    */
    ok(Math.abs(on + 4) < 1.5, "độ nâng đúng 4px (không quá ngưỡng khuyến nghị)", `y=${on}`);
  }

  /* =======================================================================
     3) RIPPLE KHI NHẤN
     ===================================================================== */
  console.log("\n=== 3. RIPPLE KHI NHẤN ===");
  const rip = await session.evaluate(`
    var btn = document.querySelector(".btn");
    if (!btn) return { err: "không có nút" };
    var r = btn.getBoundingClientRect();
    btn.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerType: "mouse", clientX: r.left + 8, clientY: r.top + 8
    }));
    return { n: btn.querySelectorAll(".ripple").length };
  `);
  ok(rip.n === 1, "nhấn nút sinh 1 vòng ripple", `thực tế ${rip.n}`);

  /* =======================================================================
     4) ĐẾM SỐ — mô phỏng đúng thứ tự thật: API về SAU khi trang đã bung
     ===================================================================== */
  console.log("\n=== 4. ĐẾM SỐ (dữ liệu về sau) ===");
  await session.evaluate(`
    var el = document.getElementById("kpi-orders");
    el.removeAttribute("data-counted");
    el.removeAttribute("data-counted-to");
    el.setAttribute("data-count", "4321");
    window.MotionFX.runCounters(document);
    return true;
  `);
  const midText = await session.evaluate(`return (document.getElementById("kpi-orders")||{}).textContent;`);
  await new Promise((r) => setTimeout(r, 1200));
  const endText = await session.evaluate(`return (document.getElementById("kpi-orders")||{}).textContent;`);
  ok(endText === "4.321", "đếm tới đúng giá trị sau khi dữ liệu về muộn", `"${endText}"`);
  ok(midText !== endText, "giá trị thay đổi trong lúc đếm (không nhảy thẳng)", `giữa="${midText}"`);

  /* =======================================================================
     5) MÀU NHẤN HỔ PHÁCH — phải thực sự xuất hiện
     ===================================================================== */
  console.log("\n=== 5. MÀU NHẤN THỨ HAI ===");
  const warm = await session.evaluate(`
    var root = getComputedStyle(document.documentElement);
    var warmVar = root.getPropertyValue("--warm").trim();
    var n = document.querySelectorAll(".kpi.is-warm, [data-tone='warm']").length;
    var applied = false;
    var el = document.querySelector(".kpi.is-warm .kpi-value");
    if (el) {
      // KHÔNG dùng regex có \\s trong chuỗi template: "\\s" sẽ bị nuốt thành
      // "s" khi truyền qua evaluate, biến /180,\\s*83/ thành /180,s*83/ và
      // không khớp "180, 83, 9" có khoảng trắng. Bỏ hết khoảng trắng rồi so
      // chuỗi đơn giản, không lỗi escape.
      var c = getComputedStyle(el).color.replace(/\\s/g, "");
      applied = c === "rgb(180,83,9)";
    }
    return { warmVar: warmVar, count: n, applied: applied, color: el ? getComputedStyle(el).color : null };
  `);
  ok(warm.warmVar.length > 0, "token --warm được định nghĩa", warm.warmVar);
  ok(warm.count > 0, "có thẻ dùng sắc hổ phách", `${warm.count} phần tử`);
  ok(warm.applied, "màu hổ phách thực sự áp dụng lên chữ", `màu thực tế: ${warm.color}`);

  /* =======================================================================
     6) DẢI CỘT XU HƯỚNG
     ===================================================================== */
  console.log("\n=== 6. DẢI CỘT XU HƯỚNG ===");
  const pulse = await session.evaluate(`
    var p = document.querySelector(".hero-pulse");
    if (!p) return { err: "không có" };
    var bars = p.querySelectorAll(".hero-pulse-bars > span");
    return {
      bars: bars.length,
      role: p.getAttribute("role"),
      label: p.getAttribute("aria-label"),
      peak: bars.length ? getComputedStyle(bars[bars.length - 1]).backgroundImage : ""
    };
  `);
  ok(pulse.bars === 12, "có 12 cột", `thực tế ${pulse.bars}`);
  ok(pulse.role === "img", "có role=img");
  ok(!!pulse.label, "có aria-label mô tả", pulse.label || "");
  // Cột đỉnh phải dùng màu nhấn (gradient hổ phách)
  ok(/217,\s*119,\s*6/.test(pulse.peak), "cột đỉnh dùng màu hổ phách");

  /* =======================================================================
     7) NHỊP DỌC — MỘT giá trị duy nhất
     ===================================================================== */
  console.log("\n=== 7. NHỊP DỌC ===");
  const rhythm = await session.evaluate(`
    var main = document.querySelector("main.wrap");
    if (!main) return { err: "không có main.wrap" };
    var kids = Array.prototype.slice.call(main.children).filter(function (e) {
      return e.getBoundingClientRect().height > 0;
    });
    var gaps = [];
    for (var i = 1; i < kids.length; i++) {
      gaps.push(Math.round(kids[i].getBoundingClientRect().top - kids[i-1].getBoundingClientRect().bottom));
    }
    return { gaps: gaps };
  `);
  const unique = [...new Set(rhythm.gaps || [])];
  ok(unique.length <= 1, "mọi khoảng hở bằng nhau", `các giá trị: ${unique.join(", ")}`);

  /* =======================================================================
     8) GIẢM CHUYỂN ĐỘNG — phải tắt sạch
     ===================================================================== */
  console.log("\n=== 8. GIẢM CHUYỂN ĐỘNG ===");
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await session.goto(`${BASE}/index.html`, 2200);
  await new Promise((r) => setTimeout(r, 600));

  const reduced = await session.evaluate(`
    var bars = document.querySelectorAll(".hero-pulse-bars > span");
    var rippleRule = false;
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
      for (var j = 0; j < rules.length; j++) {
        if (rules[j].type === 4) { // media rule
          if (/prefers-reduced-motion/.test(rules[j].conditionText || "")) rippleRule = true;
        }
      }
    }
    return {
      barAnim: bars.length ? getComputedStyle(bars[0]).animationName : "n/a",
      shown: document.querySelectorAll(".reveal.is-visible").length,
      total: document.querySelectorAll(".reveal").length,
      hasReducedBlock: rippleRule
    };
  `);
  ok(reduced.barAnim === "none", "dải cột không chạy animation", `animationName=${reduced.barAnim}`);
  ok(reduced.shown === reduced.total, "mọi khối reveal hiện ngay", `${reduced.shown}/${reduced.total}`);
  ok(reduced.hasReducedBlock, "có khối @media prefers-reduced-motion trong CSS");
} finally {
  await session.close();
}

console.log("\n" + "=".repeat(56));
console.log(`Kết quả: ${pass} đạt, ${fail} lỗi`);
if (failures.length) {
  console.log("Không đạt:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail ? 1 : 0);

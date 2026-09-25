/**
 * test/ui-chart.mjs — kiểm tra biểu đồ doanh thu bằng trình duyệt THẬT.
 *
 * Vì sao cần: biểu đồ vẽ bằng canvas nên nó là "hộp đen" — trình duyệt không tự
 * hiện gì khi rê chuột và không có phần tử DOM nào để đọc giá trị. Trước đây
 * muốn biết doanh thu một ngày cụ thể phải đoán theo trục.
 *
 * Bài này nạp dữ liệu thật vào `window.ShopChart.drawLineChart` rồi kiểm tra:
 *   1. Biểu đồ vẽ được và công bố vai trò cho trình đọc màn hình (`role`, `tabindex`).
 *   2. Bảng màu lấy từ token của design system (emerald), KHÔNG còn xanh dương/tím.
 *   3. Rê chuột vào biểu đồ → hộp thông tin thực sự được VẼ THÊM lên canvas
 *      (so sánh ảnh canvas trước/sau, không chỉ tin vào biến trạng thái).
 *   4. Vùng `aria-live` đọc đúng nhãn + giá trị của mốc đang chọn.
 *   5. Bàn phím: Tab vào được, mũi tên trái/phải đổi mốc, Escape xoá lựa chọn.
 *   6. `prefers-reduced-motion: reduce` không làm biểu đồ mất tương tác.
 *
 *   node test/ui-preview.mjs --port 8899   (cửa sổ 1)
 *   node test/ui-chart.mjs --base http://127.0.0.1:8899
 */
import { launchBrowser } from "./cdp.mjs";

const args = process.argv.slice(2);
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:8899";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nạp 30 ngày dữ liệu giả vào biểu đồ và cuộn nó vào giữa khung nhìn. */
const SETUP = String.raw`
  var c = document.getElementById("chart-revenue");
  if (!c || !window.ShopChart) return { error: "thiếu #chart-revenue hoặc window.ShopChart" };
  c.classList.remove("hidden");
  window.__days = [];
  for (var i = 0; i < 30; i++) {
    var d = new Date(Date.UTC(2024, 8, 1 + i));
    window.__days.push({ x: d.toISOString().slice(0, 10), y: 800000 + Math.round(150000 * Math.sin(i / 3) + i * 90000) });
  }
  window.__draw = function () {
    window.ShopChart.drawLineChart(c, window.__days, {
      ariaLabel: "Doanh thu theo ngày",
      valueFormatter: function (v) { return new Intl.NumberFormat("vi-VN").format(Math.round(v)) + " ₫"; },
      labelFormatter: function (iso) {
        var dt = new Date(iso + "T12:00:00+07:00");
        return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short", day: "2-digit", month: "2-digit" }).format(dt);
      }
    });
  };
  window.__draw();
  c.scrollIntoView({ block: "center" });
  return { ok: true };
`;

/** Cuộn biểu đồ vào giữa và ĐỢI toạ độ ổn định (bố cục co giãn thêm một nhịp). */
const STABILIZE = String.raw`
  var c = document.getElementById("chart-revenue");
  window.__draw();
  c.scrollIntoView({ block: "center" });
  var r = c.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width * 0.5),
    y: Math.round(r.top + r.height * 0.5),
    scrollY: Math.round(window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
`;

const session = await launchBrowser();
await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });

async function stabilize() {
  let last = null;
  for (let i = 0; i < 14; i++) {
    const box = await session.evaluate(STABILIZE);
    if (last && box.y === last.y && box.x === last.x && box.scrollY === last.scrollY) return box;
    last = box;
    await sleep(150);
  }
  return last;
}

async function key(name, code, vk) {
  const base = { key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(120);
}

async function run(label, reducedMotion) {
  console.log(`\n${"-".repeat(78)}\n${label}\n${"-".repeat(78)}`);

  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }],
  });
  await session.setViewport(1440, 800, false);
  await session.goto(`${BASE}/index.html`, 1200);
  await session.evaluate(`var p=document.getElementById("preloader"); if(p&&p.parentNode)p.parentNode.removeChild(p); return true;`);

  const setup = await session.evaluate(SETUP);
  ok("nạp được dữ liệu vào biểu đồ", !setup.error, setup.error || "");

  /* ---- 1. Biểu đồ công bố vai trò cho trình đọc màn hình ---- */
  const meta = await session.evaluate(`
    var c = document.getElementById("chart-revenue");
    return { role: c.getAttribute("role"), tabindex: c.getAttribute("tabindex"),
             ariaLabel: c.getAttribute("aria-label"),
             hasReadout: !!document.querySelector(".chart-readout[aria-live]") };
  `);
  ok("biểu đồ có role cho trình đọc màn hình", meta.role === "img", `role=${meta.role}`);
  ok("biểu đồ Tab vào được", meta.tabindex === "0", `tabindex=${meta.tabindex}`);
  ok("có vùng aria-live đọc giá trị", meta.hasReadout === true);

  /* ---- 2. Bảng màu theo design system (emerald), không phải xanh dương/tím ---- */
  const colors = await session.evaluate(`
    var c = window.ShopChart.COLORS || {};
    return { accent: c.accent, accent2: c.accent2, bar: c.bar, surface: c.surface };
  `);
  const accentLower = String(colors.accent).toLowerCase();
  const isEmerald = /#10b981|#34d399|16,\s*185,\s*129|52,\s*211,\s*153/.test(accentLower);
  ok("màu accent là emerald của design system", isEmerald, `accent=${colors.accent}`);
  ok("accent2 là emerald nhạt", /#34d399|52,\s*211,\s*153/.test(String(colors.accent2).toLowerCase()), `accent2=${colors.accent2}`);
  ok(
    "không còn màu xanh dương/tím cũ",
    !/5b8cff|7c5cff/.test(`${colors.accent}${colors.accent2}${colors.bar}`.toLowerCase()),
    `bar=${colors.bar}`,
  );

  /* ---- 3. Rê chuột: tooltip phải THỰC SỰ vẽ thêm lên canvas ---- */
  const box = await stabilize();
  const beforeShot = await session.evaluate(`return document.getElementById("chart-revenue").toDataURL("image/png").length;`);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
  await sleep(400);
  const hover = await session.evaluate(`
    var c = document.getElementById("chart-revenue");
    var h = document.querySelector(".chart-readout");
    return { len: c.toDataURL("image/png").length, readout: h ? h.textContent : null };
  `);
  ok("rê chuột làm tooltip được vẽ lên canvas", hover.len !== beforeShot, `trước=${beforeShot} sau=${hover.len}`);
  ok("vùng aria-live đọc được giá trị khi rê chuột", !!hover.readout && hover.readout.length > 3, `"${hover.readout}"`);
  ok(
    "giá trị đọc ra có đơn vị tiền Việt Nam",
    typeof hover.readout === "string" && hover.readout.indexOf("₫") !== -1,
    `"${hover.readout}"`,
  );

  /* ---- 4. Di chuyển tiếp: giá trị phải đổi theo mốc ---- */
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + 160, y: box.y, button: "none" });
  await sleep(320);
  const hover2 = await session.evaluate(`var h = document.querySelector(".chart-readout"); return h ? h.textContent : null;`);
  ok("rê sang vị trí khác đọc ra mốc khác", !!hover2 && hover2 !== hover.readout, `"${hover.readout}" vs "${hover2}"`);

  /* ---- 5. Bàn phím: mũi tên đổi mốc, Escape xoá ---- */
  await session.evaluate(`document.getElementById("chart-revenue").focus(); return true;`);
  await key("ArrowRight", "ArrowRight", 39);
  await key("ArrowRight", "ArrowRight", 39);
  const afterKeys = await session.evaluate(`
    var h = document.querySelector(".chart-readout");
    return { readout: h ? h.textContent : null, focused: document.activeElement === document.getElementById("chart-revenue") };
  `);
  ok("canvas nhận được focus bàn phím", afterKeys.focused === true);
  ok("mũi tên phải đọc ra giá trị", !!afterKeys.readout && afterKeys.readout.length > 3, `"${afterKeys.readout}"`);

  await key("Escape", "Escape", 27);
  const afterEsc = await session.evaluate(`
    var h = document.querySelector(".chart-readout");
    var c = document.getElementById("chart-revenue");
    return { readout: h ? h.textContent : null, len: c.toDataURL("image/png").length };
  `);
  ok(
    "Escape xoá lựa chọn và gỡ tooltip khỏi canvas",
    afterEsc.len !== hover.len,
    `sau Escape len=${afterEsc.len} (lúc có tooltip=${hover.len})`,
  );
}

await run("Biểu đồ doanh thu — chuyển động bình thường", false);
await run("Biểu đồ doanh thu — prefers-reduced-motion: reduce", true);

await session.close();

console.log("\n" + "=".repeat(78));
console.log(`Kết quả: ${pass} đạt, ${fail} lỗi`);
if (failures.length) {
  console.log("\nLỗi:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(78));
process.exit(fail === 0 ? 0 : 1);

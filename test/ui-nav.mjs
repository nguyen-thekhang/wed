/**
 * test/ui-nav.mjs — kiểm tra THANH ĐIỀU HƯỚNG DÙNG CHUNG trên trình duyệt thật.
 *
 * Vì sao cần: điều hướng từng là chỗ hỏng nặng nhất của dự án. Mỗi trang dùng
 * một kiểu khác nhau, và trên trang chủ nút menu là một <button> không có
 * JavaScript nào xử lý nên bấm vào KHÔNG có gì xảy ra — người dùng điện thoại
 * không thể chuyển trang. Nút đó còn hiện lơ lửng trên cả màn hình desktop.
 *
 * Bài này kiểm tra đúng những hành vi đó bằng chuột và bàn phím thật:
 *   1. Mọi trang đã đăng nhập dùng đúng một mẫu <details class="nav-shell">.
 *   2. Ở 375px: menu đóng lúc đầu, bấm nút thì mở và nhìn thấy được liên kết.
 *   3. aria-expanded đồng bộ với trạng thái mở.
 *   4. Phím Escape đóng menu và trả focus về nút menu.
 *   5. Ở 1440px: nút menu bị ẩn, liên kết hiện đủ mà không cần bấm gì.
 *   6. Ở 768px: liên kết điều hướng không bị bóp về chiều rộng vô nghĩa.
 *
 *   node test/ui-preview.mjs --port 8899   (cửa sổ 1)
 *   node test/ui-nav.mjs --base http://127.0.0.1:8899
 */
import { launchBrowser } from "./cdp.mjs";

const PAGES = ["index", "logs", "images", "uid", "tickxanh"];

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

/** Trạng thái điều hướng đo được trong trang. */
const NAV_STATE = String.raw`
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("nav-toggle");
  if (!nav || !toggle) return { missing: true };
  var toggleBox = toggle.getBoundingClientRect();
  var navBox = nav.getBoundingClientRect();
  var toggleStyle = getComputedStyle(toggle);
  var links = [];
  var anchors = nav.querySelectorAll("a");
  for (var i = 0; i < anchors.length; i++) {
    var r = anchors[i].getBoundingClientRect();
    links.push({ w: Math.round(r.width), h: Math.round(r.height) });
  }
  /*
    "Nhìn thấy được" được đo bằng HIT-TEST: đặt điểm giữa phần tử rồi hỏi trình
    duyệt phần tử nào thực sự nằm trên cùng tại điểm đó.

    Không dùng checkVisibility(): khi <details> đóng, Chrome coi nội dung là
    "không được vẽ" kể cả lúc CSS cố tình cho thanh điều hướng hiện thành hàng
    ngang ở màn hình lớn — đo bằng nó sẽ báo sai. Cũng không dùng
    getBoundingClientRect(): hộp vẫn đo được dù không ai nhìn thấy.
  */
  function hitTestable(node) {
    var r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
    var y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
    var hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    return hit === node || node.contains(hit);
  }

  function anyLinkVisible() {
    for (var i = 0; i < anchors.length; i++) {
      if (hitTestable(anchors[i])) return true;
    }
    return false;
  }

  return {
    missing: false,
    open: nav.classList.contains("is-open"),
    ariaExpanded: toggle.getAttribute("aria-expanded"),
    toggleVisible: toggleStyle.display !== "none" && toggleBox.width > 0 && hitTestable(toggle),
    navVisible: anyLinkVisible(),
    linkCount: anchors.length,
    links: links,
    navRect: { top: Math.round(navBox.top), height: Math.round(navBox.height) },
    toggleCenter: {
      x: Math.round(toggleBox.left + toggleBox.width / 2),
      y: Math.round(toggleBox.top + toggleBox.height / 2)
    }
  };
`;

const session = await launchBrowser();

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Màn hình chờ phủ toàn trang; phải đợi nó gỡ trước khi bấm vào thanh điều hướng. */
async function waitForPreloader(timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const gone = await session.evaluate(`
      var p = document.getElementById("preloader");
      if (!p) return true;
      var cs = getComputedStyle(p);
      return cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05;
    `);
    if (gone) return true;
    await sleep(150);
  }
  return false;
}

async function openPage(url) {
  await session.goto(url, 400);
  await waitForPreloader();
  await sleep(120);
}

async function click(x, y) {
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(260);
}

async function pressEscape() {
  const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await sleep(260);
}

console.log("=".repeat(78));
console.log("KIỂM TRA ĐIỀU HƯỚNG DÙNG CHUNG BẰNG TRÌNH DUYỆT THẬT");
console.log("=".repeat(78));

for (const page of PAGES) {
  console.log(`\n[${page}.html]`);
  const url = `${BASE}/${page}.html`;

  /* ---- 375px: menu đóng, mở được bằng chuột, đóng được bằng Escape ---- */
  await session.setViewport(375, 900, true);
  await openPage(url);

  let s = await session.evaluate(NAV_STATE);
  ok("dùng đúng một mẫu nav-toggle + nav", !s.missing);
  if (s.missing) continue;

  ok("375px: nút menu hiện ra", s.toggleVisible);
  ok("375px: menu đóng lúc đầu", s.open === false && s.navVisible === false, `open=${s.open} navVisible=${s.navVisible}`);
  ok('375px: aria-expanded="false" khi đóng', s.ariaExpanded === "false", s.ariaExpanded);
  ok("có đủ 5 liên kết điều hướng", s.linkCount === 5, `nhận ${s.linkCount}`);

  await click(s.toggleCenter.x, s.toggleCenter.y);
  s = await session.evaluate(NAV_STATE);
  ok("375px: bấm nút thì menu MỞ", s.open === true && s.navVisible === true, `open=${s.open} navVisible=${s.navVisible}`);
  ok('375px: aria-expanded="true" khi mở', s.ariaExpanded === "true", s.ariaExpanded);

  await pressEscape();
  s = await session.evaluate(NAV_STATE);
  ok("375px: Escape đóng menu", s.open === false && s.navVisible === false);
  ok(
    "375px: Escape trả focus về nút menu",
    await session.evaluate('return document.activeElement === document.getElementById("nav-toggle");'),
  );

  /* ---- 768px: liên kết không bị bóp width ---- */
  await session.setViewport(768, 1000, true);
  await openPage(url);
  s = await session.evaluate(NAV_STATE);
  const tiny = s.links.filter((l) => l.w < 40).length;
  ok("768px: không liên kết nào bị bóp dưới 40px", tiny === 0, `${tiny} liên kết bị bóp: ${JSON.stringify(s.links)}`);
  ok("768px: nút menu đã ẩn", s.toggleVisible === false);
  ok("768px: liên kết hiện sẵn", s.navVisible === true);

  /* ---- 1440px: thanh ngang đầy đủ, không còn nút menu lơ lửng ---- */
  await session.setViewport(1440, 900, false);
  await openPage(url);
  s = await session.evaluate(NAV_STATE);
  ok("1440px: nút menu bị ẩn hoàn toàn", s.toggleVisible === false);
  ok("1440px: liên kết hiện sẵn", s.navVisible === true);
  ok("1440px: thanh điều hướng nằm trong thanh trên cùng", s.navRect.top < 90, `top=${s.navRect.top}`);
}

await session.close();

console.log("\n" + "=".repeat(78));
console.log(`Kết quả: ${pass} đạt, ${fail} lỗi`);
if (failures.length) {
  console.log("\nLỗi:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(78));
process.exit(fail === 0 ? 0 : 1);

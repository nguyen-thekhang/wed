/**
 * test/ui-shot-cdp.mjs — chụp ảnh giao diện qua DevTools Protocol.
 *
 * Vì sao cần bản này: `test/ui-shots.mjs` gọi `chrome --screenshot` một lần rồi
 * thoát, nên màn hình chờ (preloader) chạy bằng requestAnimationFrame có thể
 * chưa kịp gỡ và ảnh chụp ra chỉ thấy màn hình "Đang tải".
 *
 * Bản này giữ trình duyệt mở, bật `prefers-reduced-motion: reduce` (app.css ẩn
 * màn hình chờ ở chế độ này) rồi mới chụp, nên ảnh luôn là nội dung thật.
 *
 *   node test/ui-preview.mjs --port 8899
 *   node test/ui-shot-cdp.mjs --out .ui-shots
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./cdp.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const PAGES = ["index", "logs", "images", "uid", "tickxanh", "login"];
const VIEWPORTS = [
  { w: 375, h: 900, mobile: true },
  { w: 768, h: 1000, mobile: true },
  { w: 1024, h: 1000, mobile: false },
  { w: 1440, h: 1000, mobile: false },
];

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:8899", dir: ".ui-shots", pages: PAGES, vps: VIEWPORTS, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--out") out.dir = argv[++i];
    else if (a === "--pages") out.pages = argv[++i].split(",");
    else if (a === "--full") out.full = true;
    else if (a === "--sizes") {
      out.vps = argv[++i].split(",").map((s) => {
        const [w, h] = s.split("x").map(Number);
        return { w, h, mobile: w < 900 };
      });
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const outDir = resolve(ROOT, opts.dir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const session = await launchBrowser();

// Ẩn màn hình chờ: app.css tắt nó khi người dùng chọn giảm chuyển động.
await session.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});

let ok = 0;
for (const page of opts.pages) {
  for (const vp of opts.vps) {
    await session.setViewport(vp.w, vp.h, vp.mobile);
    await session.goto(`${opts.base}/${page}.html`, 700);

    // Gỡ màn hình chờ nếu JavaScript chưa kịp làm việc đó.
    await session.evaluate(`
      var p = document.getElementById("preloader");
      if (p && p.parentNode) p.parentNode.removeChild(p);
      return true;
    `);

    const shot = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: opts.full,
    });
    const name = `${page}-${vp.w}x${vp.h}.png`;
    await writeFile(join(outDir, name), Buffer.from(shot.data, "base64"));
    console.log(`  ✓ ${name}`);
    ok++;
  }
}

await session.close();
console.log(`\nChụp được ${ok} ảnh vào ${outDir}`);

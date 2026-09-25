/**
 * test/ui-shots.mjs — chụp ảnh giao diện ở nhiều mốc màn hình để kiểm tra bố cục.
 *
 * Dùng Chrome/Edge có sẵn trên máy (không tải thêm gì, không thêm dependency).
 * Cần chạy kèm `node test/ui-preview.mjs` ở cửa sổ khác.
 *
 *   node test/ui-preview.mjs --port 8899
 *   node test/ui-shots.mjs --out .ui-shots
 *
 * Ảnh lưu vào thư mục --out theo tên `<trang>-<rộng>x<cao>.png`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const PAGES = ["index", "logs", "images", "uid", "tickxanh", "login"];
const VIEWPORTS = [
  { w: 375, h: 900 },
  { w: 768, h: 1000 },
  { w: 1024, h: 1000 },
  { w: 1440, h: 1000 },
];

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:8899", dir: ".ui-shots", pages: PAGES, vps: VIEWPORTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--out") out.dir = argv[++i];
    else if (a === "--pages") out.pages = argv[++i].split(",");
    else if (a === "--sizes") out.vps = argv[++i].split(",").map((s) => {
      const [w, h] = s.split("x").map(Number);
      return { w, h };
    });
  }
  return out;
}

function findBrowser() {
  for (const c of CHROME_CANDIDATES) {
    try {
      if (c && existsSync(c)) return c;
    } catch {
      /* bỏ qua đường dẫn không hợp lệ */
    }
  }
  return null;
}

function shoot(browser, url, file, vp) {
  return new Promise((resolveShot) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--force-device-scale-factor=1",
      `--window-size=${vp.w},${vp.h}`,
      `--screenshot=${file}`,
      `--virtual-time-budget=4000`,
      url,
    ];
    const child = spawn(browser, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolveShot(false);
    }, 30000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveShot(code === 0 && existsSync(file));
    });
  });
}

const opts = parseArgs(process.argv.slice(2));
const browser = findBrowser();
if (!browser) {
  console.error("Không tìm thấy Chrome hoặc Edge. Bỏ qua bước chụp ảnh.");
  process.exit(2);
}

const outDir = resolve(ROOT, opts.dir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

console.log(`Trình duyệt: ${browser}`);
console.log(`Đầu ra    : ${outDir}\n`);

let ok = 0;
let fail = 0;
for (const page of opts.pages) {
  for (const vp of opts.vps) {
    const name = `${page}-${vp.w}x${vp.h}.png`;
    const file = join(outDir, name);
    const url = `${opts.base}/${page}.html`;
    const done = await shoot(browser, url, file, vp);
    console.log(`  ${done ? "✓" : "✗"} ${name}`);
    if (done) ok++;
    else fail++;
  }
}

console.log(`\nChụp được ${ok} ảnh, lỗi ${fail}.`);
process.exit(fail === 0 ? 0 : 1);

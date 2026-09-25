/**
 * Thêm/ghi đè tham số version vào mọi link CSS và script JS cục bộ trong 6 trang.
 *
 * Vì sao: production trả app.css với `Cache-Control: public, max-age=0` nhưng
 * Cloudflare vẫn HIT ở edge và trình duyệt có thể giữ bản cũ; chủ shop từng báo
 * "vẫn thấy như cũ" sau khi đã deploy. Version hoá URL đảm bảo mỗi lần đổi nội
 * dung là một URL mới, không thể lấy nhầm bản cache.
 *
 * Cách dùng:
 *     node tools/cache-bust.mjs            # tự tính hash nội dung
 *     node tools/cache-bust.mjs --set v7   # đặt thủ công
 *
 * Ghi UTF-8, giữ nguyên kiểu xuống dòng của từng tệp.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PAGES = ["index", "logs", "images", "uid", "tickxanh", "login"];
const ASSETS = [
  "public/css/app.css",
  "public/css/pages.css",
  "public/css/scroll.css",
  "public/css/preloader.css",
  "public/js/scroll.js",
  "public/js/nav.js",
  "public/js/confirm.js",
  "public/js/chart.js",
  "public/js/dashboard.js",
  "public/js/logs.js",
  "public/js/images.js",
  "public/js/uid.js",
  "public/js/tickxanh.js",
  "public/js/login.js",
  "public/js/preloader.js",
];

const args = process.argv.slice(2);
const setIdx = args.indexOf("--set");
const manual = setIdx >= 0 ? args[setIdx + 1] : null;

/* Version = hash gộp nội dung mọi asset, nên tự đổi khi có bất kỳ thay đổi nào. */
const h = createHash("sha256");
for (const a of ASSETS) {
  try {
    h.update(readFileSync(a));
  } catch {
    /* tệp không tồn tại thì bỏ qua */
  }
}
const version = manual || h.digest("hex").slice(0, 8);

console.log(`Version: ${version}${manual ? " (đặt thủ công)" : " (hash nội dung)"}`);

/** Gắn ?v= vào href/src của asset cục bộ, bỏ query cũ nếu có. */
function bust(html) {
  return html
    .replace(/(href|src)="(\/(?:css|js)\/[^"?]+\.(?:css|js))(\?v=[^"]*)?"/g, (_m, attr, path) => `${attr}="${path}?v=${version}"`)
    .replace(/(href|src)="(\/(?:css|js)\/[^"?]+\.(?:css|js))\?v=[^"]*"/g, (_m, attr, path) => `${attr}="${path}?v=${version}"`);
}

let total = 0;
for (const page of PAGES) {
  const path = `public/${page}.html`;
  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes("\r\n");
  const html = crlf ? raw.split("\r\n").join("\n") : raw;
  const out = bust(html);
  if (out === html) {
    console.log(`  ${path}: không đổi`);
    continue;
  }
  writeFileSync(path, crlf ? out.split("\n").join("\r\n") : out, "utf8");
  const n = (out.match(/\?v=/g) || []).length;
  console.log(`  ${path}: ${n} tham chiếu đã gắn version`);
  total++;
}
console.log(`Đã cập nhật ${total} trang.`);

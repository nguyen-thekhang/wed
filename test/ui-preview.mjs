/**
 * test/ui-preview.mjs — máy chủ tĩnh chỉ để XEM GIAO DIỆN khi phát triển.
 *
 * Vì sao cần: các trang trong `public/` gọi API qua đường dẫn tuyệt đối
 * (`/css/app.css`, `/js/dashboard.js`), nên mở trực tiếp bằng `file://` sẽ mất
 * toàn bộ CSS/JS. Máy chủ này phục vụ đúng thư mục `public/` để có thể chụp ảnh
 * kiểm tra bố cục ở các mốc 375/768/1024/1440 bằng Chrome headless.
 *
 * KHÔNG phải môi trường thật:
 *   - Không có Worker, không có D1/R2, không có đăng nhập.
 *   - Mọi lời gọi API trả 503 kèm JSON để trang hiện trạng thái lỗi/rỗng.
 *   - Chỉ dùng để kiểm tra giao diện; không dùng để kiểm tra nghiệp vụ.
 *
 *   node test/ui-preview.mjs [--port 8899]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Bảng chuyển hướng giống Worker: /logs -> /logs.html ... */
const PAGES = {
  "/": "index.html",
  "/index": "index.html",
  "/index.html": "index.html",
  "/logs": "logs.html",
  "/logs.html": "logs.html",
  "/images": "images.html",
  "/images.html": "images.html",
  "/uid": "uid.html",
  "/uid.html": "uid.html",
  "/tickxanh": "tickxanh.html",
  "/tickxanh.html": "tickxanh.html",
  "/login": "login.html",
  "/login.html": "login.html",
};

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8899;

function resolveSafe(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) && abs !== ROOT.slice(0, -1)) {
    return null;
  }
  return abs;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  // API: luôn trả JSON rỗng để trang hiện trạng thái rỗng/lỗi thật của nó.
  if (pathname.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "preview", message: "Chế độ xem giao diện, không có dữ liệu." },
      }),
    );
    return;
  }

  const target = PAGES[pathname] ?? pathname;
  const file = resolveSafe(target);

  if (!file) {
    res.writeHead(400).end("Bad request");
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error("directory");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không tìm thấy: " + pathname);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Xem giao diện: http://127.0.0.1:${PORT}/  (thư mục public/)`);
});

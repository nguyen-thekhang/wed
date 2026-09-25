/**
 * =============================================================================
 * src/index.ts — Router trung tâm của Worker shop-dashboard
 * =============================================================================
 *
 * NGUYÊN TẮC BẤT DI BẤT DỊCH:
 *   DB bán hàng có bảng `stock`, cột `content` chứa acc|pass thật.
 *   Web này KHÔNG BAO GIỜ đọc, lưu, log hay trả về cột đó. Chỉ số liệu tổng hợp.
 *
 * Luồng dữ liệu một chiều: VPS → POST /api/sync → D1 → dashboard chỉ đọc.
 * Web không bao giờ gọi ngược vào VPS.
 *
 * Router chỉ làm 3 việc: xác thực, định tuyến, và bọc lỗi.
 * Toàn bộ logic nằm ở src/api/*.ts
 */

import type { Env } from "./lib/response";
import { jsonError, jsonOk, noStore, serverError, logLine, unauthorized } from "./lib/response";
import { requireAuth, unlockLogin, readCookie, sessionCookieName } from "./auth";
import { handleSync } from "./api/sync";
import { handleStats, handleDaily, handleProducts } from "./api/stats";
import { handleLogs, handleSyncLogs } from "./api/logs";
import {
  handleImagesList,
  handleImageUpload,
  handleImageView,
  handleImageDelete,
} from "./api/images";
import { handleLogin, handleLogout, UNLOCK_IP_RE } from "./api/auth-routes";
import { handleFbCheck } from "./api/fbcheck";
import { handleBluecheck, handleBluecheckWatcherRoute } from "./api/bluecheck";

/* -------------------------------------------------------------------------- */
/* Header bảo mật toàn cục                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gắn header bảo mật cho MỌI response đi ra (kể cả asset tĩnh).
 * - CSP chặn tải script/style từ ngoài: dashboard là JS thuần, không CDN.
 *   'unsafe-inline' chỉ cần cho vài thuộc tính style do JS đặt (--delay, width của thanh bar),
 *   không cho phép inline <script> chạy từ dữ liệu.
 * - frame-ancestors 'none' + X-Frame-Options: chống clickjacking.
 */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);

  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  }
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  // Dashboard là công cụ nội bộ: không để cache ở proxy/CDN.
  headers.set("X-Robots-Tag", "noindex, nofollow");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Lấy asset tĩnh từ binding ASSETS.
 *
 * QUAN TRỌNG — vì sao phải xử lý redirect ở đây:
 * Cloudflare Assets tự "chuẩn hoá" URL và trả 307 nội bộ:
 *     /index.html -> 307 -> /        /logs.html -> 307 -> /logs
 * Nếu ta trả nguyên 307 đó cho trình duyệt thì sinh VÒNG LẶP VÔ TẬN:
 *     GET /index.html -> 307 / -> (Worker lại phục vụ index.html) -> 307 / -> ...
 * Đã tái hiện được lỗi này bằng wrangler dev (người dùng đã đăng nhập vẫn bị
 * đá về /login.html vì trình duyệt đốt hết số lần redirect).
 *
 * Cách chữa đúng: TỰ ĐI THEO redirect bên trong Worker (tối đa vài bước), để
 * trình duyệt chỉ nhận đúng một response 200 cuối cùng. Tuyệt đối không đẩy
 * redirect nội bộ của tầng asset ra ngoài.
 */
async function serveAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  if (!env.ASSETS) {
    return jsonError("server_error", "Binding ASSETS chưa được cấu hình", 500);
  }

  let target = pathname;
  // Tối đa 3 bước: /index.html -> / là hết, không có chuỗi dài hơn.
  for (let hop = 0; hop < 3; hop++) {
    const url = new URL(request.url);
    url.pathname = target;
    const res = await env.ASSETS.fetch(new Request(url.toString(), request));

    if (res.status !== 301 && res.status !== 302 && res.status !== 307 && res.status !== 308) {
      return res;
    }

    const loc = res.headers.get("Location");
    if (!loc) return res;

    // Chỉ đi theo redirect nội bộ, bỏ qua mọi redirect ra ngoài.
    let next: URL;
    try {
      next = new URL(loc, url);
    } catch {
      return res;
    }
    if (next.origin !== url.origin) return res;
    if (next.pathname === target) return res; // tự trỏ vào chính nó -> dừng

    target = next.pathname;
  }

  return jsonError("not_found", "Không tìm thấy tài nguyên", 404);
}

/**
 * Các path tĩnh được phép truy cập KHÔNG cần đăng nhập.
 *
 * Giữ danh sách này CÀNG NGẮN CÀNG TỐT. Chỉ để lộ những gì trang đăng nhập
 * thực sự cần: HTML trang login, CSS dùng chung và script hiệu ứng cuộn.
 * Mọi thứ khác (dashboard.js, chart.js, logs.js, images.js, các trang HTML)
 * đều phải qua đăng nhập — chúng không phải bí mật, nhưng không có lý do gì
 * để phục vụ miễn phí cho người lạ.
 */
const PUBLIC_ASSET_PATHS = new Set<string>([
  "/login",
  "/login.html",
  "/css/app.css",
  "/css/scroll.css",
  "/js/scroll.js",
  // login.js BẮT BUỘC phải công khai: trang đăng nhập cần nó để xử lý form.
  // Nếu thiếu dòng này, trình duyệt tải /js/login.js sẽ bị 302 đá về
  // /login.html — script không chạy, bấm nút Đăng nhập không có gì xảy ra.
  // Đây là lỗi thật đã xảy ra và làm form im lặng hoàn toàn.
  "/js/login.js",
  // Màn hình chờ và biểu trưng của trang đăng nhập.
  //
  // LỖI THẬT ĐÃ KIỂM CHỨNG TRÊN PRODUCTION: ba tệp dưới đây từng thiếu trong
  // danh sách này nên bị 302 đá về /login.html:
  //     /css/preloader.css  -> màn hình chờ mất toàn bộ CSS
  //     /js/preloader.js    -> màn hình chờ không bao giờ được gỡ
  //     /img/logo.svg       -> biểu trưng vỡ (ảnh lỗi)
  // Kết quả: trang đăng nhập hiện một khối "0 % Đang tải" trơ trọi ngay trên
  // form. Đây là asset công khai thuần trang trí, không chứa bí mật, nên đưa
  // vào danh sách công khai là đúng.
  "/css/preloader.css",
  "/js/preloader.js",
  "/img/logo.svg",
  // Sprite biểu tượng: cần công khai để trang đăng nhập dùng chung một hệ
  // biểu tượng với năm trang còn lại (trước đây login tự vẽ SVG riêng).
  "/img/sprite.svg",
  // Biểu tượng tab: mọi trang đều khai báo rel="icon" nên thiếu tệp này thì
  // trang đăng nhập sẽ xin nó và bị 302 đá về chính nó (logo tab vỡ).
  "/img/favicon.svg",
  "/favicon.ico",
  "/robots.txt",
  // Lớp chuyển động dùng chung cho mọi trang, kể cả trang đăng nhập.
  //
  // Cả hai đều là asset thuần trang trí: /js/motion.js chỉ đọc thuộc tính
  // data-count đã có sẵn trong DOM và /css/motion.css chỉ định nghĩa hiệu ứng.
  // Không chứa bí mật, không đọc/ghi dữ liệu.
  //
  // LƯU Ý: nếu thiếu hai dòng này thì trang đăng nhập sẽ bị 302 đá về chính nó
  // khi trình duyệt xin tệp — hiệu ứng hỏng im lặng. test/asset-whitelist.mjs
  // tự bắt lỗi này khi thêm tài nguyên mới.
  "/css/motion.css",
  "/js/motion.js",
]);

/** Chỉ cho phép chuyển hướng nội bộ, tránh open redirect. */
function safeNext(raw: string | null): string {
  if (!raw) return "/index.html";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/index.html";
  return raw;
}

/* -------------------------------------------------------------------------- */
/* Router                                                                      */
/* -------------------------------------------------------------------------- */

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  /* ------------------------- API: health (public) ------------------------- */
  if (path === "/api/health") {
    if (method !== "GET") return methodNotAllowed("GET");
    return jsonOk({ ok: true, service: "shop-dashboard" }, 200, noStore());
  }

  /* ------------------- API: sync (token tĩnh, KHÔNG cookie) --------------- */
  // Đây là con đường duy nhất VPS → Cloudflare. Xác thực bằng Bearer token.
  if (path === "/api/sync") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleSync(request, env, ctx);
  }

  /* --------------------------- API: đăng nhập ----------------------------- */
  if (path === "/api/login") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleLogin(request, env);
  }

  if (path === "/api/logout") {
    if (method !== "POST") return methodNotAllowed("POST");
    return handleLogout(request, env);
  }

  /* --------------------------- API: đã bảo vệ ----------------------------- */
  if (path === "/api/stats") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleStats(request, env);
  }

  if (path === "/api/stats/daily") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleDaily(request, env);
  }

  if (path === "/api/stats/products") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleProducts(request, env);
  }

  if (path === "/api/logs") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleLogs(request, env);
  }

  if (path === "/api/logs/syncs") {
    if (method !== "GET") return methodNotAllowed("GET");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleSyncLogs(request, env);
  }

  /**
   * Mở khoá đăng nhập: khi chính bạn bị rate-limit (5 lần sai / 15 phút / IP),
   * dùng một phiên còn hiệu lực để xoá bộ đếm của IP đang dùng.
   * Đây KHÔNG phải backdoor: vẫn yêu cầu cookie phiên hợp lệ.
   */
  if (path === "/api/admin/unlock-login") {
    if (method !== "POST") return methodNotAllowed("POST");
    if (!(await requireAuth(request, env))) return unauthorized();

    let body: unknown = null;
    try {
      const text = await request.text();
      if (text.length > 4096) return jsonError("bad_request", "Body quá lớn", 400);
      body = text ? JSON.parse(text) : null;
    } catch {
      return jsonError("bad_request", "JSON không hợp lệ", 400);
    }

    const rawIps = (body as { ips?: unknown } | null)?.ips;
    const ips: string[] = [];
    if (Array.isArray(rawIps)) {
      for (const item of rawIps.slice(0, 20)) {
        if (typeof item === "string" && item.length <= 64 && UNLOCK_IP_RE.test(item)) {
          ips.push(item);
        }
      }
    }

    // IP của chính người gọi luôn được xoá để không tự khoá mình.
    const selfIp = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
    try {
      const cleared = await unlockLogin(env.DB, ips, selfIp);
      return jsonOk({ ok: true, cleared }, 200, noStore());
    } catch (err) {
      logLine("unlock-login failed:", err instanceof Error ? err.message : "unknown");
      return serverError();
    }
  }

  /* -------------------- API: kiểm tra UID Facebook live/die ---------------- */
  /**
   * Nhận danh sách UID, trả về 3 nhóm: live / die / unknown.
   * Cần đăng nhập (cookie phiên) — cùng mức bảo vệ như các route khác.
   * Xem src/api/fbcheck.ts để hiểu cách phân loại và vì sao có nhóm `unknown`.
   */
  if (path === "/api/fbcheck") {
    if (method !== "POST") return methodNotAllowed("POST");
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleFbCheck(request, env);
  }

  /* ------------------------ Theo dõi tích xanh (tick xanh) ---------------- */
  /**
   * Hai nhóm route dùng HAI kiểu xác thực khác nhau, nên phải tách rõ:
   *
   * 1) `/api/tickxanh/queue` và `/api/tickxanh/report` là đường đi của WATCHER
   *    chạy trên máy chủ nhà. Xác thực bằng `Authorization: Bearer
   *    <BLUECHECK_TOKEN>`, KHÔNG dùng cookie — vì máy watcher không có phiên
   *    trình duyệt. Token rỗng thì chặn, không bao giờ coi là "cho qua".
   *
   * 2) Phần còn lại dành cho người dùng trên web, dùng cookie phiên như mọi
   *    trang khác.
   */
  if (path === "/api/tickxanh/queue" || path === "/api/tickxanh/report") {
    return handleBluecheckWatcherRoute(request, env, path);
  }

  if (path === "/api/tickxanh" || path.startsWith("/api/tickxanh/")) {
    // Mọi route còn lại của tính năng đều cần đăng nhập.
    if (!(await requireAuth(request, env))) return unauthorized();
    return handleBluecheck(request, env, path);
  }

  /* ------------------------------ API: ảnh -------------------------------- */
  if (path === "/api/images") {
    if (method === "GET") {
      if (!(await requireAuth(request, env))) return unauthorized();
      return handleImagesList(request, env);
    }
    if (method === "POST") {
      if (!(await requireAuth(request, env))) return unauthorized();
      return handleImageUpload(request, env);
    }
    return methodNotAllowed("GET, POST");
  }

  if (path.startsWith("/api/images/")) {
    // Lấy key ở dạng thô; handler tự validate bằng R2_KEY_RE trước khi chạm R2.
    const key = decodeURIComponent(path.slice("/api/images/".length));
    if (!key || key.includes("/") || key.includes("..")) {
      return jsonError("not_found", "Không tìm thấy ảnh", 404);
    }
    if (method === "GET") {
      if (!(await requireAuth(request, env))) return unauthorized();
      return handleImageView(request, env, key);
    }
    if (method === "DELETE") {
      if (!(await requireAuth(request, env))) return unauthorized();
      return handleImageDelete(request, env, key);
    }
    return methodNotAllowed("GET, DELETE");
  }

  // API lạ: trả JSON 404, không rơi vào asset handler.
  if (path.startsWith("/api/")) {
    return jsonError("not_found", "Endpoint không tồn tại", 404);
  }

  /* ----------------------------- Trang tĩnh ------------------------------- */
  //
  // QUAN TRỌNG — vì sao phải liệt kê TƯỜNG MINH thay vì so khớp theo path:
  // Cloudflare Assets tự chuẩn hoá URL trước khi Worker kịp nhìn thấy:
  //   /index.html -> 307 -> /        /logs.html -> 307 -> /logs
  // Nếu chỉ chặn đúng chuỗi "/index.html" thì kẻ chưa đăng nhập vẫn vào được
  // "/" và "/logs", tức là toàn bộ HTML dashboard bị lộ. Đã kiểm chứng thực tế
  // bằng wrangler dev: GET / khi chưa đăng nhập từng trả 200 kèm HTML đầy đủ.
  //
  // Vì vậy: chỉ những asset nằm trong danh sách công khai mới được phục vụ tự do,
  // mọi đường dẫn còn lại đều phải qua requireAuth trước.
  const authed = await requireAuth(request, env);
  const isPublicAsset = PUBLIC_ASSET_PATHS.has(path);

  if (!isPublicAsset && !authed) {
    // Chưa đăng nhập và không phải asset công khai -> đẩy về trang đăng nhập.
    // Dùng 302 (không phải 307) để trình duyệt đổi sang GET.
    return redirectTo(`/login.html?next=${encodeURIComponent(safeNext(path))}`);
  }

  // Chặn thêm một lần nữa ở mức "trang": kể cả khi ai đó thêm route mới,
  // các trang HTML nhạy cảm vẫn không bao giờ rơi vào nhánh phục vụ tự do.
  if (!isPublicAsset && (await isProtectedPage(path))) {
    return serveAsset(request, env, await resolveProtectedPage(path));
  }

  if (isPublicAsset) {
    return serveAsset(request, env, path);
  }

  if (method === "GET" || method === "HEAD") {
    return serveAsset(request, env, path);
  }

  return jsonError("not_found", "Không tìm thấy", 404);
}

/** Chuyển hướng nội bộ, luôn kèm header no-store. */
function redirectTo(location: string, status = 302): Response {
  const headers = noStore();
  headers.set("Location", location);
  return new Response(null, { status, headers });
}

/** Đường dẫn trang cần đăng nhập (đã tính cả dạng bị Assets rút gọn). */
const PROTECTED_PAGES: Record<string, string> = {
  "/": "/index.html",
  "/index": "/index.html",
  "/index.html": "/index.html",
  "/logs": "/logs.html",
  "/logs.html": "/logs.html",
  "/images": "/images.html",
  "/images.html": "/images.html",
  "/uid": "/uid.html",
  "/uid.html": "/uid.html",
  "/tickxanh": "/tickxanh.html",
  "/tickxanh.html": "/tickxanh.html",
};

/** Trang này có phải trang cần đăng nhập không? */
async function isProtectedPage(path: string): Promise<boolean> {
  return Object.prototype.hasOwnProperty.call(PROTECTED_PAGES, path);
}

/** Ánh xạ URL đã rút gọn về file HTML thật để phục vụ. */
async function resolveProtectedPage(path: string): Promise<string> {
  return PROTECTED_PAGES[path] ?? "/index.html";
}

function methodNotAllowed(allow: string): Response {
  const res = jsonError("method_not_allowed", `Chỉ hỗ trợ: ${allow}`, 405);
  const headers = new Headers(res.headers);
  headers.set("Allow", allow);
  return new Response(res.body, { status: 405, headers });
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                  */
/* -------------------------------------------------------------------------- */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const res = await route(request, env, ctx);
      return withSecurityHeaders(res);
    } catch (err) {
      // KHÔNG bao giờ trả stack trace ra ngoài. Chỉ log nội bộ phần message.
      logLine("unhandled error:", err instanceof Error ? err.message : "unknown");
      return withSecurityHeaders(serverError());
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Tiện ích nhỏ dùng khi debug cookie phiên (không expose ra response).
 * Giữ ở đây để tránh import thừa trong các module khác.
 */
export function debugHasSession(request: Request, env: Env): boolean {
  const name = sessionCookieName(env);
  return readCookie(request, name) !== null;
}

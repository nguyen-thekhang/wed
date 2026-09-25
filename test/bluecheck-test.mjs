#!/usr/bin/env node
/**
 * =============================================================================
 * test/bluecheck-test.mjs — kiểm tra tính năng theo dõi tích xanh
 * =============================================================================
 *
 * Chạy: node test/bluecheck-test.mjs
 *
 * Phần 1 kiểm tra logic thuần và các cam kết an toàn, không cần mạng.
 * Phần 2 gọi endpoint ảnh công khai của UID 4; nếu mạng không khả dụng thì bỏ qua,
 * không tính là đạt.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

function ok(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skipTest(name, reason) {
  skip++;
  console.log(`  ⊖ ${name} — bỏ qua: ${reason}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/** Bỏ comment mà không làm hỏng dấu nháy, URL hoặc template literal trong JS/TS. */
function stripJsComments(source) {
  let out = "";
  let state = "code";
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i++;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state = ch === "'" ? "single" : ch === '"' ? "double" : "template";
    }
    out += ch;
  }

  return out;
}

/** Bỏ emoji để nội dung kiểm thử không phụ thuộc vào biểu tượng trang trí. */
function withoutEmoji(value) {
  return String(value)
    .normalize("NFC")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[️‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dự án dùng import TypeScript không kèm phần mở rộng để tương thích bundler.
 * Node 24 tự bỏ kiểu nhưng ESM vẫn cần resolve tới file .ts. Hook nhỏ này chỉ bổ
 * sung phần resolve còn thiếu; mã vẫn được dynamic import trực tiếp từ file nguồn.
 */
const extensionResolver = `
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // Thử phần mở rộng kế tiếp theo quy ước TypeScript.
      }
    }
  }
  return nextResolve(specifier, context);
}
`;
register(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(extensionResolver)}`,
  pathToFileURL(import.meta.url),
);

async function loadBluecheckHelpers() {
  try {
    const mod = await import("../src/api/bluecheck.ts");
    if (typeof mod.buildCelebrationBody !== "function" || typeof mod.formatWatchDuration !== "function") {
      return null;
    }
    return {
      buildCelebrationBody: mod.buildCelebrationBody,
      formatWatchDuration: mod.formatWatchDuration,
    };
  } catch (error) {
    console.log(`      (không nạp được TypeScript: ${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

/* ===========================================================================
 * PHẦN 1 — LOGIC TĨNH
 * ========================================================================= */

section("1. HÀM THUẦN TỪ src/api/bluecheck.ts");
const helpers = await loadBluecheckHelpers();

if (!helpers) {
  ok("Nạp trực tiếp được hai hàm thuần từ src/api/bluecheck.ts", false, "không nạp hoặc không đúng kiểu hàm");
} else {
  ok("Nạp trực tiếp được hai hàm thuần từ src/api/bluecheck.ts", true);
  const { buildCelebrationBody, formatWatchDuration } = helpers;
  const celebration = buildCelebrationBody("Dai jun", "61593943230865", 465);
  const lines = celebration.replace(/\r\n?/g, "\n").split("\n").map(withoutEmoji);
  const plainBody = lines.join("\n");

  // Mẫu thông báo người dùng đưa có 6 dòng:
  //   ━━━ / 📘 tên / 🔗 @uid / ━━━ / 🔵 thông báo / ⏱ thời gian
  ok("Nội dung chúc mừng có đúng 6 dòng theo mẫu", lines.length === 6, `thực tế có ${lines.length} dòng`);
  ok(
    "Hai đường kẻ ngang giữ nội dung chúc mừng",
    lines[0] === "━━━━━━━━━━━━━━━━━━" && lines[3] === "━━━━━━━━━━━━━━━━━━",
  );
  ok("Dòng tên là Dai jun", lines[1] === "Dai jun", `thực tế: ${lines[1] ?? "(thiếu)"}`);
  ok(
    "Dòng liên kết chứa @61593943230865",
    lines[2] === "@61593943230865",
    `thực tế: ${lines[2] ?? "(thiếu)"}`,
  );
  ok(
    "Có dòng thông báo đã lên tích xanh",
    plainBody.includes("Tài khoản đã LÊN TÍCH XANH trên profile công khai!"),
  );
  ok(
    "Thời gian 465 phút được hiện thành 7 giờ 45 phút",
    plainBody.includes("Thời gian theo dõi: 7 giờ 45 phút"),
  );

  const durationCases = [
    [0, "0 phút"],
    [45, "45 phút"],
    [465, "7 giờ 45 phút"],
    [120, "2 giờ"],
    [3000, "2 ngày 2 giờ"],
  ];
  for (const [minutes, expected] of durationCases) {
    const actual = formatWatchDuration(minutes);
    ok(
      `formatWatchDuration(${minutes}) = ${expected}`,
      actual === expected,
      `nhận được "${actual}"`,
    );
  }
}

/* ===========================================================================
 * PHẦN 1b — CAM KẾT AN TOÀN VÀ TÍNH NHẤT QUÁN
 * ========================================================================= */

section("2. MÃ NGUỒN CÓ ĐÚNG NHỮNG GÌ ĐÃ CAM KẾT KHÔNG");

const schemaPath = join(ROOT, "schema.sql");
if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, "utf8");
  ok(
    "schema.sql có cả bluecheck_watches và bluecheck_notifications",
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+bluecheck_watches\b/i.test(schema) &&
      /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+bluecheck_notifications\b/i.test(schema),
  );
} else {
  ok("schema.sql có cả bluecheck_watches và bluecheck_notifications", false, "không tìm thấy schema.sql");
}

const bluecheckPath = join(ROOT, "src", "api", "bluecheck.ts");
if (existsSync(bluecheckPath)) {
  const source = readFileSync(bluecheckPath, "utf8");
  const code = stripJsComments(source);
  const watcherAuth = code.match(/function\s+watcherAuthorized\s*\([^)]*\)\s*:\s*boolean\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const queueFunction = code.match(/export\s+async\s+function\s+handleBluecheckQueue\s*\([^)]*\)\s*:\s*Promise<Response>\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const reportFunction = code.match(/export\s+async\s+function\s+handleBluecheckReport\s*\([^)]*\)\s*:\s*Promise<Response>\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const reportFunctionRaw = source.match(/export\s+async\s+function\s+handleBluecheckReport\s*\([^)]*\)\s*:\s*Promise<Response>\s*\{[\s\S]*?\n\}/)?.[0] ?? "";

  ok(
    "Token watcher được so sánh bằng timingSafeEqualStr",
    /timingSafeEqualStr\s*\(/.test(watcherAuth),
    "hàm xác thực watcher không gọi timingSafeEqualStr",
  );
  ok(
    "Token watcher rỗng bị chặn, không cho qua",
    /if\s*\(\s*secret\s*===\s*["']["']\s*\)\s*return\s+false\s*;?/.test(watcherAuth),
  );

  const indexPath = join(ROOT, "src", "index.ts");
  const indexCode = existsSync(indexPath) ? stripJsComments(readFileSync(indexPath, "utf8")) : "";
  const watcherBranchStart = indexCode.indexOf(
    'if (path === "/api/tickxanh/queue" || path === "/api/tickxanh/report")',
  );
  const webBranchStart = indexCode.indexOf(
    'if (path === "/api/tickxanh" || path.startsWith("/api/tickxanh/"))',
    watcherBranchStart,
  );
  const watcherBranch = watcherBranchStart >= 0 ? indexCode.slice(watcherBranchStart, webBranchStart) : "";
  const webBranch = webBranchStart >= 0 ? indexCode.slice(webBranchStart, webBranchStart + 350) : "";
  const watcherDispatch = code.match(
    /export\s+async\s+function\s+handleBluecheckWatcherRoute\s*\([^)]*\)\s*:\s*Promise<Response>\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  const hasBearer = /Authorization/.test(watcherAuth) && /\^Bearer\\s\+/.test(watcherAuth);
  const routesUseWatcherAuth =
    queueFunction.includes("watcherAuthorized(") && reportFunction.includes("watcherAuthorized(");
  const noCookieOrSession =
    !/\bcookies?\b/i.test(`${watcherBranch}\n${queueFunction}\n${reportFunction}\n${watcherDispatch}`) &&
    !/requireAuth\s*\(/.test(`${queueFunction}\n${reportFunction}\n${watcherDispatch}`);

  ok(
    "Route queue và report dùng Bearer token, không dùng cookie",
    hasBearer &&
      routesUseWatcherAuth &&
      noCookieOrSession &&
      watcherBranch.includes("handleBluecheckWatcherRoute("),
    !hasBearer
      ? "thiếu kiểm tra Authorization Bearer"
      : !routesUseWatcherAuth
        ? "queue hoặc report không gọi watcherAuthorized"
        : !noCookieOrSession
          ? "phát hiện cookie hoặc requireAuth trong đường watcher"
          : !watcherBranch.includes("handleBluecheckWatcherRoute(")
            ? "router không tách riêng đường watcher"
            : "",
  );
  ok("Các route web /api/tickxanh đi qua requireAuth", /requireAuth\s*\(/.test(webBranch));

  const unsafeSqlConcat = /\.prepare\s*\(\s*(?:"(?:[^"\\]|\\.)*"\s*\+|`(?:[^`\\]|\\.)*\$\{|[^)]*\+)/.test(code);
  ok(
    "Không có SQL nối chuỗi bằng dấu cộng trong src/api/bluecheck.ts",
    !unsafeSqlConcat,
    "phát hiện biểu thức SQL được ghép bằng + hoặc nội suy trước prepare",
  );

  ok(
    "Không có mã đọc, ghi hoặc log cột content của bảng stock",
    !/\bstock\b/i.test(code) && !/\bcontent\b/i.test(code),
    "mã nguồn sau khi bỏ comment vẫn tham chiếu stock/content",
  );

  const oneWayVerified =
    /const\s+wasVerified\s*=\s*currentRow\.status\s*===\s*["']verified["']/.test(reportFunctionRaw) &&
    /const\s+nextStatus[^=]*=\s*wasVerified\s*\?\s*["']verified["']\s*:\s*status/.test(reportFunctionRaw) &&
    /\.bind\(\s*finalName\s*,\s*nextStatus\s*,/.test(reportFunctionRaw) &&
    /nextStatus\s*===\s*["']verified["']\s*&&\s*!wasVerified/.test(reportFunctionRaw);
  ok(
    "Trạng thái verified là một chiều, không bị ghi đè về watching",
    oneWayVerified,
  );
} else {
  ok("Các cam kết trong src/api/bluecheck.ts", false, "không tìm thấy src/api/bluecheck.ts");
}

const tickHtmlPath = join(ROOT, "public", "tickxanh.html");
if (existsSync(tickHtmlPath)) {
  const html = readFileSync(tickHtmlPath, "utf8");
  const requiredIds = [
    "bx-msg",
    "bx-ok",
    "watch-input",
    "watch-count",
    "watch-add-btn",
    "tb-verified",
    "tb-watching",
    "bell-btn",
    "bell-badge",
    "inbox",
    "inbox-close-btn",
    "logout-btn",
  ];
  const missingIds = requiredIds.filter(
    (id) => !new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(html),
  );
  ok(
    "public/tickxanh.html có đủ id cần thiết",
    missingIds.length === 0,
    missingIds.length ? `thiếu: ${missingIds.join(", ")}` : "",
  );

  const localCssLinks = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["'](\/[^"']+\.css)["']/gi)].map(
    (match) => match[1],
  );
  const cssResults = localCssLinks.map((href) => {
    const cssPath = join(ROOT, "public", href.replace(/^\/+/, ""));
    return existsSync(cssPath) && /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i.test(
      readFileSync(cssPath, "utf8"),
    );
  });
  ok(
    "Các CSS của trang có media prefers-reduced-motion reduce",
    localCssLinks.length > 0 && cssResults.every(Boolean),
    localCssLinks.length ? `kiểm tra ${localCssLinks.join(", ")}` : "không tìm thấy CSS nội bộ",
  );
} else {
  ok("public/tickxanh.html có đủ id cần thiết", false, "không tìm thấy public/tickxanh.html");
  ok("Các CSS của trang có media prefers-reduced-motion reduce", false, "không tìm thấy trang HTML");
}

const tickJsPath = join(ROOT, "public", "js", "tickxanh.js");
if (existsSync(tickJsPath)) {
  const jsCode = stripJsComments(readFileSync(tickJsPath, "utf8"));
  ok(
    "public/js/tickxanh.js không dùng innerHTML để chèn dữ liệu",
    !/\.innerHTML\s*[+]?=/.test(jsCode),
  );
} else {
  ok("public/js/tickxanh.js không dùng innerHTML để chèn dữ liệu", false, "không tìm thấy file JavaScript");
}

/* ===========================================================================
 * PHẦN 2 — GỌI THẬT (cần mạng)
 * ========================================================================= */

section("3. KIỂM CHỨNG THẬT VỚI ENDPOINT PICTURE (cần mạng)");

async function probePicture(uid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(`https://graph.facebook.com/v23.0/${uid}/picture?type=normal`, {
      redirect: "manual",
      headers: {
        Accept: "*/*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

let hasNetwork = false;
try {
  const probe = await probePicture("4");
  hasNetwork = true;
  ok("UID 4 trả HTTP 302 khi không theo redirect", probe.status === 302, `nhận HTTP ${probe.status}`);
} catch (error) {
  skipTest(
    "UID 4 trả HTTP 302 khi không theo redirect",
    `không gọi được graph.facebook.com từ máy này: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.log("      (Không có mạng nên phần kiểm chứng thật được bỏ qua, KHÔNG tính là đạt.)");
}

console.log(`\n${"-".repeat(60)}`);
console.log(`ĐẠT: ${pass}   KHÔNG ĐẠT: ${fail}   BỎ QUA: ${skip}`);
if (failures.length) {
  console.log("\nCác mục không đạt:");
  for (const failure of failures) console.log(`  - ${failure}`);
}
console.log("-".repeat(60));

process.exitCode = fail > 0 ? 1 : 0;

# HỢP ĐỒNG GIAO DIỆN (FROZEN CONTRACT) — shop-dashboard

> Tài liệu này là nguồn chân lý duy nhất. Mọi subagent viết code phải tuân thủ
> CHÍNH XÁC các chữ ký, tên route, tên field dưới đây. Không tự ý đổi.

## 0. NGUYÊN TẮC BẤT DI BẤT DỊCH

Bảng `stock` trong DB bán hàng có cột `content` chứa `acc|pass` thật.

- KHÔNG được đọc `stock.content` ở bất kỳ đâu (VPS hay Worker).
- KHÔNG được đưa vào payload sync, API response, log, audit_log, hay HTML.
- Chỉ được `COUNT(*)` trên `stock` để biết tồn kho.
- Nếu bạn thấy mình sắp viết `SELECT content` → DỪNG LẠI và báo lỗi.

Grep nghiệm thu: `grep -r "content" src/ sync_stats.py` phải KHÔNG ra chỗ nào đọc `stock.content`.

## 1. Kiểu dữ liệu

- Tiền: `number` nguyên (đồng VN). KHÔNG dùng float, KHÔNG `REAL` trong SQL.
- Thời gian lưu Cloudflare: chuỗi ISO8601 CÓ offset `+07:00`, ví dụ `2026-09-22T17:30:00+07:00`.
- Ngày: `YYYY-MM-DD` theo giờ VN (UTC+7).
- `orders.status`: `delivered` | `cancelled` | `expired` | `preorder`
- `deposits.status`: `confirmed` | `expired`
- `orders.method`: `bank` | `wallet` | `''` (rỗng gom vào nhóm `khác`)

## 2. Payload sync (VPS POST → Worker)

Route: `POST /api/sync`
Header: `Authorization: Bearer <SYNC_TOKEN>` (so sánh hằng thời gian)

```json
{
  "synced_at": "2026-09-22T17:30:00+07:00",
  "totals": {
    "revenue_delivered": 0,
    "orders_delivered": 0,
    "orders_all": 0,
    "users_total": 0,
    "deposits_confirmed": 0,
    "wallet_balance_sum": 0
  },
  "by_day":     [{ "date": "2026-09-22", "revenue": 0, "orders": 0 }],
  "by_product": [{ "product_id": 3, "name": "Tên SP", "sold": 0, "revenue": 0 }],
  "by_method":  [{ "method": "bank", "orders": 0, "revenue": 0 }],
  "by_status":  [{ "status": "delivered", "count": 0 }],
  "stock":      [{ "product_id": 3, "available": 0, "sold": 0 }]
}
```

Giới hạn validate (server PHẢI từ chối nếu vượt):
- `by_day` ≤ 400 phần tử, `by_product` ≤ 500, `by_method` ≤ 20, `by_status` ≤ 20, `stock` ≤ 500
- `name` ≤ 200 ký tự, chỉ chuỗi; mọi số ≥ 0, ≤ 1e12, là số nguyên hữu hạn
- `method` ∈ {`bank`,`wallet`,`khác`,`other`,`''`}, `status` ∈ {delivered,cancelled,expired,preorder}
- `date` đúng regex `^\d{4}-\d{2}-\d{2}$`
- Payload là object; field lạ bị bỏ qua (không lưu), field thiếu → 400.

## 3. Module nội bộ (đã freeze)

### src/lib/response.ts
```ts
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  SYNC_TOKEN: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  BLUECHECK_TOKEN: string;
  SESSION_COOKIE?: string;
  SESSION_TTL_SECONDS?: string;
}
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export function jsonOk(data: unknown, status?: number, extraHeaders?: HeadersInit): Response;
export function jsonError(code: string, message: string, status: number): Response;
export function noStore(headers?: HeadersInit): Headers;   // Cache-Control: no-store + security headers
export function unauthorized(message?: string): Response;   // 401 {error:{code:'unauthorized'}}
export function serverError(): Response;                    // 500 KHÔNG lộ stack trace
export function clientIp(req: Request): string;             // CF-Connecting-IP -> X-Forwarded-For -> '0.0.0.0'
export function htmlResponse(body: string, status?: number): Response;
export interface AuditRow { action: string; detail?: string | null; ip?: string | null; created_at?: string }
export async function writeAudit(db: D1Database, row: AuditRow): Promise<void>;  // INSERT prepared
export function logLine(...parts: unknown[]): void;         // console.log có tiền tố [shop-dashboard]; KHÔNG log payload thô
export function timingSafeEqualStr(a: string, b: string): boolean; // hằng thời gian, không dùng ===
```

### src/lib/validate.ts
```ts
export interface Totals { revenue_delivered:number; orders_delivered:number; orders_all:number;
  users_total:number; deposits_confirmed:number; wallet_balance_sum:number }
export interface ByDay { date:string; revenue:number; orders:number }
export interface ByProduct { product_id:number; name:string; sold:number; revenue:number }
export interface ByMethod { method:string; orders:number; revenue:number }
export interface ByStatus { status:string; count:number }
export interface StockRow { product_id:number; available:number; sold:number }
export interface SyncPayload { synced_at:string; totals:Totals; by_day:ByDay[];
  by_product:ByProduct[]; by_method:ByMethod[]; by_status:ByStatus[]; stock:StockRow[] }
export function parseSyncPayload(raw: unknown): SyncPayload;  // ném ValidationError nếu sai
export class ValidationError extends Error {}
export function isIsoWithOffset(s: string): boolean;         // bắt buộc có +07:00 hoặc offset hợp lệ
export function vnToday(now?: Date): string;                 // 'YYYY-MM-DD' theo UTC+7
export function vnDateOf(iso: string): string;               // cắt ngày theo +07:00
```

### src/lib/uid-input.ts (dependency-free, để unit-test độc lập)
```ts
export function extractUidFromLine(rawLine: string): string | null;
// '61579461239864' -> '61579461239864'
// 'https://www.facebook.com/profile.php?id=615...&ref=x' -> '615...'
// 'user01|pass01' -> null  (KHÔNG BAO GIỜ nuốt acc|pass)
export interface ParsedUidList { uids: string[]; invalid: number }
export function parseUidList(text: string): ParsedUidList;
// Nhận: văn bản thuần nhiều dòng | {"uids":"111\n222"} | {"uids":["111"]} | ["111"].
// Tự loại UID trùng, giữ thứ tự gõ, bỏ dòng rỗng, đếm dòng hỏng vào `invalid`.
```

### src/api/fbcheck.ts
```ts
export const MAX_UIDS_PER_REQUEST: number;      // 200
export function extractUidFromLine(s: string): string | null;   // re-export
export function parseUidList(s: string): ParsedUidList;         // re-export
export async function handleFbCheck(req: Request, env: Env): Promise<Response>;
```
Phân loại (endpoint công khai của Meta, KHÔNG cookie/token/đăng nhập/proxy):

```
GET https://graph.facebook.com/v23.0/<uid>/picture?type=normal   (redirect: "manual")
  302            → live
  400            → die
  429/5xx/lỗi mạng/timeout → unknown
```

`unknown` là bắt buộc: coi lỗi mạng thành `die` sẽ khiến người dùng xoá nhầm tài
khoản đang hoạt động. Không dùng `profile.php` vì nó trả cùng một trang lỗi cho
cả "đã xoá" lẫn "đổi sang riêng tư".

### src/api/bluecheck.ts
```ts
export async function handleBluecheckList(req: Request, env: Env): Promise<Response>;
export async function handleBluecheckAdd(req: Request, env: Env): Promise<Response>;
export async function handleBluecheckRead(req: Request, env: Env): Promise<Response>;
export async function handleBluecheckDelete(req: Request, env: Env): Promise<Response>;
export async function handleBluecheckQueue(req: Request, env: Env): Promise<Response>;
export async function handleBluecheckReport(req: Request, env: Env): Promise<Response>;
```

Bốn handler dành cho trang dashboard đều yêu cầu cookie phiên. Hai handler
dành cho watcher (`queue`, `report`) chỉ chấp nhận `Authorization: Bearer
<BLUECHECK_TOKEN>`, dùng so sánh hằng thời gian và không dùng cookie. Không
được để route nào đọc, ghi hoặc ghi log cột `content` của bảng `stock`.

### src/auth.ts
```ts
export async function hashPassword(password: string, saltHex?: string, iterations?: number): Promise<string>;
// trả "pbkdf2$<iterations>$<saltHex>$<hashHex>" dùng Web Crypto PBKDF2-SHA256, iterations >= 100000
export async function verifyPassword(password: string, stored: string): Promise<boolean>; // hằng thời gian
export async function issueSession(env: Env, ip: string): Promise<string>;  // "payloadB64.sigB64"
export async function verifySession(env: Env, token: string | null): Promise<boolean>;
export function sessionCookie(env: Env, token: string, maxAgeSeconds: number): string; // HttpOnly; Secure; SameSite=Strict; Path=/
export function clearSessionCookie(env: Env): string;
export function readCookie(req: Request, name: string): string | null;
export async function requireAuth(req: Request, env: Env): Promise<boolean>;
export const MAX_FAILED_LOGINS = 5;
export const LOGIN_WINDOW_SECONDS = 900;
export async function recordFailedLogin(db: D1Database, ip: string): Promise<void>;
export async function failedLoginCount(db: D1Database, ip: string): Promise<number>;
/**
 * Kiểm tra khoá đăng nhập CỦA CHÍNH NGƯỜI DÙNG (admin tự bấm nút mở khoá):
 * xoá toàn bộ login_attempts của các IP này rồi ghi audit_log action='unlock'.
 */
export async function unlockLogin(db: D1Database, ips: string[], selfIp: string): Promise<number>;
```
Cookie phiên: `SESSION_COOKIE` (mặc định `shop_session`), HMAC-SHA256 ký bằng `SESSION_SECRET`, payload chứa `iat`, `exp`, `sub`. TTL từ `SESSION_TTL_SECONDS` (mặc định 43200).

### src/index.ts (router — module này do nhánh tích hợp giữ)
```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
}
export function withSecurityHeaders(res: Response): Response;
```
Nhiệm vụ router:
- `GET  /` và `/index.html` → `env.ASSETS.fetch(...)`, nếu chưa đăng nhập thì 302 → `/login.html`
- `GET  /login.html` → asset (luôn cho phép)
- `GET  /api/health` → 200 `{ok:true}` không cần auth
- `POST /api/login` → gọi loginHandler trong src/api/auth-routes.ts
- `POST /api/logout` → xoá cookie, audit `logout`
- `POST /api/sync` → `handleSync` (src/api/sync.ts), chỉ token, KHÔNG cần cookie
- `GET  /api/stats`, `/api/stats/daily`, `/api/stats/products` → `requireAuth` rồi gọi stats.ts
- `GET  /api/logs`, `GET /api/logs/syncs` → requireAuth rồi gọi logs.ts
- `POST /api/admin/unlock-login` → requireAuth rồi gọi `unlockLogin`
- `GET/POST /api/images`, `GET /api/images/:key`, `DELETE /api/images/:key` → requireAuth rồi gọi images.ts
- `GET/POST /api/tickxanh`, `POST /api/tickxanh/read`, `DELETE /api/tickxahn/:uid` → requireAuth rồi gọi `bluecheck.ts`
- `GET /api/tickxahn/queue`, `POST /api/tickxahn/report` → so sánh Bearer `BLUECHECK_TOKEN`, KHÔNG dùng cookie, rồi gọi `bluecheck.ts`
- mọi thứ khác: không phải `/api/*` → asset; `/api/*` lạ → 404 JSON
- Bọc try/catch toàn cục: lỗi → `serverError()` (không lộ stack).

### src/api/api-types.ts (freeze — mọi API trả về dùng kiểu này)
```ts
export interface StatsResponse {
  synced_at: string | null;      // ISO +07:00
  received_at: string | null;    // UTC, từ datetime('now')
  stale: boolean;                // true nếu quá 1 giờ chưa sync
  stale_seconds: number | null;
  totals: Totals;                // số 0 nếu chưa có dữ liệu
  by_day: ByDay[];               // ĐÃ điền đủ 30 ngày gần nhất, ngày thiếu = 0
  by_product: ByProduct[];
  by_method: ByMethod[];         // bank / wallet / khác
  by_status: ByStatus[];
  stock: StockRow[];
  last_syncs: SyncMeta[];
}
export interface BluecheckWatch {
  uid: string;
  name: string;
  status: 'watching' | 'verified' | 'not_found' | 'unknown';
  started_at: number;
  last_checked_at: number;
  verified_at: number;
  checks_count: number;
  last_error: string;
  watch_minutes: number;
}
export interface BluecheckNotification {
  id: string;
  uid: string;
  name: string;
  title: string;
  body: string;
  watch_minutes: number;
  read: boolean;
  created_at: number;
}
export interface BluecheckListResponse {
  ok: true;
  watching: BluecheckWatch[];
  verified: BluecheckWatch[];
  other: BluecheckWatch[];
  notifications: BluecheckNotification[];
  unread: number;
  summary: Record<string, number>;
  server_time: number;
}
export interface SyncMeta { synced_at: string; received_at: string; }
export interface LogsResponse { admin_log: AdminLogRow[]; syncs: SyncMeta[] }
export interface AdminLogRow { id:number; action:string; detail:string|null; ip:string|null; created_at:string }
export interface ImageRow { id:number; r2_key:string; note:string|null; mime:string; size_bytes:number; sha256:string; created_at:string; url:string }
export type FbUidVerdict = 'live' | 'die' | 'unknown';
export interface FbLiveRow { uid:string; has_photo:boolean }
export interface FbDieRow { uid:string }
export interface FbUnknownRow { uid:string; reason:string }
export interface FbCheckResponse {
  ok: true;
  total: number;
  live: FbLiveRow[];
  die: FbDieRow[];
  unknown: FbUnknownRow[];
  summary: { live:number; die:number; unknown:number; invalid_lines:number };
}
```

Mọi mốc thời gian riêng của `BluecheckWatch` và `BluecheckNotification` là
số nguyên epoch **giây**, không phải ISO8601.

## 4. Hợp đồng HTTP

| Method | Path | Auth | Thành công | Lỗi |
|---|---|---|---|---|
| POST | `/api/sync` | Bearer token | 200 `{ok:true, synced_at}` | 401, 400, 413, 500 |
| POST | `/api/login` | – | 200 `{ok:true}` + Set-Cookie | 401, 429, 400 |
| POST | `/api/logout` | cookie | 200 `{ok:true}` | – |
| GET | `/api/stats` | cookie | 200 `StatsResponse` | 401 |
| GET | `/api/stats/daily?days=30` | cookie | 200 `{days:ByDay[]}` | 401, 400 |
| GET | `/api/stats/products` | cookie | 200 `{products:ByProduct[]}` | 401 |
| GET | `/api/logs?date=YYYY-MM-DD` | cookie | 200 `LogsResponse` | 401 |
| GET | `/api/logs/syncs?limit=50` | cookie | 200 `{syncs:SyncMeta[]}` | 401 |
| POST | `/api/admin/unlock-login` | cookie | 200 `{ok:true, cleared:n}` | 401, 400 |
| GET | `/api/images?limit=50` | cookie | 200 `{images:ImageRow[]}` | 401 |
| POST | `/api/images` | cookie | 201 `{ok:true, image:ImageRow}` | 400, 401, 413 |
| GET | `/api/images/:key` | cookie | 200 ảnh nhị phân | 401, 404 |
| DELETE | `/api/images/:key` | cookie | 200 `{ok:true}` | 401, 404 |
| POST | `/api/fbcheck` | cookie | 200 `FbCheckResponse` | 400, 401, 413, 429, 500 |
| POST | `/api/tickxanh` | cookie | 200 `{ok, added}` | 400, 401, 413 |
| GET | `/api/tickxanh` | cookie | 200 `BluecheckListResponse` | 401 |
| POST | `/api/tickxanh/read` | cookie | 200 `{ok, marked}` | 400, 401 |
| DELETE | `/api/tickxahn/:uid` | cookie | 200 `{ok, uid}` | 400, 401 |
| GET | `/api/tickxahn/queue` | Bearer `BLUECHECK_TOKEN` | 200 `BluecheckQueueResponse` | 401 |
| POST | `/api/tickxahn/report` | Bearer `BLUECHECK_TOKEN` | 200 `BluecheckReportResponse` | 400, 401, 413 |

Hai route cuối dùng **Bearer `BLUECHECK_TOKEN`, KHÔNG dùng cookie**; bốn route
`/api/tickxanh` phía trên dùng **cookie phiên**. `GET /api/tickxahn/queue`
trả danh sách UID đến hạn để watcher xử lý; `POST /api/tickxahn/report` nhận
kết quả thực tế của watcher. Cả hai tuyệt đối không đọc, ghi hoặc log cột
`content` của bảng `stock`.

`POST /api/fbcheck` nhận body thuần (dán nhiều dòng) hoặc JSON
(`{"uids": "111\n222"}` / `{"uids": ["111"]}` / `["111"]`). Rate limit
20 lần / 10 phút / IP qua bảng `fbcheck_attempts`. Audit ghi action `fbcheck`
với SỐ LIỆU tổng hợp (`total=.. live=.. die=..`), không ghi danh sách UID.

Lỗi luôn có dạng `{ "error": { "code": "...", "message": "..." } }`.

Mã lỗi dùng thống nhất: `unauthorized`, `forbidden`, `bad_request`, `payload_too_large`,
`rate_limited`, `not_found`, `method_not_allowed`, `server_error`, `invalid_credentials`.

## 5. Cấu trúc file (không tạo file ngoài danh sách này)

```
src/index.ts            src/auth.ts            src/api/api-types.ts
src/api/auth-routes.ts  src/api/sync.ts        src/api/stats.ts
src/api/images.ts       src/api/logs.ts        src/lib/validate.ts
src/lib/response.ts     src/lib/migrate.ts     src/lib/uid-input.ts
src/api/fbcheck.ts  src/api/bluecheck.ts
public/index.html  public/login.html  public/logs.html  public/images.html
public/uid.html  public/tickxanh.html
public/css/scroll.css  public/css/app.css  public/css/preloader.css
public/js/scroll.js  public/js/chart.js  public/js/dashboard.js
public/js/logs.js  public/js/images.js  public/js/uid.js
public/js/tickxanh.js  public/js/preloader.js
sync_stats.py  requirements.txt  bluecheck_watcher.py
test/acceptance.mjs  test/fbcheck-test.mjs  test/bluecheck-test.mjs
test/watcher-test.py
```

Quy ước import: đường dẫn tương đối, có đuôi `.js`? KHÔNG — dùng import không đuôi
(ví dụ `import { jsonOk } from "../lib/response";`), bundler của wrangler tự resolve.

## 6. Định dạng tiền ở client

`formatVND(1234567) === "1.234.567 ₫"` — dấu chấm phân cách nghìn, ký hiệu ₫ sau cùng,
có dấu cách ngăn cách. Định nghĩa trong `public/js/dashboard.js` và export qua `window.ShopFmt`.

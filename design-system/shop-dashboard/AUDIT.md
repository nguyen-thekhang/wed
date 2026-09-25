# AUDIT GIAO DIỆN — shop-dashboard

> Bản kiểm kê nội bộ trước khi nâng cấp UI/UX. Số liệu lấy trực tiếp từ source
> tại thời điểm rà soát, không phải ước lượng. Mọi thay đổi giao diện phải đối
> chiếu với `design-system/shop-dashboard/MASTER.md` (bản sự thật về thiết kế).

## 1. Sản phẩm là gì

| Hạng mục | Kết luận |
|---|---|
| Loại sản phẩm | Dashboard vận hành nội bộ (không phải landing page, không có luồng bán hàng). |
| Người dùng | Một người: chủ shop, tự đăng nhập bằng mật khẩu, xem số liệu và công cụ kiểm tra. |
| Backend | Cloudflare Worker (TypeScript) + D1 + R2 + static assets, `run_worker_first = true`. |
| Frontend | HTML + CSS + JavaScript thuần, không framework, không build step, không CDN. |
| CSP | `script-src 'self'` (không inline script), `style-src 'self' 'unsafe-inline'`, `font-src 'self'`. |
| Ngôn ngữ | Tiếng Việt có dấu, toàn bộ nhãn và thông báo. |
| Theme | Dark mode là trải nghiệm chuẩn duy nhất (`color-scheme: dark`). |

### Workflow quan trọng nhất

1. **Đăng nhập** → `/login.html` → `POST /api/login` → cookie phiên → `/index.html`.
2. **Đọc số liệu** → `/index.html` gọi `/api/stats`, `/api/stats/daily`, `/api/stats/products`, `/api/logs/syncs`; tự làm mới 5 phút/lần; cảnh báo đỏ khi snapshot cũ > 1 giờ.
3. **Tra cứu nhật ký** → `/logs.html` lọc theo ngày / hành động / số dòng, giữ tham số trên URL.
4. **Quản lý ảnh** → `/images.html` tải lên (kiểm magic bytes), xem qua Worker, xoá.
5. **Kiểm tra UID** → `/uid.html` dán danh sách → `POST /api/fbcheck` → 3 nhóm live/die/unknown + copy.
6. **Theo dõi tích xanh** → `/tickxanh.html` thêm UID vào hàng đợi, watcher đẩy kết quả về, tự làm mới 30 giây.

### CTA quan trọng nhất

| Trang | CTA chính |
|---|---|
| `login.html` | Đăng nhập |
| `index.html` | Làm mới số liệu (và đọc KPI doanh thu) |
| `logs.html` | Áp dụng bộ lọc |
| `images.html` | Chọn ảnh để tải lên |
| `uid.html` | Kiểm tra |
| `tickxanh.html` | Thêm UID vào hàng đợi |

## 2. Bản đồ route

| Route (Worker) | File | Script | Ghi chú |
|---|---|---|---|
| `/` `/index` `/index.html` | `public/index.html` | `scroll.js`, `chart.js`, `dashboard.js` | Trang tổng quan, 3 KPI, biểu đồ canvas, 4 bảng. |
| `/logs` `/logs.html` | `public/logs.html` | `scroll.js`, `logs.js` | Bộ lọc + bảng audit + bảng sync; có `skip-link`. |
| `/images` `/images.html` | `public/images.html` | `scroll.js`, `images.js` | Vùng kéo thả, thư viện ảnh, xoá ảnh. |
| `/uid` `/uid.html` | `public/uid.html` | `scroll.js`, `uid.js` | 3 panel kết quả, copy theo nhóm. |
| `/tickxanh` `/tickxanh.html` | `public/tickxanh.html` | `preloader.js`, `scroll.js`, `tickxanh.js` | Hàng đợi theo dõi, hộp thư thông báo. |
| `/login` `/login.html` | `public/login.html` | `scroll.js`, `login.js` | Không cần đăng nhập; asset công khai trong `PUBLIC_ASSET_PATHS`. |

`/js/nav.js` (mới) sẽ là script dùng chung cho khung điều hướng ở cả 5 trang đã đăng nhập.

## 3. Kiểm kê component

Cột "Trạng thái" mô tả tình trạng **trước** khi nâng cấp; kết quả sau nâng cấp nằm ở bảng bên dưới.

| Thành phần | Trạng thái trước | Vấn đề | Sau nâng cấp |
|---|---|---|---|
| Topbar / điều hướng | **5 cách triển khai khác nhau** | `index.html` dùng `<button>` không có JS → menu mobile hiện đè nội dung; `logs.html` dùng `popover`; `images.html` + `uid.html` dùng `<details class="nav-shell">`; `tickxanh.html` dùng `.tx-topbar` riêng + JS riêng. | Một mẫu `button.nav-toggle` + `nav#nav` + `/js/nav.js` cho cả 5 trang. |
| Skip-link | Thiếu ở `index`, `uid`, `tickxanh` | Không nhất quán. | Có ở cả 6 trang, cao 44px. |
| Brand | 4 biến thể (`.dot`, `.icon` sprite, `.tx-brand`) | Cùng sản phẩm, 4 diện mạo. | Một `.brand` + `.icon.brand-icon`. |
| Nút đăng xuất | 3 biến thể | `tickxanh` tự vẽ SVG. | `.btn.btn-sm` + icon sprite, nhãn bọc `<span data-logout-label>`. |
| Icon | Sprite **và** SVG inline ở `tickxanh` | Hai hệ song song, nét khác nhau. | Một sprite `/img/sprite.svg` (21 symbol). |
| Card / panel | `.card`, `.glass`, `.bx-panel`, `.tx-*` | `tickxanh` tự dựng panel riêng. | Một `.card` (+ `.is-flush`, `.card-head`, `.card-foot`). |
| Empty state | 4 phiên bản | Trùng lặp, lệch hình thức, có chỗ thiếu hành động. | Một `.empty-state` (+ `.is-compact`, `.uid-empty`). |
| Loading state | Chỉ chữ "Đang tải…" | Thiếu skeleton và thiếu tín hiệu máy đọc. | `.skeleton` + `aria-busy="true"` trên mọi vùng dữ liệu. |
| Bảng | Cuộn ngang, `min-width: 560px` | Phải cuộn ngang ở 375px. | Giữ bảng + `caption`; cuộn ngang có kiểm soát, không tràn trang. |
| Xác nhận hành động phá huỷ | `window.confirm()` | Không theo design system, không kiểm soát focus. | `.confirm-dialog` + `window.ShopConfirm.ask()`. |
| Hộp thư (bell + inbox) | Hai hệ class (`.bell*` và `.tx-*`) | Cùng chức năng, hai hệ. | Một `.bell-btn`/`.bell-badge`/`.inbox-panel`. |
| Biểu đồ | Canvas 1 chuỗi, không tooltip | Thiếu phản hồi khi rê chuột. | **Còn tồn** — xem mục 8. |
| Preloader / Reveal | Dùng chung tốt | — | Giữ nguyên. |

## 4. Kiểm kê CSS

| File | Dung lượng | Vai trò |
|---|---:|---|
| `public/css/app.css` | 43.494 B / 2.332 dòng / 305 selector | Design system hiện tại. |
| `public/css/scroll.css` | 7.953 B | Hiệu ứng cuộn (được test ràng buộc, không đổi). |
| `public/css/preloader.css` | 5.198 B | Màn hình chờ. |
| `<style>` nội tuyến trong 6 trang HTML | **69.557 B** | Trùng lặp và phân kỳ. |

Trùng lặp nền tảng đo được (selector đã có trong `app.css` mà vẫn khai báo lại trong trang):

| Trang | CSS nội tuyến | Selector | Đã có trong `app.css` | Riêng trang |
|---|---:|---:|---:|---:|
| `tickxanh.html` | 18.368 B | 91 | 0 | 91 (hệ `.tx-*` độc lập) |
| `uid.html` | 16.908 B | 67 | 15 | 52 |
| `images.html` | 14.481 B | 81 | 16 | 65 |
| `logs.html` | 10.695 B | 51 | 7 | 44 |
| `login.html` | 6.939 B | 31 | 6 | 25 |
| `index.html` | 2.166 B | 13 | 0 | 13 |

Ví dụ trùng lặp rõ nhất: `.skip-link` được định nghĩa **3 lần** với 3 bộ giá trị
khác nhau (`app.css`, `logs.html`, `images.html`), `.nav-shell` 3 lần,
`.empty-state` 2 lần với cấu trúc khác nhau.

## 5. Vấn đề UX/UI cụ thể đã xác định

| # | Vấn đề | Ảnh hưởng | Hướng xử lý | Trạng thái |
|---|---|---|---|---|
| 1 | Menu mobile của `index.html` luôn mở đè nội dung | Người dùng không đọc được số liệu trên điện thoại | Đưa về khung điều hướng dùng chung + `nav.js`. | ✅ Đã sửa |
| 2 | 5 kiến trúc điều hướng khác nhau | Sản phẩm trông như nhiều template ghép lại | Một markup topbar duy nhất cho cả 6 trang. | ✅ Đã sửa |
| 3 | 69,5 KB CSS nội tuyến | Khó bảo trì, không thể rút `'unsafe-inline'` khỏi CSP | Chuyển toàn bộ ra `app.css` + `pages.css`, xoá khối `<style>`. | ✅ Đã sửa |
| 4 | `tickxanh.html` là hệ thiết kế thứ hai (`.tx-*`) | Trang lệch tông so với 5 trang còn lại | Chuyển sang component dùng chung, giữ nguyên hành vi. | ✅ Đã sửa |
| 5 | Icon: sprite vs SVG tự vẽ | Độ dày nét và kích thước không khớp | Bổ sung symbol còn thiếu vào sprite, bỏ SVG inline. | ✅ Đã sửa |
| 6 | Bảng 4 cột phải cuộn ngang ở 375px | Khó đọc trên điện thoại | Bảng vẫn cuộn ngang có kiểm soát + `caption`; không tràn ngang trang. | ✅ Đã xử lý |
| 7 | Không có skeleton khi tải | Nội dung nhảy, cảm giác chậm | Thêm `.skeleton` + `aria-busy`. | ✅ Đã sửa |
| 8 | `window.confirm()` khi xoá ảnh/UID | Không đồng bộ design system, không kiểm soát focus | Hộp thoại `<dialog>` dùng chung (`confirm.js`) trả focus về nút gọi. | ✅ Đã sửa |
| 9 | Empty state 4 phiên bản | Không đồng nhất, thiếu hành động ở vài chỗ | Một component `.empty-state` (kèm `.uid-empty`) luôn có hướng dẫn + hành động. | ✅ Đã sửa |
| 10 | Biểu đồ không có tooltip | Phải đoán giá trị từng ngày | Tooltip vẽ trên canvas + đọc được bằng bàn phím và `aria-live`; màu lấy từ token emerald. | ✅ Đã sửa |
| 11 | 3 trang thiếu `skip-link` | Người dùng bàn phím phải tab qua menu | Thêm vào cả 6 trang. | ✅ Đã sửa |
| 12 | Nhãn trang không đồng nhất | Nhịp điệu thị giác lệch | Chuẩn hoá `.page-head` + `.page-eyebrow`. | ✅ Đã sửa |
| 13 | Tham chiếu `kpi-wallet` còn sót trong `dashboard.js` | Code chết | — | ✅ Không còn trong source |
| 14 | `.shimmer` khai báo nhưng không dùng | CSS chết | Xoá, thay bằng `.skeleton`. | ✅ Đã sửa |

### Lỗi phát hiện thêm khi kiểm chứng (không có trong bản kiểm kê đầu)

| # | Vấn đề | Bằng chứng | Trạng thái |
|---|---|---|---|
| 15 | Nút menu `index.html` là `<button>` **không có JS** — bấm không có gì xảy ra | Đo bằng CDP ở 375px: `shell.open=false` sau khi bấm. | ✅ Đã sửa |
| 16 | Nút menu hiện **lơ lửng trên desktop** ở `index.html` | Ảnh chụp 1440px cho thấy nút hamburger cạnh brand. | ✅ Đã sửa |
| 17 | Thanh điều hướng **không hiện** ở 768px và desktop (`logs`, `images`, `uid`, `tickxanh`) | `elementFromPoint()` tại tâm liên kết trả về phần tử cha; ảnh chụp desktop thiếu hẳn dải liên kết. Nguyên nhân: nội dung `<details>` khi đóng không được trình duyệt vẽ ra. | ✅ Đã sửa (đổi sang `<button>` + `.is-open`) |
| 18 | Trang đăng nhập bị **302** cho `/css/preloader.css`, `/js/preloader.js`, `/img/logo.svg` | Gọi thẳng production: cả ba trả 302 về `/login.html`. Kết quả: màn hình chờ trơ "0 % Đang tải" đè trên form và logo vỡ. | ✅ Đã sửa (`PUBLIC_ASSET_PATHS`) |
| 19 | `#favicon.ico` bị 404 trên **mọi** trang | `Network.responseReceived` trả 404 cho `/favicon.ico`. | ✅ Đã sửa (khai báo `rel="icon"` + whitelist) |
| 20 | `.empty-state` của `index.html` không bao giờ hiện | `.empty-state` bị `pages.css` (nạp sau) ghi đè `display:none` với hiệu lực toàn cục. | ✅ Đã sửa (một định nghĩa duy nhất) |
| 21 | `#logout-btn` của `uid.html` chèn biểu tượng lên nút đăng xuất của **mọi** trang | `#logout-btn::before` trong `pages.css` áp cho cả 5 trang. | ✅ Đã sửa |
| 22 | Nút "Đăng xuất" của `tickxanh` mất biểu tượng khi bận | `setLogoutBusy` gán `textContent` lên cả nút. | ✅ Đã sửa |
| 23 | `logs.html` hiện **hai khối rỗng cùng lúc** | Đo trong DOM: 2 khối `.empty-state` và 2 khối chữ trần cùng hiện. | ✅ Đã sửa |
| 24 | `aria-busy` sai trạng thái trên `logs.html` (`"false"` trong lúc đang tải) | Đo bằng CDP khi giữ request. | ✅ Đã sửa |
| 25 | Bảng và danh sách không công bố `aria-busy` khi đang tải | Nhiều trang chỉ có chữ "Đang tải…", thiếu tín hiệu đọc được. | ✅ Đã sửa |

### Lỗi tìm thấy ở vòng rà soát thứ hai (dọn dẹp)

| # | Vấn đề | Bằng chứng | Trạng thái |
|---|---|---|---|
| 26 | `dashboard.js` vẫn gọi `setText("kpi-wallet", …)` — tham chiếu tới thẻ đã bị yêu cầu bỏ, và chạm vào trường `wallet_balance_sum` (dữ liệu nhạy cảm) | `grep` trong `public/js` | ✅ Đã sửa |
| 27 | `pages.css` còn sót 13 selector chết nằm LẪN trong danh sách dùng chung (`.glass`, `.chip`, `.bx-panel`, `.bx-dot`, `.spacer`, `.grow`…) | Quét class khai báo vs dùng | ✅ Đã sửa |
| 28 | `app.css` còn `.hero-sub, .hero-note,` treo trong một `@media` | Đọc mã | ✅ Đã sửa |
| 29 | `chart.js` còn hàm `pad()` không nơi nào gọi | Quét hàm JS | ✅ Đã sửa |
| 30 | `chart.js` hardcode màu xanh dương/tím (`#5b8cff`, `#7c5cff`) trái design system | Đọc mã + ảnh chụp | ✅ Đã sửa |

## 6. Ràng buộc bất di bất dịch khi nâng cấp

- Không đổi `id` phần tử mà JS đang dùng; không đổi route/URL; không đổi API.
- Không thêm CDN, font ngoài, framework, thư viện UI.
- Không dùng `<script>` nội tuyến (CSP chặn) và không `innerHTML` cho dữ liệu máy chủ.
- Mọi asset tĩnh mới phải thêm vào `PUBLIC_ASSET_PATHS` **chỉ khi** trang công khai
  (`login.html`) cần; asset của trang đã đăng nhập không cần.
- `test/acceptance.mjs` và `test/login-flow.mjs` phải tiếp tục đạt.
- Giữ `prefers-reduced-motion`, chỉ animate `opacity`/`transform`, mật độ 8/10.

## 7. Thứ tự thi công

1. Khung dùng chung: topbar + nav + skip-link cho 6 trang, thêm `/js/nav.js`.
2. Rút CSS nội tuyến ra `app.css` (hệ thống) và `pages.css` (bố cục riêng trang), xoá `<style>`.
3. Bổ sung component dùng chung: empty-state, skeleton, dialog xác nhận, toast, bảng → thẻ ở mobile.
4. Chuyển `tickxanh.html` sang component dùng chung, bỏ hệ `.tx-*` và SVG inline.
5. Nâng cấp từng trang: thứ bậc thị giác, CTA, trạng thái tải/rỗng/lỗi/disabled.
6. Responsive tại 375/768/1024/1440; kiểm tra tràn ngang.
7. Tiếp cận: nhãn aria, focus, tương phản, kích thước vùng chạm.
8. Dọn dẹp: CSS chết, `kpi-wallet`, kiểm tra typecheck + test + build.
9. Kiểm chứng bằng trình duyệt thật ở 375/768/1024/1440 (xem `npm run ui:*` trong README).

## 8. Còn tồn thật sự

**Không còn hạng mục nào đã biết.** Mọi mục trong bảng 5, bảng 15–25 và bảng 26–30 đã được sửa và kiểm chứng bằng trình duyệt thật.

Quét lần cuối: **0 class CSS chết** (221 khai báo / 260 dùng), **0 hàm JS không được gọi**, 0 lỗi console ở 24 tổ hợp trang × mốc màn hình.

Ba việc dưới đây **không phải lỗi** nhưng cần biết khi làm tiếp:

1. **Bảng rộng ở 375px phải cuộn ngang.** Đây là lựa chọn có chủ ý: bảng giữ đúng `caption` và thứ tự đọc cho trình đọc màn hình, không tràn ngang trang, và có gợi ý "vuốt ngang bảng để xem đủ các cột". Chuyển hẳn sang dạng thẻ ở mobile sẽ làm mất cột đối chiếu — chỉ nên làm nếu chủ shop yêu cầu.
2. **`/favicon.ico` và `/robots.txt`** được khai báo trong `PUBLIC_ASSET_PATHS` nhưng không có tệp tương ứng nên trả 404. Vô hại (khai báo một đường dẫn không tồn tại không lộ gì). Mọi trang đã khai báo `/img/favicon.svg` nên trình duyệt không còn tự hỏi `/favicon.ico`.
3. **`login.html` phải được cập nhật mỗi khi thêm tài nguyên mới.** Trang này là trang công khai duy nhất, nên mọi tài nguyên nó tham chiếu đều phải nằm trong `PUBLIC_ASSET_PATHS`. `node test/asset-whitelist.mjs` sẽ báo lỗi ngay nếu thiếu — chạy nó sau mỗi lần sửa `login.html`.



# Hệ thống thiết kế chuẩn — Shop Dashboard

> Đây là bản sự thật chuẩn cho giao diện Shop Dashboard. Mọi triển khai phải tuân thủ tài liệu này, ưu tiên tốc độ nhận biết, khả năng vận hành và khả năng truy cập.

## 1. Tổng quan

| Hạng mục | Quyết định |
|---|---|
| Loại sản phẩm | Dashboard công cụ làm việc, ưu tiên đọc dữ liệu nhanh, thao tác rõ ràng và theo dõi trạng thái liên tục. |
| Người dùng | Một người dùng vận hành hệ thống; không thiết kế theo nhu cầu thuyết phục nhiều tầng như trang marketing. |
| Ngôn ngữ | Toàn bộ nội dung hiển thị và chú thích bằng tiếng Việt có dấu. |
| Giao diện | Dark mode là trải nghiệm chuẩn của sản phẩm. |
| Công nghệ giao diện | HTML, CSS và JavaScript thuần; không framework. |
| Backend | Cloudflare Worker viết bằng TypeScript. |
| Phạm vi | Không phải landing page; không dùng cấu trúc Hero, dải logo khách hàng, luồng Contact Sales hay CTA thuyết phục. |

**Style: Glassmorphism + Data-Dense Dashboard**  
**Density 8/10** — Mật độ cao, thông tin dày nhưng vẫn dễ quét.  
**Motion 4/10** — Chuyển động tinh tế, phục vụ phản hồi trạng thái chứ không gây chú ý.

Nguyên tắc sản phẩm:

- Giao diện phục vụ công việc, không kể một câu chuyện thương hiệu dài.
- Thông tin quan trọng phải dễ tìm, dễ so sánh và dễ thao tác.
- Dữ liệu, trạng thái và hành động phải nổi bật theo thứ tự ưu tiên thực tế.
- Không phụ thuộc CDN, thư viện UI từ xa, Google Fonts hay nguồn ảnh bên ngoài.
- Worker áp dụng CSP chặt chẽ; tài nguyên phải phục vụ từ cùng dự án.
- JavaScript phải nằm trong `public/js/*.js`; không dùng thẻ `<script>` nội tuyến.

## 2. Bảng màu

| Vai trò | Mã màu | Biến CSS đề xuất | Cách dùng |
|---|---|---|---|
| Nền chính | `#0b0f19` | `--color-bg` | Nền toàn trang. |
| Nền độ sâu | `#09090b` | `--color-bg-deep` | Vùng chìm, lớp nền sâu hơn. |
| Thẻ kính mờ | `rgba(255,255,255,0.03)` | `--color-surface` | Bề mặt thẻ và vùng nội dung. |
| Bề mặt nhấn mạnh | `rgba(255,255,255,0.045)` | `--color-surface-raised` | Thẻ nổi bật, hàng chọn, lớp hoạt động. |
| Viền | `rgba(255,255,255,0.10)` | `--color-border` | Viền chung, ngăn cách mảnh. |
| Accent chính | `#10b981` | `--color-accent` | Hành động chính, trạng thái tích cực, focus. |
| Accent sáng | `#34d399` | `--color-accent-hover` | Hover và trạng thái nhấn mạnh của accent. |
| Tiêu đề | `#f8fafc` | `--color-text` | Tiêu đề và nội dung chính. |
| Nội dung phụ | `#94a3b8` | `--color-text-secondary` | Mô tả, nhãn phụ, dữ liệu hỗ trợ. |
| Chú thích | `#738399` | `--color-text-muted` | Chú thích thấp trọng nhưng vẫn đạt chuẩn. |
| Nguy hiểm | `#fb7185` | `--color-danger` | Lỗi, xóa, thất bại nghiêm trọng. |
| Cảnh báo | `#f59e0b` | `--color-warning` | Cảnh báo và trạng thái cần chú ý. |
| Meta đã xác nhận | `#1877F2` | `--color-meta-verified` | Chỉ dùng cho biểu tượng trạng thái tài khoản Meta đã xác nhận; không dùng làm màu giao diện. |

Quy tắc sử dụng:

- Màu accent làm nổi bật hành động và trạng thái tích cực, không dùng đeo trên mọi vùng.
- Bề mặt dùng hai cấp độ kính mờ đã quy định; viền luôn mảnh `1px`.
- Không dùng `#1877F2` cho nút, liên kết, biểu đồ hoặc trạng thái chung.
- Không dùng các màu cơ bản phổ biến của bộ sinh giao diện tự động như `blue-500`, `blue-600`, `gray-100` hoặc `gray-500` làm bảng màu chính.
- Không thay đổi độ tương phản đã kiểm chứng để đổi sang một sắc xanh hoặc xanh lá khác.

### Lưu ý tương phản chữ chú thích

Màu chú thích phải giữ nguyên `#738399`, không thay bằng `#64748b`:

- `#64748b` chỉ đạt khoảng `4.02:1` trên nền tối nhất và **không đạt WCAG AA** cho chữ thông thường.
- `#738399` đạt khoảng `4.51:1` trên nền tối nhất, đáp ứng mức tối thiểu `4.5:1`.
- Mọi cặp chữ và nền thực tế vẫn phải được kiểm tra lại khi kết hợp trong giao diện.

## 3. Chữ

Dùng font hệ thống, không tải font từ mạng:

```css
:root {
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
}
```

| Nhóm | Font | Dùng cho |
|---|---|---|
| Chữ thường | `--font` | Nội dung, nhãn, nút, điều hướng và tiêu đề. |
| Chữ dữ liệu | `--mono` | Số liệu, UID, mã, thời gian và giá trị cần so sánh chính xác. |

Quy tắc:

- Cỡ chữ nhỏ nhất là `12px`.
- Chữ thân nội dung dùng `14–15px`.
- Tiêu đề trang dùng `28–34px`; tiêu đề nhóm nhỏ hơn và không cạnh tranh với tiêu đề chính.
- Font đơn sắc phải có `font-variant-numeric: tabular-nums` cho cột số liệu để dễ dọc dọc.
- Không dùng `@import`, Google Fonts, jsDelivr hoặc bất kỳ tải font ngoài nào.

Bộ skill có thể gợi ý Fira Code và Fira Sans, nhưng dự án **không được dùng** hai font này. Worker có CSP `font-src 'self'`, nên Google Fonts bị chặn; tải bản sao chưa được phê duyệt cũng làm tăng rủi ro vận hành và trái với nguyên tắc phục vụ tài nguyên từ cùng dự án. Font hệ thống đáp ứng giao diện, không phụ thuộc mạng và giữ đúng ràng buộc bảo mật.

## 4. Khoảng cách và mật độ

**Density 8/10** là mục tiêu bắt buộc, không phải lựa chọn tùy ý theo từng màn hình.

| Quy tắc | Giá trị |
|---|---|
| Khoảng cách trong thẻ | `6–10px` |
| Khoảng cách giữa các khối | `14–18px` |
| Padding trong khối | `14–18px` |
| Lề giữa các thành phần | `10–12px` |
| Bán kính thẻ | `16px` |
| Bán kính nút | `10px` |
| Bán kính nhỏ | `7px` |
| Độ dày viền | `1px` |

Nguyên tắc bố cục:

- Dùng nền, viền và khoảng trắng để phân cấp thông tin; không tạo cảm giác thoáng bằng cách tăng padding vô hạn.
- Glassmorphism phải tinh tế: bề mặt kính mờ, viền mảnh và tối đa `2–3` lớp chiều sâu.
- Các lớp nền sâu dùng `#09090b`; nền chính dùng `#0b0f19`; tuyệt đối không thay bằng đen tuyệt đối.
- Bảng, danh sách và thẻ số liệu phải cô đọng, nhưng vẫn có khoảng đệm đủ để dễ quét và nhấn.
- Không dùng bóng đổ nặng, hiệu ứng lấp lánh hoặc gradient trang trí làm tranh chấp sự chú ý với dữ liệu.

## 5. Chuyển động

**Motion 4/10** — Chuyển động chỉ giúp người dùng hiểu thay đổi trạng thái.

| Thuộc tính | Quy tắc |
|---|---|
| Thời lượng | `150–300ms` |
| Đường cong | `cubic-bezier(0.22, 1, 0.36, 1)` |
| Thuộc tính được phép | Chỉ `opacity` và `transform` |
| Mục tiêu | Hover, focus, mở/đóng lớp, hiển thị trạng thái mới |
| Reduced motion | Tắt chuyển động không thiết yếu và hiển thị ngay trạng thái cuối |

- Không tạo hiệu ứng dây chuyền, nảy quá độ, parallax hoặc hiệu ứng tự động kéo người dùng chú ý.
- Không chuyển động `width`, `height`, `top`, `left`, `margin` hoặc các thuộc tính làm thay đổi bố cục.
- Chuyển động không được làm chậm thao tác thường xuyên trên dashboard.
- Với `prefers-reduced-motion: reduce`, bỏ chuyển động không cần thiết; dữ liệu và hành động vẫn phải sử dụng được ngay lập tức.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
```

## 6. Biểu tượng

- Dùng SVG outline tự vẽ, lấy từ sprite cục bộ `/img/sprite.svg`.
- Dùng `currentColor`, cùng kích thước và cùng độ dày nét để toàn bộ biểu tượng nhất quán.
- Không dùng emoji làm biểu tượng.
- Không tải Lucide, Feather, Heroicons hoặc bất kỳ icon CDN nào.
- Nút chỉ có biểu tượng phải có `aria-label` mô tả đúng chức năng; không chỉ dựa vào vị trí hoặc hình ảnh.
- Icon mang tính trang trí phải được đánh dấu ẩn với trình đọc màn hình; icon mang thông tin phải có nhãn văn bản tương ứng.

Ví dụ tham chiếu:

```html
<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
  <use href="/img/sprite.svg#dashboard"></use>
</svg>
```

## 7. Component dùng chung

Mọi thành phần giao diện phải lấy từ danh sách này. Không dựng biến thể riêng ở cấp trang.

| Thành phần | Class / id chuẩn | Ghi chú |
|---|---|---|
| Thanh trên cùng | `.topbar > .wrap.topbar-inner` | Một mẫu duy nhất cho cả năm trang đã đăng nhập. |
| Thương hiệu | `.brand` + `.icon.brand-icon` | Cao tối thiểu 44px; nhãn tự cắt bằng dấu ba chấm. |
| Nút menu | `.nav-toggle` (`#nav-toggle`) | `<button>` có `aria-expanded`, mở bằng class `.is-open` trên `#nav`. |
| Điều hướng | `.nav` (`#nav`) | Cột ở mobile, hàng ngang từ 768px. Mỗi mục có `.icon` + nhãn chữ. |
| Liên kết bỏ qua | `.skip-link` | Mọi trang đều có; cao 44px; hiện khi được focus. |
| Nút | `.btn`, `.btn-primary`, `.btn-danger` | Cao tối thiểu 44px. |
| Nút chỉ biểu tượng | `.icon-button` / `.bell-btn` | 44×44px, bắt buộc `aria-label`. |
| Thẻ | `.card`, `.card.is-flush` | `.is-flush` bỏ đệm để nhét bảng. |
| Đầu / chân thẻ | `.card-head`, `.card-heading`, `.card-head-title`, `.card-foot` | Thay cho mọi biến thể `*-table-head`. |
| Nhãn / viên | `.badge`, `.pill`, `.chip`, `.count-chip`, `.meta-chip` | Trạng thái dùng thêm `.is-ok` / `.is-warn` / `.is-danger`. |
| Trạng thái rỗng | `.empty-state` (+ `.is-compact`) | Bắt buộc có `.empty-state-mark`, tiêu đề, câu giải thích và hành động. |
| Khung xương | `.skeleton`, `.skeleton-line`, `.skeleton-stack` | Trang trí: `aria-hidden="true"` + một dòng `.visually-hidden`. |
| Hộp thư | `.inbox-panel`, `.inbox-panel-head`, `#inbox` | Lớp nổi `position: fixed`; đặt ngoài `.topbar` để không bị neo vào thanh trên cùng. |
| Hộp thoại xác nhận | `.confirm-dialog` + `window.ShopConfirm.ask()` | Thay `window.confirm`; trả focus về nút gọi khi đóng. |
| Các bước | `.steps`, `.step-num`, `.step-copy` | Danh sách "cách hoạt động". |
| Chân biểu mẫu | `.form-actions` | Gợi ý bên trái, nút gửi bên phải. |
| Bảng | `.table-wrap` / `.table-scroll` (+ `.is-wide`) | Cuộn ngang có kiểm soát; mọi bảng có `<caption>`. |
| Ghi chú dưới bảng | `.table-note` | Một định nghĩa dùng chung trong `app.css`. |

Quy ước bắt buộc:

- `app.css` là nơi duy nhất định nghĩa primitive và component dùng chung.
- `pages.css` **không** được khai báo lại `.skip-link`, `.nav*`, `.empty-state`… vì nó được nạp trên cả năm trang nên mọi selector đều có hiệu lực toàn cục.
- Không dùng selector cấp id của thành phần dùng chung (ví dụ `#logout-btn`) trong `pages.css`.
- Script dùng chung: `/js/nav.js` (điều hướng), `/js/confirm.js` (hộp thoại xác nhận), `/js/preloader.js`, `/js/scroll.js`.

### Cạm bẫy khi dọn CSS chết

Hai lần dọn đã làm HỎNG giao diện vì cùng một lý do, ghi lại để không lặp lại:

1. **Xoá theo regex `selector { … }` là sai.** `.badge, .pill, .chip { … }` sẽ bị cắt từ `.chip` trở xuống, làm mất luôn phần thân rule của `.badge`/`.pill` (mất `width: fit-content`, `line-height: 1.3`). Chỉ được xoá một rule khi **toàn bộ** danh sách selector của nó đều chết.
2. **Duyệt theo dòng rồi `i++` một dòng là sai.** Khi rule còn selector sống, vòng lặp chỉ đẩy dòng đầu rồi tiến một dòng; dòng `.chip,` tiếp theo lại được coi là *đầu một danh sách mới* → trông "chết hoàn toàn" và bị xoá cả rule.

Cách đúng: phân tích cả tệp thành các cặp (danh sách selector, thân trong ngoặc), **đệ quy vào `@media`**, cắt selector từ bản **đã bỏ chú thích** (không phải bản gốc — nếu không, rule đứng sau chú thích mục sẽ có selector lẫn cả chú thích và không bao giờ khớp), rồi lọc selector chết khỏi danh sách. Sau đó chạy guard: không còn selector chết, không có dấu phẩy treo/đôi, ngoặc cân bằng, **số rule không tăng**, và các khai báo quan trọng (`width: fit-content`, `line-height: 1.3`, `.bell-btn`, `.bx-uid`…) vẫn còn.

Và luôn kiểm chứng bằng **so sánh với bản sao lưu**: liệt kê mọi dòng khai báo thuộc tính bị mất rồi xác nhận từng dòng đều thuộc selector đã chết.


## 8. Khả năng tiếp cận

- Mọi chữ thông thường phải đạt tương phản tối thiểu `4.5:1`; chữ lớn cũng không được bỏ qua kiểm tra.
- Focus của bàn phím phải luôn nhìn thấy, ưu tiên viền accent rõ và khoảng tách khỏi phần tử.
- Mọi phần tử có thể nhấn hoặc nhấp phải có `cursor: pointer`; trạng thái focus của chuột không được thay thế focus bàn phím.
- Trạng thái không được chỉ truyền tải bằng màu; luôn kết hợp với nhãn, biểu tượng, hình dạng hoặc văn bản phù hợp.
- Trạng thái rỗng phải có hướng dẫn và một hành động khả dụng; không để vùng trống không giải thích.
- Bảng và danh sách phải giữ thứ tự đọc hợp lý khi dùng bàn phím và trình đọc màn hình.
- Vùng tương tác phải có nhãn truy cập rõ; hình ảnh có ý nghĩa phải có văn bản thay thế phù hợp.
- Vùng dữ liệu cập nhật bất đồng bộ phải công bố trạng thái cho trình đọc màn hình: dùng `aria-busy="true"` khi đang tải (bảng, danh sách) và `role="status"`/`role="alert"` cho phản hồi.
- Mọi vùng chạm (nút, liên kết, ô nhập, `summary`) phải cao tối thiểu `44px`; **kể cả** `.brand` và `.skip-link`.

### Kiểm chứng bằng trình duyệt thật

Không phán đoán từ đọc mã. Bốn bài đo trong `test/` chạy Chrome thật qua DevTools Protocol:

| Lệnh | Đo gì |
|---|---|
| `npm run ui:audit` | Tràn ngang, phần tử tràn khung, vùng chạm <44px, tương phản, chữ bị cắt, lỗi console ở 375/768/1024/1440. |
| `npm run ui:nav` | Điều hướng dùng chung: menu đóng/mở thật bằng chuột, `aria-expanded`, Escape trả focus, thanh ngang ở desktop, liên kết không bị bóp chiều rộng. |
| `npm run ui:a11y` | 10 phép kiểm khả năng tiếp cận + giảm chuyển động. |
| `npm run ui:states` | Trạng thái đang tải / rỗng / lỗi / khoá + hộp thoại xác nhận. |
| `npm run ui:chart` | Biểu đồ: màu theo token, tooltip vẽ thật trên canvas, đọc được bằng bàn phím + `aria-live`. |
| `npm run assets:check` | Mọi tài nguyên `login.html` tham chiếu đều nằm trong `PUBLIC_ASSET_PATHS` (chống lỗi 302 làm vỡ trang đăng nhập). |

Bốn lưu ý kỹ thuật đã trả giá khi viết các bài đo này:

1. `element.focus()` bằng lập trình **không** bật `:focus-visible`; phải bấm Tab thật. Và cửa sổ headless không được coi là đang focus nên `:focus` không khớp — phải bật `Emulation.setFocusEmulationEnabled`.
2. `getBoundingClientRect()` **không** cho biết phần tử có nhìn thấy được không; phải dùng hit-test `document.elementFromPoint()`.
3. Nội dung của `<details>` khi đóng không được trình duyệt vẽ ra — vì vậy điều hướng dùng `<button>` + `.is-open`, không dùng `<details>` (xem mục 10).
4. Đo `:hover` phải cuộn phần tử vào khung nhìn và **đợi toạ độ ổn định**; nếu không, `scrollIntoView()` làm bố cục co giãn thêm một nhịp và chuột tới sai chỗ. Và với canvas, phải so sánh **ảnh canvas** trước/sau chứ không tin vào biến trạng thái — bằng không sẽ bỏ sót lỗi tooltip không được vẽ.

Bố cục responsive theo hướng mobile-first và phải được kiểm tra tại các mốc:

| Mốc | Yêu cầu |
|---|---|
| `375px` | Không tràn ngang; thao tác chính vẫn dễ chạm; dữ liệu ưu tiên được thu gọn có kiểm soát. |
| `768px` | Bố cục chuyển sang nhiều cột khi đủ chỗ, không làm mất ngữ cảnh dữ liệu. |
| `1024px` | Tận dụng không gian cho cột thao tác, bộ lọc và bảng mà vẫn giữ mật độ 8/10. |
| `1440px` | Giới hạn chiều rộng nội dung và căn chỉnh để tránh quét dòng quá xa. |

## 9. Anti-patterns phải tránh

| Không làm | Hành động đúng |
|---|---|
| Dùng landing page hoặc bố cục Hero → logo khách hàng → Contact Sales. | Xây dựng màn hình vận hành với khu vực trạng thái, dữ liệu, bộ lọc, bảng và hành động theo ưu tiên. |
| Để trạng thái rỗng trơn, không giải thích hoặc không có cách khắc phục. | Hiện hướng dẫn ngắn, nguyên nhân nếu phù hợp và hành động tiếp theo rõ ràng. |
| Dùng emoji làm icon. | Dùng SVG outline nhất quán từ `/img/sprite.svg`. |
| Bỏ bộ lọc khỏi dashboard. | Cung cấp bộ lọc cần thiết vì người dùng phải thu hẹp và đối chiếu khối lượng dữ liệu. |
| Thêm chuyển động thừa hoặc chuyển động thuộc tính bố cục. | Chỉ dùng `opacity` và `transform` trong `150–300ms`. |
| Dùng chữ có tương phản dưới `4.5:1`. | Dùng bảng màu đã kiểm chứng và kiểm tra lại từng cặp chữ–nền. |
| Lấy `blue-500`, `blue-600`, `gray-100` hoặc `gray-500` làm màu cơ bản. | Dùng emerald accent và các màu nền, bề mặt, chữ đã quy định trong tài liệu này. |
| Dùng gradient tím–xanh phong thếp. | Dùng nền tối có chiều sâu qua hai nền và hai cấp bề mặt kính mờ. |
| Dùng đen tuyệt đối làm nền. | Dùng `#0b0f19` hoặc `#09090b`, không dùng `#000000`. |
| Tải Tailwind, Lucide, Google Fonts, jsDelivr hoặc tài nguyên bên ngoài. | Phục vụ mọi tài nguyên từ dự án và tuân thủ CSP của Worker. |
| Đặt JavaScript trong thẻ `<script>` nội tuyến. | Đặt mọi JavaScript trong `public/js/*.js`. |
| Dùng `innerHTML` để chèn dữ liệu từ máy chủ. | Tạo phần tử bằng `createElement` và gán nội dung bằng `textContent`. |

## 10. Kiểm tra trước khi giao

- [ ] Đây là dashboard làm việc cho một người dùng, không phải landing page.
- [ ] Toàn bộ nội dung hiển thị và chú thích bằng tiếng Việt có dấu.
- [ ] Dùng đúng `#0b0f19`, `#09090b`, hai lớp kính mờ, viền và bảng màu đã quy định.
- [ ] Accent là `#10b981` / `#34d399`; không dùng màu cơ bản phổ biến của bộ sinh giao diện tự động.
- [ ] Màu chú thích vẫn là `#738399`; không thay bằng `#64748b`.
- [ ] `#1877F2` chỉ xuất hiện ở biểu tượng trạng thái tài khoản Meta đã xác nhận.
- [ ] Không có Google Fonts, CDN, `@import` tài nguyên ngoài hoặc font Fira.
- [ ] Chữ thường dùng system font; số liệu, UID và mã dùng monospace.
- [ ] Cỡ chữ nhỏ nhất là `12px`; chữ thân là `14–15px`; tiêu đề là `28–34px`.
- [ ] Khoảng cách, padding, lề và bo góc nằm trong mật độ 8/10 đã chốt.
- [ ] Mọi chuyển động chỉ dùng `opacity` và `transform`, kéo dài `150–300ms` với đường cong đã chốt.
- [ ] `prefers-reduced-motion: reduce` tắt chuyển động không thiết yếu.
- [ ] Biểu tượng là SVG outline từ `/img/sprite.svg`; không có emoji hoặc icon CDN.
- [ ] Mọi nút có thao tác có `cursor: pointer`; mọi focus bàn phím đều nhìn thấy.
- [ ] Tương phản chữ đạt tối thiểu `4.5:1`; trạng thái không chỉ dùng màu để truyền tải.
- [ ] Mọi trạng thái rỗng có hướng dẫn và hành động; bộ lọc cần thiết vẫn được giữ.
- [ ] Giao diện được kiểm tra ở `375px`, `768px`, `1024px` và `1440px`, không tràn ngang.
- [ ] Không có CDN, JavaScript nội tuyến hoặc `innerHTML` để chèn dữ liệu từ máy chủ.
- [ ] Dữ liệu từ máy chủ được chèn bằng `createElement` và `textContent`.
- [ ] Không thay đổi `id` phần tử HTML mà JavaScript hiện đang sử dụng.
- [ ] Không đọc, ghi hoặc ghi nhật ký nội dung cột bí mật của bảng `stock`.

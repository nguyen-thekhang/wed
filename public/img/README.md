# Bộ tài nguyên giao diện Dashboard

Thư mục này chỉ chứa các tài nguyên SVG dùng chung cho Dashboard. Không tải biểu tượng, phông chữ hoặc ảnh từ dịch vụ bên ngoài.

## Biểu tượng dùng chung

File `sprite.svg` chứa các `<symbol>` với khung `0 0 24 24`, nét viền `1.75`, bo tròn và màu kế thừa qua `currentColor`.

| ID | Dùng khi nào |
| --- | --- |
| `icon-chart` | Hiển thị biểu đồ, xu hướng hoặc chỉ số tổng quan |
| `icon-clock` | Hiển thị thời gian, lịch hoặc hoạt động gần đây |
| `icon-image` | Hiển thị ảnh, thư viện hoặc trạng thái chưa có ảnh |
| `icon-search` | Mở tìm kiếm, lọc danh sách hoặc nhập từ khóa |
| `icon-bell` | Hiển thị thông báo hoặc cập nhật chưa đọc |
| `icon-check` | Xác nhận thành công, trạng thái hoàn tất hoặc lựa chọn đã chọn |
| `icon-x` | Đóng hộp thoại, hủy thao tác hoặc xóa bộ lọc |
| `icon-alert` | Hiển thị cảnh báo, lỗi hoặc trạng thái cần chú ý |
| `icon-trash` | Xóa dữ liệu hoặc mở hộp thoại xóa |
| `icon-plus` | Thêm mục, tạo bản ghi hoặc mở hành động mới |
| `icon-user` | Hiển thị người dùng, hồ sơ hoặc thông tin tài khoản |
| `icon-logout` | Đăng xuất hoặc kết thúc phiên làm việc |
| `icon-copy` | Sao chép giá trị, mã hoặc nội dung ngắn |
| `icon-external` | Mở liên kết ngoài hoặc điều hướng ra ngoài ứng dụng |
| `icon-sparkles` | Biểu thấy tính năng mới, gợi ý hoặc trạng thái tự động |
| `icon-refresh` | Tải lại dữ liệu, đồng bộ hoặc thử lại thao tác |

## Cách sử dụng

Đặt phần tử `<svg>` cạnh nút hoặc nhãn. Icon có ý nghĩa phải có `aria-label`; icon trang trí nên dùng `aria-hidden="true"`.

```html
<svg width="24" height="24" aria-label="Hoàn tất" role="img">
  <use href='/img/sprite.svg#icon-check'></use>
</svg>
```

Ví dụ rút gọn đúng yêu cầu:

```html
<svg><use href='/img/sprite.svg#icon-check'></use></svg>
```

Đặt màu cho `<svg>` bằng CSS hoặc thuộc tính `color`; các symbol sẽ dùng màu `currentColor`. Không thêm `fill` vào nút chứa icon.

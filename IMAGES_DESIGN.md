# =====================================================================
# ẢNH: thiết kế đã freeze cho nhánh làm ảnh (R2 + D1 + UI).
# Bucket R2 là PRIVATE. Mọi truy cập đều đi qua Worker và phải đăng nhập.
# =====================================================================

## Bảo mật bắt buộc

1. Bucket `shop-images` **KHÔNG** bật public access, không gắn custom domain công khai.
2. Upload chỉ nhận `image/jpeg`, `image/png`, `image/webp`.
3. Tối đa **5 MB** (5 * 1024 * 1024 byte). Vượt → 413 `payload_too_large`.
4. **Không tin `Content-Type` của client.** Đọc bytes đầu file và đối chiếu magic bytes:
   - JPEG: `FF D8 FF`
   - PNG: `89 50 4E 47 0D 0A 1A 0A`
   - WEBP: `52 49 46 46` (offset 0..3) + `57 45 42 50` (offset 8..11)
   Nếu magic bytes không khớp đuôi/mime → từ chối 400 `bad_request`.
   File `.exe` đổi tên thành `.jpg` phải bị từ chối.
5. Tên trên R2 dùng UUID v4 (không dùng tên gốc của client), ví dụ `img_<uuid>.<ext>`.
6. `sha256` hex của nội dung file, lưu vào D1.
7. `GET /api/images/:key` phải gọi `requireAuth` TRƯỚC khi chạm R2. Không đăng nhập → 401.
8. Trả ảnh kèm `Content-Type` lấy từ D1/R2, `Content-Disposition: inline`,
   `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
9. `key` phải validate regex `^img_[0-9a-f-]{36}\.(jpg|png|webp)$` trước khi chạm R2 (chống path traversal).
10. Xóa ảnh: xóa R2 + xóa row D1 + ghi `audit_log` action `delete`.

## Route

| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/images?limit=50` | Danh sách ảnh mới nhất, kèm `url` = `/api/images/<key>` |
| POST | `/api/images` | Upload. Body: `multipart/form-data` hoặc raw binary. Field ghi chú: `note` (≤200 ký tự, có thể trống) |
| GET | `/api/images/:key` | Trả bytes ảnh, yêu cầu đăng nhập |
| DELETE | `/api/images/:key` | Xóa ảnh |

Upload nhận cả hai dạng để UI dễ làm:
- `multipart/form-data` với field file tên bất kỳ (thường là `file`) + field `note`.
- Raw body: bytes ảnh trực tiếp, ghi chú qua query `?note=...`.

Response 201:
```json
{ "ok": true, "image": { "id": 1, "r2_key": "img_....jpg", "note": null,
  "mime": "image/jpeg", "size_bytes": 12345, "sha256": "…", "created_at": "…",
  "url": "/api/images/img_....jpg" } }
```

Mọi response lỗi theo chuẩn `{ "error": { "code": "...", "message": "..." } }`.

## Ghi chú UI

Trang `public/images.html` chỉ hiển thị ảnh qua `src="/api/images/<key>"` — trình duyệt
tự gửi cookie phiên. Không dùng URL R2 trực tiếp, không tạo presigned URL công khai.

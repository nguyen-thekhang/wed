/* =====================================================================
   nav.js — hành vi dùng chung cho thanh điều hướng của mọi trang đã đăng nhập.

   Mẫu HTML chuẩn (chỉ có MỘT mẫu điều hướng trong toàn bộ dự án):

     <button type="button" class="nav-toggle" id="nav-toggle"
             aria-label="Mở menu điều hướng" aria-expanded="false" aria-controls="nav">
       <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
     </button>
     <nav id="nav" class="nav" aria-label="Điều hướng chính">…</nav>

   Vì sao dùng <button> chứ không dùng <details>: nội dung của <details> khi ĐÓNG
   không được trình duyệt vẽ ra. Ở màn hình lớn ta cần thanh điều hướng hiện
   thành hàng ngang, nhưng CSS không thể buộc trình duyệt vẽ lại phần nội dung đã
   bị bỏ — hộp vẫn đo được nhưng không nhìn thấy và không bấm được. Đã kiểm
   chứng bằng elementFromPoint(): tại tâm liên kết, trình duyệt trả về phần tử
   cha. Vì vậy trạng thái mở do script này quản lý qua class .is-open.

   Script chịu trách nhiệm:
     1. Bật/tắt menu và đồng bộ aria-expanded (CSS vẽ dấu X theo thuộc tính này).
     2. Đóng menu khi bấm ra ngoài.
     3. Đóng menu bằng phím Escape và trả focus về nút menu.
     4. Đóng menu ngay sau khi người dùng chọn một liên kết.
     5. Đóng menu khi bề rộng chuyển sang mức desktop.

   Nếu JavaScript bị chặn, thanh điều hướng ở màn hình lớn VẪN hiện đầy đủ vì
   nó chỉ phụ thuộc CSS; chỉ menu thu gọn trên điện thoại là không mở được.

   Script cổ điển: không import/export, không build step, không thư viện ngoài,
   không dùng innerHTML và không đọc/ghi dữ liệu người dùng.
   ===================================================================== */
(function () {
  "use strict";

  var DESKTOP_QUERY = "(min-width: 768px)";

  function setup(toggle, nav) {
    if (!toggle || !nav) {
      return;
    }

    var media = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null;

    function isOpen() {
      return nav.classList.contains("is-open");
    }

    function sync() {
      toggle.setAttribute("aria-expanded", isOpen() ? "true" : "false");
    }

    function open() {
      nav.classList.add("is-open");
      sync();
    }

    function close(returnFocus) {
      if (!isOpen()) {
        return;
      }
      nav.classList.remove("is-open");
      sync();
      if (returnFocus) {
        try {
          toggle.focus();
        } catch (error) {
          /* Không để lỗi focus chặn thao tác đóng menu. */
        }
      }
    }

    toggle.addEventListener(
      "click",
      function (event) {
        event.preventDefault();
        if (isOpen()) {
          close(false);
        } else {
          open();
        }
      },
      false,
    );

    nav.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (target && typeof target.closest === "function" && target.closest("a")) {
          close(false);
        }
      },
      false,
    );

    document.addEventListener(
      "click",
      function (event) {
        if (!isOpen()) {
          return;
        }
        var target = event.target;
        if (target && (nav.contains(target) || toggle.contains(target))) {
          return;
        }
        close(false);
      },
      false,
    );

    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key === "Escape" && isOpen()) {
          close(true);
        }
      },
      false,
    );

    if (media) {
      var handleChange = function () {
        if (media.matches) {
          close(false);
        }
      };
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", handleChange);
      } else if (typeof media.addListener === "function") {
        media.addListener(handleChange);
      }
    }

    // Trang được tải lại ở mức desktop thì menu phải bắt đầu ở trạng thái đóng.
    close(false);
  }

  function init() {
    setup(document.getElementById("nav-toggle"), document.getElementById("nav"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
}());

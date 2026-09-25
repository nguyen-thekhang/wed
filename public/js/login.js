/**
 * =============================================================================
 * public/js/login.js — xử lý biểu mẫu đăng nhập
 * =============================================================================
 *
 * Worker gắn chính sách bảo mật nội dung với script-src 'self'. Vì vậy, mọi
 * mã JavaScript phải nằm trong tệp riêng dưới public/js và không được nhúng
 * trực tiếp vào HTML.
 *
 * Tệp này không lưu mật khẩu trong bộ nhớ cục bộ của trình duyệt. Phiên đăng nhập
 * nằm trong cookie HttpOnly do máy chủ quản lý; JavaScript không lưu mật khẩu.
 */

(function () {
  "use strict";

  function getMessageElement() {
    return document.getElementById("login-msg");
  }

  function linkFieldToMessage(input, messageElement, hasError) {
    if (!input || !messageElement) return;

    var currentDescription = input.getAttribute("aria-describedby") || "";
    var descriptions = currentDescription.split(/\s+/).filter(Boolean);
    var messageIndex = descriptions.indexOf(messageElement.id);

    if (hasError && messageIndex === -1) {
      descriptions.push(messageElement.id);
      input.setAttribute("aria-describedby", descriptions.join(" "));
      input.setAttribute("aria-invalid", "true");
    } else if (!hasError) {
      if (messageIndex !== -1) {
        descriptions.splice(messageIndex, 1);
        if (descriptions.length > 0) {
          input.setAttribute("aria-describedby", descriptions.join(" "));
        } else {
          input.removeAttribute("aria-describedby");
        }
      }
      input.removeAttribute("aria-invalid");
    }
  }

  /**
   * Đưa vùng thông báo có sẵn sát trường nhập mà không tạo thêm phần tử HTML.
   * Phần tử giữ nguyên id để không phá vỡ các quy ước giao diện hiện tại.
   */
  function placeMessageNearField(input, messageElement) {
    if (!input || !messageElement) return;

    var control = input.closest(".password-control");
    if (!control || !control.parentNode) return;
    if (messageElement.parentNode === control.parentNode && messageElement.previousElementSibling === control) return;

    control.insertAdjacentElement("afterend", messageElement);
  }

  /**
   * Hiện lỗi bằng văn bản thuần, liên kết trực tiếp với trường mật khẩu và
   * để trình đọc màn hình thông báo ngay bằng vai trò cảnh báo.
   */
  function showMessage(text) {
    var messageElement = getMessageElement();
    var input = document.getElementById("password");
    var safeText = typeof text === "string" ? text.trim() : "";

    if (!messageElement || !safeText) return;

    messageElement.setAttribute("role", "alert");
    messageElement.setAttribute("aria-live", "assertive");
    messageElement.setAttribute("aria-atomic", "true");
    placeMessageNearField(input, messageElement);
    linkFieldToMessage(input, messageElement, true);
    messageElement.textContent = safeText;
    messageElement.classList.remove("hidden");

    if (input) input.focus();
  }

  function hideMessage() {
    var messageElement = getMessageElement();
    var input = document.getElementById("password");

    if (messageElement) {
      messageElement.textContent = "";
      messageElement.classList.add("hidden");
    }
    linkFieldToMessage(input, messageElement, false);
  }

  function readServerMessage(body) {
    if (!body || typeof body !== "object" || !body.error || typeof body.error !== "object") {
      return "";
    }

    return typeof body.error.message === "string" ? body.error.message.trim() : "";
  }

  function initPasswordToggle(input) {
    var toggle = document.getElementById("password-toggle");
    if (!toggle || toggle.tagName !== "BUTTON") return;

    function updatePasswordToggle(isVisible) {
      input.type = isVisible ? "text" : "password";
      toggle.setAttribute("aria-pressed", String(isVisible));
      toggle.setAttribute("aria-label", isVisible ? "Ẩn mật khẩu" : "Hiện mật khẩu");
    }

    updatePasswordToggle(false);
    toggle.addEventListener("click", function () {
      var selectionStart = input.selectionStart;
      var selectionEnd = input.selectionEnd;
      var willShowPassword = input.type === "password";

      updatePasswordToggle(willShowPassword);
      input.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        input.setSelectionRange(selectionStart, selectionEnd);
      }
    });
  }

  function init() {
    var form = document.getElementById("login-form");
    var button = document.getElementById("submit-btn");
    var input = document.getElementById("password");
    var messageElement = getMessageElement();

    if (!form || !button || !input) return;

    if (messageElement) {
      placeMessageNearField(input, messageElement);
    }
    initPasswordToggle(input);
    input.focus();
    input.addEventListener("input", hideMessage);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      hideMessage();

      var password = input.value;
      if (!password) {
        showMessage("Vui lòng nhập mật khẩu quản trị.");
        return;
      }

      var keepButtonBusy = false;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Đang kiểm tra…";

      fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: password }),
      })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              // Máy chủ có thể trả về trang lỗi HTML thay cho JSON.
              return null;
            })
            .then(function (body) {
              return { status: response.status, body: body };
            });
        })
        .then(function (result) {
          if (result.status === 200 && result.body && result.body.ok) {
            keepButtonBusy = true;
            button.textContent = "Đang vào…";
            window.location.replace("/index.html");
            return;
          }

          if (result.status === 429) {
            showMessage("Sai quá nhiều lần. Tài khoản bị tạm khoá 15 phút, vui lòng thử lại sau.");
          } else if (result.status === 401) {
            showMessage("Mật khẩu không đúng. Vui lòng nhập lại.");
          } else if (result.status === 500) {
            showMessage("Máy chủ chưa sẵn sàng xác thực. Vui lòng thử lại sau.");
          } else {
            var serverMessage = readServerMessage(result.body);
            showMessage(
              serverMessage ||
                "Không thể đăng nhập (HTTP " + result.status + "). Vui lòng thử lại sau.",
            );
          }

          if (input.type !== "password" && input.value.length > 0) {
            input.setSelectionRange(0, input.value.length);
          }
        })
        .catch(function () {
          showMessage("Không thể kết nối tới máy chủ. Kiểm tra kết nối mạng rồi thử lại.");
        })
        .then(function () {
          if (keepButtonBusy) return;

          button.disabled = false;
          button.removeAttribute("aria-busy");
          if (button.textContent === "Đang kiểm tra…") {
            button.textContent = "Đăng nhập";
          }
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

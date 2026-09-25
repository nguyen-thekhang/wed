/* =====================================================================
   motion.js — chuyển động bổ sung: đếm số KPI, phản hồi nhấn, gợi ý
   Script CỔ ĐIỂN (không module, không build step, không dependency).

   Mục tiêu: chuyển động phải MANG Ý NGHĨA, không phải để trang "sống".
   Ba hiệu ứng ở đây đều trả lời một câu hỏi của người dùng:
     1. Số này TĂNG hay GIẢM?      → đếm số có hướng
     2. Tôi vừa bấm cái gì?         → phản hồi nhấn tức thì
     3. Nút này dẫn tới đâu?       → gợi ý tooltip

   Tôn trọng prefers-reduced-motion: bật giảm chuyển động → đặt thẳng số cuối
   cùng, không chạy vòng đếm, không ripple.

   LƯU Ý BẢO MẬT: file này không đọc/ghi/log dữ liệu từ API. Nó chỉ đọc
   thuộc tính data-count đã được dashboard.js ghi sẵn vào DOM.
   ===================================================================== */
(function () {
  "use strict";

  var DURATION = 900;   // ms — vừa đủ thấy rõ mà không làm chờ
  var reduced = false;

  try {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (err) {
    reduced = false;
  }

  /* ---------------------------------------------------------------------
     1) ĐẾM SỐ
     Đọc data-count (số nguyên mục tiêu), chạy từ 0 tới đó bằng rAF.
     Chỉ chạy MỘT LẦM mỗi phần tử: sau khi đếm xong gắn cờ, không chạy lại.
     --------------------------------------------------------------------- */
  function format(n, isMoney) {
    return isMoney
      ? new Intl.NumberFormat("vi-VN").format(n) + " ₫"
      : new Intl.NumberFormat("vi-VN").format(n);
  }

  function countUp(el) {
    if (!el) return;

    var raw = String(el.getAttribute("data-count") || "");
    var target = parseFloat(raw);

    /*
      KHÔNG đánh dấu "đã đếm" khi chưa có dữ liệu.

      Lỗi thật đã gặp: nếu đặt data-counted="1" ngay đầu hàm, thì lúc tải trang
      data-count vẫn là "0" (dashboard.js chưa gọi xong API) → hàm đánh dấu
      rồi thoát. Về sau API về số thật và gọi runCounters() lần nữa, phần tử đã
      mang cờ "đã đếm" nên KHÔNG còn đếm được — số nhảy từ 0 thẳng lên giá
      trị cuối, mất hẳn hiệu ứng.

      Vì vậy chỉ đánh dấu sau khi đã thực sự chạy xong hiệu ứng.
    */
    if (!isFinite(target) || target <= 0) return;

    // Doanh thu ghi "8.547.318" không phải số → bỏ đếm, đã có sẵn dạng chuỗi.
    if (!/^\d+(\.\d+)?$/.test(raw)) return;

    // Đã đếm tới đúng giá trị này rồi → không chạy lại (dashboard có thể
    // renderKpis() nhiều lần khi làm mới).
    if (el.dataset.counted === "1" && el.dataset.countedTo === raw) return;
    el.dataset.countedTo = raw;
    el.dataset.counted = "1";

    var isMoney = el.classList.contains("is-money");
    if (reduced || !window.requestAnimationFrame) {
      el.textContent = format(target, isMoney);
      return;
    }

    var start = null;
    var from = 0;

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / DURATION);
      // ease-out cubic: nhanh lúc đầu, chậm dần về đích
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = format(Math.round(from + (target - from) * eased), isMoney);
      if (p < 1) {
        window.requestAnimationFrame(step);
      } else {
        el.textContent = format(target, isMoney);
      }
    }
    window.requestAnimationFrame(step);
  }

  function runCounters(root) {
    var list = (root || document).querySelectorAll(".count-up");
    for (var i = 0; i < list.length; i++) countUp(list[i]);
  }

  /* ---------------------------------------------------------------------
     2) GỢI Ý NÚT (tooltip nhẹ)
     Hiển thị data-hint khi rê chuột / khi nhận focus bàn phím.
     Dùng aria-describedby? Không — gợi ý thẩm mỹ, không mang thông tin
     mà người dùng cần nghe. Nội dung thật vẫn nằm ở aria-label nếu có.
     --------------------------------------------------------------------- */
  var tipEl = null;

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement("div");
    tipEl.className = "motion-tip";
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(target) {
    var text = target.getAttribute("data-hint");
    if (!text) return;
    var tip = ensureTip();
    tip.textContent = text;
    var r = target.getBoundingClientRect();
    tip.style.left = r.left + r.width / 2 + "px";
    tip.style.top = r.top - 8 + "px";
    tip.classList.add("is-on");
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove("is-on");
  }

  function wireTips(root) {
    var list = (root || document).querySelectorAll("[data-hint]");
    for (var i = 0; i < list.length; i++) {
      (function (el) {
        el.addEventListener("mouseenter", function () { showTip(el); });
        el.addEventListener("mouseleave", hideTip);
        el.addEventListener("focus", function () { showTip(el); });
        el.addEventListener("blur", hideTip);
      })(list[i]);
    }
  }

  /* ---------------------------------------------------------------------
     3) PHẢN HỒI NHẤN (ripple nhẹ)
     Chỉ trên chuột/trackpad thật. Ripple tự xoá sau khi nở xong nên không
     tích tụ DOM. Tôn trọng reduced-motion (bỏ ripple).
     --------------------------------------------------------------------- */
  function wireRipples(root) {
    if (reduced) return;
    var list = (root || document).querySelectorAll(".btn:not([data-no-ripple])");
    for (var i = 0; i < list.length; i++) {
      (function (el) {
        el.addEventListener("pointerdown", function (ev) {
          if (ev.pointerType && ev.pointerType === "touch") return; // cảm ứng dùng :active
          var r = el.getBoundingClientRect();
          var size = Math.max(r.width, r.height) * 2;
          var ripple = document.createElement("span");
          ripple.className = "ripple";
          ripple.style.width = ripple.style.height = size + "px";
          ripple.style.left = ev.clientX - r.left - size / 2 + "px";
          ripple.style.top = ev.clientY - r.top - size / 2 + "px";
          el.appendChild(ripple);
          var self = ripple;
          setTimeout(function () { if (self.parentNode) self.parentNode.removeChild(self); }, 700);
        });
      })(list[i]);
    }
  }

  /* ---------------------------------------------------------------------
     Khởi động + theo nội dung render sau
     --------------------------------------------------------------------- */
  function boot(root) {
    runCounters(root);
    wireTips(root);
    wireRipples(root);
  }

  window.MotionFX = { boot: boot, runCounters: runCounters };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { boot(document); });
  } else {
    boot(document);
  }
})();

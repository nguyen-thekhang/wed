/* =====================================================================
   confirm.js — hộp thoại xác nhận dùng chung cho hành động phá huỷ.

   Vì sao không dùng window.confirm(): hộp thoại của trình duyệt không theo
   design system, không đặt được nhãn nút theo ngữ cảnh, không kiểm soát được
   thứ tự focus và chặn toàn bộ luồng JavaScript.

   Cách dùng:

     window.ShopConfirm.ask({
       title: "Xoá ảnh này?",
       message: "Ảnh sẽ bị xoá khỏi kho R2 và không khôi phục được.",
       confirmLabel: "Xoá ảnh",
     }).then(function (confirmed) { if (confirmed) { … } });

   Trả về Promise<boolean>. Escape hoặc nút huỷ → false.

   Hộp thoại được dựng bằng createElement và textContent (không dùng innerHTML),
   nên nhãn động như tên ảnh hay UID không bao giờ trở thành mã HTML.
   Nếu trình duyệt không hỗ trợ <dialog>.showModal, script tự lùi về
   window.confirm để hành động vẫn hoàn tất được.

   Script cổ điển: không import/export, không build step, không thư viện ngoài.
   ===================================================================== */
(function () {
  "use strict";

  var SPRITE = "/img/sprite.svg#icon-alert";

  var dialog = null;
  var titleNode = null;
  var messageNode = null;
  var confirmNode = null;
  var cancelNode = null;
  var returnFocusTo = null;

  function svgIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", SPRITE);
    svg.appendChild(use);
    return svg;
  }

  function build() {
    if (dialog) {
      return dialog;
    }

    dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog";
    dialog.id = "confirm-dialog";
    dialog.setAttribute("aria-labelledby", "confirm-dialog-title");
    dialog.setAttribute("aria-describedby", "confirm-dialog-message");

    var body = document.createElement("div");
    body.className = "confirm-dialog-body";

    var mark = document.createElement("span");
    mark.className = "confirm-dialog-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(svgIcon());

    titleNode = document.createElement("h2");
    titleNode.id = "confirm-dialog-title";

    messageNode = document.createElement("p");
    messageNode.id = "confirm-dialog-message";

    body.appendChild(mark);
    body.appendChild(titleNode);
    body.appendChild(messageNode);

    var actions = document.createElement("div");
    actions.className = "confirm-dialog-actions";

    cancelNode = document.createElement("button");
    cancelNode.type = "button";
    cancelNode.className = "btn";
    cancelNode.textContent = "Huỷ";

    confirmNode = document.createElement("button");
    confirmNode.type = "button";
    confirmNode.className = "btn btn-danger";
    confirmNode.id = "confirm-dialog-accept";

    actions.appendChild(cancelNode);
    actions.appendChild(confirmNode);

    dialog.appendChild(body);
    dialog.appendChild(actions);
    document.body.appendChild(dialog);

    cancelNode.addEventListener("click", function () {
      dialog.close("cancel");
    });

    confirmNode.addEventListener("click", function () {
      dialog.close("confirm");
    });

    // Escape và nút đóng gốc của <dialog> đều đi qua sự kiện cancel.
    dialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      dialog.close("cancel");
    });

    return dialog;
  }

  function supportsDialog() {
    var probe = document.createElement("dialog");
    return typeof probe.showModal === "function";
  }

  function ask(options) {
    var opts = options || {};
    var title = opts.title ? String(opts.title) : "Xác nhận thao tác";
    var message = opts.message ? String(opts.message) : "";
    var confirmLabel = opts.confirmLabel ? String(opts.confirmLabel) : "Xác nhận";

    if (!supportsDialog()) {
      var fallback = message ? title + "\n\n" + message : title;
      return Promise.resolve(window.confirm(fallback));
    }

    build();
    titleNode.textContent = title;
    messageNode.textContent = message;
    messageNode.hidden = !message;
    confirmNode.textContent = confirmLabel;

    returnFocusTo = document.activeElement;

    return new Promise(function (resolve) {
      function done() {
        dialog.removeEventListener("close", done);
        var accepted = dialog.returnValue === "confirm";
        if (returnFocusTo && typeof returnFocusTo.focus === "function" && document.contains(returnFocusTo)) {
          try {
            returnFocusTo.focus();
          } catch (error) {
            /* Không để lỗi focus chặn luồng xoá. */
          }
        }
        returnFocusTo = null;
        resolve(accepted);
      }

      dialog.addEventListener("close", done);
      dialog.returnValue = "";
      dialog.showModal();
      // Focus mặc định vào nút huỷ: hành động phá huỷ không nên được kích hoạt
      // chỉ bằng một lần nhấn Enter.
      try {
        cancelNode.focus();
      } catch (error) {
        /* Một số trình duyệt tự đặt focus; bỏ qua nếu lỗi. */
      }
    });
  }

  window.ShopConfirm = { ask: ask };
}());

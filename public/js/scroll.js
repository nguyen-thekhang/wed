/* =====================================================================
   scroll.js — lớp hiệu ứng cuộn (reveal + stagger)
   Script CỔ ĐIỂN (không ES module, không import/export, không build step).
   Dùng trong HTML như sau:

       <html class="no-js">
       <link rel="stylesheet" href="/css/app.css" />
       <link rel="stylesheet" href="/css/scroll.css" />
       <script src="/js/scroll.js" defer></script>

   API thủ công cho nội dung render sau khi fetch (dashboard, logs, images):
       window.ScrollFX.observe(root)     — quét .reveal:not(.is-visible) trong root
                                           rồi đưa vào IntersectionObserver dùng chung
       window.ScrollFX.applyStagger(root)— gán --delay cho con của .stagger
       window.ScrollFX.revealAll()       — hiện tất cả ngay (dùng khi in / lỗi)
       window.ScrollFX.refresh()         — quét lại toàn bộ document

   LƯU Ý BẢO MẬT: file này KHÔNG đọc, KHÔNG ghi, KHÔNG log bất kỳ dữ liệu nào
   từ API. Nó chỉ thao tác class/style trên phần tử đã có sẵn trong DOM, nên
   không có đường nào để dữ liệu free-text (hay cột nhạy cảm của bảng stock)
   lọt ra giao diện qua lớp hiệu ứng này.
   ===================================================================== */
(function () {
  "use strict";

  /* ------------------------------ Cấu hình ------------------------------ */

  var DEBUG = false; // bật true khi cần gỡ lỗi; chỉ dùng console.debug

  // Bước stagger: 70ms (spec yêu cầu 60–80ms)
  var STEP = 70;

  // Chặn trần: con thứ 8 trở đi dùng chung mốc 490ms (7 * 70)
  // → danh sách dài không bao giờ phải chờ hàng giây.
  var MAX_STEP_INDEX = 7;

  // Sau 3s, thứ gì còn ẩn thì hiện hết (lưới an toàn cứng, phòng observer lỗi)
  var SAFETY_MS = 3000;

  // Thời gian tối đa chờ transitionend trước khi tự gỡ will-change
  var WILLCHANGE_TIMEOUT_MS = 1000;

  // MutationObserver: gom nhiều thay đổi DOM trong 150ms rồi mới quét 1 lần
  var MUTATION_DEBOUNCE_MS = 150;

  // Tùy chọn IntersectionObserver (7.5) — dùng CHUNG cho mọi phần tử mặc định
  var IO_OPTIONS = {
    threshold: 0.15,
    rootMargin: "0px 0px -50px 0px"
  };

  // Selector gốc của hệ thống reveal
  var REVEAL_SELECTOR = ".reveal";

  /* --------------------------- Trạng thái nội bộ ------------------------- */

  var docEl = document.documentElement;

  // Một instance IntersectionObserver DUY NHẤT cho mọi phần tử mặc định
  var io = null;

  // WeakSet: phần tử đã xử lý rồi → không observe lại, không tính --delay lại,
  // và khi phần tử bị gỡ khỏi DOM thì rác tự được thu hồi (không rò rỉ RAM).
  var seen = typeof WeakSet === "function" ? new WeakSet() : null;

  // WeakSet thứ hai: container .stagger đã gán --delay
  var staggered = typeof WeakSet === "function" ? new WeakSet() : null;

  var reduced = false; // người dùng có đang bật "giảm chuyển động" không
  var revealedAll = false; // đã bung hết chưa (lúc đó bỏ qua mọi việc khác)
  var revealedCount = 0;
  var mutationObserver = null;
  var mutationTimer = null;
  var safetyTimer = null;

  /* ------------------------------- Tiện ích ------------------------------ */

  function debug() {
    // Chỉ một dòng debug duy nhất, và chỉ khi bật cờ — không làm ồn console
    if (DEBUG && typeof console !== "undefined" && console.debug) {
      console.debug.apply(console, ["[scroll.js]"].concat([].slice.call(arguments)));
    }
  }

  function each(list, fn) {
    for (var i = 0; i < list.length; i++) fn(list[i], i);
  }

  /**
   * Quét các phần tử .reveal trong `root` mà CHƯA xử lý.
   * Phần tử đã có .is-visible (server render sẵn hoặc đã hiện) thì bỏ qua luôn.
   */
  function collect(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var out = [];
    var list;

    try {
      list = scope.querySelectorAll(REVEAL_SELECTOR);
    } catch (err) {
      return out;
    }

    each(list, function (el) {
      if (el.classList.contains("is-visible")) return; // đã hiện → không đụng lại
      if (seen && seen.has(el)) return; // đã observe rồi → không observe trùng
      out.push(el);
    });

    return out;
  }

  /**
   * Gắn class rồi gỡ class ngay trong cùng một frame.
   * Mục đích: ép trình duyệt tính lại style (style recalc) trước khi thêm
   * .is-visible, để transition thực sự chạy thay vì bị "nhảy" thẳng.
   */
  function reflow(el) {
    // eslint-disable-next-line no-unused-expressions
    el.offsetHeight;
  }

  /**
   * Bật will-change NGAY TRƯỚC khi animate, và gỡ NGAY khi animate xong.
   * Giữ will-change vĩnh viễn sẽ bắt trình duyệt giữ một layer GPU cho mỗi
   * phần tử → tốn RAM, thậm chí chậm hơn. Vì vậy có 2 đường gỡ:
   *   1) transitionend / animationend
   *   2) timeout an toàn (transition không chạy vì lý do gì đó)
   */
  function animateOnce(el) {
    if (reduced) return; // giảm chuyển động → không cần will-change

    el.classList.add("is-animating");

    var done = false;

    function cleanup() {
      if (done) return;
      done = true;
      el.classList.remove("is-animating");
      el.removeEventListener("transitionend", onEnd);
      el.removeEventListener("animationend", onEnd);
    }

    function onEnd(ev) {
      // Bỏ qua sự kiện nổi lên (bubbling) từ phần tử con
      if (ev && ev.target !== el) return;
      cleanup();
    }

    el.addEventListener("transitionend", onEnd);
    el.addEventListener("animationend", onEnd);

    // Lưới an toàn: nếu transitionend không bao giờ bắn (transition bị tắt,
    // phần tử bị display:none, tab bị ẩn…) thì vẫn phải gỡ will-change.
    window.setTimeout(cleanup, WILLCHANGE_TIMEOUT_MS);
  }

  /**
   * Hiện một phần tử: bật will-change → thêm .is-visible → gỡ will-change khi xong.
   * Chú ý: ở đây KHÔNG dùng aria-hidden và KHÔNG dùng display:none.
   * Nội dung luôn nằm trong DOM và luôn đọc được bởi screen reader; hiệu ứng
   * chỉ là opacity/transform thuần trang trí. Đó cũng là lý do phải có
   * .no-js .reveal và lưới an toàn 3 giây — không bao giờ để nội dung bị kẹt ở opacity 0.
   */
  function reveal(el, animate) {
    if (!el || el.classList.contains("is-visible")) return;

    if (seen) seen.add(el);

    if (animate === false || reduced) {
      el.classList.add("is-visible");
      el.classList.remove("is-animating");
      return;
    }

    animateOnce(el);
    reflow(el);
    el.classList.add("is-visible");
    revealedCount++;
  }

  /* ------------------------------ Stagger -------------------------------- */

  /**
   * Gán --delay cho con trực tiếp của từng container .stagger trong `root`.
   *   con 0 → 0ms, con 1 → 70ms, con 2 → 140ms … con 7 → 490ms
   *   con 8 trở đi → 490ms (chặn trần, không để danh sách dài chờ hàng giây)
   * Con nào đã có --delay inline sẵn thì tôn trọng, KHÔNG ghi đè.
   */
  function applyStagger(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var containers = [];
    var i;

    // Chính `root` cũng có thể là một container .stagger
    if (root && root.nodeType === 1 && root.classList && root.classList.contains("stagger")) {
      containers.push(root);
    }

    try {
      var found = scope.querySelectorAll(".stagger");
      for (i = 0; i < found.length; i++) containers.push(found[i]);
    } catch (err) {
      /* selector lỗi thì bỏ qua */
    }

    each(containers, function (box) {
      if (staggered && staggered.has(box)) return; // đã gán rồi → không gán lại
      if (staggered) staggered.add(box);

      var children = box.children; // CHỈ con trực tiếp (element children)
      for (var idx = 0; idx < children.length; idx++) {
        var child = children[idx];
        if (!child.style) continue;

        // Tôn trọng --delay do HTML/JS khác đặt sẵn
        var own = child.style.getPropertyValue("--delay");
        if (own && own.trim() !== "") continue;

        var stepIndex = idx > MAX_STEP_INDEX ? MAX_STEP_INDEX : idx;
        child.style.setProperty("--delay", stepIndex * STEP + "ms");
      }
    });

    debug("applyStagger:", containers.length, "container");
  }

  /* ---------------------------- Vòng đời chính --------------------------- */

  /**
   * Quét và bắt đầu quan sát các .reveal chưa xử lý trong `root`.
   * Gọi được nhiều lần — phần tử đã xử lý nằm trong WeakSet nên không bị lặp.
   */
  function observe(root) {
    var scope = root && root.querySelectorAll ? root : document;

    applyStagger(scope);

    // Đang ở chế độ giảm chuyển động (hoặc đã bung hết): hiện luôn, không observe
    if (reduced || revealedAll) {
      each(collect(scope), function (el) {
        reveal(el, false);
      });
      return;
    }

    var targets = collect(scope);
    if (!targets.length) return;

    if (!io) {
      // Một observer DUY NHẤT dùng chung cho tất cả phần tử mặc định
      io = new IntersectionObserver(onIntersect, IO_OPTIONS);
    }

    each(targets, function (el) {
      if (seen) seen.add(el);
      // IntersectionObserver bắn callback NGAY sau khi observe đối với phần tử
      // đang nằm trong viewport → khối ở màn hình đầu tiên tự hiện tức thì,
      // không cần chờ người dùng cuộn. Không cần xử lý "above the fold" riêng.
      io.observe(el);
    });

    debug("observe:", targets.length, "phần tử mới");
  }

  function onIntersect(entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry.isIntersecting) continue;

      var el = entry.target;

      // Mỗi phần tử chỉ chạy hiệu ứng MỘT lần: hiện xong là unobserve ngay
      if (io) io.unobserve(el);

      reveal(el, true);
    }
  }

  /** Hiện tất cả ngay lập tức, không hiệu ứng (in ấn, lỗi, hoặc lưới an toàn). */
  function revealAll() {
    revealedAll = true;

    if (io) {
      io.disconnect();
      io = null;
    }

    var all;
    try {
      all = document.querySelectorAll(REVEAL_SELECTOR);
    } catch (err) {
      all = [];
    }

    each(all, function (el) {
      el.classList.add("is-visible");
      el.classList.remove("is-animating");
      if (seen) seen.add(el);
    });

    debug("revealAll:", all.length, "phần tử");
  }

  /** Quét lại toàn trang — dùng sau khi render xong một vùng lớn. */
  function refresh() {
    if (revealedAll) return;
    observe(document);
  }

  /* ----------------------- Tùy chọn giảm chuyển động --------------------- */

  var motionQuery = null;

  function onMotionChange() {
    var nowReduced = !!(motionQuery && motionQuery.matches);

    if (nowReduced === reduced) return;
    reduced = nowReduced;

    // Gắn cờ lên <html> để CSS tắt transition/transform ngay cả khi trình duyệt
    // không tự khớp media query (đề phòng trình duyệt cũ).
    if (reduced) {
      docEl.classList.add("reveal-reduced");
      revealAll(); // đang giảm chuyển động → hiện hết, không chờ cuộn
    } else {
      docEl.classList.remove("reveal-reduced");
    }

    debug("reduced-motion =", reduced);
  }

  function watchReducedMotion() {
    if (typeof window.matchMedia !== "function") {
      reduced = false;
      return;
    }

    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = !!motionQuery.matches;

    if (reduced) docEl.classList.add("reveal-reduced");

    // Lắng nghe thay đổi để bật/tắt được NGAY, không cần tải lại trang.
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", onMotionChange);
    } else if (typeof motionQuery.addListener === "function") {
      // Trình duyệt cũ (Safari < 14)
      motionQuery.addListener(onMotionChange);
    }
  }

  /* --------------------- Nội dung được thêm sau (fetch) ------------------ */

  function onMutations(mutations) {
    if (revealedAll) return;

    var hasNew = false;

    for (var i = 0; i < mutations.length && !hasNew; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;

        // Node mới thêm CHÍNH NÓ là .reveal, hoặc chứa .reveal bên trong
        if (node.classList && node.classList.contains("reveal")) {
          hasNew = true;
          break;
        }
        if (node.querySelector && node.querySelector(REVEAL_SELECTOR)) {
          hasNew = true;
          break;
        }
      }
    }

    if (!hasNew) return;

    // Gộp nhiều mutation liên tiếp (bảng render theo từng dòng) thành 1 lần quét
    if (mutationTimer) window.clearTimeout(mutationTimer);
    mutationTimer = window.setTimeout(function () {
      mutationTimer = null;
      observe(document);
    }, MUTATION_DEBOUNCE_MS);
  }

  /**
   * MutationObserver trên document.body.
   * KHÔNG chạy mãi: mỗi lần chỉ quét đúng phần tử .reveal chưa nằm trong WeakSet,
   * nên chi phí giảm dần về 0 khi giao diện đã render ổn định.
   * Khi revealAll() chạy (lưới an toàn 3 giây / giảm chuyển động) thì ngắt hẳn.
   */
  function watchMutations() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (mutationObserver) return;

    mutationObserver = new MutationObserver(onMutations);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopMutations() {
    if (!mutationObserver) return;
    mutationObserver.disconnect();
    mutationObserver = null;
    if (mutationTimer) {
      window.clearTimeout(mutationTimer);
      mutationTimer = null;
    }
  }

  /* ------------------------------- Khởi động ----------------------------- */

  function start() {
    // Gỡ cờ no-js NGAY khi JS chạy: từ đây CSS tin rằng có JS sống.
    // Nếu file này không tải được (JS tắt / lỗi 404), .no-js còn nguyên và
    // .no-js .reveal { opacity: 1 } trong scroll.css giữ nội dung hiện đủ.
    docEl.classList.remove("no-js");

    watchReducedMotion();

    // Chống nháy: trong lúc quét lần đầu, transition bị tắt bằng
    // [data-reveal-boot] trong scroll.css; gỡ cờ này ngay sau khi quét xong.
    docEl.setAttribute("data-reveal-boot", "");

    observe(document);
    watchMutations();

    // Lưới an toàn CỨNG: sau 3 giây, bất cứ thứ gì còn ẩn đều hiện ra,
    // kể cả khi IntersectionObserver không hỗ trợ hoặc có lỗi bất ngờ.
    safetyTimer = window.setTimeout(function () {
      safetyTimer = null;
      // Gắn cờ CSS để cả những phần tử thêm sau đó cũng không bị kẹt ở opacity 0
      docEl.classList.add("reveal-safety");
      stopMutations();
      revealAll();
    }, SAFETY_MS);

    // Bỏ cờ boot ở frame kế tiếp → transition hoạt động trở lại, nhưng những
    // phần tử đã hiện trong frame đầu sẽ hiện luôn, không bị "nhảy" từ 0 → 1.
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          docEl.removeAttribute("data-reveal-boot");
        });
      });
    } else {
      window.setTimeout(function () {
        docEl.removeAttribute("data-reveal-boot");
      }, 32);
    }

    debug("khởi động xong; reduced =", reduced);
  }

  /* ------------------------------ API công khai -------------------------- */

  // API nhỏ cho nội dung render động (bảng/card dựng bằng JS sau khi fetch)
  window.ScrollFX = {
    observe: function (root) {
      observe(root || document);
    },
    applyStagger: function (root) {
      applyStagger(root || document);
    },
    revealAll: revealAll,
    refresh: refresh
  };

  /* --------------------------- Điểm vào của script ----------------------- */

  // Nếu in ấn: hiện hết ngay, không đợi observer
  if (typeof window.matchMedia === "function") {
    try {
      var printQuery = window.matchMedia("print");
      if (typeof printQuery.addEventListener === "function") {
        printQuery.addEventListener("change", function (ev) {
          if (ev.matches) revealAll();
        });
      }
    } catch (err) {
      /* matchMedia("print") không hỗ trợ → bỏ qua */
    }
  }

  // Nhả timer khi trang bị đóng băng (bfcache) để không giữ việc vô ích
  window.addEventListener("pagehide", function () {
    if (safetyTimer) {
      window.clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    // Script có defer nên thường đã qua "loading"; vẫn xử lý cả hai trường hợp
    start();
  }
})();

(function () {
  "use strict";

  var DURATION = 800;
  var READY_LIMIT = 1400;
  var FINISH_DELAY = 120;
  var EXIT_DURATION = 220;
  var REMOVE_DELAY = EXIT_DURATION + 100;
  var BUMP_DURATION = 180;
  var REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

  function removeSafely(node) {
    if (!node) {
      return;
    }

    try {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    } catch (error) {
      try {
        node.style.display = "none";
      } catch (hiddenError) {
        // Không ghi nhận lỗi để không làm gián đoạn giao diện.
      }
    }
  }

  function hideImmediately() {
    try {
      var node = document.getElementById("preloader");
      if (!node) {
        return;
      }

      node.style.animation = "none";
      node.classList.add("is-done");
      node.style.opacity = "0";
      node.style.visibility = "hidden";
      node.style.pointerEvents = "none";
      window.setTimeout(function () {
        removeSafely(node);
      }, REMOVE_DELAY);
    } catch (error) {
      // Không để lỗi hiển thị giữ người dùng ở màn hình tải.
    }
  }

  function startPreloader() {
    try {
      var preloader = document.getElementById("preloader");
      if (!preloader) {
        return;
      }

      var numberNode = document.getElementById("preloader-num");
      var fillNode = document.getElementById("preloader-fill");
      var countNode = preloader.querySelector(".preloader-count");
      if (!numberNode || !fillNode || !countNode) {
        hideImmediately();
        return;
      }

      var startTime = null;
      var currentValue = -1;
      var lastMilestone = 0;
      var bumpTimer = 0;
      var isReady = document.readyState === "complete";
      var isRemoved = false;
      var finishStarted = false;
      var reducedMotion = false;

      try {
        reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
      } catch (error) {
        reducedMotion = false;
      }

      function easeOutCubic(progress) {
        return 1 - Math.pow(1 - progress, 3);
      }

      function updateCounter(value) {
        if (value === currentValue) {
          return;
        }

        currentValue = value;
        numberNode.textContent = String(value);
        fillNode.style.width = value + "%";

        var milestone = Math.floor(value / 10);
        if (milestone > lastMilestone) {
          lastMilestone = milestone;
          if (!reducedMotion) {
            countNode.classList.remove("is-bump");
            void countNode.offsetWidth;
            countNode.classList.add("is-bump");
            if (bumpTimer) {
              window.clearTimeout(bumpTimer);
            }
            bumpTimer = window.setTimeout(function () {
              try {
                countNode.classList.remove("is-bump");
                bumpTimer = 0;
              } catch (error) {
                // Phần tử có thể đã được gỡ khỏi trang.
              }
            }, BUMP_DURATION);
          }
        }
      }

      function removePreloader() {
        if (isRemoved) {
          return;
        }

        isRemoved = true;
        try {
          preloader.removeEventListener("transitionend", handleTransitionEnd, false);
          removeSafely(preloader);
        } catch (error) {
          try {
            preloader.style.display = "none";
          } catch (hiddenError) {
            // Không ghi nhận lỗi để không làm gián đoạn giao diện.
          }
        }
      }

      function handleTransitionEnd(event) {
        if (event.target === preloader && event.propertyName === "opacity") {
          removePreloader();
        }
      }

      function finish() {
        try {
          if (finishStarted) {
            return;
          }
          finishStarted = true;
          preloader.addEventListener("transitionend", handleTransitionEnd, false);
          preloader.classList.add("is-done");
          preloader.setAttribute("aria-hidden", "true");
          window.setTimeout(removePreloader, REMOVE_DELAY);
        } catch (error) {
          hideImmediately();
        }
      }

      function renderFrame(timestamp) {
        try {
          if (startTime === null) {
            startTime = timestamp;
          }

          var elapsed = Math.max(0, timestamp - startTime);
          var progress = Math.min(elapsed / DURATION, 1);

          if (isReady && progress >= 1) {
            updateCounter(100);
            window.setTimeout(finish, FINISH_DELAY);
            return;
          }

          // Giữ 99% cho đến khi trang sẵn sàng, rồi mới hoàn tất.
          updateCounter(Math.min(99, Math.floor(99 * easeOutCubic(progress))));
          window.requestAnimationFrame(renderFrame);
        } catch (error) {
          hideImmediately();
        }
      }

      function markReady() {
        isReady = true;
      }

      if (!isReady) {
        window.addEventListener("load", markReady, false);
        window.setTimeout(markReady, READY_LIMIT);
      }

      updateCounter(0);
      window.requestAnimationFrame(renderFrame);
    } catch (error) {
      hideImmediately();
    }
  }

  startPreloader();
}());

/**
 * =============================================================================
 * public/js/chart.js — vẽ biểu đồ bằng canvas thuần, KHÔNG thư viện
 * =============================================================================
 *
 * Yêu cầu gốc: "Dùng thẻ <canvas> vẽ tay bằng JS thuần, không kéo thư viện chart
 * nặng về". Vì vậy toàn bộ trục, lưới, nhãn, vùng tô đều vẽ bằng CanvasRenderingContext2D.
 *
 * API công khai (dùng bởi dashboard.js):
 *   window.ShopChart.drawLineChart(canvas, [{x, y}], opts)
 *   window.ShopChart.drawBarChart(canvas, [{label, value}], opts)
 *   window.ShopChart.redraw()      // vẽ lại tất cả biểu đồ đã đăng ký (khi resize)
 *   window.ShopChart.destroy(canvas)
 *
 * Điểm quan trọng về kỹ thuật:
 *   - Canvas phải được vẽ theo ĐÚNG số pixel vật lý (devicePixelRatio), nếu không
 *     trên điện thoại Retina biểu đồ sẽ mờ nhoè.
 *   - Mọi màu lấy từ cùng bảng màu với app.css để giao diện đồng nhất.
 *   - Không animate canvas: mục 7.4 chỉ cho phép animate opacity/transform, và vẽ
 *     lại canvas mỗi frame là nguyên nhân giật kinh điển. Chỉ vẽ một lần.
 */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /* Bảng màu — đọc từ biến CSS của app.css để biểu đồ KHỚP design system     */
  /* ---------------------------------------------------------------------- */

  /** Lấy giá trị biến CSS đã tính, có giá trị dự phòng nếu thiếu. */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = v ? v.trim() : "";
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  /*
    Bảng màu trước đây hardcode xanh dương/tím (#5b8cff, #7c5cff) — trái với
    design system emerald của sản phẩm và lệch hẳn so với phần còn lại của
    giao diện. Nay mọi màu lấy từ token trong app.css, chỉ giữ giá trị dự phòng
    để biểu đồ vẫn vẽ được nếu biến CSS chưa kịp nạp.
  */
  function palette() {
    var accent = cssVar("--accent", "#10b981");
    var accentLight = cssVar("--accent-light", "#34d399");
    return {
      text: cssVar("--text", "#f8fafc"),
      dim: cssVar("--text-dim", "#94a3b8"),
      faint: cssVar("--text-faint", "#738399"),
      grid: "rgba(255, 255, 255, 0.075)",
      axis: "rgba(255, 255, 255, 0.17)",
      accent: accent,
      accent2: accentLight,
      accentSoft: "rgba(16, 185, 129, 0.18)",
      accentFill: "rgba(16, 185, 129, 0.13)",
      bar: accentLight,
      surface: cssVar("--bg-deep", "#09090b"),
    };
  }

  var FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /** Danh sách biểu đồ đã vẽ, để vẽ lại khi cửa sổ đổi kích thước. */
  var registry = [];

  /*
    Tooltip: canvas là một khối đục nên trình duyệt không tự hiện gì khi rê chuột.
    Trước đây người dùng phải đoán giá trị từng ngày theo trục. Nay mỗi biểu đồ
    giữ một bảng "điểm nóng" để tra ngược toạ độ chuột ra đúng mốc dữ liệu, rồi
    hiện một hộp thông tin NHÌN THẤY ĐƯỢC (vẽ bằng canvas) và đọc được BẰNG BÀN
    PHÍM (một vùng aria-live ẩn cập nhật theo mốc đang chọn).
  */
  var COLORS = palette();

  /* ---------------------------------------------------------------------- */
  /* Tiện ích                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Chuẩn bị canvas cho màn hình mật độ cao.
   * Trả về { ctx, w, h } với w/h là kích thước theo CSS pixel (đơn vị để vẽ).
   */
  function prepare(canvas) {
    var rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    var dpr = window.devicePixelRatio || 1;
    // Giới hạn dpr ở 2: màn hình 3x-4x chỉ tốn RAM mà mắt không thấy khác biệt.
    if (dpr > 2) dpr = 2;

    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    var ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    return { ctx: ctx, w: w, h: h };
  }

  /** Làm tròn "đẹp" lên: 1.234 -> 2.000, 87.000 -> 100.000. */
  function niceCeil(value) {
    if (!isFinite(value) || value <= 0) return 1;
    var exp = Math.floor(Math.log10(value));
    var base = Math.pow(10, exp);
    var n = value / base;
    var step;
    if (n <= 1) step = 1;
    else if (n <= 2) step = 2;
    else if (n <= 2.5) step = 2.5;
    else if (n <= 5) step = 5;
    else step = 10;
    return step * base;
  }

  /**
   * Nhãn trục tung: rút gọn cho dễ đọc (1,2 tr / 340 ng).
   * Trục không cần chính xác từng đồng — tooltip mới cần.
   */
  function shortNumber(v) {
    var n = Math.abs(v);
    if (n >= 1000000000) return trimNum(v / 1000000000) + " tỷ";
    if (n >= 1000000) return trimNum(v / 1000000) + " tr";
    if (n >= 1000) return trimNum(v / 1000) + " ng";
    return String(Math.round(v));
  }

  function trimNum(x) {
    var s = x.toFixed(1);
    if (s.slice(-2) === ".0") s = s.slice(0, -2);
    return s.replace(".", ",");
  }

  /** Ngày 'YYYY-MM-DD' -> 'DD/MM' cho nhãn trục hoành. */
  function shortDate(iso) {
    var s = String(iso || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(8, 10) + "/" + s.slice(5, 7);
    return s.slice(0, 10);
  }

  /* ---------------------------------------------------------------------- */
  /* Biểu đồ đường — doanh thu theo ngày                                     */
  /* ---------------------------------------------------------------------- */

  function drawLineChart(canvas, series, opts) {
    opts = opts || {};
    var points = Array.isArray(series) ? series.slice() : [];
    if (!canvas || !points.length) return;

    var box = prepare(canvas);
    if (!box) {
      // Canvas chưa có kích thước (đang ẩn). Thử lại ở khung hình sau.
      window.requestAnimationFrame(function () {
        drawLineChart(canvas, series, opts);
      });
      return;
    }

    var ctx = box.ctx;
    var W = box.w;
    var H = box.h;

    // Chừa chỗ cho nhãn trục tung bên trái và nhãn ngày bên dưới.
    var padLeft = 54;
    var padRight = 12;
    var padTop = 14;
    var padBottom = 26;

    var plotW = W - padLeft - padRight;
    var plotH = H - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    var values = points.map(function (p) {
      return Number(p.y) || 0;
    });
    var maxV = Math.max.apply(null, values.concat([0]));
    var top = niceCeil(maxV > 0 ? maxV : 1);

    function xAt(i) {
      if (points.length === 1) return padLeft + plotW / 2;
      return padLeft + (plotW * i) / (points.length - 1);
    }
    function yAt(v) {
      return padTop + plotH - (plotH * v) / top;
    }

    ctx.font = "11px " + FONT_STACK;
    ctx.textBaseline = "middle";

    /* --- Lưới ngang + nhãn trục tung --- */
    var TICKS = 4;
    for (var t = 0; t <= TICKS; t++) {
      var v = (top * t) / TICKS;
      var y = yAt(v);

      ctx.beginPath();
      ctx.strokeStyle = t === 0 ? COLORS.axis : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = COLORS.faint;
      ctx.textAlign = "right";
      ctx.fillText(shortNumber(v), padLeft - 8, y);
    }

    /* --- Nhãn trục hoành: khoảng 6 nhãn để không chồng chữ --- */
    var labelStep = Math.max(1, Math.ceil(points.length / 6));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (var i = 0; i < points.length; i++) {
      if (i % labelStep !== 0 && i !== points.length - 1) continue;
      ctx.fillStyle = COLORS.faint;
      ctx.fillText(shortDate(points[i].x), xAt(i), padTop + plotH + 8);
    }

    /* --- Vùng tô dưới đường: hai lớp gradient cho cảm giác có chiều sâu --- */
    var grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    grad.addColorStop(0, COLORS.accentSoft);
    grad.addColorStop(0.45, COLORS.accentFill);
    grad.addColorStop(1, "rgba(16, 185, 129, 0)");

    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(values[0]));
    for (var j = 1; j < points.length; j++) ctx.lineTo(xAt(j), yAt(values[j]));
    ctx.lineTo(xAt(points.length - 1), padTop + plotH);
    ctx.lineTo(xAt(0), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    /* --- Đường doanh thu: gradient ngang + đổ bóng nhẹ --- */
    var lineGrad = ctx.createLinearGradient(padLeft, 0, padLeft + plotW, 0);
    lineGrad.addColorStop(0, COLORS.accent);
    lineGrad.addColorStop(1, COLORS.accent2);

    ctx.save();
    ctx.shadowColor = COLORS.accentSoft;
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (var k = 0; k < points.length; k++) {
      var px = xAt(k);
      var py = yAt(values[k]);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    /* --- Chấm ở đỉnh: chỉ đánh dấu ngày có doanh thu, tránh rối mắt --- */
    for (var m = 0; m < points.length; m++) {
      if (values[m] <= 0) continue;
      var cx = xAt(m);
      var cy = yAt(values[m]);
      // Quầng sáng quanh chấm
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.accentSoft;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.accent;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.surface;
      ctx.fill();
    }

    // Ghi nhớ để vẽ lại khi resize + gắn tương tác đọc giá trị.
    var redrawLine = function () {
      drawLineChart(canvas, series, opts);
    };
    remember(canvas, redrawLine);
    wireInteractivity(canvas, {
      kind: "line",
      redraw: redrawLine,
      padTop: padTop,
      plotLeft: padLeft,
      plotW: plotW,
      plotH: plotH,
      values: values,
      points: points,
      xAt: xAt,
      yAt: yAt,
      labelFormatter: opts.labelFormatter,
      valueFormatter: opts.valueFormatter,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Biểu đồ cột — dùng cho các bảng phân chia nếu cần                       */
  /* ---------------------------------------------------------------------- */

  function drawBarChart(canvas, rows, opts) {
    opts = opts || {};
    var data = Array.isArray(rows) ? rows.slice() : [];
    if (!canvas || !data.length) return;

    var box = prepare(canvas);
    if (!box) {
      window.requestAnimationFrame(function () {
        drawBarChart(canvas, rows, opts);
      });
      return;
    }

    var ctx = box.ctx;
    var W = box.w;
    var H = box.h;

    var padLeft = 54;
    var padRight = 12;
    var padTop = 14;
    var padBottom = 28;
    var plotW = W - padLeft - padRight;
    var plotH = H - padTop - padBottom;
    if (plotW <= 10 || plotH <= 10) return;

    var values = data.map(function (d) {
      return Number(d.value) || 0;
    });
    var maxV = Math.max.apply(null, values.concat([0]));
    var top = niceCeil(maxV > 0 ? maxV : 1);

    ctx.font = "11px " + FONT_STACK;

    var TICKS = 4;
    for (var t = 0; t <= TICKS; t++) {
      var v = (top * t) / TICKS;
      var y = padTop + plotH - (plotH * v) / top;
      ctx.beginPath();
      ctx.strokeStyle = t === 0 ? COLORS.axis : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = COLORS.faint;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(shortNumber(v), padLeft - 8, y);
    }

    var slot = plotW / data.length;
    var barW = Math.max(6, Math.min(46, slot * 0.6));

    for (var i = 0; i < data.length; i++) {
      var cx = padLeft + slot * i + slot / 2;
      var barH = (plotH * values[i]) / top;
      var by = padTop + plotH - barH;

      ctx.fillStyle = COLORS.bar;
      // Bo góc trên cho cột; chiều cao 0 vẫn vẽ một vạch mỏng để thấy là có mục.
      var hh = Math.max(2, barH);
      var r = Math.min(4, barW / 2, hh);
      roundedRectTop(ctx, cx - barW / 2, padTop + plotH - hh, barW, hh, r);
      ctx.fill();

      ctx.fillStyle = COLORS.faint;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(String(data[i].label == null ? "" : data[i].label), cx, padTop + plotH + 8);
    }

    remember(canvas, function () {
      drawBarChart(canvas, rows, opts);
    });
    wireInteractivity(canvas, {
      kind: "bar",
      redraw: function () {
        drawBarChart(canvas, rows, opts);
      },
      padTop: padTop,
      plotLeft: padLeft,
      plotW: plotW,
      plotH: plotH,
      values: values,
      points: data.map(function (d) {
        return { label: d.label };
      }),
      xAt: function (i) {
        return padLeft + (plotW / data.length) * (i + 0.5);
      },
      yAt: function (i) {
        return padTop + plotH - (plotH * values[i]) / top;
      },
      labelFormatter: opts.labelFormatter,
      valueFormatter: opts.valueFormatter,
    });
  }

  function roundedRectTop(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------------- */
  /* Tooltip + đọc bằng bàn phím                                             */
  /* ---------------------------------------------------------------------- */

  /* Mỗi canvas có một trạng thái tương tác riêng, lưu theo phần tử. */
  var interaction = new WeakMap();

  /** Hoàn tất tương tác của một biểu đồ và gỡ mọi listener (tránh rò rỉ). */
  function teardown(canvas) {
    var st = interaction.get(canvas);
    if (!st) return;
    if (st.onMove) canvas.removeEventListener("mousemove", st.onMove);
    if (st.onLeave) canvas.removeEventListener("mouseleave", st.onLeave);
    if (st.onDown) canvas.removeEventListener("mousedown", st.onDown);
    if (st.onUp) canvas.removeEventListener("mouseup", st.onUp);
    if (st.onKey) canvas.removeEventListener("keydown", st.onKey);
    if (st.onBlur) canvas.removeEventListener("blur", st.onBlur);
    if (st.hint && st.hint.parentNode) st.hint.parentNode.removeChild(st.hint);
    interaction.delete(canvas);
  }

  /**
   * Gắn tương tác cho một biểu đồ (idempotent).
   *
   * QUAN TRỌNG — phải idempotent: hàm vẽ gọi lại chính nó khi resize hoặc khi
   * chọn mốc, nên nếu mỗi lần đều gỡ rồi gắn lại listener + vùng aria-live thì
   * vùng hint đang được cập nhật sẽ bị gỡ khỏi DOM (và trở thành phần tử mồ côi),
   * khiến trình đọc màn hình không bao giờ nhận được gì. Vì vậy: nếu đã có trạng
   * thái cho canvas này, chỉ cập nhật lại `geo` rồi trả về.
   */
  function wireInteractivity(canvas, geo) {
    var existing = interaction.get(canvas);
    if (existing) {
      existing.geo = geo;
      return existing;
    }

    var hint = document.createElement("p");
    hint.className = "visually-hidden chart-readout";
    hint.setAttribute("aria-live", "polite");
    hint.setAttribute("aria-atomic", "true");
    canvas.parentNode.appendChild(hint);

    var st = { canvas: canvas, geo: geo, index: -1, pinned: false, hint: hint };
    interaction.set(canvas, st);

    canvas.style.cursor = "crosshair";
    if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
    canvas.setAttribute("role", "img");

    st.draw = function () {
      // Vẽ lại toàn bộ biểu đồ (hàm vẽ sẽ gọi lại wireInteractivity, nhưng nhờ
      // idempotent nên không gỡ hint), rồi vẽ đè hộp thông tin và cập nhật hint.
      st.geo.redraw();
      if (st.index >= 0) paintTooltip(canvas, st.geo, st.index);
      updateHint(canvas, st);
    };

    st.onMove = function (ev) {
      if (st.pinned) return;
      var idx = indexAtCursor(canvas, geo, ev);
      if (idx !== st.index) {
        st.index = idx;
        st.draw();
      }
    };
    st.onLeave = function () {
      if (st.pinned) return;
      if (st.index !== -1) {
        st.index = -1;
        st.draw();
      }
    };
    st.onDown = function (ev) {
      st.pinned = !st.pinned;
      st.index = indexAtCursor(canvas, geo, ev);
      st.draw();
    };
    st.onUp = function () {
      /* mousedown đã xử lý ghim; mouseup chỉ để nhả trạng thái kéo */
    };
    st.onKey = function (ev) {
      var n = geo.points.length;
      if (!n) return;
      var moved = false;
      if (ev.key === "ArrowRight") {
        st.index = st.index < 0 ? 0 : Math.min(n - 1, st.index + 1);
        moved = true;
      } else if (ev.key === "ArrowLeft") {
        st.index = st.index < 0 ? n - 1 : Math.max(0, st.index - 1);
        moved = true;
      } else if (ev.key === "Home") {
        st.index = 0;
        moved = true;
      } else if (ev.key === "End") {
        st.index = n - 1;
        moved = true;
      } else if (ev.key === "Escape") {
        st.index = -1;
        st.pinned = false;
        st.draw();
        return;
      }
      if (moved) {
        ev.preventDefault();
        st.draw();
      }
    };
    st.onBlur = function () {
      st.pinned = false;
      if (st.index !== -1) {
        st.index = -1;
        st.draw();
      }
    };

    canvas.addEventListener("mousemove", st.onMove, false);
    canvas.addEventListener("mouseleave", st.onLeave, false);
    canvas.addEventListener("mousedown", st.onDown, false);
    canvas.addEventListener("mouseup", st.onUp, false);
    canvas.addEventListener("keydown", st.onKey, false);
    canvas.addEventListener("blur", st.onBlur, false);
  }

  /** Toạ độ chuột (CSS pixel) đổi sang chỉ số mốc dữ liệu gần nhất. */
  function indexAtCursor(canvas, geo, ev) {
    var rect = canvas.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var n = geo.points.length;
    if (!n) return -1;
    if (x < geo.plotLeft || x > geo.plotLeft + geo.plotW) return -1;
    if (geo.kind === "bar") {
      var slot = geo.plotW / n;
      return Math.max(0, Math.min(n - 1, Math.floor((x - geo.plotLeft) / slot)));
    }
    // Đường: tìm điểm gần nhất theo trục x.
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i < n; i++) {
      var d = Math.abs(geo.xAt(i) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Nhãn của mốc dữ liệu.
   *
   * Biểu đồ đường nhận mốc dạng {x, y} (x là ngày), biểu đồ cột nhận {label, value}.
   * Vì vậy phải đọc cả hai khoá — nếu chỉ đọc `label` thì tooltip của biểu đồ
   * doanh thu sẽ luôn hiện nhãn rỗng.
   */
  function labelOf(geo, idx) {
    var point = geo.points[idx] || {};
    var raw = point.label != null ? point.label : point.x != null ? point.x : "";
    if (typeof geo.labelFormatter === "function" && raw !== "") {
      return String(geo.labelFormatter(raw, idx));
    }
    return raw === "" ? "" : String(raw);
  }

  /** Giá trị của mốc dữ liệu dưới dạng chữ (ưu tiên định dạng riêng của trang). */
  function valueOf(geo, idx) {
    var v = geo.values[idx];
    if (typeof geo.valueFormatter === "function") {
      return String(geo.valueFormatter(v));
    }
    return shortNumber(v);
  }

  /** Vẽ hộp thông tin cho mốc `idx` lên chính canvas (luôn tương phản rõ). */
  function paintTooltip(canvas, geo, idx) {
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var label = labelOf(geo, idx);
    var body = valueOf(geo, idx);
    var title = label;

    ctx.font = "600 12px " + FONT_STACK;
    var wTitle = ctx.measureText(title).width;
    ctx.font = "700 13px " + FONT_STACK;
    var wBody = ctx.measureText(body).width;
    var boxW = Math.max(wTitle, wBody) + 20;
    var boxH = 44;

    // Neo hộp theo điểm dữ liệu, luôn giữ trong khung vẽ.
    var anchorX = geo.kind === "bar" ? geo.plotLeft + (geo.plotW / geo.points.length) * (idx + 0.5) : geo.xAt(idx);
    var anchorY = geo.yAt(idx);
    var bx = Math.max(4, Math.min(canvas.clientWidth - boxW - 4, anchorX - boxW / 2));
    var by = anchorY - boxH - 12;
    if (by < 4) by = anchorY + 14;

    // Đường chỉ từ điểm tới hộp.
    ctx.strokeStyle = COLORS.accent2;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(anchorX, anchorY);
    ctx.lineTo(Math.max(bx + 6, Math.min(bx + boxW - 6, anchorX)), by + (by < anchorY ? boxH : 0));
    ctx.stroke();
    ctx.setLineDash([]);

    // Điểm nhấn tại mốc đang chọn.
    ctx.beginPath();
    ctx.arc(anchorX, anchorY, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.accent2;
    ctx.fill();

    // Hộp nền.
    ctx.fillStyle = "rgba(9, 9, 11, 0.94)";
    ctx.strokeStyle = "rgba(52, 211, 153, 0.42)";
    ctx.lineWidth = 1;
    roundedRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.faint;
    ctx.font = "600 12px " + FONT_STACK;
    ctx.fillText(title, bx + 10, by + 7);
    ctx.fillStyle = COLORS.text;
    ctx.font = "700 13px " + FONT_STACK;
    ctx.fillText(body, bx + 10, by + 24);

    ctx.restore();
  }

  /** Cập nhật vùng aria-live để trình đọc màn hình nghe được giá trị đang chọn. */
  function updateHint(canvas, st) {
    if (!st.hint) return;
    if (st.index < 0) {
      st.hint.textContent = "Dùng phím mũi tên trái hoặc phải để đọc từng mốc dữ liệu.";
      return;
    }
    st.hint.textContent = labelOf(st.geo, st.index) + ": " + valueOf(st.geo, st.index);
  }

  /** Bo góc đủ 4 cạnh (dùng cho hộp tooltip). */
  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------------- */
  /* Quản lý vòng đời                                                        */
  /* ---------------------------------------------------------------------- */

  /** Ghi nhớ hàm vẽ của một canvas để gọi lại khi resize. */
  function remember(canvas, redrawFn) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].canvas === canvas) {
        registry[i].redraw = redrawFn;
        return;
      }
    }
    registry.push({ canvas: canvas, redraw: redrawFn });
  }

  /** Vẽ lại mọi biểu đồ đã đăng ký. Dùng khi đổi kích thước cửa sổ / xoay máy. */
  function redraw() {
    for (var i = 0; i < registry.length; i++) {
      var entry = registry[i];
      // Canvas đã bị gỡ khỏi DOM thì bỏ luôn, tránh rò rỉ.
      if (!entry.canvas.isConnected) {
        teardown(entry.canvas);
        registry.splice(i, 1);
        i--;
        continue;
      }
      try {
        // Sau khi vẽ lại, nếu đang có mốc được chọn thì vẽ lại cả tooltip —
        // nếu không, hộp thông tin sẽ biến mất mỗi lần người dùng đổi cỡ cửa sổ
        // hoặc xoay máy.
        var st = interaction.get(entry.canvas);
        if (st) st.draw();
        else entry.redraw();
      } catch (e) {
        /* một biểu đồ lỗi không được làm chết cả trang */
      }
    }
  }

  function destroy(canvas) {
    teardown(canvas);
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].canvas === canvas) {
        registry.splice(i, 1);
        break;
      }
    }
  }

  // Xuất API.
  window.ShopChart = {
    drawLineChart: drawLineChart,
    drawBarChart: drawBarChart,
    redraw: redraw,
    destroy: destroy,
    COLORS: COLORS,
  };
})();

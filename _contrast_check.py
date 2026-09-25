"""Kiem tra tuong phan (contrast ratio) cho bang mau emerald cua du an wed.

Theo skill ui-ux-pro-max, Accessibility la uu tien 1 (CRITICAL):
  - text thuong can >= 4.5:1
  - text lon (>=24px hoac >=19px bold) can >= 3:1
  - khong phu thuoc vao mau don le
"""

def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * srgb_to_linear(r) + 0.7152 * srgb_to_linear(g) + 0.0722 * srgb_to_linear(b)


def contrast(fg: str, bg: str) -> float:
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def blend(fg: str, bg: str, alpha: float) -> str:
    """Tron mau alpha len nen -> hex ke qua."""
    f = fg.lstrip("#")
    b = bg.lstrip("#")
    out = ""
    for i in (0, 2, 4):
        c_f = int(f[i:i + 2], 16)
        c_b = int(b[i:i + 2], 16)
        v = round(c_f * alpha + c_b * (1 - alpha))
        out += f"{max(0, min(255, v)):02x}"
    return "#" + out


BG_DEEP = "#0b0f19"
BG_DEEPER = "#09090b"
ACCENT = "#10b981"
ACCENT_LIGHT = "#34d399"
TEXT = "#f8fafc"
TEXT_DIM = "#94a3b8"
TEXT_FAINT = "#64748b"
BUTTON_TEXT = "#052e24"
DANGER = "#fb7185"

# The nen cua the/panel la kinh mo trang 3% pha len nen chinh.
SURFACE = blend("#ffffff", BG_DEEP, 0.03)
SURFACE_RAISED = blend("#ffffff", BG_DEEP, 0.045)

CHECKS = [
    # (nhan, chu, nen, nguong, ghi chu)
    ("Tieu de tren nen", TEXT, BG_DEEP, 4.5, "text trang tren nen toi"),
    ("Chu chinh tren nen", TEXT, BG_DEEP, 4.5, ""),
    ("Chu phu tren nen", TEXT_DIM, BG_DEEP, 4.5, "chu phu, noi dung chinh"),
    ("Chu mo nhat tren nen", TEXT_FAINT, BG_DEEP, 4.5, "chu chu thich - hay LO"),
    ("Chu mo nhat tren the", TEXT_FAINT, SURFACE, 4.5, ""),
    ("Chu phu tren the", TEXT_DIM, SURFACE, 4.5, ""),
    ("Tieu de tren the", TEXT, SURFACE, 4.5, ""),
    ("Tieu de tren the noi bat", TEXT, SURFACE_RAISED, 4.5, ""),
    ("Chu phu tren the noi bat", TEXT_DIM, SURFACE_RAISED, 4.5, ""),
    ("Accent sang tren nen", ACCENT_LIGHT, BG_DEEP, 4.5, "chu accent tren nen toi"),
    ("Accent tren nen", ACCENT, BG_DEEP, 4.5, ""),
    ("Chu tren nut emerald", BUTTON_TEXT, ACCENT, 4.5, "chu toi tren nut chinh"),
    ("Chu tren nut emerald sang", BUTTON_TEXT, ACCENT_LIGHT, 4.5, ""),
    ("Chu canh bao tren nen", DANGER, BG_DEEP, 4.5, ""),
    ("Chu canh bao tren the", DANGER, SURFACE, 4.5, ""),
]

print(f"Nen chinh: {BG_DEEP}   The kinh mo: {SURFACE}   The noi bat: {SURFACE_RAISED}")
print("-" * 88)
fails = []
for label, fg, bg, need, note in CHECKS:
    r = contrast(fg, bg)
    ok = r >= need
    flag = "DAT " if ok else "LO  "
    if not ok:
        fails.append((label, round(r, 2), need))
    extra = f"  <- {note}" if note else ""
    print(f"  {flag} {label:<28} {r:>5.2f}:1  (can >= {need}){extra}")

print("-" * 88)
if fails:
    print(f"CO {len(fails)} MUC KHONG DAT chuan WCAG AA:")
    for label, r, need in fails:
        print(f"  - {label}: {r}:1 (thieu)")
else:
    print("TAT CA deu dat WCAG AA 4.5:1")

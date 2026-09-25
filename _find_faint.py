"""Tim gia tri toi nhat cho --text-faint de dat WCAG AA tren ca nen va the."""

def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(h: str) -> float:
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * srgb_to_linear(r) + 0.7152 * srgb_to_linear(g) + 0.0722 * srgb_to_linear(b)


def contrast(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def blend(fg: str, bg: str, alpha: float) -> str:
    f, b = fg.lstrip("#"), bg.lstrip("#")
    out = ""
    for i in (0, 2, 4):
        v = round(int(f[i:i + 2], 16) * alpha + int(b[i:i + 2], 16) * (1 - alpha))
        out += f"{max(0, min(255, v)):02x}"
    return "#" + out


BG = "#0b0f19"
SURFACE = blend("#ffffff", BG, 0.03)
SURFACE_RAISED = blend("#ffffff", BG, 0.045)

# Quet cac buoc xam ngang giua #64748b va #94a3b8
start = (0x64, 0x74, 0x8B)
end = (0x94, 0xA3, 0xB8)
steps = 100
best = None

print("Quet tim mau nhat dat 4.5:1 tren ca 3 nen...")
for i in range(steps + 1):
    t = i / steps
    r = round(start[0] + (end[0] - start[0]) * t)
    g = round(start[1] + (end[1] - start[1]) * t)
    b = round(start[2] + (end[2] - start[2]) * t)
    hexv = f"#{r:02x}{g:02x}{b:02x}"
    c_bg = contrast(hexv, BG)
    c_sf = contrast(hexv, SURFACE)
    c_sr = contrast(hexv, SURFACE_RAISED)
    worst = min(c_bg, c_sf, c_sr)
    if worst >= 4.5:
        best = (hexv, c_bg, c_sf, c_sr, t)
        break

if best:
    hexv, c_bg, c_sf, c_sr, t = best
    print(f"  -> {hexv}  (buoc {t:.0%} tu #64748b toi #94a3b8)")
    print(f"     nen        : {c_bg:.2f}:1")
    print(f"     the        : {c_sf:.2f}:1")
    print(f"     the noi bat: {c_sr:.2f}:1  <- truong hop xau nhat")
    print()
    print("  So sanh:")
    print(f"    #64748b (cu)  the noi bat: {contrast('#64748b', SURFACE_RAISED):.2f}:1  -> LO")
    print(f"    {hexv} (moi) the noi bat: {c_sr:.2f}:1  -> DAT")
    print(f"    #94a3b8 (dim) the noi bat: {contrast('#94a3b8', SURFACE_RAISED):.2f}:1 -> DAT")

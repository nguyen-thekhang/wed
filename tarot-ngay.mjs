/**
 * Rút bài tarot cho "ngày hôm nay của Linh".
 *
 * Trải 3 lá theo ba buổi: Sáng — Chiều — Tối.
 * Xáo bằng crypto.randomInt (nguồn ngẫu nhiên mật mã của hệ điều hành),
 * KHÔNG dùng Math.random — để lá bài không phải do tôi tự nghĩ ra.
 */

import { randomInt } from "node:crypto";

const MAJOR = [
  "The Fool", "The Magician", "The High Priestess", "The Empress", "The Emperor",
  "The Hierophant", "The Lovers", "The Chariot", "Strength", "The Hermit",
  "Wheel of Fortune", "Justice", "The Hanged Man", "Death", "Temperance",
  "The Devil", "The Tower", "The Star", "The Moon", "The Sun",
  "Judgement", "The World",
];

const SUITS = ["Wands", "Cups", "Swords", "Pentacles"];
const RANKS = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Page", "Knight", "Queen", "King"];

const DECK = [...MAJOR, ...SUITS.flatMap((s) => RANKS.map((r) => `${r} of ${s}`))];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* Giờ Việt Nam (UTC+7) — quan trọng vì "hôm nay" phụ thuộc múi giờ  */
/* ------------------------------------------------------------------ */

const nowUtc = new Date();
const vn = new Date(nowUtc.getTime() + 7 * 3600 * 1000);
const p = (n) => String(n).padStart(2, "0");
const vnDate = `${p(vn.getUTCDate())}/${p(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()}`;
const vnTime = `${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}`;
const vnHour = vn.getUTCHours();

let buoi;
if (vnHour < 11) buoi = "sáng";
else if (vnHour < 13) buoi = "trưa";
else if (vnHour < 18) buoi = "chiều";
else if (vnHour < 22) buoi = "tối";
else buoi = "đêm muộn";

const positions = [
  "SÁNG — điều mở đầu ngày của cô ấy",
  "CHIỀU — điều diễn ra giữa ngày",
  "TỐI — điều còn lại khi ngày khép lại",
];

const shuffled = shuffle(DECK);

console.log("=".repeat(64));
console.log("  TRẢI BÀI MỘT NGÀY — VÕ THUỲ LINH");
console.log("=".repeat(64));
console.log("");
console.log(`  Ngày (giờ VN): ${vnDate}  —  bây giờ là ${vnTime} (${buoi})`);
console.log(`  Bộ bài: ${DECK.length} lá, xáo bằng nguồn ngẫu nhiên mật mã`);
console.log("");
console.log("-".repeat(64));
console.log("");

positions.forEach((label, i) => {
  const reversed = randomInt(0, 2) === 1;
  console.log(`  ${label}`);
  console.log(`     →  ${shuffled[i]}${reversed ? "   (LẬT NGƯỢC)" : "   (xuôi)"}`);
  console.log("");
});

console.log("-".repeat(64));
console.log("");

// Cảnh báo trung thực về thời điểm đọc bài.
if (vnHour >= 21) {
  console.log("  ⚠️  LÚC NÀY ĐÃ " + vnTime + " — ngày " + vnDate + " gần như đã hết.");
  console.log("      Lá 'Sáng' và 'Chiều' chỉ còn là nhìn lại, không phải dự báo.");
  console.log("      Nếu muốn xem cho ngày MAI, nói tôi rút lại.");
  console.log("");
} else if (vnHour < 5) {
  console.log("  ⚠️  Bây giờ là " + vnTime + " — phần lớn người còn đang ngủ.");
  console.log("      'Hôm nay' của cô ấy có thể chưa thật sự bắt đầu.");
  console.log("");
}

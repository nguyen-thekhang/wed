/**
 * Rút bài tarot thật sự ngẫu nhiên.
 *
 * Dùng crypto.randomInt (nguồn ngẫu nhiên của hệ điều hành), không dùng
 * Math.random — để lá bài không phải do tôi tự nghĩ ra.
 *
 * Bốc 3 lá theo kiểu "trải bài quan hệ":
 *   Lá 1 — Bạn (Nguyễn Thế Khang)
 *   Lá 2 — Người ấy (Võ Thuỳ Linh)
 *   Lá 3 — Mối quan hệ này
 */

import { randomInt } from "node:crypto";

// 78 lá của bộ bài tarot đầy đủ (22 ẩn chính + 56 ẩn phụ)
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

const DECK = [
  ...MAJOR,
  ...SUITS.flatMap((s) => RANKS.map((r) => `${r} of ${s}`)),
];

// Xáo kiểu Fisher-Yates bằng nguồn ngẫu nhiên mật mã.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const positions = [
  "LÁ 1 — BẠN (Nguyễn Thế Khang)",
  "LÁ 2 — NGƯỜI ẤY (Võ Thuỳ Linh)",
  "LÁ 3 — MỐI QUAN HỆ NÀY",
];

const shuffled = shuffle(DECK);

console.log("=".repeat(62));
console.log("  TRẢI BÀI QUAN HỆ — 3 LÁ");
console.log("=".repeat(62));
console.log("");
console.log(`Bộ bài: ${DECK.length} lá. Đã xáo bằng nguồn ngẫu nhiên mật mã.`);
console.log(`Lần rút: ${new Date().toISOString()}`);
console.log("");

positions.forEach((label, i) => {
  // 50% xác suất lá bị lật ngược (ngược chiều) — đúng như rút bài thật.
  const reversed = randomInt(0, 2) === 1;
  const card = shuffled[i];
  console.log(`  ${label}`);
  console.log(`     →  ${card}${reversed ? "  (LẬT NGƯỢC)" : "  (xuôi)"}`);
  console.log("");
});

console.log("=".repeat(62));

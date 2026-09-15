// Number formatting shared across views.

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"];
const BYTE_BASE = 1024;

// One decimal below 10, whole numbers above: "6.0 MiB", "28 MiB", "512 B".
export function humanBytes(n) {
  let value = n;
  let unit = 0;
  while (value >= BYTE_BASE && unit < BYTE_UNITS.length - 1) {
    value /= BYTE_BASE;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

// A share as a percentage: "37%", with one decimal under 10 so a small
// slice does not read as zero.
export function percent(part, whole) {
  if (whole === 0) {
    return "0%";
  }
  const value = (100 * part) / whole;
  const digits = value < 10 && value > 0 ? 1 : 0;
  return `${value.toFixed(digits)}%`;
}

// A count with thousands separators.
export const count = (n) => n.toLocaleString("en-US");

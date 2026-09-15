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

// A share as a percentage: "37%", one decimal under 10 and over 99 so a
// small slice does not read as zero nor a large one as everything, and
// "<0.1%" or ">99.9%" at the extremes.
const PERCENT_FLOOR = 0.1;
const PERCENT_CEILING = 99.9;
const FINE_BELOW = 10;
const FINE_ABOVE = 99;

export function percent(part, whole) {
  if (whole === 0 || part === 0) {
    return "0%";
  }
  if (part === whole) {
    return "100%";
  }
  const value = (100 * part) / whole;
  if (value < PERCENT_FLOOR) {
    return `<${PERCENT_FLOOR}%`;
  }
  if (value > PERCENT_CEILING) {
    return `>${PERCENT_CEILING}%`;
  }
  const digits = value < FINE_BELOW || value > FINE_ABOVE ? 1 : 0;
  return `${value.toFixed(digits)}%`;
}

// A count with thousands separators.
export const count = (n) => n.toLocaleString("en-US");

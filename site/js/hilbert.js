// The Hilbert curve that lays a closure's bytes out on the plane.
//
// A world of order N is 2^N x 2^N pixels, one byte of NAR per pixel, and
// the curve index d of a pixel is the byte's offset in the concatenated
// closure. The property the renderer is built on: the aligned block of
// pixels [bx*2^m, (bx+1)*2^m) x [by*2^m, (by+1)*2^m) covers exactly one
// contiguous curve range [q*4^m, (q+1)*4^m), and (bx, by) is
// d2xy(N - m, q). A tile, and a mip texel, is therefore a byte range.
//
// Never use bitwise operators on d: curve indices pass 2^32 for closures
// over 4 GiB. Coordinates stay below 2^31, so `x & s` is safe.

// Both directions return through these, so hot loops do not allocate.
let outX = 0;
let outY = 0;

// The curve index of pixel (x, y) in a world of the given order.
export function xy2d(order, x, y) {
  const n = 2 ** order;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);

    // Rotate the quadrant so the sub-curve starts where the parent
    // curve enters it.
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

// The pixel at curve index d, written to outX and outY and read back
// with lastX() and lastY(). d2xy() wraps this in an array for callers
// that are not in a hot loop.
export function d2xyInto(order, d) {
  const n = 2 ** order;
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < n; s *= 2) {
    const rx = Math.floor(t / 2) % 2;
    const ry = (t % 2) ^ rx;

    // The inverse rotation of xy2d's, applied at this sub-curve's size.
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const swap = x;
      x = y;
      y = swap;
    }

    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  outX = x;
  outY = y;
}

export const lastX = () => outX;
export const lastY = () => outY;

export function d2xy(order, d) {
  d2xyInto(order, d);
  return [outX, outY];
}

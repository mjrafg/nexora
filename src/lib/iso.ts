/**
 * 2:1 isometric projection helpers for the office scene.
 * Floor coordinates are in "units"; z is height in units.
 */
export const S = 12; // px per floor unit
export const OX = 560; // screen x of floor origin
export const OY = 128; // screen y of floor origin
export const VIEW_W = 1360;
export const VIEW_H = 790;

export function iso(x: number, y: number, z = 0): [number, number] {
  return [OX + (x - y) * S, OY + ((x + y) * S) / 2 - z * S];
}

export function poly(points: Array<[number, number]>) {
  return points.map((p) => p.join(",")).join(" ");
}

/** Floor-plane rectangle polygon points string */
export function floorRect(x: number, y: number, w: number, d: number, z = 0) {
  return poly([iso(x, y, z), iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)]);
}

/** Convert iso screen coordinates to percentages of the viewBox (for HTML overlays) */
export function pct(x: number, y: number, z = 0): { left: string; top: string } {
  const [sx, sy] = iso(x, y, z);
  return { left: `${(sx / VIEW_W) * 100}%`, top: `${(sy / VIEW_H) * 100}%` };
}

/** Deterministic PRNG so SSR and client render identical scenes. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shade(hex: string, amt: number) {
  // amt in [-1, 1]; negative darkens toward black, positive lightens toward white
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  r = Math.round(r + (t - r) * p);
  g = Math.round(g + (t - g) * p);
  b = Math.round(b + (t - b) * p);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

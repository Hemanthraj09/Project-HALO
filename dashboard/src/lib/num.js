// Number guards shared by every helper. Firebase values arrive untyped, so nothing is
// formatted or compared until it has passed isNum.

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

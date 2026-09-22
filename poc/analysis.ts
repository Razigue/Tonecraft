export function activeRms(x: Float32Array, rate = 48000): number {
  const win = rate * 0.05, act: number[] = [];
  for (let i = 0; i + win < x.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += x[j]! ** 2; const r = Math.sqrt(s / win); if (r > 1e-3 * 1e-0 * 0.001) act.push(r); }
  const top = act.sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(act.length * 0.8)));
  return Math.sqrt(top.reduce((s, r) => s + r * r, 0) / top.length);
}

export const bands = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
export function ltas(x: Float32Array, rate: number): number[] {
  const N = 8192, acc = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let o = 0; o + N < x.length; o += N / 2) {
    let e = 0; for (let i = 0; i < N; i++) e += x[o + i]! ** 2;
    if (e / N < 1e-7) continue;
    for (let i = 0; i < N; i++) { re[i] = x[o + i]! * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k]! += re[k]! ** 2 + im[k]! ** 2;
  }
  return bands.map((f) => { let s = 0; const lo = Math.floor(f / 1.122 * N / rate), hi = Math.ceil(f * 1.122 * N / rate); for (let k = lo; k <= hi; k++) s += acc[k]!; return 10 * Math.log10(s + 1e-30); });
}
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len; for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
    const wr = Math.cos(a * k), wi = Math.sin(a * k), xr = re[i + k + len / 2]! * wr - im[i + k + len / 2]! * wi, xi = re[i + k + len / 2]! * wi + im[i + k + len / 2]! * wr;
    re[i + k + len / 2] = re[i + k]! - xr; im[i + k + len / 2] = im[i + k]! - xi; re[i + k]! += xr; im[i + k]! += xi; } }
}

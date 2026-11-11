/**
 * 在一块窗口的水陆图上走方格(marching squares),把水陆分界接成折线。
 *
 * 为什么需要它:整张图的海岸矢量是在 1 倍底图(2048 × 1024)上追一次就固定的,
 * 而放大后的瓦片是按当前倍率重新栅格化的 —— 两边的水陆边界差 1 个底图像素,
 * 放大到 400% 就是 3~4 个屏幕像素,线就"浮"在海岸外面了。这里在瓦片自己的分辨率
 * 上追踪,倍率多高线就多准,再交给前端按 1px 画。
 *
 * 坐标是瓦片内的像素坐标(0..size,含亚像素),调用方按瓦片的贴图尺寸换算到屏幕。
 */

/** 方格的四个角:TL(bit0) / TR(bit1) / BR(bit2) / BL(bit3);边:0 上 1 右 2 下 3 左 */
const CASE_EDGES: number[][] = [
  [], // 0
  [3, 0], // 1  TL
  [0, 1], // 2  TR
  [3, 1], // 3  TL TR
  [1, 2], // 4  BR
  [3, 2, 1, 0], // 5  TL BR(鞍点:拆成两段)
  [0, 2], // 6  TR BR
  [3, 2], // 7  TL TR BR
  [2, 3], // 8  BL
  [0, 2], // 9  TL BL
  [0, 3, 2, 1], // 10 TR BL(鞍点)
  [1, 2], // 11 TL TR BL
  [1, 3], // 12 BR BL
  [0, 1], // 13 TL BR BL
  [0, 3], // 14 TR BR BL
  [], // 15
];

/**
 * 把 mask 里等于 value 的像素圈成折线。
 * @param mask 长度 n*n,值 0/1/2
 * @param n 边长
 * @param value 要圈的值(1 = 海洋,2 = 湖泊)
 * @param ox / oy 输出时减掉的偏移(mask 可以带 pad,调用方把自己裁到瓦片内)
 * @returns 折线数组,每条是 [x0,y0,x1,y1,…]
 */
export function traceMaskValue(
  mask: Uint8Array,
  n: number,
  value: number,
  ox = 0,
  oy = 0,
): number[][] {
  // 1) 逐格取线段。坐标用"半像素"整数存,既精确(中点只会落在 .0 / .5)又好做哈希
  const segs: number[] = [];
  const ex = [0, 0, 0, 0];
  const ey = [0, 0, 0, 0];
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const p = y * n + x;
      const tl = mask[p] === value ? 1 : 0;
      const tr = mask[p + 1] === value ? 1 : 0;
      const br = mask[p + n + 1] === value ? 1 : 0;
      const bl = mask[p + n] === value ? 1 : 0;
      const c = tl | (tr << 1) | (br << 2) | (bl << 3);
      const edges = CASE_EDGES[c];
      if (!edges.length) continue;
      if (tl !== tr) { ex[0] = x + 0.5; ey[0] = y; }
      if (tr !== br) { ex[1] = x + 1; ey[1] = y + 0.5; }
      if (br !== bl) { ex[2] = x + 0.5; ey[2] = y + 1; }
      if (bl !== tl) { ex[3] = x; ey[3] = y + 0.5; }
      for (let k = 0; k < edges.length; k += 2) {
        const a = edges[k];
        const b = edges[k + 1];
        segs.push(ex[a] * 2, ey[a] * 2, ex[b] * 2, ey[b] * 2);
      }
    }
  }
  const count = segs.length / 4;
  if (!count) return [];

  // 2) 按端点把线段接成折线。端点最多 2n 个,一步就能查完
  const HX = 4 * n + 8;
  const at = new Map<number, number[]>();
  const keyOf = (hx: number, hy: number) => hy * HX + hx;
  for (let s = 0; s < count; s++) {
    const ka = keyOf(segs[s * 4], segs[s * 4 + 1]);
    const kb = keyOf(segs[s * 4 + 2], segs[s * 4 + 3]);
    let la = at.get(ka);
    if (!la) at.set(ka, (la = []));
    la.push(s);
    let lb = at.get(kb);
    if (!lb) at.set(kb, (lb = []));
    lb.push(s);
  }
  const used = new Uint8Array(count);
  const nextAt = (hx: number, hy: number): number => {
    const list = at.get(keyOf(hx, hy));
    if (!list) return -1;
    for (const s of list) if (!used[s]) return s;
    return -1;
  };
  const lines: number[][] = [];
  for (let s0 = 0; s0 < count; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const line = [segs[s0 * 4], segs[s0 * 4 + 1], segs[s0 * 4 + 2], segs[s0 * 4 + 3]];
    // 从两端各往前接
    for (let dir = 0; dir < 2; dir++) {
      for (;;) {
        const hi = dir === 0 ? line.length - 2 : 0;
        const hx = line[hi];
        const hy = line[hi + 1];
        const nx = nextAt(hx, hy);
        if (nx < 0) break;
        used[nx] = 1;
        const ax = segs[nx * 4];
        const ay = segs[nx * 4 + 1];
        const bx = segs[nx * 4 + 2];
        const by = segs[nx * 4 + 3];
        const otherX = ax === hx && ay === hy ? bx : ax;
        const otherY = ax === hx && ay === hy ? by : ay;
        if (dir === 0) line.push(otherX, otherY);
        else line.unshift(otherX, otherY);
      }
    }
    lines.push(line);
  }
  // 3) 半像素整数 → 瓦片内坐标(保留 1 位小数:0.1 瓦片像素 ≈ 0.1 屏幕像素)
  const out: number[][] = [];
  for (const line of lines) {
    const v: number[] = new Array(line.length);
    for (let i = 0; i < line.length; i += 2) {
      v[i] = line[i] / 2 - ox;
      v[i + 1] = line[i + 1] / 2 - oy;
    }
    const thin = simplify(v, SIMPLIFY_TOL);
    const use = thin.length >= 4 ? thin : v;
    const z: number[] = new Array(use.length);
    for (let i = 0; i < use.length; i++) z[i] = Math.round(use[i] * 10) / 10;
    if (z.length >= 4) out.push(z);
  }
  return out;
}

/** 抽稀容差(瓦片像素):0.25 在最高倍率下也就 0.35 屏幕像素,看不出来,点数能砍掉一大半 */
const SIMPLIFY_TOL = 0.25;

/** Douglas–Peucker,显式栈避免长折线递归过深 */
function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const tol2 = tol * tol;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a * 2];
    const ay = pts[a * 2 + 1];
    const bx = pts[b * 2];
    const by = pts[b * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1;
    let farD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2];
      const py = pts[i * 2 + 1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push(a, far, far, b);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

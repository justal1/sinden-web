// Light-gun border tracker: finds the bright rectangular border the game draws around the
// screen in a camera frame, and maps the frame centre (where the gun points) to normalised
// screen coordinates. Pure functions, no DOM.
//
// Method (informed by the notes of the sindenrs driver, MIT, Chaz Schlarp):
//   1. luma, with a threshold at half-brightness between the room and the border's own peak
//   2. largest ring-like blob -> its OUTER silhouette (per-row and per-column extremes)
//   3. undistort the silhouette points (one-parameter division model; barrel distortion bows
//      straight edges by ~10 px otherwise) and fit a straight line per side
//   4. intersect adjacent lines for sub-pixel corners -> homography -> where the frame centre lands
var __sindenFactory = function (root) {
  'use strict';

  // Homography mapping 4 src points to 4 dst points; returns 9 numbers or null.
  function solveHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
      }
    }
    const h = [];
    for (let i = 0; i < 8; i++) h.push(A[i][8] / A[i][i]);
    h.push(1);
    return h;
  }

  function applyH(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }

  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }

  // ---------- lens: one-parameter division model p_u = c + (p_d - c) / (1 + k1 r^2), r in half-widths ----------
  // k1 < 0 is barrel distortion. The centre is the frame centre (where the gun points), so it stays fixed.
  function undistortPt(x, y, k1, w, h) {
    if (!k1) return [x, y];
    const cx = (w - 1) / 2, cy = (h - 1) / 2, s = w / 2;
    const dx = (x - cx) / s, dy = (y - cy) / s, f = 1 + k1 * (dx * dx + dy * dy);
    return [cx + (dx / f) * s, cy + (dy / f) * s];
  }

  // ---------- image helpers ----------
  function lumaOf(frame) {
    const { data, width: w, height: h } = frame, n = w * h, L = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (data[j] + data[j + 1] + data[j + 2]) / 3;
    return L;
  }
  function histogram(L) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < L.length; i++) hist[L[i]]++;
    return hist;
  }
  function percentile(hist, total, p) {
    const want = total * p; let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
    return 255;
  }

  // Label blobs of luma >= thr; keep the largest by pixel count. Returns {best, mask}; mask holds 2 for every blob pixel.
  function bestBlob(L, w, h, thr, minArea) {
    const n = w * h, mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (L[i] >= thr) mask[i] = 1;
    const stack = new Int32Array(n);
    let best = null;
    for (let s = 0; s < n; s++) {
      if (mask[s] !== 1) continue;
      let sp = 0, count = 0, touches = false;
      let tl = s, br = s, tr = s, bl = s;
      let sumTL = Infinity, sumBR = -Infinity, difTR = -Infinity, difBL = Infinity;
      stack[sp++] = s; mask[s] = 2;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        count++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
        const sum = x + y, dif = x - y;
        if (sum < sumTL) { sumTL = sum; tl = p; }
        if (sum > sumBR) { sumBR = sum; br = p; }
        if (dif > difTR) { difTR = dif; tr = p; }
        if (dif < difBL) { difBL = dif; bl = p; }
        if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack[sp++] = p + w; }
      }
      if (count < minArea * (n / 76800) || (best && count <= best.pixels)) continue;
      const pt = (p) => [p % w, (p / w) | 0];
      best = { seed: s, pixels: count, touches, corners: [pt(tl), pt(tr), pt(br), pt(bl)] };
    }
    return { best, mask };
  }

  // Outer silhouette of the blob containing `seed`: leftmost/rightmost pixel per row and topmost/bottommost per
  // column (the inner edge of the ring never contributes). Points sit on the pixel boundary (half a pixel outward).
  // Also returns a luma histogram of the blob, for the half-brightness threshold.
  function silhouette(mask, L, seed, w, h) {
    const rowMin = new Int32Array(h).fill(w), rowMax = new Int32Array(h).fill(-1);
    const colMin = new Int32Array(w).fill(h), colMax = new Int32Array(w).fill(-1);
    const hist = new Uint32Array(256), stack = new Int32Array(w * h);
    let sp = 0, count = 0;
    stack[sp++] = seed; mask[seed] = 3;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      count++; hist[L[p]]++;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (y < colMin[x]) colMin[x] = y;
      if (y > colMax[x]) colMax[x] = y;
      if (x > 0 && mask[p - 1] === 2) { mask[p - 1] = 3; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] === 2) { mask[p + 1] = 3; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] === 2) { mask[p - w] = 3; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] === 2) { mask[p + w] = 3; stack[sp++] = p + w; }
    }
    const pts = [];
    for (let y = 0; y < h; y++) if (rowMax[y] >= 0) pts.push([rowMin[y] - 0.5, y], [rowMax[y] + 0.5, y]);
    for (let x = 0; x < w; x++) if (colMax[x] >= 0) pts.push([x, colMin[x] - 0.5], [x, colMax[x] + 0.5]);
    return { pts, hist, count };
  }

  // Total-least-squares line through points: {m: centre, d: unit direction, rms}.
  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(th), Math.sin(th)];
    let ss = 0;
    for (const p of pts) { const r = (p[0] - mx) * -d[1] + (p[1] - my) * d[0]; ss += r * r; }
    return { m: [mx, my], d, rms: Math.sqrt(ss / pts.length) };
  }
  function lineDist(line, p) { return (p[0] - line.m[0]) * -line.d[1] + (p[1] - line.m[1]) * line.d[0]; }
  // Line fit that drops outliers once (sharp spikes from noise or a stray bright pixel).
  function robustLine(pts) {
    let line = fitLine(pts);
    const lim = Math.max(2.5 * line.rms, 0.75);
    const keep = pts.filter((p) => Math.abs(lineDist(line, p)) <= lim);
    if (keep.length >= 8 && keep.length < pts.length) line = fitLine(keep);
    return line;
  }
  function intersect(a, b) {
    const det = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(det) < 1e-6) return null;
    const dx = b.m[0] - a.m[0], dy = b.m[1] - a.m[1];
    const t = (dx * b.d[1] - dy * b.d[0]) / det;
    return [a.m[0] + t * a.d[0], a.m[1] + t * a.d[1]];
  }

  // Split silhouette points into the four sides by nearest chord of the rough corner quad, ignoring the
  // ends of each side (corner rounding). Rough corners are [tl, tr, br, bl].
  function splitSides(pts, rough) {
    const sides = [[], [], [], []];
    for (const [x, y] of pts) {
      let bd = Infinity, bi = 0, bt = 0;
      for (let i = 0; i < 4; i++) {
        const a = rough[i], b = rough[(i + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
        const d = Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / Math.sqrt(L2);
        if (d < bd) { bd = d; bi = i; bt = t; }
      }
      if (bt > 0.12 && bt < 0.88) sides[bi].push([x, y]);
    }
    return sides;
  }

  // Corners from four fitted side lines (points already undistorted), or null if the geometry is degenerate.
  function cornersFromSides(sides, roughU) {
    if (sides.some((s) => s.length < 8)) return null;
    const L = sides.map(robustLine);
    const c = [intersect(L[3], L[0]), intersect(L[0], L[1]), intersect(L[1], L[2]), intersect(L[2], L[3])];   // tl tr br bl
    if (c.some((p) => !p)) return null;
    const diag = Math.hypot(roughU[2][0] - roughU[0][0], roughU[2][1] - roughU[0][1]);
    for (let i = 0; i < 4; i++) if (Math.hypot(c[i][0] - roughU[i][0], c[i][1] - roughU[i][1]) > 0.2 * diag) return null;
    return c;
  }

  // Everything up to the silhouette, at one threshold. {ok:true, ...} or {ok:false, fail, thr}.
  function analyse(L, w, h, thr, o) {
    const { best, mask } = bestBlob(L, w, h, thr, o.minArea);
    if (!best) return { ok: false, fail: 'nothing', thr };
    if (best.touches) return { ok: false, fail: 'edge', thr };
    // A border is a thin ring, so pixels fill well under the quad; a lamp or merged game content is solid.
    const area = polyArea(best.corners);
    if (area < 0.01 * w * h) return { ok: false, fail: 'nothing', thr };
    if (best.pixels / area > 0.7) return { ok: false, fail: 'solid', thr };
    return { ok: true, best, sil: silhouette(mask, L, best.seed, w, h), thr, mask };   // mask: 3 = the chosen blob, 2 = other bright blobs
  }

  // Find the border in an RGBA frame. Returns {ok:true, best:{corners (rough), ...}, sil, thr, mask} or {ok:false, fail}.
  // With o.auto the threshold is chosen from the picture, trying several (a low one merges bright game content into
  // the border; a high one can miss a dim border): o.hint is tried first, then half-brightness of the picture's
  // peak, then a low one, then a high one. Without o.auto, o.threshold is used as given.
  function findBorder(frame, opts) {
    const o = Object.assign({ threshold: 200, minArea: 150, auto: false, hint: 0 }, opts);
    const { width: w, height: h } = frame, L = lumaOf(frame);
    if (!o.auto) return analyse(L, w, h, o.threshold, o);
    const hist = histogram(L), bg = percentile(hist, w * h, 0.5), peak0 = percentile(hist, w * h, 0.997);
    const clampT = (t) => Math.max(30, Math.min(235, t));
    const cands = [];
    for (const t of [o.hint, 0.5 * (peak0 + bg), bg + Math.max(25, 0.15 * (255 - bg)), 0.75 * peak0 + 0.25 * bg]) {
      if (t > 0 && !cands.some((c) => Math.abs(c - clampT(t)) < 6)) cands.push(clampT(t));
    }
    const fails = [];
    for (let i = 0; i < cands.length; i++) {
      let r = analyse(L, w, h, cands[i], o);
      if (!r.ok) { fails.push(r); continue; }
      if (!(o.hint && i === 0)) {
        // Refine at half-brightness between the room and the border's own peak: the edges then sit where the
        // picture changes fastest, so they don't creep with exposure or bloom.
        const peak = percentile(r.sil.hist, r.sil.count, 0.85), thr2 = clampT(0.5 * (peak + bg));
        if (Math.abs(thr2 - r.thr) > 6) { const b = analyse(L, w, h, thr2, o); if (b.ok) r = b; }
      }
      return r;
    }
    // Report the most informative failure: a solid blob, else a border cut off by the frame, else nothing bright.
    return fails.find((f) => f.fail === 'solid') || fails.find((f) => f.fail === 'edge') || fails[0] || { ok: false, fail: 'nothing' };
  }

  // Corners (undistorted pixels) and the per-side silhouette points (distorted), from a found border.
  function solveCorners(a, w, h, k1) {
    const rough = a.best.corners, roughU = rough.map(([x, y]) => undistortPt(x, y, k1, w, h));
    const sides = splitSides(a.sil.pts, rough);
    const fitted = cornersFromSides(sides.map((s) => s.map(([x, y]) => undistortPt(x, y, k1, w, h))), roughU);
    return { corners: fitted || roughU, fitted: !!fitted, sides };
  }

  // ---------- dropout bridging: follow the picture's motion when the border can't be solved ----------
  // Bright-pixel masks of a frame at 1/4 and 1/2 resolution (cheap), as point lists for matching.
  function smallMasks(frame, thr) {
    const { data, width: w, height: h } = frame, t3 = thr * 3, out = {};
    for (const step of [4, 2]) {
      const sw = Math.floor(w / step), sh = Math.floor(h / step), m = new Uint8Array(sw * sh), px = [], py = [];
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const p = ((y * step) * w + x * step) * 4;
        if (data[p] + data[p + 1] + data[p + 2] >= t3) { m[y * sw + x] = 1; px.push(x); py.push(y); }
      }
      out[step] = { m, sw, sh, px, py };
    }
    return out;
  }
  // How many of P's bright pixels land on bright pixels of C when shifted by (dx, dy).
  function hits(P, C, dx, dy) {
    let n = 0;
    for (let i = 0; i < P.px.length; i++) {
      const x = P.px[i] + dx, y = P.py[i] + dy;
      if (x >= 0 && x < C.sw && y >= 0 && y < C.sh && C.m[y * C.sw + x]) n++;
    }
    return n;
  }
  // Translation (full-resolution pixels) that carries the previous frame's bright pixels onto the current one's,
  // searched coarse-to-fine; null if there is too little to match or the match is poor.
  function matchShift(prev, cur, R) {
    const P4 = prev[4], C4 = cur[4];
    if (P4.px.length < 30 || C4.px.length < 30) return null;
    let best = -1, bx = 0, by = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const n = hits(P4, C4, dx, dy);
      if (n > best || (n === best && Math.abs(dx) + Math.abs(dy) < Math.abs(bx) + Math.abs(by))) { best = n; bx = dx; by = dy; }
    }
    if (best / P4.px.length < 0.45) return null;
    const P2 = prev[2], C2 = cur[2];
    let b2 = -1, fx = bx * 2, fy = by * 2;
    for (let dy = by * 2 - 2; dy <= by * 2 + 2; dy++) for (let dx = bx * 2 - 2; dx <= bx * 2 + 2; dx++) {
      const n = hits(P2, C2, dx, dy);
      if (n > b2) { b2 = n; fx = dx; fy = dy; }
    }
    return [fx * 2, fy * 2];
  }

  function createTracker(userOpts) {
    // alpha: 1 = no smoothing, lower = smoother but laggier. k1: lens distortion (negative = barrel).
    const o = Object.assign({ threshold: 200, minArea: 150, flipX: false, flipY: false, alpha: 0.6, jump: 0.15, auto: true, k1: 0, bridge: true, maxBridge: 30, searchR: 8 }, userOpts);
    let prev = null, lost = 0, pending = null, hint = 0, frames = 0;
    let prevFrame = null, prevMasks = null, lastH = null, goodH = null, shift = [0, 0], bridged = 0, noMatch = 0;
    const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const tracker = {
      opts: o,
      lastSides: null, lastSize: null, lastFitted: false, lastThreshold: 0, lastMask: null, lastFail: '',    // for the lens fit and diagnostics
      // Returns {valid, u, v, corners}; u,v are 0..1 across the screen, outside that range = off-screen.
      update(frame) {
        if (bridged) { prev = null; pending = null; }          // after a bridge the first real measurement is taken as is (no smoothing, no jump guard)
        const r = track(frame);
        const before = prevFrame; prevFrame = frame;
        if (r.valid) { bridged = 0; shift = [0, 0]; noMatch = 0; goodH = lastH; prevMasks = null; return r; }
        if (!(o.bridge && goodH && before && bridged < o.maxBridge)) { prevMasks = null; return r; }
        // Border lost: follow the picture's motion instead. Masks are built only now, so normal frames pay nothing.
        const thr = tracker.lastThreshold || 128, cur = smallMasks(frame, thr);
        const s = matchShift(prevMasks || smallMasks(before, thr), cur, o.searchR);
        prevMasks = cur;
        if (s) { shift[0] += s[0]; shift[1] += s[1]; noMatch = 0; } else if (++noMatch > 3) return r;   // nothing reliable to follow
        const w = frame.width, h = frame.height;
        // The scene moved by `shift` pixels, so the point now under the centre was at (centre - shift) before.
        let [px, py] = undistortPt((w - 1) / 2 - shift[0], (h - 1) / 2 - shift[1], o.k1, w, h);
        if (o.flipX) px = w - 1 - px;
        if (o.flipY) py = h - 1 - py;
        const [u, v] = applyH(goodH, px, py);
        bridged++; tracker.lastFail = 'bridged';
        return { valid: true, bridged: true, u, v, corners: null };
      },
    };
    function track(frame) {
        if (++frames % 30 === 0) hint = 0;                 // re-evaluate the threshold from scratch now and then
        const a = findBorder(frame, Object.assign({}, o, { hint }));
        if (!a.ok) { lost++; hint = 0; if (lost > 3) prev = null; tracker.lastMask = null; tracker.lastFail = a.fail; return { valid: false, u: 0, v: 0, corners: null }; }
        lost = 0; hint = a.thr; tracker.lastFail = '';
        const w = frame.width, h = frame.height;
        const sc = solveCorners(a, w, h, o.k1);
        tracker.lastSides = sc.sides; tracker.lastSize = [w, h]; tracker.lastFitted = sc.fitted; tracker.lastThreshold = a.thr; tracker.lastMask = a.mask;
        let corners = sc.corners.map(([x, y]) => [o.flipX ? w - 1 - x : x, o.flipY ? h - 1 - y : y]);
        if (o.flipX) corners = [corners[1], corners[0], corners[3], corners[2]];
        if (o.flipY) corners = [corners[3], corners[2], corners[1], corners[0]];
        const H = solveHomography(corners, unit);
        if (!H) return { valid: false, u: 0, v: 0, corners: null };
        lastH = H;
        let [u, v] = applyH(H, (w - 1) / 2, (h - 1) / 2);
        // Jump guard: a leap bigger than o.jump in one frame is held once, and accepted only if the next frame agrees.
        if (prev && Math.hypot(u - prev[0], v - prev[1]) > o.jump) {
          if (pending && Math.hypot(u - pending[0], v - pending[1]) < o.jump / 2) { prev = null; pending = null; }   // real move: follow it, unsmoothed
          else { pending = [u, v]; return { valid: true, u: prev[0], v: prev[1], held: true, corners: a.best.corners }; }
        } else pending = null;
        if (prev) {
          const d = Math.hypot(u - prev[0], v - prev[1]);
          const al = Math.min(1, o.alpha + d * 30);   // smooth jitter when still, follow fast moves
          u = prev[0] + (u - prev[0]) * al;
          v = prev[1] + (v - prev[1]) * al;
        }
        prev = [u, v];
        return { valid: true, u, v, corners: a.best.corners, fitted: sc.fitted };
    }
    return tracker;
  }

  // ---------- lens fit: pick the k1 that makes the border's edges straight ----------
  // samples: [{sides: [pts x4] (distorted pixels), w, h}], as collected from tracker.lastSides.
  function lensRms(samples, k1) {
    let ss = 0, n = 0;
    for (const sm of samples) for (const side of sm.sides) {
      if (side.length < 8) continue;
      const u = side.map(([x, y]) => undistortPt(x, y, k1, sm.w, sm.h)), line = fitLine(u);
      for (const p of u) { const r = Math.min(3, Math.abs(lineDist(line, p))); ss += r * r; n++; }   // capped: a few bad points mustn't steer the fit
    }
    return n ? Math.sqrt(ss / n) : Infinity;
  }
  function fitLens(samples) {
    let best = { k1: 0, rms: Infinity };
    for (let k = -0.7; k <= 0.3001; k += 0.02) { const r = lensRms(samples, k); if (r < best.rms) best = { k1: k, rms: r }; }
    let lo = best.k1 - 0.02, hi = best.k1 + 0.02;                     // golden-section refinement
    const g = 0.381966;
    let a = lo + g * (hi - lo), b = hi - g * (hi - lo), fa = lensRms(samples, a), fb = lensRms(samples, b);
    for (let i = 0; i < 25; i++) {
      if (fa < fb) { hi = b; b = a; fb = fa; a = lo + g * (hi - lo); fa = lensRms(samples, a); }
      else { lo = a; a = b; fa = fb; b = hi - g * (hi - lo); fb = lensRms(samples, b); }
    }
    const k1 = (lo + hi) / 2;
    return { k1, rms: lensRms(samples, k1), rms0: lensRms(samples, 0) };
  }

  const api = { createTracker, findBorder, solveHomography, applyH, undistortPt, fitLens, lensRms };
  if (typeof module !== 'undefined') module.exports = api;
  root.SindenTracker = api;
};
__sindenFactory(typeof window !== 'undefined' ? window : globalThis);
if (typeof window !== 'undefined') window.SindenTracker.__factory = __sindenFactory;   // lets the game rebuild the tracker inside a worker

// Point Blank-style mode: a run of short, silly shooting challenges. Clear a stage to score, fail
// and lose a life; three lives. After all eight stages the loop restarts, faster and smaller.
// Plugs into the engine in game.js through window.Engine. Positions are fractions of the playfield
// (fx across its width, fy down its height); sizes are fractions of its height.
(() => {
  'use strict';
  const E = window.Engine;
  const { rnd, clamp, text, sfx, addParts, pop } = E;
  const px = (fx) => E.F.x + fx * E.F.w;
  const py = (fy) => E.F.y + fy * E.F.h;
  const rad = (r) => r * E.F.h;
  const dist = (a, x, y) => Math.hypot(a.x - x, a.y - y);          // aim (pixels) to a point (pixels)
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const TAU = Math.PI * 2;

  // ---------- shared drawing ----------
  function backdrop(top, bottom, floor) {
    const { ctx, F } = E, g = ctx.createLinearGradient(0, F.y, 0, F.y + F.h);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g; ctx.fillRect(F.x, F.y, F.w, F.h);
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    for (let i = 0; i < 16; i++) if (i % 2) ctx.fillRect(F.x + (F.w / 16) * i, F.y, F.w / 16, F.h);
    if (floor) { ctx.fillStyle = floor; ctx.fillRect(F.x, py(0.9), F.w, F.h * 0.1); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(F.x, py(0.9), F.w, F.h * 0.012); }
  }
  function disc(x, y, r, c, ring) {
    const { ctx } = E; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = Math.max(2, r * 0.12); ctx.stroke(); }
  }
  function bullseye(x, y, r) { E.drawBulls(x, y, r); }
  function number(n, x, y, r, c = '#fff') { text(String(n), x, y + r * 0.04, r * 1.15, c); }
  function heart(x, y, s, on) {
    const { ctx } = E; ctx.fillStyle = on ? '#ff4d6d' : 'rgba(255,255,255,.2)';
    ctx.beginPath(); ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x - s, y - s * 0.3, x - s * 0.5, y - s * 0.95, x, y - s * 0.4);
    ctx.bezierCurveTo(x + s * 0.5, y - s * 0.95, x + s, y - s * 0.3, x, y + s * 0.35); ctx.fill();
  }
  const colourHex = { red: '#ff4d4d', blue: '#4d8dff', green: '#4dd66b', yellow: '#ffd84a' };

  // ---------- the challenges ----------
  // Each factory takes the difficulty (lv: 0, 1, 2, ...) and returns
  //   {time, update(dt), draw(tm), shot(a), status() -> 'win'|'lose'|null, timeout() -> 'win'|'lose',
  //    bot() -> {x, y} pixel position a perfect player would shoot, or null, theme: [top, bottom, floor]}
  // `speed` and `size` scale with level so later loops get harder.
  const speedOf = (lv) => 1 + 0.22 * lv, sizeOf = (lv) => Math.pow(0.93, lv);

  function range(lv) {                        // targets pop up and vanish: hit enough of them
    const need = 8 + lv, life = 2.1 / speedOf(lv), size = 0.085 * sizeOf(lv);
    const s = { time: 14, theme: ['#1b2a4e', '#0c1228', '#2a3558'], hits: 0, t: [], spawn: 0.3 };
    s.update = (dt) => {
      s.spawn -= dt;
      if (s.spawn <= 0 && s.t.filter((t) => !t.dead).length < 3) {
        for (let k = 0; k < 12; k++) {
          const c = { x: rnd(0.14, 0.86), y: rnd(0.3, 0.78), age: 0, dead: false, anim: 0 };
          if (s.t.every((o) => o.dead || Math.hypot((o.x - c.x) * E.F.w, (o.y - c.y) * E.F.h) > rad(size * 2.4))) { s.t.push(c); break; }
        }
        s.spawn = 0.55 / speedOf(lv);
      }
      for (const t of s.t) { t.age += dt; if (t.dead) t.anim += dt; else if (t.age > life) { t.dead = true; t.gone = true; } }
      s.t = s.t.filter((t) => t.anim < 0.3);
    };
    s.draw = () => {
      for (const t of s.t) {
        const x = px(t.x), y = py(t.y), r = rad(size) * (t.dead ? 1 + t.anim * 2 : Math.min(1, t.age * 8));
        E.ctx.globalAlpha = t.dead ? 1 - t.anim / 0.3 : 1; bullseye(x, y, r);
        if (!t.dead) { E.ctx.strokeStyle = '#ffe27a'; E.ctx.lineWidth = 4; E.ctx.beginPath(); E.ctx.arc(x, y, r * 1.18, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - t.age / life)); E.ctx.stroke(); }
        E.ctx.globalAlpha = 1;
      }
      text(`${s.hits} / ${need}`, px(0.5), py(0.17), E.F.h * 0.09, '#ffe27a');
    };
    s.shot = (a) => {
      for (const t of s.t) if (!t.dead && dist(a, px(t.x), py(t.y)) <= rad(size) * 1.1) {
        t.dead = true; s.hits++; sfx.bullseye(); addParts(px(t.x), py(t.y), '#ff4d4d', 14); pop(px(t.x), py(t.y), '+100'); return 100;
      }
      return 0;
    };
    s.status = () => (s.hits >= need ? 'win' : null);
    s.timeout = () => 'lose';
    s.bot = () => { const t = s.t.find((o) => !o.dead); return t && { x: px(t.x), y: py(t.y) }; };
    return s;
  }

  function cans(lv) {                         // a pyramid of cans, limited ammo, slowly sliding
    const size = 0.055 * sizeOf(lv), rows = [4, 3, 2, 1], list = [];
    rows.forEach((n, ri) => { for (let i = 0; i < n; i++) list.push({ ox: (i - (n - 1) / 2) * 1.15, oy: -ri * 1.15, vx: 0, vy: 0, rot: 0, down: false, t: 0 }); });
    const s = { time: 13, theme: ['#3a2a1a', '#1c120a', '#5a3c20'], ammo: list.length + 4, cans: list, phase: 0 };
    const pos = (c, tm) => ({ x: px(0.5 + Math.sin(s.phase) * 0.14 * Math.min(1, 0.4 + 0.2 * lv)) + c.ox * rad(size) * 2, y: py(0.78) + c.oy * rad(size) * 2 });
    s.update = (dt) => {
      s.phase += dt * 1.1 * speedOf(lv);
      if (s.ammo <= 0) s.dry = (s.dry || 0) + dt;
      for (const c of s.cans) if (c.down) { c.t += dt; c.fx += c.vx * dt; c.fy += c.vy * dt; c.vy += 1800 * dt; c.rot += c.vx * dt * 0.02; }
    };
    s.draw = () => {
      const { ctx } = E;
      ctx.fillStyle = '#6b4526'; ctx.fillRect(px(0.2), py(0.78) + rad(size) * 1.1, E.F.w * 0.6, rad(0.03));
      for (const c of s.cans) {
        const p = c.down ? { x: c.fx, y: c.fy } : pos(c), r = rad(size);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(c.rot);
        ctx.fillStyle = '#d9d9e0'; ctx.fillRect(-r, -r * 1.05, r * 2, r * 2.1);
        ctx.fillStyle = '#d6453a'; ctx.fillRect(-r, -r * 0.45, r * 2, r * 0.9);
        ctx.fillStyle = '#9a9aa4'; ctx.fillRect(-r, -r * 1.05, r * 2, r * 0.18); ctx.fillRect(-r, r * 0.87, r * 2, r * 0.18);
        ctx.restore();
      }
      text(`${s.cans.filter((c) => !c.down).length} cans left`, px(0.5), py(0.14), E.F.h * 0.07, '#ffe27a');
      for (let i = 0; i < s.ammo; i++) { E.ctx.fillStyle = '#ffd84a'; E.ctx.fillRect(px(0.06) + i * E.F.h * 0.03, py(0.93), E.F.h * 0.015, E.F.h * 0.045); }
    };
    s.shot = (a) => {
      if (s.ammo <= 0) { sfx.empty(); return 0; }
      s.ammo--;
      for (const c of s.cans) if (!c.down) {
        const p = pos(c);
        if (Math.abs(a.x - p.x) <= rad(size) * 1.05 && Math.abs(a.y - p.y) <= rad(size) * 1.15) {
          c.down = true; c.fx = p.x; c.fy = p.y; c.vx = rnd(-500, 500); c.vy = rnd(-900, -500);
          sfx.hit(); addParts(p.x, p.y, '#d6453a', 10); pop(p.x, p.y, '+50'); return 50;
        }
      }
      return 0;
    };
    s.status = () => (s.cans.every((c) => c.down) ? 'win' : (s.dry || 0) > 1.0 ? 'lose' : null);   // out of ammo with cans left
    s.timeout = () => 'lose';
    s.bot = () => { const c = s.cans.find((o) => !o.down); return c && s.ammo > 0 ? pos(c) : null; };
    return s;
  }

  function balloons(lv) {                     // pop the coloured balloons, not the black bombs
    const need = 10 + lv, size = 0.075 * sizeOf(lv), list = [];
    const s = { time: 15, theme: ['#2a63a8', '#9fd0f5', null], list, pops: 0, strikes: 0, spawn: 0.2 };
    s.update = (dt) => {
      s.spawn -= dt;
      if (s.spawn <= 0) {
        list.push({ x: rnd(0.12, 0.88), y: 1.1, vy: -rnd(0.2, 0.3) * speedOf(lv), ph: rnd(0, 6), bomb: Math.random() < 0.18, col: pick(['#ff4d4d', '#ffd84a', '#4d8dff', '#4dd66b', '#ff8ad8']), dead: false, t: 0 });
        s.spawn = rnd(0.35, 0.6) / speedOf(lv);
      }
      for (const b of list) { if (b.dead) b.t += dt; else { b.y += b.vy * dt; b.ph += dt * 2; } }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].y < -0.15 || list[i].t > 0.25) list.splice(i, 1);
    };
    const bp = (b) => ({ x: px(b.x + Math.sin(b.ph) * 0.02), y: py(b.y) });
    s.draw = () => {
      const { ctx } = E;
      for (const b of list) {
        if (b.dead) continue;
        const p = bp(b), r = rad(size);
        ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y + r * 1.15); ctx.quadraticCurveTo(p.x + r * 0.3, p.y + r * 2, p.x, p.y + r * 2.6); ctx.stroke();
        ctx.fillStyle = b.bomb ? '#1a1a22' : b.col; ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 0.88, r * 1.1, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.ellipse(p.x - r * 0.3, p.y - r * 0.4, r * 0.18, r * 0.3, 0.5, 0, TAU); ctx.fill();
        if (b.bomb) text('X', p.x, p.y, r * 0.9, '#ff5a5a');
      }
      text(`${s.pops} / ${need}`, px(0.5), py(0.12), E.F.h * 0.09, '#fff');
      for (let i = 0; i < 2; i++) heart(px(0.92) - i * E.F.h * 0.07, py(0.1), E.F.h * 0.03, i >= s.strikes);
    };
    s.shot = (a) => {
      let best = null;
      for (const b of list) if (!b.dead) { const p = bp(b); if (Math.hypot(a.x - p.x, (a.y - p.y) * 0.85) <= rad(size) * 1.0 && (!best || b.y > best.y)) best = b; }
      if (!best) return 0;
      const p = bp(best); best.dead = true;
      if (best.bomb) { s.strikes++; sfx.bomb(); E.shake(0.7); addParts(p.x, p.y, '#ff7a1a', 22, 320); pop(p.x, p.y, 'BOMB!', '#ff6b6b'); return -50; }
      s.pops++; sfx.hit(); addParts(p.x, p.y, best.col, 12); pop(p.x, p.y, '+50'); return 50;
    };
    s.status = () => (s.pops >= need ? 'win' : s.strikes >= 2 ? 'lose' : null);
    s.timeout = () => 'lose';
    s.bot = () => { const b = list.filter((o) => !o.dead && !o.bomb && o.y < 0.95 && o.y > 0.15).sort((p, q) => p.y - q.y)[0]; return b && bp(b); };
    return s;
  }

  function skeet(lv) {                        // clay pigeons on arcs
    const total = 10, need = 7 + Math.min(2, lv), size = 0.05 * sizeOf(lv), discs = [];
    const s = { time: 18, theme: ['#f0a048', '#f7d9a0', '#4a7a3a'], discs, launched: 0, hits: 0, missed: 0, spawn: 0.6 };
    s.update = (dt) => {
      s.spawn -= dt;
      if (s.spawn <= 0 && s.launched < total) {
        const left = Math.random() < 0.5;
        discs.push({ x: left ? 0.02 : 0.98, y: rnd(0.65, 0.85), vx: (left ? 1 : -1) * rnd(0.34, 0.46) * speedOf(lv), vy: -rnd(0.75, 0.95), rot: 0, dead: false, t: 0 });
        s.launched++; s.spawn = rnd(1.0, 1.5) / speedOf(lv);
      }
      for (const d of discs) {
        if (d.dead) { d.t += dt; continue; }
        d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 0.9 * dt; d.rot += dt * 9;
        if (d.y > 0.95 || d.x < -0.1 || d.x > 1.1) { d.dead = true; d.gone = true; d.t = 9; s.missed++; }
      }
      for (let i = discs.length - 1; i >= 0; i--) if (discs[i].t > 0.4) discs.splice(i, 1);
    };
    s.draw = () => {
      const { ctx } = E;
      for (const d of discs) {
        if (d.dead) continue;
        ctx.save(); ctx.translate(px(d.x), py(d.y)); ctx.rotate(0.3);
        ctx.fillStyle = '#d2531b'; ctx.beginPath(); ctx.ellipse(0, 0, rad(size) * 1.4, rad(size) * (0.5 + 0.2 * Math.sin(d.rot)), 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ff9a55'; ctx.beginPath(); ctx.ellipse(0, -rad(size) * 0.1, rad(size) * 0.9, rad(size) * 0.25, 0, 0, TAU); ctx.fill(); ctx.restore();
      }
      text(`${s.hits} hit   ${s.launched}/${total} launched`, px(0.5), py(0.1), E.F.h * 0.06, '#5a2a0a');
    };
    s.shot = (a) => {
      for (const d of discs) if (!d.dead && Math.hypot(a.x - px(d.x), (a.y - py(d.y)) * 0.7) <= rad(size) * 1.5) {
        d.dead = true; s.hits++; sfx.hit(); addParts(px(d.x), py(d.y), '#ff9a55', 16, 300); pop(px(d.x), py(d.y), '+100'); return 100;
      }
      return 0;
    };
    s.status = () => (s.missed > total - need ? 'lose' : s.hits >= need ? 'win' : null);
    s.timeout = () => (s.hits >= need ? 'win' : 'lose');
    s.bot = () => { const d = discs.find((o) => !o.dead && o.y < 0.85 && o.x > 0 && o.x < 1); return d && { x: px(d.x), y: py(d.y) }; };
    return s;
  }

  function numbers(lv) {                      // shoot 1..n in order
    const n = Math.min(12, 9 + lv), size = 0.065 * sizeOf(lv), dots = [];
    for (let i = 1; i <= n; i++) {
      for (let k = 0; k < 200; k++) {
        const c = { n: i, x: rnd(0.12, 0.88), y: rnd(0.22, 0.82), done: false, t: 0 };
        if (dots.every((o) => Math.hypot((o.x - c.x) * E.F.w, (o.y - c.y) * E.F.h) > rad(size * 2.4))) { dots.push(c); break; }
      }
    }
    const s = { time: 12, theme: ['#14391f', '#0a1e11', '#1f5230'], dots, next: 1, bonusTime: 0 };
    s.update = (dt) => { for (const d of dots) if (d.done) d.t += dt; };
    s.draw = () => {
      for (const d of dots) {
        const x = px(d.x), y = py(d.y), r = rad(size);
        if (d.done) { E.ctx.globalAlpha = Math.max(0, 1 - d.t * 4); disc(x, y, r * (1 + d.t * 2), '#7dffb0'); E.ctx.globalAlpha = 1; continue; }
        disc(x, y, r, d.n === s.next ? '#ffe27a' : '#e8e8ee', d.n === s.next ? '#ff9b3a' : '#7a7a88'); number(d.n, x, y, r, '#1a1a22');
      }
      text(`next: ${Math.min(s.next, n)}`, px(0.5), py(0.1), E.F.h * 0.07, '#ffe27a');
    };
    s.shot = (a) => {
      for (const d of dots) if (!d.done && dist(a, px(d.x), py(d.y)) <= rad(size) * 1.1) {
        if (d.n === s.next) { d.done = true; s.next++; sfx.bullseye(); addParts(px(d.x), py(d.y), '#7dffb0', 10); pop(px(d.x), py(d.y), '+100'); return 100; }
        s.penalty = 1; sfx.empty(); E.shake(0.4); pop(px(d.x), py(d.y), '-1s', '#ff6b6b'); return -25;
      }
      return 0;
    };
    s.status = () => (s.next > n ? 'win' : null);
    s.timeout = () => 'lose';
    s.bot = () => { const d = dots.find((o) => o.n === s.next); return d && { x: px(d.x), y: py(d.y) }; };
    return s;
  }

  function bandits(lv) {                      // quick draw: bandits yes, civilians no
    const total = 10, size = 0.2, wins = [0.2, 0.5, 0.8], pops = [];
    const s = { time: 26, theme: ['#c88a4a', '#7a4a22', '#5a3416'], pops, count: 0, strikes: 0, spawn: 0.7, civ: false, resolved: 0 };
    const life = 1.5 / speedOf(lv);
    // A fixed mix (7 bandits, 3 civilians) in random order, so doing nothing can never win by luck.
    const seq = [...Array(7).fill(true), ...Array(total - 7).fill(false)].sort(() => Math.random() - 0.5);
    s.update = (dt) => {
      s.spawn -= dt;
      if (s.spawn <= 0 && s.count < total) {
        const free = wins.map((_, i) => i).filter((i) => !pops.some((p) => p.w === i && !p.gone));
        if (free.length) { pops.push({ w: pick(free), bandit: seq[s.count], t: 0, dead: false, fired: false, gone: false }); s.count++; }
        s.spawn = rnd(0.7, 1.1) / speedOf(lv);
      }
      for (const p of pops) {
        p.t += dt;
        if (p.gone) continue;                              // already counted: it only lingers while it is removed
        if (p.dead) { if (p.t > p.deadAt + 0.5) p.gone = true; continue; }
        if (p.t > life) { p.gone = true; if (p.bandit) { s.strikes++; p.fired = true; sfx.bomb(); E.shake(0.5); pop(px(wins[p.w]), py(0.45), 'OUCH!', '#ff6b6b'); } s.resolved++; }
      }
      for (let i = pops.length - 1; i >= 0; i--) if (pops[i].gone && pops[i].t > life + 0.4) pops.splice(i, 1);
    };
    const figure = (p) => { const rise = Math.min(1, (p.dead ? p.deadAt : p.t) * 5); return { x: px(wins[p.w]), y: py(0.62) - rad(0.12) * rise + (p.dead ? rad(0.25) * Math.min(1, (p.t - p.deadAt) * 3) : 0) }; };
    s.draw = () => {
      const { ctx } = E;
      for (let i = 0; i < 3; i++) {   // windows with a figure behind the sill
        const x = px(wins[i]), w = rad(0.3), top = py(0.3);
        ctx.fillStyle = '#1a0f08'; ctx.fillRect(x - w / 2, top, w, rad(0.45));
        for (const p of pops) if (p.w === i && !p.gone) {
          const f = figure(p), r = rad(0.1);
          ctx.save(); ctx.beginPath(); ctx.rect(x - w / 2, top, w, rad(0.45)); ctx.clip();
          disc(f.x, f.y - r * 0.9, r * 0.55, '#f3c9a0');                                 // head
          ctx.fillStyle = p.bandit ? '#7a1f1f' : '#2f5fa8'; ctx.fillRect(f.x - r * 0.8, f.y - r * 0.4, r * 1.6, r * 2);  // body
          ctx.fillStyle = p.bandit ? '#2a1a14' : '#e8e0c0'; ctx.fillRect(f.x - r * 0.85, f.y - r * 1.45, r * 1.7, r * 0.22); ctx.fillRect(f.x - r * 0.45, f.y - r * 1.75, r * 0.9, r * 0.35);   // hat
          if (p.bandit) { ctx.fillStyle = '#1a1a22'; ctx.fillRect(f.x - r * 0.4, f.y - r * 0.95, r * 0.8, r * 0.18); }   // mask
          ctx.restore();
        }
        ctx.fillStyle = '#4a2a14'; ctx.fillRect(x - w / 2 - rad(0.02), top + rad(0.45), w + rad(0.04), rad(0.04));
      }
      text(`${s.resolved + 0}/${total} done`, px(0.5), py(0.12), E.F.h * 0.06, '#fff');
      for (let i = 0; i < 3; i++) heart(px(0.9) - i * E.F.h * 0.07, py(0.1), E.F.h * 0.03, i >= s.strikes);
    };
    s.shot = (a) => {
      for (const p of pops) {
        if (p.dead || p.gone) continue;
        const f = figure(p);
        if (Math.abs(a.x - f.x) <= rad(0.14) && a.y > f.y - rad(0.3) && a.y < f.y + rad(0.5) && a.y > py(0.3)) {
          p.dead = true; p.deadAt = p.t; s.resolved++;
          if (p.bandit) { sfx.hit(); addParts(f.x, f.y, '#ffd84a', 12); pop(f.x, f.y - rad(0.1), '+100'); return 100; }
          s.civ = true; sfx.bomb(); E.shake(1); pop(f.x, f.y - rad(0.1), 'CIVILIAN!', '#ff6b6b'); return -200;
        }
      }
      return 0;
    };
    s.status = () => (s.civ ? 'lose' : s.strikes >= 3 ? 'lose' : s.resolved >= total ? 'win' : null);
    s.timeout = () => 'lose';
    s.bot = () => { const p = pops.find((o) => o.bandit && !o.dead && !o.gone && o.t > 0.25); if (!p) return null; const f = figure(p); return { x: f.x, y: f.y - rad(0.05) }; };
    return s;
  }

  function robot(lv) {                        // boss: only the glowing core hurts it
    const maxHp = 8 + 2 * lv, s = { time: 17, theme: ['#2b1a4a', '#12081f', '#3a2a5a'], hp: maxHp, t: 0 };
    const open = () => (s.t % (2.2 / speedOf(lv))) > (1.0 / speedOf(lv));    // core is exposed in a repeating window
    const body = () => ({ x: px(0.5 + Math.sin(s.t * 0.9 * speedOf(lv)) * 0.22), y: py(0.5 + Math.sin(s.t * 1.7) * 0.03) });
    s.update = (dt) => { s.t += dt; };
    s.draw = () => {
      const { ctx } = E, b = body(), r = rad(0.2 * sizeOf(lv));
      ctx.fillStyle = '#7a7a96'; ctx.fillRect(b.x - r * 0.9, b.y - r * 0.9, r * 1.8, r * 1.9);                  // torso
      ctx.fillStyle = '#9a9ab8'; ctx.fillRect(b.x - r * 0.55, b.y - r * 1.55, r * 1.1, r * 0.7);                // head
      disc(b.x - r * 0.2, b.y - r * 1.2, r * 0.1, '#ff4d4d'); disc(b.x + r * 0.2, b.y - r * 1.2, r * 0.1, '#ff4d4d');
      ctx.fillStyle = '#5a5a76'; ctx.fillRect(b.x - r * 1.5, b.y - r * 0.7, r * 0.55, r * 1.4); ctx.fillRect(b.x + r * 0.95, b.y - r * 0.7, r * 0.55, r * 1.4);   // arms
      const o = open(); disc(b.x, b.y + r * 0.15, r * 0.34, o ? '#7dffb0' : '#3a3a4e', o ? '#fff' : '#22222e');
      if (o) { ctx.globalAlpha = 0.25 + 0.2 * Math.sin(s.t * 20); disc(b.x, b.y + r * 0.15, r * 0.6, '#7dffb0'); ctx.globalAlpha = 1; }
      const w = E.F.w * 0.4; ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(px(0.5) - w / 2, py(0.145), w, E.F.h * 0.035);
      ctx.fillStyle = '#ff4d6d'; ctx.fillRect(px(0.5) - w / 2, py(0.145), w * (s.hp / maxHp), E.F.h * 0.035);
      text('ROBOT', px(0.5), py(0.11), E.F.h * 0.04, '#cfc3ee');
    };
    s.shot = (a) => {
      const b = body(), r = rad(0.2 * sizeOf(lv)), cx = b.x, cy = b.y + r * 0.15;
      if (open() && dist(a, cx, cy) <= r * 0.42) { s.hp--; sfx.bullseye(); E.shake(0.5); addParts(cx, cy, '#7dffb0', 14); pop(cx, cy, 'HIT!', '#7dffb0'); return 150; }
      if (Math.abs(a.x - b.x) <= r * 1.6 && Math.abs(a.y - b.y) <= r * 1.6) { sfx.empty(); addParts(a.x, a.y, '#ffd84a', 5, 120); return 0; }   // armour: sparks only
      return 0;
    };
    s.status = () => (s.hp <= 0 ? 'win' : null);
    s.timeout = () => 'lose';
    s.bot = () => { if (!open()) return null; const b = body(); return { x: b.x, y: b.y + rad(0.2 * sizeOf(lv)) * 0.15 }; };
    return s;
  }

  function colours(lv) {                      // shoot only the colour on the sign
    const need = 8 + lv, size = 0.07 * sizeOf(lv), names = Object.keys(colourHex), balls = [];
    const s = { time: 16, theme: ['#1c1c3a', '#0b0b1c', '#2a2a52'], balls, want: pick(names), swap: 4, good: 0 };
    const spawn = () => {
      const c = pick(names);
      balls.push({ x: rnd(0.15, 0.85), y: rnd(0.3, 0.8), vx: rnd(-0.18, 0.18) * speedOf(lv), vy: rnd(-0.18, 0.18) * speedOf(lv), c, dead: false, t: 0 });
    };
    for (let i = 0; i < 7; i++) spawn();
    s.update = (dt) => {
      s.swap -= dt;
      if (s.swap <= 0) { s.want = pick(names.filter((n) => n !== s.want)); s.swap = 3.5; sfx.reload(); }
      for (const b of balls) {
        if (b.dead) { b.t += dt; continue; }
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.x < 0.1 || b.x > 0.9) { b.vx *= -1; b.x = clamp(b.x, 0.1, 0.9); }
        if (b.y < 0.25 || b.y > 0.85) { b.vy *= -1; b.y = clamp(b.y, 0.25, 0.85); }
      }
      for (let i = balls.length - 1; i >= 0; i--) if (balls[i].t > 0.3) { balls.splice(i, 1); spawn(); }
      if (!balls.some((b) => !b.dead && b.c === s.want)) { const o = balls.find((b) => !b.dead); if (o) o.c = s.want; }   // there is always one to shoot
    };
    s.draw = () => {
      for (const b of balls) {
        const x = px(b.x), y = py(b.y), r = rad(size);
        E.ctx.globalAlpha = b.dead ? Math.max(0, 1 - b.t * 4) : 1; disc(x, y, r * (b.dead ? 1 + b.t * 2 : 1), colourHex[b.c], '#fff'); E.ctx.globalAlpha = 1;
      }
      const w = E.F.w * 0.34, x = px(0.5), y = py(0.12);
      E.ctx.fillStyle = 'rgba(0,0,0,.55)'; E.ctx.fillRect(x - w / 2, y - E.F.h * 0.055, w, E.F.h * 0.11);
      text(`SHOOT ${s.want.toUpperCase()}`, x, y, E.F.h * 0.07, colourHex[s.want]);
      text(`${s.good} / ${need}`, px(0.1), py(0.1), E.F.h * 0.06, '#fff', 'left');
    };
    s.shot = (a) => {
      for (const b of balls) if (!b.dead && dist(a, px(b.x), py(b.y)) <= rad(size) * 1.1) {
        b.dead = true;
        if (b.c === s.want) { s.good++; sfx.hit(); addParts(px(b.x), py(b.y), colourHex[b.c], 12); pop(px(b.x), py(b.y), '+100'); return 100; }
        s.penalty = 1; sfx.empty(); E.shake(0.4); pop(px(b.x), py(b.y), '-1s', '#ff6b6b'); return -25;
      }
      return 0;
    };
    s.status = () => (s.good >= need ? 'win' : null);
    s.timeout = () => 'lose';
    s.bot = () => { const b = balls.find((o) => !o.dead && o.c === s.want); return b && { x: px(b.x), y: py(b.y) }; };
    return s;
  }

  const GAMES = [
    { id: 'range', name: 'SHOOTING RANGE', hint: 'Shoot the targets before they vanish!', make: range },
    { id: 'cans', name: 'CAN CRUSH', hint: 'Knock down every can. Ammo is limited!', make: cans },
    { id: 'balloons', name: 'BALLOON POP', hint: 'Pop the balloons. Avoid the bombs!', make: balloons },
    { id: 'skeet', name: 'CLAY PIGEONS', hint: 'Hit the flying clays!', make: skeet },
    { id: 'numbers', name: 'IN ORDER', hint: 'Shoot the numbers 1, 2, 3...', make: numbers },
    { id: 'bandits', name: 'HIGH NOON', hint: 'Shoot bandits fast. Spare the civilians!', make: bandits },
    { id: 'robot', name: 'ROBOT BOSS', hint: 'Only the glowing core hurts it!', make: robot },
    { id: 'colours', name: 'COLOUR CODE', hint: 'Shoot only the colour on the sign!', make: colours },
  ];

  // ---------- the run: intro card -> play -> result, three lives ----------
  const R = { phase: 'idle', t: 0, order: [], idx: 0, lives: 3, score: 0, stage: 0, lv: 0, game: null, def: null, left: 0, shots: 0, hits: 0, resultKind: '', best: E.store.get('best.pointblank', 0), newBest: false, flash: 0 };

  function nextOrder() { const o = GAMES.map((_, i) => i); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; }
  function start() {
    Object.assign(R, { lives: 3, score: 0, stage: 0, lv: 0, order: R.fixedOrder || nextOrder(), idx: 0, shots: 0, hits: 0, newBest: false });
    if (!R.fixedOrder) R.order[R.order.indexOf(0)] = R.order[0], R.order[0] = 0;   // always open with the shooting range
    intro();
  }
  function intro() {
    R.def = GAMES[R.order[R.idx]]; R.game = R.def.make(R.lv); R.left = R.game.time; R.phase = 'intro'; R.t = 0; R.stage++;
    sfx.reload();
  }
  function finish(kind) {
    R.phase = 'result'; R.t = 0; R.resultKind = kind;
    if (kind === 'win') {
      const bonus = Math.round(Math.max(0, R.left) * 40); R.score += 1000 + bonus; R.bonus = bonus; sfx.star();
      for (let i = 0; i < 4; i++) addParts(px(rnd(0.2, 0.8)), py(rnd(0.2, 0.5)), pick(['#ffd84a', '#ff4d6d', '#4dd66b', '#4d8dff']), 18, 400);
    } else { R.lives--; sfx.over(); E.shake(0.8); }
  }
  function advance() {
    if (R.lives <= 0) { R.phase = 'over'; R.t = 0; if (R.score > R.best) { R.best = R.score; E.store.set('best.pointblank', R.best); R.newBest = true; } return; }
    if (++R.idx >= R.order.length) { R.idx = 0; R.order = R.fixedOrder || nextOrder(); R.lv++; }
    intro();
  }
  function shot(a) {
    if (R.phase === 'over') { if (R.t > 1.2) E.exitMode(); return; }
    if (R.phase !== 'play') return;
    E.shotFx(); R.shots++;
    const pts = R.game.shot(a);
    if (pts > 0) { R.hits++; R.score += pts; }
    else if (pts < 0) R.score = Math.max(0, R.score + pts);
  }
  function update(dt) {
    R.t += dt;
    if (R.phase === 'intro' && R.t > 2.2) { R.phase = 'play'; R.t = 0; sfx.bullseye(); }
    else if (R.phase === 'play') {
      R.game.update(dt); R.left -= dt;
      if (R.game.penalty) { R.left -= R.game.penalty; R.game.penalty = 0; }
      const st = R.game.status();
      if (st) finish(st); else if (R.left <= 0) finish(R.game.timeout());
    } else if (R.phase === 'result' && R.t > 1.9) advance();
  }

  function draw() {
    const { ctx, F } = E, th = R.game ? R.game.theme : ['#222', '#000', null];
    backdrop(th[0] || '#222', th[1] || '#000', th[2]);
    if (R.phase === 'play' || R.phase === 'result') R.game.draw(R.t);
    // HUD
    const fs = F.h * 0.04;
    text(`STAGE ${R.stage}`, px(0.02), py(0.035), fs, 'rgba(255,255,255,.85)', 'left');
    text(String(R.score).padStart(6, '0'), px(0.98), py(0.035), fs * 1.2, '#ffe27a', 'right');
    for (let i = 0; i < 3; i++) heart(px(0.5) - (i - 1) * fs * 1.5, py(0.035), fs * 0.55, i < R.lives);
    if (R.phase === 'play') {
      const tw = F.w * 0.5, tx = px(0.5) - tw / 2, ty = py(0.965);
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(tx, ty, tw, fs * 0.5);
      ctx.fillStyle = R.left < 4 ? '#ff5a5a' : '#6bd6ff'; ctx.fillRect(tx, ty, tw * clamp(R.left / R.game.time, 0, 1), fs * 0.5);
    }
    if (R.phase === 'intro') {
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(F.x, F.y, F.w, F.h);
      const slide = Math.min(1, R.t * 5);
      text(`STAGE ${R.stage}`, px(0.5), py(0.28 - (1 - slide) * 0.1), F.h * 0.06, '#bcaee0');
      text(R.def.name, px(0.5), py(0.42), F.h * 0.12, '#ffe27a');
      text(R.def.hint, px(0.5), py(0.56), F.h * 0.045, '#fff', 'center', 600);
      if (R.lv > 0) text(`LEVEL ${R.lv + 1}`, px(0.5), py(0.65), F.h * 0.04, '#ff9bd0');
      text(R.t < 1.5 ? 'READY...' : 'FIRE!', px(0.5), py(0.78), F.h * (R.t < 1.5 ? 0.07 : 0.11), R.t < 1.5 ? '#fff' : '#ff4d4d');
    } else if (R.phase === 'result') {
      const win = R.resultKind === 'win', k = Math.min(1, R.t * 6);
      ctx.fillStyle = win ? 'rgba(20,70,30,.45)' : 'rgba(90,20,20,.5)'; ctx.fillRect(F.x, F.y, F.w, F.h);
      text(win ? 'CLEAR!' : 'MISS...', px(0.5), py(0.42), F.h * 0.16 * (0.6 + 0.4 * k), win ? '#7dffb0' : '#ff6b6b');
      if (win) text(`+1000  time bonus +${R.bonus}`, px(0.5), py(0.58), F.h * 0.05, '#ffe27a');
      else text(R.lives > 0 ? `${R.lives} ${R.lives === 1 ? 'life' : 'lives'} left` : 'no lives left', px(0.5), py(0.58), F.h * 0.05, '#fff');
    } else if (R.phase === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(F.x, F.y, F.w, F.h);
      text('GAME OVER', px(0.5), py(0.24), F.h * 0.13, '#ff6b6b');
      text(String(R.score), px(0.5), py(0.44), F.h * 0.15, '#fff');
      text(R.newBest ? 'NEW BEST!' : `best ${R.best}`, px(0.5), py(0.58), F.h * 0.05, R.newBest ? '#7dffb0' : '#bcaee0');
      text(`stages cleared ${R.stage - 1}   accuracy ${R.shots ? Math.round((100 * R.hits) / R.shots) : 0}%`, px(0.5), py(0.67), F.h * 0.04, '#bcaee0', 'center', 500);
      if (R.t > 1.2) text('shoot to continue', px(0.5), py(0.82), F.h * 0.045, '#fff');
    }
  }

  const mode = { id: 'pointblank', label: 'POINT BLANK', start, update, draw, shot };
  E.register(mode);

  // test hooks: drive any stage directly and ask what a perfect player would shoot
  window.__pb = { R, GAMES, start, update, shot, mode, play(i, lv = 0) { R.fixedOrder = [i]; start(); R.lv = lv; R.def = GAMES[i]; R.game = R.def.make(lv); R.left = R.game.time; R.phase = 'play'; R.t = 0; } };
})();

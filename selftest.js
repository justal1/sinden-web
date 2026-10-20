// Headless checks: drives the game through the test hook, reports to #out.
(async () => {
  const g = window.__gallery, G = g.G, out = [];
  const ok = (c, m) => out.push((c ? 'ok   ' : 'FAIL ') + m);
  const scene = location.hash.slice(1);
  try {
    // title -> shoot START
    g.mouse.x = 0; g.aim.off = false;
    const start = G.menu[0], F = { x: innerWidth * 0.0 };
    g.aim.x = innerWidth * 0.3; g.aim.y = innerHeight * 0.62;
    // aim is recomputed each frame from mouse, so move the "mouse"
    g.mouse.x = g.aim.x; g.mouse.y = g.aim.y; g.updateAim(performance.now());
    g.trigger(); ok(G.state === 'play', 'shooting START begins game (state=' + G.state + ')');

    // place a duck dead-centre of the aim and shoot it
    G.targets = [{ type: 'duck', x: 0.5, cy: 0.58, vx: 0, r: 0.078, dir: 1, ph: 0 }];
    const rect = document.getElementById('c').getBoundingClientRect();
    const bw = Math.round(Math.min(innerWidth, innerHeight) * 0.05), m = Math.round(bw * 1.5);
    g.mouse.x = m + 0.5 * (innerWidth - 2 * m); g.mouse.y = m + 0.58 * (innerHeight - 2 * m);
    g.updateAim(performance.now());
    const ammo0 = G.ammo; g.trigger();
    ok(G.score === 10 && G.hits === 1 && G.ammo === ammo0 - 1, `duck hit: score=${G.score} hits=${G.hits} ammo=${G.ammo}`);

    // bomb penalty
    G.targets = [{ type: 'bomb', x: 0.5, cy: 0.58, vx: 0, r: 0.078, dir: 1, ph: 0 }]; g.trigger();
    ok(G.score === 0 && G.time < 60, `bomb: score=${G.score} time=${G.time.toFixed(1)}`);

    // miss resets combo, empty/reload cycle
    G.combo = 5; G.targets = []; g.trigger(); ok(G.combo === 0, 'miss resets combo');
    while (G.ammo > 0) g.trigger(); g.trigger();
    ok(G.ammo === 0, 'empty magazine does not go negative');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    g.update(0.5); ok(G.ammo === 6, 'reload refills ammo');

    // run a whole round at 60fps with random shooting: no exceptions, ends in "over"
    G.time = 60;
    for (let i = 0; i < 4500 && G.state === 'play'; i++) {
      g.update(1 / 60);
      if (i % 20 === 0) { g.mouse.x = Math.random() * innerWidth; g.mouse.y = Math.random() * innerHeight; }
    }
    ok(G.state === 'over', 'round ends (state=' + G.state + ', targets handled=' + G.targets.length + ')');

    // gun mode mapping: injected tracker output -> aim pixels, with calibration
    g.toTitle(); g.setMode('gun'); g.updateAim(performance.now());
    g.gun.u = 0.25; g.gun.v = 0.75; g.gun.lastSeen = performance.now();
    g.updateAim(performance.now());
    ok(Math.abs(g.aim.x - innerWidth * 0.25) < 2 && Math.abs(g.aim.y - innerHeight * 0.75) < 2 && !g.aim.off, 'gun uv -> aim px');
    g.gun.u = 1.3; g.gun.lastSeen = performance.now(); g.updateAim(performance.now());
    ok(g.aim.off, 'uv outside screen = off-screen');
    g.gun.lastSeen = -1e9; g.updateAim(performance.now());
    ok(g.aim.off, 'tracker lost = off-screen');

    // calibration recovers a known gun bias (raw = true*0.9 + 0.04)
    g.startCalib();
    const pts = [[0.5, 0.5], [0.2, 0.22], [0.8, 0.22], [0.2, 0.78], [0.8, 0.78]];
    for (const [u, v] of pts) { g.gun.u = u * 0.9 + 0.04; g.gun.v = v * 0.9 + 0.04; g.gun.lastSeen = performance.now(); g.aim.off = false; g.trigger(); }
    ok(G.state === 'title', 'calibration completes');
    const c = g.S.calib;
    ok(Math.abs(c.au - 1 / 0.9) < 0.01 && Math.abs(c.bu + 0.04 / 0.9) < 0.01, `calibration fit au=${c.au.toFixed(3)} bu=${c.bu.toFixed(3)}`);
    g.S.calib = { au: 1, bu: 0, av: 1, bv: 0 };
    // an upside-down camera (both axes inverted) is learned as negative slopes; calibration shots work even if aim reads off-screen
    g.startCalib();
    for (const [u, v] of pts) { g.gun.u = 1 - u; g.gun.v = 1 - v; g.gun.lastSeen = performance.now(); g.aim.off = true; g.trigger(); }
    ok(G.state === 'title', 'calibration completes even while aim reads off-screen');
    const c2 = g.S.calib;
    ok(c2.au < -0.95 && c2.av < -0.95 && Math.abs(c2.bu - 1) < 0.02, `flipped camera learned: au=${c2.au.toFixed(2)} bu=${c2.bu.toFixed(2)}`);
    g.S.calib = { au: 1, bu: 0, av: 1, bv: 0 };
  } catch (e) { out.push('EXCEPTION ' + e.stack); }
  g.setMode('mouse'); g.S.calib = { au: 1, bu: 0, av: 1, bv: 0 };

  // scenes for screenshots
  if (scene === 'play') { g.toTitle(); g.startGame(); for (let i = 0; i < 600; i++) g.update(1 / 60); g.mouse.x = innerWidth * 0.5; g.mouse.y = innerHeight * 0.55; }
  if (scene === 'gun') { g.setMode('gun'); g.toTitle(); g.gun.u = .3; g.gun.v = .5; g.gun.lastSeen = performance.now() + 1e7; }
  if (scene === 'over') { g.startGame(); G.score = 340; g.update(61); G.overAt = 0; }
  document.getElementById('out').textContent = out.join('\n') + '\nRESULT: ' + (out.some(l => /^(FAIL|EXC)/.test(l)) ? 'FAILED' : 'ALL PASSED');
})();
// Quick Fire: every stage must be winnable by a perfect player and lost by a player who does nothing, at several levels.
if (location.hash === '#pb') (() => {
  const pb = window.__pb, g = window.__gallery, out = [];
  const ok = (c, m) => out.push((c ? 'ok   ' : 'FAIL ') + m);
  try {
    ok(g.modes.some((m) => m.id === 'quickfire'), 'Quick Fire registered on the title screen');
    const names = pb.GAMES.map((x) => x.id);
    for (const lv of [0, 2, 5]) {
      const res = [];
      pb.GAMES.forEach((def, i) => {
        // perfect player
        pb.play(i, lv); let frames = 0, aimed = 0;
        while (pb.R.phase === 'play' && frames < 60 * 40) {
          pb.update(1 / 60); frames++;
          if (frames % 5 === 0) { const t = pb.R.game.bot(); if (t) { pb.shot({ x: t.x, y: t.y, off: false }); aimed++; } }
        }
        const won = pb.R.phase === 'result' && pb.R.resultKind === 'win';
        // idle player
        pb.play(i, lv); let f2 = 0;
        while (pb.R.phase === 'play' && f2 < 60 * 40) { pb.update(1 / 60); f2++; }
        const lost = pb.R.phase === 'result' && pb.R.resultKind === 'lose';
        res.push(`${def.id}:${won ? 'W' : '!w'}/${lost ? 'L' : '!l'}`);
        if (!won) ok(false, `level ${lv} ${def.id}: perfect player did not win (phase ${pb.R.phase}, ${frames} frames, ${aimed} shots)`);
        if (!lost) ok(false, `level ${lv} ${def.id}: idle player did not lose`);
      });
      ok(!res.some((r) => r.includes('!')), `level ${lv}: all ${pb.GAMES.length} stages winnable and losable  [${res.join(' ')}]`);
    }
    // full run through the engine: start from the title screen, idle until game over, shoot to exit
    g.setMode('mouse'); g.toTitle();
    const item = g.G.menu.find((m) => m.label === 'QUICK FIRE');
    ok(!!item, 'title menu has a QUICK FIRE target');
    item.act(); ok(g.G.state === 'mode', 'selecting it enters the mode');
    let steps = 0; while (pb.R.phase !== 'over' && steps < 60 * 400) { g.update(1 / 60); steps++; }
    ok(pb.R.phase === 'over' && pb.R.lives <= 0, `idle run ends in game over after ${pb.R.stage} stages (${(steps / 60).toFixed(0)} s)`);
    g.update(1.5); g.mouse.x = 300; g.mouse.y = 300; g.aim.x = 300; g.aim.y = 300; g.aim.off = false; g.trigger();
    ok(g.G.state === 'title', 'shooting at game over returns to the title');
  } catch (e) { out.push('EXCEPTION ' + e.stack); }
  const o = document.getElementById('out'); o.style.display = 'block'; o.textContent += '\n' + out.join('\n') + '\nPBRESULT: ' + (out.some((l) => /^(FAIL|EXC)/.test(l)) ? 'FAILED' : 'ALL PASSED');
})();
// camera scene: drive the real getUserMedia -> tracker path with a fake webcam
if (location.hash === '#cam') (async () => {
  const g = window.__gallery, o = document.getElementById('out'); o.style.display = 'block';
  g.setMode('gun'); document.getElementById('startCam').click();
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (g.gun.valid) break; }
  const msg = `camera: worker=${g.worker} procMs=${(g.gun.procMs||0).toFixed(1)} valid=${g.gun.valid} u=${g.gun.u.toFixed(3)} v=${g.gun.v.toFixed(3)} aim=(${(g.aim.x/innerWidth).toFixed(3)},${(g.aim.y/innerHeight).toFixed(3)}) off=${g.aim.off}`;
  fetch('http://127.0.0.1:8791/', { method: 'POST', mode: 'no-cors', body: msg });
  g.startLensFit();                                           // lens fit across the worker boundary
  for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 100)); if (i > 10 && !document.getElementById('fitLens').disabled) break; }   // the button re-enables when the fit is done
  fetch('http://127.0.0.1:8791/', { method: 'POST', mode: 'no-cors', body: 'lensfit: ' + document.getElementById('lensInfo').textContent + '  button enabled=' + !document.getElementById('fitLens').disabled });
  o.textContent += `\ncamera: valid=${g.gun.valid} u=${g.gun.u.toFixed(3)} v=${g.gun.v.toFixed(3)} status="${document.getElementById('status').textContent}"`;
})();
// serial link wiring: a gun trigger report fires once, and a click arriving right after is deduped
if (location.hash === '#serial') (() => {
  const g = window.__gallery, G = g.G, out = [];
  g.startGame(); G.targets = []; const a0 = G.ammo;
  g.onGunEvent({ type: 'buttons', state1: 1, state2: 0 });
  g.onGunEvent({ type: 'buttons', state1: 0, state2: 0 });
  g.fire();                                            // the mapped mouse click arriving at the same moment
  out.push((G.ammo === a0 - 1 ? 'ok   ' : 'FAIL ') + `trigger report + click = one shot (ammo ${a0} -> ${G.ammo})`);
  G.ammo = 3; G.reloadT = 0; g.onGunEvent({ type: 'buttons', state1: 2, state2: 0 });
  out.push((G.reloadT > 0 ? 'ok   ' : 'FAIL ') + 'another gun button reloads');
  const o = document.getElementById('out'); o.style.display = 'block'; o.textContent += '\n' + out.join('\n');
})();
// screenshot scenes: #pbshot0..7 = that stage mid-play, #pbintro = intro card, #pbresult = clear card, #pbtitle = title with the new menu
if (/^#pb(shot\d|intro|result|title)$/.test(location.hash)) (() => {
  const pb = window.__pb, g = window.__gallery, h = location.hash.slice(3);
  g.setMode('mouse');
  if (h === 'title') { g.toTitle(); return; }
  const i = h.startsWith('shot') ? +h.slice(4) : 4;
  g.startMode(pb.mode); pb.play(i, 0);
  if (h === 'intro') { pb.R.phase = 'intro'; pb.R.t = 1.7; }
  else {
    for (let f = 0; f < 60 * 3; f++) { pb.update(1 / 60); if (f % 40 === 0) { const t = pb.R.game.bot(); if (t) pb.shot({ x: t.x, y: t.y }); } }
    if (h === 'result') { pb.R.left = 4; pb.R.game.status = () => 'win'; pb.update(0.01); pb.R.t = 0.5; }
    const t = pb.R.game.bot && pb.R.game.bot(); if (t) { g.mouse.x = t.x + 40; g.mouse.y = t.y + 30; }
  }
})();

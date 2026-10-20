// Gallery: a carnival shooting gallery that works with a mouse or a Sinden-style
// light gun (camera + white border). The game draws its own border, reads the gun's
// camera and tracks it itself, so no driver is needed. See tracker.js.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const cv = $('c'), ctx = cv.getContext('2d');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('gallery.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('gallery.' + k, JSON.stringify(v)); } catch {} },
  };

  // ---------- layout: white border at the very edge, black gap, then the playfield ----------
  let W = 0, H = 0, F = { x: 0, y: 0, w: 0, h: 0 }, bw = 0;
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (W * H * dpr * dpr > 2.4e6) dpr = Math.max(1, Math.sqrt(2.4e6 / (W * H)));   // big Retina screens: fewer pixels to repaint is much smoother
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bw = Math.round(Math.min(W, H) * 0.06);
    const m = Math.round(bw * 2);   // border + an equally wide black gap, so bright game content can't bleed into it in the camera
    F = { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- settings ----------
  const S = Object.assign({ mode: 'mouse', threshold: 200, exposure: 45, flipX: false, flipY: false, crosshair: true,
    calib: { au: 1, bu: 0, av: 1, bv: 0 }, recoil: false, recoilStr: 60, alpha: 0.6, auto: true, k1: 0 }, store.get('settings', {}));
  const saveS = () => store.set('settings', S);

  // ---------- audio ----------
  let actx = null;
  function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } return actx; }
  function tone(f, d, type = 'square', vol = 0.12, slide = 0, delay = 0) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f + slide), t + d);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + 0.02);
  }
  function noise(d, vol = 0.2, delay = 0) {
    const a = audio(); if (!a) return;
    const n = Math.floor(a.sampleRate * d), buf = a.createBuffer(1, n, a.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = a.createBufferSource(), g = a.createGain();
    g.gain.value = vol; s.buffer = buf; s.connect(g); g.connect(a.destination); s.start(a.currentTime + delay);
  }
  const sfx = {
    shot() { noise(0.12, 0.25); tone(180, 0.1, 'sawtooth', 0.12, -120); },
    hit() { tone(660, 0.08, 'square', 0.12); tone(990, 0.12, 'square', 0.1, 0, 0.06); },
    bullseye() { [660, 880, 1320].forEach((f, i) => tone(f, 0.1, 'triangle', 0.14, 0, i * 0.06)); },
    star() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.12, 'triangle', 0.14, 0, i * 0.05)); },
    bomb() { noise(0.5, 0.4); tone(90, 0.5, 'sawtooth', 0.2, -60); },
    empty() { tone(1400, 0.03, 'square', 0.06); },
    reload() { tone(300, 0.05, 'square', 0.1); tone(500, 0.07, 'square', 0.1, 0, 0.18); },
    over() { [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'triangle', 0.14, 0, i * 0.2)); },
  };

  // ---------- gun: camera in, tracker, calibration ----------
  const vid = $('vid'), dbg = $('dbg'), dctx = dbg.getContext('2d');
  const GW = 640, GH = 480;   // full camera resolution: finer corner positions than a 320x240 copy
  const grab = document.createElement('canvas'); grab.width = GW; grab.height = GH;
  const gctx = grab.getContext('2d', { willReadFrequently: true });
  const tracker = SindenTracker.createTracker({ threshold: S.threshold, flipX: S.flipX, flipY: S.flipY, alpha: S.alpha, auto: S.auto, k1: S.k1 });
  const gun = { stream: null, track: null, valid: false, u: 0, v: 0, lastSeen: -1e9, fps: 0, frames: 0, fpsT: 0, lastVT: -1 };

  async function startCam() {
    stopCam();
    const id = $('cams').value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } } });
      gun.stream = stream; gun.track = stream.getVideoTracks()[0];
      vid.srcObject = stream; await vid.play();
      // Handle each camera frame the moment it arrives, not at the next screen refresh.
      if (vid.requestVideoFrameCallback && !gun.rvfc) {
        gun.rvfc = true;
        const onFrame = () => {
          if (!gun.stream) { gun.rvfc = false; return; }
          if (S.mode === 'gun') processFrame(performance.now());
          vid.requestVideoFrameCallback(onFrame);
        };
        vid.requestVideoFrameCallback(onFrame);
      }
      await listCams(gun.track.getSettings().deviceId);
      applyExposure();
      setStatus('camera on');
    } catch (e) { setStatus('camera error: ' + (e.message || e.name)); }
  }
  function stopCam() { if (gun.stream) gun.stream.getTracks().forEach((t) => t.stop()); gun.stream = gun.track = null; gun.valid = false; }
  async function listCams(sel) {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const el = $('cams'); el.innerHTML = '';
      devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Camera ' + (i + 1); if (d.deviceId === sel) o.selected = true; el.appendChild(o); });
      const sin = devs.find((d) => /sinden|lightgun/i.test(d.label)); if (sin && !sel) el.value = sin.deviceId;
    } catch {}
  }
  // A dim picture makes the white border stand out; the gun relies on low exposure.
  function applyExposure() {
    if (!gun.track || !gun.track.getCapabilities) return;
    let caps; try { caps = gun.track.getCapabilities(); } catch { return; }
    $('expRow').style.display = caps.exposureTime ? '' : 'none';
    if (!caps.exposureTime) return;
    const { min, max } = caps.exposureTime;
    // Log scale between the camera's minimum and 40 ms: a long exposure drags the frame rate down
    // (the control is in 100 us units; 750 would be 75 ms, about 13 fps).
    const hi = Math.max(min, Math.min(max, 400));
    const adv = { exposureTime: Math.round(min * Math.pow(hi / min, S.exposure / 100)) };
    if (caps.exposureMode && caps.exposureMode.includes('manual')) adv.exposureMode = 'manual';
    gun.track.applyConstraints({ advanced: [adv] }).catch(() => {});
  }
  function setStatus(t) { $('status').textContent = t; }

  // ---------- tracking runs in a worker thread, so the camera never slows the screen ----------
  // Copying a 640x480 picture and running the tracker costs several ms per camera frame, up to 60 times a second.
  // On the main thread that starved drawing; in a worker, the picture goes across as an ImageBitmap and only a
  // small result comes back. (A page opened from file:// can't load a worker file, so the worker is built from
  // the tracker's own source.) If workers aren't available, tracking falls back to the main thread.
  function workerMain() {
    const T = self.SindenTracker, GWk = 640, GHk = 480;
    const tracker = T.createTracker({});
    const cx = new OffscreenCanvas(GWk, GHk).getContext('2d', { willReadFrequently: true });
    let lens = null;
    self.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'opts') { Object.assign(tracker.opts, m.opts); return; }
      if (m.type === 'lensStart') { lens = { samples: [], n: 0 }; return; }
      if (m.type === 'lensStop') {
        const samples = lens ? lens.samples : []; lens = null;
        self.postMessage({ type: 'lensResult', fit: samples.length >= 15 ? T.fitLens(samples) : null, count: samples.length });
        return;
      }
      if (m.type !== 'frame') return;
      cx.drawImage(m.bmp, 0, 0, GWk, GHk); m.bmp.close();
      const frame = cx.getImageData(0, 0, GWk, GHk);
      const t0 = performance.now();
      const r = tracker.update(frame);
      const ms = performance.now() - t0;
      if (lens && r.valid && tracker.lastSides && ++lens.n % 3 === 0) {
        const thin = (s) => s.filter((_, i) => i % Math.max(1, Math.floor(s.length / 80)) === 0);
        lens.samples.push({ sides: tracker.lastSides.map(thin), w: GWk, h: GHk });
      }
      let dbg = null;
      if (m.debug) {   // 320x240 view: white = the chosen border, orange = other bright pixels
        dbg = new Uint8ClampedArray(320 * 240 * 4);
        const thr = tracker.opts.auto ? tracker.lastThreshold : tracker.opts.threshold, src = frame.data, mk = tracker.lastMask;
        for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
          const p = ((y * 2) * GWk + x * 2) * 4, i = (y * 320 + x) * 4, l = (src[p] + src[p + 1] + src[p + 2]) / 3;
          if (mk && mk[(y * 2) * GWk + x * 2] === 3) { dbg[i] = dbg[i + 1] = dbg[i + 2] = 255; }
          else if (l >= thr) { dbg[i] = 200; dbg[i + 1] = 110; dbg[i + 2] = 20; }
          else { dbg[i] = dbg[i + 1] = dbg[i + 2] = l * 0.5; }
          dbg[i + 3] = 255;
        }
      }
      self.postMessage({ type: 'result', r: { valid: r.valid, u: r.u, v: r.v, bridged: !!r.bridged, corners: r.corners },
        fail: tracker.lastFail, thr: tracker.lastThreshold, fitted: !!(tracker.lastFitted && r.valid), ms, lensCount: lens ? lens.samples.length : -1, dbg },
        dbg ? [dbg.buffer] : []);
    };
  }

  let worker = null, workerBusy = false, workerSent = 0;
  const trk = { fail: '', thr: 0, fitted: false };     // what the tracker last reported (from the worker or the main thread)
  const trkOpts = () => ({ threshold: S.threshold, flipX: S.flipX, flipY: S.flipY, alpha: S.alpha, auto: S.auto, k1: S.k1 });
  const setTrk = (patch) => { Object.assign(tracker.opts, patch); if (worker) worker.postMessage({ type: 'opts', opts: patch }); };
  function startWorker() {
    try {
      if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap || !SindenTracker.__factory) return;
      const src = '(' + SindenTracker.__factory.toString() + ')(self);\n(' + workerMain.toString() + ')();';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = onWorkerMsg;
      worker.onerror = (e) => { console.warn('tracker worker failed; tracking on the main thread:', e.message); worker = null; workerBusy = false; };
      worker.postMessage({ type: 'opts', opts: trkOpts() });
    } catch (e) { console.warn('no tracker worker:', e); worker = null; }
  }

  function applyResult(r, now, ms) {
    gun.procMs = gun.procMs ? gun.procMs * 0.9 + ms * 0.1 : ms;
    gun.valid = r.valid; gun.bridged = !!r.bridged;
    if (r.valid) { gun.u = r.u; gun.v = r.v; gun.lastSeen = now; }
    gun.frames++;
    if (now - gun.fpsT > 1000) { gun.fps = gun.frames; gun.frames = 0; gun.fpsT = now; }
  }
  const debugWanted = () => panelOn && G.state !== 'play' && G.state !== 'mode';

  function sendFrame(now) {
    if (workerBusy && now - workerSent < 1000) return;           // still working on the previous frame: skip this one
    if (vid.readyState < 2) return;
    workerBusy = true; workerSent = now;
    const debug = debugWanted();
    createImageBitmap(vid, { resizeWidth: GW, resizeHeight: GH })
      .then((bmp) => { if (worker) worker.postMessage({ type: 'frame', bmp, debug }, [bmp]); else bmp.close(); })
      .catch(() => { workerBusy = false; });
  }
  function onWorkerMsg(e) {
    const m = e.data, now = performance.now();
    if (m.type === 'result') {
      workerBusy = false;
      trk.fail = m.fail; trk.thr = m.thr; trk.fitted = m.fitted;
      applyResult(m.r, now, m.ms);
      if (m.dbg) { dbgImg.data.set(new Uint8ClampedArray(m.dbg)); paintDebug(m.r); }
      if (lensFit && !lensFit.legacy) lensTick(now, m.lensCount);
    } else if (m.type === 'lensResult') finishLens(m.fit);
  }

  function processFrame(now) {
    if (worker) { sendFrame(now); return; }
    // Main-thread fallback.
    gctx.drawImage(vid, 0, 0, GW, GH);
    const frame = gctx.getImageData(0, 0, GW, GH);
    const t0 = performance.now();
    const r = tracker.update(frame);
    applyResult(r, now, performance.now() - t0);
    trk.fail = tracker.lastFail; trk.thr = tracker.lastThreshold; trk.fitted = !!(tracker.lastFitted && r.valid);
    if (lensFit) collectLensSample(now, r);
    if (debugWanted()) legacyDebug(frame, r);
  }
  // Fallback for browsers without requestVideoFrameCallback: pick frames up once per screen refresh.
  function pollCamera(now) {
    if (gun.rvfc || S.mode !== 'gun' || !gun.stream || vid.readyState < 2) return;
    if (vid.currentTime === gun.lastVT) return;     // no new frame yet
    gun.lastVT = vid.currentTime;
    processFrame(now);
  }

  // ---------- lens fit: while the user moves the gun around with the border in view, collect edge points; then fit k1 ----------
  let lensFit = null;
  function startLensFit() {
    if (!gun.stream) { $('lensInfo').textContent = 'start the camera first'; return; }
    lensFit = { samples: [], n: 0, until: performance.now() + 7000, legacy: !worker, stopping: false };
    if (worker) worker.postMessage({ type: 'lensStart' });
    $('fitLens').disabled = true;
  }
  function lensTick(now, count) {
    const left = Math.max(0, Math.ceil((lensFit.until - now) / 1000));
    $('lensInfo').textContent = `move the gun around... ${left}s (${count} frames)`;
    if (now >= lensFit.until && !lensFit.stopping) { lensFit.stopping = true; if (worker) worker.postMessage({ type: 'lensStop' }); }
  }
  function collectLensSample(now, r) {      // main-thread fallback
    if (r.valid && tracker.lastSides && ++lensFit.n % 3 === 0) {
      const thin = (s) => s.filter((_, i) => i % Math.max(1, Math.floor(s.length / 80)) === 0);
      lensFit.samples.push({ sides: tracker.lastSides.map(thin), w: GW, h: GH });
    }
    lensTick(now, lensFit.samples.length);
    if (now >= lensFit.until) finishLens(lensFit.samples.length >= 15 ? SindenTracker.fitLens(lensFit.samples) : null);
  }
  function finishLens(fit) {
    lensFit = null; $('fitLens').disabled = false;
    if (!fit) { $('lensInfo').textContent = 'too few frames: keep the whole border in view while moving'; return; }
    if (fit.rms > fit.rms0 * 0.9) { S.k1 = 0; setTrk({ k1: 0 }); $('lensInfo').textContent = `no distortion found (edge error ${fit.rms0.toFixed(2)} px)`; }
    else { S.k1 = fit.k1; setTrk({ k1: fit.k1 }); $('lensInfo').textContent = `lens k1 ${fit.k1.toFixed(3)}  (edge error ${fit.rms0.toFixed(2)} -> ${fit.rms.toFixed(2)} px)`; }
    saveS();
  }

  // ---------- debug view (panel): white = what the tracker locked onto, orange = other bright pixels ----------
  const dbgImg = dctx.createImageData(320, 240);
  function legacyDebug(frame, r) {
    const thr = S.auto ? tracker.lastThreshold : S.threshold, d = dbgImg.data, src = frame.data, mk = tracker.lastMask;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
      const p = ((y * 2) * GW + x * 2) * 4, i = (y * 320 + x) * 4, l = (src[p] + src[p + 1] + src[p + 2]) / 3;
      if (mk && mk[(y * 2) * GW + x * 2] === 3) { d[i] = d[i + 1] = d[i + 2] = 255; }
      else if (l >= thr) { d[i] = 200; d[i + 1] = 110; d[i + 2] = 20; }
      else { d[i] = d[i + 1] = d[i + 2] = l * 0.5; }
      d[i + 3] = 255;
    }
    paintDebug(r);
  }
  function paintDebug(r) {
    dctx.putImageData(dbgImg, 0, 0);
    $('thrVal').textContent = S.auto ? `auto ${Math.round(trk.thr)} ` : '';
    if (r.corners) {
      dctx.strokeStyle = '#fc3'; dctx.lineWidth = 2; dctx.beginPath();
      r.corners.forEach(([x, y], i) => (i ? dctx.lineTo(x * 320 / GW, y * 240 / GH) : dctx.moveTo(x * 320 / GW, y * 240 / GH))); dctx.closePath(); dctx.stroke();
    }
    dctx.strokeStyle = '#f44'; dctx.beginPath(); dctx.moveTo(150, 120); dctx.lineTo(170, 120); dctx.moveTo(160, 110); dctx.lineTo(160, 130); dctx.stroke();
    setStatus(`${r.bridged ? 'bridging (border lost)' : r.valid ? 'border found' : 'no border' + (trk.fail ? ' (' + trk.fail + ')' : '')}${r.valid && trk.fitted ? ' (lines fitted)' : ''}, camera ${gun.fps} fps, tracker ${gun.procMs.toFixed(1)} ms${worker ? ' (worker)' : ' (main thread)'}, screen ${perf.fps} fps`);
  }

  // ---------- gun serial link: wakes the gun so the trigger and buttons work ----------
  let serialGun = null, prevBtn = [0, 0];
  const gunStatus = (t) => { $('gunStatus').textContent = t; };
  function onGunEvent(ev) {
    if (ev.type === 'closed') { if (serialGun) { serialGun = null; $('wake').textContent = 'Wake gun (serial)'; gunStatus('gun disconnected'); } return; }
    if (ev.type !== 'buttons') return;
    const [p1, p2] = prevBtn; prevBtn = [ev.state1, ev.state2];
    if (ev.state1 & 1 && !(p1 & 1)) fire();                                  // trigger pulled
    const others = (ev.state1 & ~1 & ~p1) | (ev.state2 & ~p2);               // any other button newly pressed
    if (others) reload();
    gunStatus(`gun awake, fw ${serialGun ? serialGun.firmware || '?' : '?'} · buttons ${ev.state1.toString(2).padStart(8, '0')} ${ev.state2.toString(2).padStart(8, '0')}`);
  }
  // auto: connect only if the browser already has permission for the gun (no click available at page load).
  let waking = false;
  async function wakeGun(auto) {
    if (auto !== true && serialGun) { const g = serialGun; serialGun = null; await g.close(); $('wake').textContent = 'Wake gun (serial)'; gunStatus('gun disconnected'); return; }
    if (serialGun || waking) return;
    if (!navigator.serial) { gunStatus('Web Serial needs Chrome or Edge'); return; }
    waking = true;
    try { return await tryWake(auto); } finally { waking = false; }
  }
  async function tryWake(auto) {
    const port = await SindenGun.pickPort(auto !== true).catch((e) => { gunStatus('gun error: ' + (e.message || e.name)); return undefined; });
    if (port === undefined) return;
    if (!port) { gunStatus('gun not connected: click anywhere once to pick it'); return false; }
    // The handshake often fails right after plugging in or page load, so retry a few times.
    const TRIES = 5, RETRY_MS = 3000;
    for (let n = 1; n <= TRIES; n++) {
      let g = null;
      try {
        gunStatus(n > 1 ? `connecting... (try ${n}/${TRIES})` : 'connecting...');
        g = new SindenGun.SindenSerial(port, { onEvent: onGunEvent, onLog: (s) => gunStatus(s) });
        await g.open();
        await g.wake({ recoil: S.recoil ? { strength: S.recoilStr } : null });
        serialGun = g; prevBtn = [0, 0];
        $('wake').textContent = 'Disconnect gun';
        gunStatus(`gun awake, firmware ${g.firmware || '?'}`);
        return;
      } catch (e) {
        if (g) await g.close();
        if (n === TRIES) { gunStatus('gun error: ' + (e.message || e.name) + ' (if it keeps failing, unplug and replug the gun)'); return; }
        gunStatus(`gun error: ${e.message || e.name}, retrying in ${RETRY_MS / 1000}s (${n}/${TRIES})`);
        await new Promise((r) => setTimeout(r, RETRY_MS));
        if (serialGun) return;
      }
    }
  }

  const applyCal = (u, v) => [u * S.calib.au + S.calib.bu, v * S.calib.av + S.calib.bv];

  // ---------- aim ----------
  const mouse = { x: 0, y: 0 };
  const aim = { x: 0, y: 0, off: false };
  function updateAim(now) {
    if (S.mode === 'gun') {
      const seen = now - gun.lastSeen < 400;     // ride out short dropouts; only a long loss counts as pointing away
      if (seen) {
        const [u, v] = applyCal(gun.u, gun.v);
        aim.x = u * W; aim.y = v * H;
        aim.off = u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02;
      } else aim.off = true;
    } else { aim.x = mouse.x; aim.y = mouse.y; aim.off = false; }
  }

  // ---------- game state ----------
  const ROWS = [{ y: 0.37, r: 0.062, v: 0.09, dir: 1 }, { y: 0.58, r: 0.078, v: 0.13, dir: -1 }, { y: 0.8, r: 0.098, v: 0.18, dir: 1 }];
  const G = { state: 'title', score: 0, combo: 0, best: store.get('best', 0), time: 60, ammo: 6, reloadT: 0, shake: 0,
    targets: [], parts: [], pops: [], spawnT: 0, elapsed: 0, shots: 0, hits: 0, overAt: 0, flash: 0, msg: '', msgT: 0,
    menu: [], calib: { i: 0, raw: [], tgt: [] } };
  // Centre first (easiest to hit, shows tracking works), then four points inset from the corners: the camera must
  // keep the whole border in view, which is hardest when aiming near an edge.
  const CAL_PTS = [[0.5, 0.5], [0.2, 0.22], [0.8, 0.22], [0.2, 0.78], [0.8, 0.78]];

  const mult = () => Math.min(5, 1 + Math.floor(G.combo / 3));
  function say(t) { G.msg = t; G.msgT = 1.4; }

  function toTitle() {
    G.state = 'title'; G.targets = []; G.parts = []; G.pops = [];
    const items = [{ label: 'GALLERY', act: startGame }, ...modes.map((m) => ({ label: m.label, act: () => startMode(m) })), { label: 'CALIBRATE', act: startCalib }];
    G.menu = items.map((it, i) => ({ ...it, fx: (i + 1) / (items.length + 1), fy: 0.62, r: items.length > 3 ? 0.1 : 0.12 }));
  }
  // ---------- game modes: other games plug in here (see minigames.js) ----------
  // A mode is {id, label, start(), update(dt), draw(tm), shot(aim), exit hook via Engine.exitMode()}.
  const modes = [];
  function startMode(m) { G.state = 'mode'; G.mode = m; G.targets = []; G.parts = []; G.pops = []; m.start(); }
  function startGame() {
    Object.assign(G, { state: 'play', score: 0, combo: 0, time: 60, ammo: 6, reloadT: 0, targets: [], parts: [], pops: [],
      spawnT: 0, elapsed: 0, shots: 0, hits: 0 });
  }
  function startCalib() { G.state = 'calib'; G.calib = { i: 0, raw: [], tgt: [] }; G.targets = []; }
  function endGame() {
    G.state = 'over'; G.overAt = performance.now(); sfx.over();
    if (G.score > G.best) { G.best = G.score; store.set('best', G.best); G.newBest = true; } else G.newBest = false;
  }

  function spawn() {
    const roll = Math.random();
    if (roll < 0.06) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      G.targets.push({ type: 'star', x: dir > 0 ? -0.06 : 1.06, cy: 0.17, vx: dir * 0.3, r: 0.05, dir, ph: rnd(0, 6) });
      return;
    }
    const ri = Math.floor(Math.random() * ROWS.length), row = ROWS[ri];
    const type = roll < 0.18 ? 'bomb' : roll < 0.32 ? 'bull' : 'duck';
    const sp = row.v * (1 + G.elapsed / 70) * rnd(0.85, 1.2);
    G.targets.push({ type, x: row.dir > 0 ? -0.06 : 1.06, cy: row.y, vx: row.dir * sp, r: row.r * (type === 'bull' ? 0.85 : 1), dir: row.dir, ph: rnd(0, 6) });
  }

  function addParts(x, y, color, n = 14, speed = 220) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(0.3, 1) * speed;
      G.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, life: rnd(0.4, 0.8), t: 0, c: color, r: rnd(2, 5) });
    }
  }
  const pop = (x, y, text, color = '#fff') => G.pops.push({ x, y, text, color, t: 0 });

  function tpx(t) { return { x: F.x + t.x * F.w, y: F.y + t.cy * F.h, r: t.r * F.h }; }

  function reload() {
    if (G.state === 'mode') return;                 // modes manage their own ammo (usually unlimited)
    if (G.state !== 'play' || G.reloadT > 0 || G.ammo === 6) return;
    G.reloadT = 0.45; sfx.reload();
  }

  function playShot(a) {
    if (G.reloadT > 0) return;
    if (G.ammo <= 0) { sfx.empty(); say('RELOAD!'); return; }
    G.ammo--; G.shots++; G.flash = 1; sfx.shot();
    if (serialGun) serialGun.fireRecoil();
    let hit = null, hd = 1e9;
    for (const t of G.targets) {
      if (t.dead) continue;
      const p = tpx(t), d = Math.hypot(a.x - p.x, a.y - p.y - p.r * 0.1);
      if (d <= p.r * 1.05 && (!hit || p.y > hd)) { hit = t; hd = p.y; }   // nearer (lower) row wins
    }
    if (!hit) { G.combo = 0; return; }
    const p = tpx(hit); hit.dead = true; hit.ht = 0; G.hits++;
    if (hit.type === 'bomb') {
      G.combo = 0; G.score = Math.max(0, G.score - 30); G.time = Math.max(0, G.time - 3); G.shake = 1;
      sfx.bomb(); addParts(p.x, p.y, '#ff7a1a', 30, 380); pop(p.x, p.y, '-30  -3s', '#ff6b6b');
      return;
    }
    G.combo++;
    const base = hit.type === 'star' ? 50 : hit.type === 'bull' ? 25 : 10, gain = base * mult();
    G.score += gain;
    if (hit.type === 'star') { G.time += 3; sfx.star(); addParts(p.x, p.y, '#ffd84a', 26, 320); pop(p.x, p.y, `+${gain}  +3s`, '#ffd84a'); }
    else if (hit.type === 'bull') { sfx.bullseye(); addParts(p.x, p.y, '#ff4d4d', 16); pop(p.x, p.y, '+' + gain, '#ffb3b3'); }
    else { sfx.hit(); addParts(p.x, p.y, '#ffd84a', 14); pop(p.x, p.y, '+' + gain, '#fff6bf'); }
  }

  function menuShot(a) {
    for (const m of G.menu) {
      if (Math.hypot(a.x - (F.x + m.fx * F.w), a.y - (F.y + m.fy * F.h)) <= m.r * F.h * 1.1) {
        sfx.bullseye(); addParts(F.x + m.fx * F.w, F.y + m.fy * F.h, '#ff4d4d', 20); m.act(); return;
      }
    }
    sfx.shot();
  }
  function calibShot() {
    if (S.mode !== 'gun') { say('Calibration needs the light gun'); G.state = 'title'; toTitle(); return; }
    if (now() - gun.lastSeen > 150) { say("Can't see the border"); sfx.empty(); return; }
    const c = G.calib; c.raw.push([gun.u, gun.v]); c.tgt.push(CAL_PTS[c.i]); c.i++; sfx.bullseye();
    if (c.i >= CAL_PTS.length) {
      const fit = (ix) => {
        const n = c.raw.length, r = c.raw.map((p) => p[ix]), t = c.tgt.map((p) => p[ix]);
        const mr = r.reduce((s, v) => s + v, 0) / n, mt = t.reduce((s, v) => s + v, 0) / n;
        let cov = 0, vr = 0; for (let i = 0; i < n; i++) { cov += (r[i] - mr) * (t[i] - mt); vr += (r[i] - mr) ** 2; }
        let a = vr > 1e-6 ? cov / vr : 1; a = Math.sign(a || 1) * clamp(Math.abs(a), 0.5, 2); return [a, mt - a * mr];   // negative slope = flipped camera axis
      };
      const [au, bu] = fit(0), [av, bv] = fit(1);
      S.calib = { au, bu, av, bv }; saveS(); say('Calibrated'); toTitle();
    }
  }

  const now = () => performance.now();
  // The gun's trigger can arrive twice (serial report and the click it maps to); count it once.
  let lastFire = -1e9;
  function fire() { const t = now(); if (t - lastFire < 90) return; lastFire = t; trigger(); }
  function trigger() {
    audio();
    if (G.state === 'over') { if (now() - G.overAt > 1200) toTitle(); return; }
    if (G.state === 'calib') return calibShot();                 // judged on whether the camera sees the border, not on aim
    if (G.state === 'mode') { if (!aim.off) G.mode.shot(aim); return; }
    if (aim.off) { if (G.state === 'play') reload(); return; }   // pointing away from screen = reload
    if (G.state === 'title') menuShot(aim);
    else if (G.state === 'play') playShot(aim);
  }

  // ---------- update ----------
  function update(dt) {
    G.flash = Math.max(0, G.flash - dt * 6); G.shake = Math.max(0, G.shake - dt * 2.5); G.msgT = Math.max(0, G.msgT - dt);
    for (const p of G.parts) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 600 * dt; }
    G.parts = G.parts.filter((p) => p.t < p.life);
    for (const p of G.pops) p.t += dt;
    G.pops = G.pops.filter((p) => p.t < 0.9);
    if (G.state === 'mode') { G.mode.update(dt); return; }
    if (G.state !== 'play') return;
    G.elapsed += dt; G.time -= dt;
    if (G.reloadT > 0) { G.reloadT -= dt; if (G.reloadT <= 0) G.ammo = 6; }
    G.spawnT -= dt;
    if (G.spawnT <= 0) { spawn(); G.spawnT = Math.max(0.35, 0.8 - G.elapsed * 0.006) * rnd(0.7, 1.3); }
    for (const t of G.targets) {
      if (t.dead) { t.ht += dt; continue; }
      t.x += t.vx * dt;
    }
    G.targets = G.targets.filter((t) => (t.dead ? t.ht < 0.6 : t.x > -0.12 && t.x < 1.12));
    if (G.time <= 0) endGame();
  }

  // ---------- drawing ----------
  function drawBulls(x, y, r) {
    const cols = ['#e8e8ee', '#d62f2f', '#e8e8ee', '#d62f2f', '#e8e8ee'];
    cols.forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r * (1 - i * 0.2), 0, 6.3); ctx.fill(); });
    ctx.fillStyle = '#d62f2f'; ctx.beginPath(); ctx.arc(x, y, r * 0.12, 0, 6.3); ctx.fill();
  }
  function drawDuck(x, y, r, dir) {
    ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.ellipse(x, y + r * 0.15, r, r * 0.72, 0, 0, 6.3); ctx.fill();
    ctx.beginPath(); ctx.arc(x + dir * r * 0.6, y - r * 0.5, r * 0.46, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#ff8c1a'; ctx.beginPath();
    ctx.moveTo(x + dir * r * 0.98, y - r * 0.55); ctx.lineTo(x + dir * r * 1.45, y - r * 0.42); ctx.lineTo(x + dir * r * 0.98, y - r * 0.3); ctx.fill();
    ctx.fillStyle = '#c99a0a'; ctx.beginPath(); ctx.ellipse(x - dir * r * 0.15, y + r * 0.1, r * 0.5, r * 0.3, dir * 0.4, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + dir * r * 0.68, y - r * 0.6, r * 0.07, 0, 6.3); ctx.fill();
  }
  function drawBomb(x, y, r, tm) {
    ctx.fillStyle = '#16161c'; ctx.beginPath(); ctx.arc(x, y + r * 0.1, r * 0.85, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#333a48'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.2, r * 0.22, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#a58b5a'; ctx.lineWidth = r * 0.12; ctx.beginPath(); ctx.moveTo(x, y - r * 0.7); ctx.quadraticCurveTo(x + r * 0.3, y - r * 1.1, x + r * 0.5, y - r * 1.0); ctx.stroke();
    ctx.fillStyle = Math.sin(tm * 20) > 0 ? '#ffb300' : '#ff4d00'; ctx.beginPath(); ctx.arc(x + r * 0.5, y - r * 1.0, r * 0.14, 0, 6.3); ctx.fill();
    ctx.fillStyle = '#ff4d4d'; ctx.font = `bold ${r * 0.9}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', x, y + r * 0.15);
  }
  function drawStar(x, y, r) {
    ctx.fillStyle = '#ffd84a'; ctx.strokeStyle = '#a87b00'; ctx.lineWidth = r * 0.12; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  function drawTarget(t, tm) {
    let { x, y, r } = tpx(t);
    ctx.save();
    if (t.dead) { const k = t.ht / 0.6; ctx.translate(x, y + k * k * F.h * 0.25); ctx.rotate(k * 5 * t.dir); ctx.globalAlpha = 1 - k; x = y = 0; }
    else y += Math.sin(tm * 3 + t.ph) * r * 0.06;
    if (t.type === 'duck') drawDuck(x, y, r, t.dir);
    else if (t.type === 'bull') drawBulls(x, y, r);
    else if (t.type === 'bomb') drawBomb(x, y, r, tm);
    else drawStar(x, y + Math.sin(tm * 6 + t.ph) * r * 0.2, r);
    ctx.restore();
  }

  function drawBackdrop(tm) {
    const g = ctx.createLinearGradient(0, F.y, 0, F.y + F.h);
    g.addColorStop(0, '#2d1258'); g.addColorStop(1, '#10051f');
    ctx.fillStyle = g; ctx.fillRect(F.x, F.y, F.w, F.h);
    ctx.fillStyle = 'rgba(255,255,255,.035)';
    for (let i = 0; i < 24; i++) if (i % 2) ctx.fillRect(F.x + (F.w / 24) * i, F.y, F.w / 24, F.h);
    // curtains
    const cw = F.w * 0.075;
    for (const left of [true, false]) {
      const x0 = left ? F.x : F.x + F.w - cw, cg = ctx.createLinearGradient(x0, 0, x0 + cw, 0);
      cg.addColorStop(0, '#6e0f1d'); cg.addColorStop(0.5, '#b3203a'); cg.addColorStop(1, '#6e0f1d');
      ctx.fillStyle = cg; ctx.fillRect(x0, F.y, cw, F.h);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; for (let i = 1; i < 5; i++) ctx.fillRect(x0 + (cw / 5) * i - 1, F.y, 2, F.h);
    }
    // bulbs
    const n = 22;
    for (let i = 0; i < n; i++) {
      const x = F.x + (F.w * (i + 0.5)) / n, y = F.y + F.h * 0.045, on = (Math.floor(tm * 2) + i) % 3 === 0;
      ctx.fillStyle = on ? '#fff3b0' : '#6a5a2a'; ctx.beginPath(); ctx.arc(x, y, F.h * 0.012, 0, 6.3); ctx.fill();
      if (on) { ctx.fillStyle = 'rgba(255,230,140,.18)'; ctx.beginPath(); ctx.arc(x, y, F.h * 0.03, 0, 6.3); ctx.fill(); }
    }
    // shelves
    for (const r of ROWS) {
      const y = F.y + (r.y + r.r * 0.85) * F.h;
      ctx.fillStyle = '#5b3a1e'; ctx.fillRect(F.x, y, F.w, F.h * 0.022);
      ctx.fillStyle = '#7a5129'; ctx.fillRect(F.x, y, F.w, F.h * 0.007);
    }
    ctx.fillStyle = '#3a2412'; ctx.fillRect(F.x, F.y + F.h * 0.93, F.w, F.h * 0.07);
  }

  function text(s, x, y, size, color = '#fff', align = 'center', weight = 800) {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillStyle = color; ctx.fillText(s, x, y);
  }

  function drawHUD() {
    const fs = F.h * 0.05;
    text(String(G.score).padStart(5, '0'), F.x + F.w * 0.1, F.y + F.h * 0.1, fs * 1.3, '#ffe27a', 'left');
    if (mult() > 1) text('x' + mult(), F.x + F.w * 0.1, F.y + F.h * 0.17, fs, '#ff9bd0', 'left');
    const tw = F.w * 0.3, tx = F.x + F.w / 2 - tw / 2, ty = F.y + F.h * 0.085;
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(tx, ty, tw, fs * 0.5);
    ctx.fillStyle = G.time < 10 ? '#ff5a5a' : '#6bd6ff'; ctx.fillRect(tx, ty, tw * clamp(G.time / 60, 0, 1), fs * 0.5);
    text(Math.ceil(Math.max(0, G.time)) + 's', F.x + F.w / 2, ty + fs * 1.2, fs * 0.8, '#cfe9ff');
    for (let i = 0; i < 6; i++) {
      const x = F.x + F.w * 0.9 - i * fs * 0.7, y = F.y + F.h * 0.1;
      ctx.fillStyle = i < G.ammo && G.reloadT <= 0 ? '#ffd84a' : 'rgba(255,255,255,.18)';
      ctx.fillRect(x - fs * 0.15, y - fs * 0.45, fs * 0.3, fs * 0.9);
    }
    if (G.ammo === 0 && G.reloadT <= 0 && Math.floor(now() / 300) % 2) text('RELOAD  (R / shoot off-screen)', F.x + F.w / 2, F.y + F.h * 0.93 + F.h * 0.035, fs * 0.8, '#ffb347');
  }

  function drawScene(tm) {
    drawBackdrop(tm);
    const st = G.state;
    if (st === 'title') {
      text('GUN ARCADE', F.x + F.w / 2, F.y + F.h * 0.25, F.h * 0.14, '#ffe27a');
      text('shoot a target to choose', F.x + F.w / 2, F.y + F.h * 0.38, F.h * 0.035, '#bcaee0', 'center', 500);
      for (const m of G.menu) {
        const x = F.x + m.fx * F.w, y = F.y + m.fy * F.h;
        drawBulls(x, y, m.r * F.h); text(m.label, x, y + m.r * F.h * 1.35, F.h * 0.045, '#fff');
      }
      text(`best ${G.best}   ·   mode: ${S.mode === 'gun' ? 'light gun' : 'mouse'}   ·   Tab for setup`, F.x + F.w / 2, F.y + F.h * 0.95, F.h * 0.028, '#8f82b5', 'center', 500);
    } else if (st === 'mode') {
      G.mode.draw(tm);
    } else if (st === 'calib') {
      const c = G.calib, p = CAL_PTS[c.i] || CAL_PTS[0];
      text('Shoot the target', F.x + F.w / 2, F.y + F.h * 0.3, F.h * 0.05, '#fff');
      text(`${c.i + 1} / ${CAL_PTS.length}`, F.x + F.w / 2, F.y + F.h * 0.37, F.h * 0.035, '#bcaee0', 'center', 500);
      drawBulls(p[0] * W, p[1] * H, F.h * 0.07);
    } else {
      for (const t of G.targets) drawTarget(t, tm);
      drawHUD();
      if (st === 'over') {
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(F.x, F.y, F.w, F.h);
        text('TIME UP', F.x + F.w / 2, F.y + F.h * 0.25, F.h * 0.12, '#ffe27a');
        text(String(G.score), F.x + F.w / 2, F.y + F.h * 0.45, F.h * 0.14, '#fff');
        text(G.newBest ? 'NEW BEST!' : 'best ' + G.best, F.x + F.w / 2, F.y + F.h * 0.58, F.h * 0.05, G.newBest ? '#7dffb0' : '#bcaee0');
        text(`accuracy ${G.shots ? Math.round((100 * G.hits) / G.shots) : 0}%`, F.x + F.w / 2, F.y + F.h * 0.66, F.h * 0.04, '#bcaee0', 'center', 500);
        if (now() - G.overAt > 1200) text('shoot to continue', F.x + F.w / 2, F.y + F.h * 0.8, F.h * 0.045, '#fff');
      }
    }
    for (const p of G.parts) { ctx.globalAlpha = 1 - p.t / p.life; ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.3); ctx.fill(); }
    ctx.globalAlpha = 1;
    for (const p of G.pops) { ctx.globalAlpha = 1 - p.t / 0.9; text(p.text, p.x, p.y - p.t * F.h * 0.12, F.h * 0.045, p.color); }
    ctx.globalAlpha = 1;
    if (G.msgT > 0) text(G.msg, F.x + F.w / 2, F.y + F.h * 0.52, F.h * 0.06, '#fff');
  }

  function drawGunStatus() {
    if (S.mode !== 'gun' || (G.state !== 'title' && G.state !== 'calib')) return;
    const seen = now() - gun.lastSeen < 150;
    const [msg, col] = !gun.stream ? ['camera off: press Tab, then Start camera', '#ff9b6b']
      : seen && gun.bridged ? ['border lost: following the camera\'s motion until it returns', '#ffb347']
      : seen ? [`border found   raw aim ${gun.u.toFixed(2)}, ${gun.v.toFixed(2)}   camera ${gun.fps} fps   screen ${perf.fps} fps`, '#7dffb0']
      : [({ nothing: 'border LOST: nothing bright enough in view. Aim at the screen, or raise Exposure / lower Threshold (Tab)',
            edge: 'border LOST: it runs off the edge of the camera view. Step back, or aim nearer the middle',
            solid: 'border LOST: a solid bright shape (game graphics merged with the border, or a lamp) hides it' })[trk.fail] || 'border LOST: the camera must see the whole white border', '#ff6b6b'];
    text(msg, F.x + F.w / 2, F.y + F.h * 0.885, F.h * 0.03, col, 'center', 600);
  }

  function drawCrosshair() {
    const lost = S.mode === 'gun' && aim.off;
    if (!S.crosshair && !lost) return;
    if (lost && (aim.x < 0 || aim.x > W || aim.y < 0 || aim.y > H)) return;
    const r = F.h * 0.028;
    ctx.globalAlpha = lost ? 0.45 : 1;
    ctx.strokeStyle = lost ? '#ff5a5a' : G.flash > 0 ? '#fff' : '#3dffb0'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(aim.x, aim.y, r * (1 + G.flash * 0.5), 0, 6.3);
    ctx.moveTo(aim.x - r * 1.5, aim.y); ctx.lineTo(aim.x - r * 0.4, aim.y); ctx.moveTo(aim.x + r * 0.4, aim.y); ctx.lineTo(aim.x + r * 1.5, aim.y);
    ctx.moveTo(aim.x, aim.y - r * 1.5); ctx.lineTo(aim.x, aim.y - r * 0.4); ctx.moveTo(aim.x, aim.y + r * 0.4); ctx.lineTo(aim.x, aim.y + r * 1.5);
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  function draw(tm) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(F.x, F.y, F.w, F.h); ctx.clip();
    if (G.shake > 0) ctx.translate(rnd(-1, 1) * G.shake * 10, rnd(-1, 1) * G.shake * 10);
    drawScene(tm);
    if (S.mode === 'gun') { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(F.x, F.y, F.w, F.h); }   // dim the game so the pure-white border stands out to the camera
    drawGunStatus();
    drawCrosshair();
    ctx.restore();
    // The tracked border: pure white, flush with the screen edge, black gap inside.
    if (S.mode === 'gun' || showBorder) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, bw); ctx.fillRect(0, H - bw, W, bw); ctx.fillRect(0, 0, bw, H); ctx.fillRect(W - bw, 0, bw, H);
    }
  }
  let showBorder = false, panelOn = true, autoHid = false;

  // ---------- loop ----------
  const perf = { fps: 0, frames: 0, t: 0 };
  let last = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    perf.frames++; if (t - perf.t > 1000) { perf.fps = Math.round((perf.frames * 1000) / (t - perf.t)); perf.frames = 0; perf.t = t; }
    pollCamera(t); updateAim(t); update(dt); draw(t / 1000);
    if (serialGun) serialGun.setPosition(clamp(aim.x / W, 0, 1), clamp(aim.y / H, 0, 1));   // keeps the gun reporting buttons
    if (!autoHid && serialGun && gun.stream) { panelOn = false; autoHid = true; }   // gun clicks follow the aim, so keep buttons out of the way
    if (!serialGun) autoHid = false;
    $('panel').classList.toggle('hidden', !panelOn || G.state === 'play' || G.state === 'mode');   // never cover the playfield mid-round
    requestAnimationFrame(frame);
  }

  // ---------- input ----------
  cv.addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  cv.addEventListener('pointerdown', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (e.button === 2) { reload(); return; }
    if (e.button === 0) fire();
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); panelOn = !panelOn; }
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) fire(); }
    else if (e.key === 'r' || e.key === 'R') reload();
    else if (e.key === 'b' || e.key === 'B') showBorder = !showBorder;
    else if (e.key === 'Escape' && G.state !== 'title') toTitle();
  });

  // ---------- panel ----------
  function syncPanel() {
    $('mode').value = S.mode; $('thr').value = S.threshold; $('exp').value = S.exposure;
    $('recoil').checked = S.recoil; $('recoilStr').value = S.recoilStr;
    $('smooth').value = Math.round((1 - S.alpha) * 100);
    $('auto').checked = S.auto; $('thr').disabled = S.auto;
    $('lensInfo').textContent = S.k1 ? `lens k1 ${S.k1.toFixed(3)}` : 'lens: none';
    $('flipX').checked = S.flipX; $('flipY').checked = S.flipY; $('xhair').checked = S.crosshair;
    $('gunOnly').style.display = S.mode === 'gun' ? '' : 'none';
  }
  $('mode').onchange = (e) => { S.mode = e.target.value; saveS(); syncPanel(); if (S.mode === 'gun') autoConnect(); };
  $('startCam').onclick = startCam;
  $('wake').onclick = () => wakeGun();

  // Light gun mode: start the Sinden camera and serial link without the setup panel.
  const isSinden = (o) => /sinden|lightgun/i.test(o.textContent);
  async function autoConnect() {
    if (S.mode !== 'gun') return;
    if (!gun.stream) {
      await listCams();
      let opt = [...$('cams').options].find(isSinden);
      if (!opt) { await startCam(); opt = [...$('cams').options].find(isSinden); }   // camera names stay hidden until permission is given
      if (opt && (!gun.track || gun.track.getSettings().deviceId !== opt.value)) { $('cams').value = opt.value; await startCam(); }
      else if (!opt) setStatus('Sinden camera not found, using the selected camera');
    }
    if (!serialGun && navigator.serial) await wakeGun(true);
  }
  // The first time, the browser only shows its serial chooser after a click.
  document.addEventListener('pointerdown', () => { if (S.mode === 'gun' && !serialGun && navigator.serial) wakeGun(true).then((r) => { if (r === false) wakeGun(); }); }, { once: true });
  if (navigator.serial) navigator.serial.addEventListener('connect', () => { if (S.mode === 'gun' && !serialGun) wakeGun(true); });
  const pushRecoil = () => { if (serialGun) serialGun.setRecoil(S.recoil ? { strength: S.recoilStr } : null).catch(() => {}); };
  $('recoil').onchange = (e) => { S.recoil = e.target.checked; saveS(); pushRecoil(); };
  $('recoilStr').onchange = (e) => { S.recoilStr = +e.target.value; saveS(); pushRecoil(); };
  $('thr').oninput = (e) => { S.threshold = +e.target.value; setTrk({ threshold: S.threshold }); saveS(); };
  $('exp').oninput = (e) => { S.exposure = +e.target.value; saveS(); applyExposure(); };
  $('auto').onchange = (e) => { S.auto = e.target.checked; setTrk({ auto: S.auto }); $('thr').disabled = S.auto; if (!S.auto) $('thrVal').textContent = ''; saveS(); };
  $('fitLens').onclick = startLensFit;
  $('smooth').oninput = (e) => { S.alpha = 1 - (+e.target.value) / 100; setTrk({ alpha: S.alpha }); saveS(); };
  $('flipX').onchange = (e) => { S.flipX = e.target.checked; setTrk({ flipX: S.flipX }); saveS(); };
  $('flipY').onchange = (e) => { S.flipY = e.target.checked; setTrk({ flipY: S.flipY }); saveS(); };
  $('xhair').onchange = (e) => { S.crosshair = e.target.checked; saveS(); };
  $('fs').onclick = () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); };
  syncPanel();

  // What a mode needs from the engine.
  window.Engine = {
    get ctx() { return ctx; }, get F() { return F; }, get W() { return W; }, get H() { return H; }, aim, S, G,
    sfx, tone, noise, text, rnd, clamp, now, store, say,
    addParts, pop,
    shotFx() { G.flash = 1; sfx.shot(); if (serialGun) serialGun.fireRecoil(); },
    drawBulls, shake(v = 1) { G.shake = Math.max(G.shake, v); },
    register(m) { modes.push(m); toTitle(); },
    exitMode: () => toTitle(),
  };

  startWorker();

  // test hook for headless checks
  window.__gallery = { G, S, aim, mouse, updateAim, trigger, fire, onGunEvent, startGame, startCalib, toTitle, update, gun, tracker, startMode, modes, get worker() { return !!worker; }, perf, startLensFit, setMode(m) { S.mode = m; } };

  toTitle();
  autoConnect();
  requestAnimationFrame(frame);
})();

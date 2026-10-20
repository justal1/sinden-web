// Sinden lightgun serial link over Web Serial: wakes the gun up (handshake, button map,
// button reports) so the trigger works without any vendor driver.
//
// The protocol is ported from sindenrs by Chaz Schlarp (MIT) https://github.com/schlarpc/sindenrs
// and its macOS fork https://github.com/TheBrinkOfTomorrow/sindenrs-macos, which worked it out
// clean-room. Copyright (c) 2026 Chaz Schlarp, MIT License. Only the wire protocol is used here;
// nothing comes from the vendor's software.
//
// Wire format: every host->gun message is 7 bytes `AA cmd p1 p2 p3 p4 BB`. Replies are raw
// bytes whose length depends on the command. Button reports arrive as `FE state1 state2 96`
// once "secondary serial output" (cmd 50) is on; bit 0 of state1 is the trigger.
(function (root) {
  'use strict';

  const CMD = {
    SECONDARY_SERIAL_ON: 50, OFFSCREEN_RELOAD_OFF: 55, BUTTON_MAP: 60, FIRMWARE_VERSION: 101,
    AUTH_HOST_CHALLENGE: 109, AUTH_GUN_CHALLENGE: 110, STREAM_START: 121,
    RECOIL_ENABLE: 161, RECOIL_AUTO_PARAMS: 162, RECOIL_TRIGGER_MODE: 163, RECOIL_EVENTS: 164,
    RECOIL_BUTTONS: 165, RECOIL_STRENGTH: 167, RECOIL_TEST_SHOT: 168, RECOIL_TIMING: 171,
    RECOIL_STRENGTH_EXT: 172, POSITION: 40, CAMERA_NAME_READ: 102, UNIQUE_ID: 111, CALIBRATION_MODE_ENABLE: 180, RECOIL_TOGGLE_ENABLE: 181,
    JOYSTICK_MODE: 182, LOW_RESOURCE_MODE: 183,
  };
  // Fixed constants shared by every driver build; there is no per-device key.
  const GUN_SECRET = 'SindenLightgun364294735243894HaveANiceDay';
  const HOST_SECRET = '60341663085532170074617363215964';
  const BAUD = 115200;
  // The gun absorbs config frames slowly (the button map appears to be written to EEPROM, which
  // takes ~3 ms per byte), so frames sent back to back overrun its tiny receive buffer and it
  // loses sync and stops answering until it is power-cycled. 15 ms between frames is reliable.
  const PACE_MS = 15;
  const SINDEN_USB_VENDOR = 0x16c0;
  // Button action bytes the gun expects (Arduino keycodes plus the vendor's private range).
  const ACTION = { none: 0, mouse_left: 255, mouse_middle: 254, mouse_right: 253 };
  // Slot order of the 10 physical controls in the button map.
  const SLOTS = ['trigger', 'front_left', 'rear_left', 'front_right', 'rear_right', 'up', 'down', 'left', 'right', 'pump'];

  const enc = new TextEncoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = (cmd, p = [0, 0, 0, 0]) => Uint8Array.of(0xaa, cmd, p[0], p[1], p[2], p[3], 0xbb);
  const flag = (cmd, on) => frame(cmd, [on ? 1 : 0, 0, 0, 0]);

  async function sha256(...parts) {
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  }
  const gunResponse = (nonce) => sha256(nonce, enc.encode(GUN_SECRET));   // what the gun must answer to our nonce
  const hostResponse = (challenge) => sha256(challenge, enc.encode(HOST_SECRET));  // what we answer to its challenge
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // The 41 command-60 frames: on-screen action per slot (100+), off-screen (110+),
  // modifiers (120+, 130+), pedal (140). `map` is {slotName: [onscreen, offscreen]} of action names.
  function buttonFrames(map) {
    const val = (name) => (name in ACTION ? ACTION[name] : 0);
    const out = [];
    const f = (slot, v) => out.push(frame(CMD.BUTTON_MAP, [0, slot, 0, v]));
    SLOTS.forEach((s, i) => f(100 + i, val((map[s] || [])[0] || 'none')));
    SLOTS.forEach((s, i) => f(110 + i, val((map[s] || [])[1] || 'none')));
    SLOTS.forEach((s, i) => f(120 + i, 0));
    SLOTS.forEach((s, i) => f(130 + i, 0));
    f(140, 0);
    return out;
  }

  // Incremental parser for gun->host event bytes.
  function createEventParser() {
    let pending = [];
    return {
      feed(bytes) {
        pending.push(...bytes);
        const out = []; let i = 0;
        while (i < pending.length) {
          const b = pending[i];
          if (b === 254) {
            if (pending.length < i + 4) break;           // wait for the rest of the report
            out.push({ type: 'buttons', state1: pending[i + 1], state2: pending[i + 2] });
            i += 3;
          } else if (b === 200) out.push({ type: 'calibration-enter' });
          else if (b === 201) out.push({ type: 'calibration-set' });
          else if (b === 202) out.push({ type: 'calibration-exit' });
          else if (b === 120) out.push({ type: 'trigger-enabled' });
          else out.push({ type: 'unknown', byte: b });
          i++;
        }
        pending = pending.slice(i);
        return out;
      },
    };
  }

  // The button map this game wants: trigger = left click, pump and front-left = right click
  // (reload). Off-screen actions match on-screen ones because the game, not the gun, decides
  // what "off-screen" means.
  const GAME_BUTTONS = { trigger: ['mouse_left', 'mouse_left'], front_left: ['mouse_right', 'mouse_right'], pump: ['mouse_right', 'mouse_right'] };

  class SindenSerial {
    // port: a Web Serial SerialPort (or anything with open/readable/writable/setSignals/close).
    constructor(port, { onEvent = () => {}, onLog = () => {}, onRaw = null } = {}) {
      this.port = port; this.onEvent = onEvent; this.log = onLog; this.onRaw = onRaw;
      this.buf = []; this.mode = 'query'; this.parser = createEventParser();
      this.firmware = null; this.recoilOn = false;
    }

    async open() {
      await this.port.open({ baudRate: BAUD });
      try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this._pump();
    }

    async _pump() {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (!value || !value.length) continue;
          if (this.onRaw) this.onRaw('rx', value);
          if (this.mode === 'events') for (const ev of this.parser.feed(value)) this.onEvent(ev);
          else { this.buf.push(...value); if (this._wake) this._wake(); }
        }
      } catch (e) { this.log('serial read ended: ' + e.message); }
      this.onEvent({ type: 'closed' });
    }

    write(bytes) {
      if (this.onRaw) this.onRaw('tx', bytes);
      this.writesIssued = (this.writesIssued || 0) + 1;
      return this.writer.write(bytes).then(() => { this.writesDone = (this.writesDone || 0) + 1; });
    }
    drain() { this.buf.length = 0; }

    async readExact(n, ms = 2000) {
      const end = performance.now() + ms;
      while (this.buf.length < n) {
        const left = end - performance.now();
        if (left <= 0) throw new Error(`gun did not answer (wanted ${n} bytes, got ${this.buf.length})`);
        await new Promise((res) => { this._wake = res; setTimeout(res, left); });
      }
      return Uint8Array.from(this.buf.splice(0, n));
    }

    // Both legs of the handshake; streaming and button reports are refused until it succeeds.
    async authenticate() {
      this.drain();
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const msg = new Uint8Array(7 + 32);
      msg.set(frame(CMD.AUTH_GUN_CHALLENGE)); msg.set(nonce, 7);       // one write: command + payload together
      await this.write(msg);
      const reply = await this.readExact(32);
      if (!same(reply, await gunResponse(nonce))) throw new Error('gun failed authentication (is this a Sinden gun?)');
      this.drain();
      await this.write(frame(CMD.AUTH_HOST_CHALLENGE));
      const challenge = await this.readExact(32);
      await this.write(await hostResponse(challenge));
      const verdict = new TextDecoder().decode(await this.readExact(5)).trim();
      if (verdict !== 'true') throw new Error(`gun rejected the handshake (replied "${verdict}")`);
    }

    // Everything that arrives until the line has been quiet for quietMs (or max bytes / timeout).
    async readUntilQuiet(max = 64, quietMs = 60, timeoutMs = 500) {
      const end = performance.now() + timeoutMs; let lastLen = 0, lastChange = performance.now();
      while (performance.now() < end && this.buf.length < max) {
        if (this.buf.length !== lastLen) { lastLen = this.buf.length; lastChange = performance.now(); }
        else if (lastLen > 0 && performance.now() - lastChange >= quietMs) break;
        await sleep(5);
      }
      return Uint8Array.from(this.buf.splice(0, max));
    }

    // The reference probe reads these before configuring; kept optional to bisect firmware quirks.
    async identify() {
      this.drain(); await this.write(frame(CMD.CAMERA_NAME_READ));
      const name = new TextDecoder().decode(await this.readExact(15, 500)).trim();
      this.drain(); await this.write(frame(CMD.UNIQUE_ID));
      const id = [...(await this.readUntilQuiet())].join('');
      return { name, id };
    }

    async firmwareVersion() {
      this.drain(); await this.write(frame(CMD.FIRMWARE_VERSION));
      const [maj, min] = await this.readExact(2, 500);
      return `${maj}.${min}`;
    }

    // Wake the gun: handshake (with one unwedge retry), config, button reports, streaming.
    async wake({ recoil = null, probeLike = false } = {}) {
      this.mode = 'query';
      try { await this.authenticate(); }
      catch (e) {
        // A command that reached the gun without its 32-byte payload leaves it waiting for exactly that.
        this.log('handshake failed (' + e.message + '), trying to unwedge');
        await this.write(new Uint8Array(32)); await sleep(500); this.drain();
        await this.authenticate();
      }
      try { this.firmware = await this.firmwareVersion(); } catch { this.firmware = null; }
      if (probeLike) { try { this.ident = await this.identify(); this.log('camera ' + this.ident.name + ', id ' + this.ident.id); } catch (e) { this.log('identify failed: ' + e.message); } }
      await this.configure({ recoil });
      this.drain(); this.mode = 'events';
    }

    async configure({ recoil }) {
      const tx = async (b) => { await this.write(b); await sleep(PACE_MS); };   // every config frame is paced
      await tx(frame(CMD.OFFSCREEN_RELOAD_OFF));
      for (const f of buttonFrames(GAME_BUTTONS)) await tx(f);
      await this.setRecoil(recoil);
      await tx(flag(CMD.CALIBRATION_MODE_ENABLE, false));
      await tx(frame(CMD.SECONDARY_SERIAL_ON));                // gates the gun's button reports
      await tx(flag(CMD.RECOIL_TOGGLE_ENABLE, false));
      await tx(flag(CMD.JOYSTICK_MODE, false));
      await tx(flag(CMD.LOW_RESOURCE_MODE, false));
      await this.write(frame(CMD.STREAM_START)); await sleep(150); await this.write(frame(CMD.STREAM_START));
      await tx(frame(CMD.SECONDARY_SERIAL_ON));                // the reference probe asserts this again after streaming starts
    }

    // recoil: null = make sure it's off; {strength: 0-100} = on, fired manually per shot.
    async setRecoil(recoil) {
      const gap = () => sleep(PACE_MS);
      if (!recoil) { await this.write(flag(CMD.RECOIL_ENABLE, false)); await gap(); this.recoilOn = false; return; }
      const level = Math.min(250, Math.round(Math.min(100, recoil.strength) * 2.5));
      const burst = [
        frame(CMD.RECOIL_AUTO_PARAMS, [40, 0, 40, 13]), flag(CMD.RECOIL_ENABLE, true),
        frame(CMD.RECOIL_STRENGTH, [level, 0, 0, 0]), flag(CMD.RECOIL_TRIGGER_MODE, false),
        frame(CMD.RECOIL_EVENTS, [0, 0, 0, 0]), frame(CMD.RECOIL_BUTTONS, [0, 0, 0, 0]),   // no automatic kicks: the game fires them
        frame(CMD.RECOIL_TIMING, [4, 4, 4, 0]), flag(CMD.RECOIL_ENABLE, true),
        frame(CMD.RECOIL_STRENGTH_EXT, [level, 0, 0, 0]),
      ];
      for (const f of burst) { await this.write(f); await gap(); }
      this.recoilOn = true;
    }

    // Tell the gun where it is pointing (u, v in 0..1 of the screen). The gun only reports
    // buttons while it is being fed positions, and uses them for its own HID mouse.
    // Skips a frame if the previous write is still in flight rather than queueing up.
    setPosition(u, v) {
      if (this.mode !== 'events' || this._posBusy) return;
      const ax = (t) => Math.max(0, Math.min(32767, Math.round(t * 32767)));
      const x = ax(u), y = ax(v);
      this._posBusy = true; this.positionsSent = (this.positionsSent || 0) + 1;
      this.write(frame(CMD.POSITION, [x >> 8, x & 255, y >> 8, y & 255])).catch(() => {}).finally(() => { this._posBusy = false; });
    }

    fireRecoil() { if (this.recoilOn && this.mode === 'events') return this.write(frame(CMD.RECOIL_TEST_SHOT)); }

    async close() {
      try { if (this.mode === 'events') await this.write(flag(CMD.RECOIL_ENABLE, false)); } catch {}
      this.mode = 'closed';
      try { await this.reader.cancel(); } catch {}
      try { this.reader.releaseLock(); } catch {}
      // Position frames may still be queued: abort them, or the stream stays locked and the port cannot close.
      try { await this.writer.abort(); } catch {}
      try { this.writer.releaseLock(); } catch {}
      try { await this.port.close(); } catch {}
    }
  }

  // Find the gun's serial port: a previously granted one, else ask the user (needs a click).
  // With ask=false it only returns an already granted port (no click needed), else null.
  // force=true always shows the chooser, so a different port can be picked than the one granted before.
  async function pickPort(ask = true, force = false) {
    const filters = [{ usbVendorId: SINDEN_USB_VENDOR }];
    const granted = (await navigator.serial.getPorts()).filter((p) => (p.getInfo().usbVendorId === SINDEN_USB_VENDOR));
    return (!force && granted[0]) || (ask ? navigator.serial.requestPort({ filters }) : null);
  }

  const api = { SindenSerial, pickPort, buttonFrames, createEventParser, gunResponse, hostResponse, frame, CMD, GAME_BUTTONS };
  if (typeof module !== 'undefined') module.exports = api;
  root.SindenGun = api;
})(typeof window !== 'undefined' ? window : globalThis);

# Gun Arcade (gallery + Point Blank)

> **Unofficial and experimental.** Not affiliated with or endorsed by Sinden Technology. It talks to the gun
> over Web Serial and writes a button map to it, which I suspect lands in the gun's EEPROM. Use at your own
> risk. If a gun stops answering, unplug and replug it.
>
> **Status.** Developed on macOS (Apple Silicon), Chrome, one gun (firmware 1.9, camera `16d0:1097`).
> Verified on the real gun: serial handshake, trigger and button reports, position streaming, camera aim.
> Not yet verified on the real gun: the whole game over a long session, frame rate, recoil, Point Blank feel.
> Needs Chrome or Edge (Web Serial + camera). Firefox and Safari won't work.

Carnival shooting gallery for a mouse or a Sinden-style light gun, in a single browser page
(Chrome). The game draws its own white border and reads the gun's camera itself, so no Sinden
driver is needed. Open `index.html` in Chrome (file:// works; camera needs a user click).

## Point Blank mode
Shoot the POINT BLANK target on the title screen. A run is a string of short challenges, three lives, eight stages
per loop (then faster and smaller): shooting range, can crush (limited ammo), balloon pop (avoid bombs), clay pigeons,
shoot 1..n in order, high noon (shoot bandits, spare civilians), robot boss (only the glowing core hurts), colour code.
Clear a stage = 1000 + time bonus. Aiming off-screen does nothing in this mode (unlimited ammo).
`minigames.js` plugs into the engine via `window.Engine`; add a mode with `Engine.register({id,label,start,update,draw,shot})`.
Tests: `selftest.html#pb` (every stage must be winnable by a perfect bot and losable by an idle one at levels 1, 3, 6).

## Play
- Mouse mode: click to shoot, right-click or R to reload, Tab toggles the setup panel.
- Shoot a target on the title screen to start or calibrate. Esc returns to the title.
- Ducks 10, bullseyes 25, gold stars 50 (+3s). Bombs: -30 and -3s. Combo multiplier up to x5.

## Light gun
1. Plug the gun in, set "Aim with" to Light gun, click **Wake gun (serial)** (pick the usbmodem port the
   first time), then pick the camera and Start camera. Waking the gun is what makes the trigger work:
   the gun sends no button events until a host runs the handshake and sends its button map (`gun.js`).
2. Pure white border should appear around the screen; the debug view shows the detected quad (green).
3. Tune Threshold / Exposure until the border is found reliably; dim room helps. Flip X/Y if aim is mirrored.
4. Shoot CALIBRATE on the title screen (5 shots).
- Trigger arrives both as a serial report and as the left click the button map produces; the game counts it once.
  Pump / front-left buttons reload. Aiming off-screen and firing also reloads.
- Recoil (if the gun has it): tick the box in the panel; the game fires a kick per shot.
- The gun's HID cursor is ignored; aim comes from the camera.

## Files
- `tracker.js`  border detection + homography (pure functions)
- `gun.js`      Web Serial link: handshake, button map, button reports, recoil (protocol ported from sindenrs, MIT)
- `gun-test.html` protocol tests against known answers + a mock gun
- `input-test.html` logs every mouse/key/gamepad/serial event (diagnostics)
- `game.js`     game, gun input, calibration
- `test.html`   tracker tests on synthetic frames; `selftest.html` game logic tests (+ `#cam` scene for a fake webcam)
- Run tests: headless Chrome `--dump-dom` (no node on this machine).

## Tracking method
Border blob -> outer silhouette -> lens undistortion (division model, `k1`) -> four fitted lines -> intersected
corners -> homography. Threshold is automatic by default (half-way between the room and the border's own
peak brightness); untick Auto threshold for a manual value (the debug view tints pixels above the threshold green).
"Fit lens" estimates `k1` for your camera from live frames (move the gun around, border in view, 7 s).
Informed by the sindenrs notes (barrel distortion bows edges ~10 px; corners from lines, not extreme pixels).
Synthetic tests: aim error 0.23% -> 0.03% of screen width with lens correction.

## Performance
Camera frames are handled in a worker thread (tracker.js is rebuilt inside a Blob worker, since file:// pages can't load
worker files); the main thread only draws. Falls back to the main thread if workers/OffscreenCanvas are missing.
The canvas pixel count is capped on big Retina screens. The panel status shows camera fps, tracker ms and screen fps.

## Gun quirk worth knowing
Config frames must be paced (15 ms apart, `PACE_MS` in gun.js). Sent back to back, the gun (firmware 1.9) loses
sync after the button map and stops answering until it is unplugged and replugged; it looked like a stall
about a second into the position stream. Hypothesis: the map is written to EEPROM (~3 ms per byte).
Found by staged bisecting with a native probe; with pacing the trigger (left click + serial report `fe 01 00 96`),
the right-click buttons and the 60 Hz position stream all work. Clicks land at the aim position the host
streams (positions are what put the HID cursor there).

## Things to try (untested ideas, reports welcome)
- **Chromebooks / ChromeOS.** Should work in principle: Chrome there has Web Serial and `getUserMedia`, and the gun is a
  standard UVC + CDC serial + HID device. Untested. Watch for: slow CPUs (check the camera/tracker/screen fps in the
  panel), managed devices whose policy blocks Web Serial or the camera, USB-C-only ports needing an adapter, dim or
  glossy screens making the border harder to find (tune Threshold / Exposure), and the gun's own HID cursor
  jumping around (the game ignores it for aim). Android is unlikely to work (no Web Serial there).
- **Windows / Linux.** Same browser features should work, but only macOS has been tried. Sinden's own driver
  will also grab the gun there, so close it first or only one program gets the serial port.
- **Browser emulators (JSNES, EmulatorJS, Nostalgist.js / RetroArch cores).** The tracker gives a screen position and
  the trigger gives a click, which is all a Zapper / Super Scope / Menacer core needs. Idea: draw the white border
  around the emulator canvas and feed the tracked aim in as its pointer position (API call or synthetic mouse events).
  The emulator must be in the same page or a same-origin iframe (synthetic events can't cross origins). Bring your own
  ROMs; none are included. Camera latency on top of the emulator's may hurt timing-sensitive Zapper games.
- **Other guns.** Anything that is a camera plus a way to report the trigger could use the tracker; only the Sinden
  handshake in `gun.js` is gun-specific.

## Credits and licensing
MIT licensed (see `LICENSE`); third-party notices in `THIRD_PARTY.md`.

The serial protocol (frame format, handshake, button map, event format, recoil commands) comes from
sindenrs by Chaz Schlarp (MIT, https://github.com/schlarpc/sindenrs) and the macOS fork
https://github.com/TheBrinkOfTomorrow/sindenrs-macos. Nothing is taken from Sinden's own software, whose
license forbids decompiling it.

## Not verified on real hardware
Chrome's access to the camera's exposure control, real latency, and the whole game with the live gun
(the native probe confirmed the serial protocol, pacing, trigger and buttons on the real gun). Only one program can hold the gun's serial
port: close other tabs/tools that opened it (e.g. input-test.html).

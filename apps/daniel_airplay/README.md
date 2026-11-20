# AirPlay Mirror (iDrive 7)

Shows your iPhone's screen on the centre display through iOS **Screen Mirroring**,
over the car's own Wi-Fi hotspot, **only while the car is parked**. Video only for now.

It is two components in this repo:

| Component | Path | What it is |
|---|---|---|
| **AirPlay receiver** (`daniel-airplay`, tool) | `tools/daniel-airplay/` | A system service. It advertises the car as an AirPlay receiver on the hotspot, does the AirPlay handshake (pairing, FairPlay), decrypts the H.264 stream and decodes it into mgu-render's video file `/dev/shm/mgu-video-daniel-airplay`. |
| **AirPlay Mirror** (`daniel_airplay`, app) | `apps/daniel_airplay/` | The tile and pages. It shows the receiver's state and draws the picture through mgu-render, gated on vehicle speed. |

The app `requires` the tool and `needs` a renderer, so the Store installs those with it.

## Install

1. Push this repo to GitHub. If it's already a source in the Store, its next check offers the new apps.
2. Store → **AirPlay Mirror** → Install. This also installs *AirPlay receiver* and, if missing, *mgu-render*.
3. **Restart the head unit** (Store → Settings → Restart head unit). A new tool's service starts at the next boot, and mgu-render's in-page (embed) drawing also needs a restart after mgu-render's first install.

## Use

1. Park. The iPhone must be on the car's Wi-Fi (`DIRECT-BMW…`). With wireless CarPlay it already is.
2. iPhone: Control Centre → **Screen Mirroring** → **BMW**.
3. In the car: Apps → **AirPlay Mirror** → **Show phone screen**.

The receiver's name is `BMW`. To change it, edit `name` in `/var/opt/daniel-airplay/data/config.json` and restart the service (the control socket also takes `{"cmd":"rename","name":"…"}`).

**Safety.** The picture is drawn only while Vehicle2's speed reads below 3 km/h with a reading less than 3 s old. When the car moves, or the speed signal goes quiet, the picture goes and the app returns to its main page. The phone stays connected, and **Show phone screen** works again once you've stopped.

## How it works

```
iPhone ──Wi-Fi (wlan_bridge, 172.16.222.97)──► airplayd.js (Node 8, root)
   mDNS 5353/udp   "BMW" _airplay._tcp + _raop._tcp, hotspot only
   7100/tcp        RTSP control: /info, pair-setup/verify (Ed25519/X25519), fp-setup, SETUP
   7101/tcp        events      7102/tcp  video stream (AES-CTR H.264)
   7103/udp        timing      7104-7105/udp  audio (accepted, discarded)
        │ decrypted H.264 (pipe)
        ▼
   bin/airplay-video (static, runs as nobody) ──► /dev/shm/mgu-video-daniel-airplay (I420, 3 slots)
        ▲                                                   │
   bin/fairplay (static, nobody): unwraps the session key   ▼
                                               mgu-render ◄── AirPlay Mirror app (VIDEO op, embed page)
```

* **Firewall.** The service inserts two rules at the top of `ip filter input`, for `iifname "wlan_bridge"` only, tagged `comment "daniel-airplay"`. It re-checks them every 30 s, because a ruleset reload drops them, and removes them when it stops.
* **App ↔ tool.** `/run/daniel-airplay/ctl.sock` (0666) carries JSON lines. The state is also written to `/run/daniel-airplay/status.json`.
* **Decoding** is software (FFmpeg's H.264 decoder, statically linked). The receiver tells the phone its display is 1280×720, so a portrait phone sends about 332×720.

## First time on the car: what to check

Over SSH (mgu-store's `deploy/hu connect`):

```sh
systemctl status daniel-airplay
journalctl -u daniel-airplay -f            # "ready: "BMW" on port 7100 (172.16.222.97)"
nft -a list chain ip filter input | grep daniel-airplay
ss -lntup | grep -E ':(5353|7100|7101|7102|7103)\b'
cat /run/daniel-airplay/status.json
```

While mirroring, the journal shows `session: "<your iPhone>"`, `mirror: codec avc1…` and, every 10 s, `video: NN fps`.

**Not yet tested on a car.** These are the open questions, and the log will answer each:

| Question | What you'd see |
|---|---|
| Does iOS list "BMW" while wireless CarPlay is connected? | Nothing in the journal after `ready:` when you open Screen Mirroring. iOS may then hide other receivers on the CarPlay link. |
| Is UDP 5353 free to share on the unit? | `mdns: socket error: … EADDRINUSE` at start. |
| Does the firewall accept the rules? | `firewall: insert failed for …` |
| Is embed (in-page) drawing available? | The app log says `mgu-render: layer …` instead of `embed`. It still works, drawn over the page. |
| Is the decoder fast enough? | `video: NN fps` well under 30, or `dropped` counts rising. |

## Develop

```sh
# the tool (Linux or WSL; Node 8 like the car)
sh tools/daniel-airplay/native/build.sh          # rebuild bin/airplay-video and bin/fairplay (static, musl)
node tools/daniel-airplay/test/run-tests.js      # handshake, real decode into the frame file, ctl socket

# the app
cd apps/daniel_airplay
node tools/gen_rhmi.js && node tools/check.js    # screens + offline checks
node tools/sim.js                                # the parked gate against a fake HMI, tool and mgu-render
node tools/build.js --mgu-store <mgu-store checkout>   # pack with mgu-store's linker
```

## Licences

The tool is **GPL-3.0-or-later**, because `bin/fairplay` is built from *playfair* (the reverse-engineered FairPlay that every third-party AirPlay receiver uses, from RPiPlay, GPL-3). `bin/airplay-video` statically links FFmpeg 7.1.1 (LGPL-2.1+, `LICENSE.ffmpeg`), and `lib/nacl.js` is TweetNaCl.js (public domain). See `tools/daniel-airplay/LICENSE`. The app's `src/mgu_render_client.js` is mgu-store's MIT client.

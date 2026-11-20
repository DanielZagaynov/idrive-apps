# Cluster Themes (`daniel_themes`)

Puts a theme over the **whole instrument cluster** of an **iDrive 7** car, with
**live needles and readouts**: speed, engine rpm and gear from the car. The
first theme is **Christmas Wood**, from the render in
`assets/christmas_cluster.webp`.

It draws through **Cluster renderer** (`cluster-render`, from the Store
source robertnisipeanu/idrive-apps), on its `panel` target: 1920×720, the
whole cluster, over BMW's gauges. iDrive 8 has no whole-cluster target, so
the app is iDrive 7 only.

## How it stays safe

The theme covers the real speedometer, so it is shown **only while the car's
speed is known and fresh** (read or notified within 2.5 s). If the speed
stops coming (the car's interface goes, the renderer restarts, anything), the
theme is taken off and BMW's gauges show again. The rpm needle and the
readouts are drawn only from fresh values too. Warnings still take the
cluster: cluster-render takes everything off during a warning or with a door
open.

## What you see on the car

- The app starts with the head unit (`autostart`). The theme shows once the
  car sends a speed.
- Its tile, **Cluster Themes**, opens one page: what the theme is doing
  ("On the cluster", "Hidden: no speed from the car yet", "Waiting for
  Cluster renderer…") and **Turn theme off / on**, which is remembered.

## The clean plate (needed before installing)

The render has its needles, "60", "D" and "1,800" painted in. The app draws
those live, so it needs a copy of the same picture **without** them:

- remove both **needles**, but keep the round **hubs** they turn on;
- remove the **speed number** ("60"), the **gear letter** ("D") and the
  **rpm number** ("1,800");
- keep everything else: the scales and their numbers, "mph", "rpm",
  "×1000 rpm", the map, the garland, the bows and the ribbon, all in the same places.

Save it as `assets/christmas_plate.png` (any size with the same 8:3 shape,
2000×750 like the render is fine), then run `node tools/build_assets.js`.
Until it exists, `tools/check.js` and `tools/build.js` refuse to pass.

## Files

| Path | What |
|---|---|
| `themes/christmas.json` | the theme: its render and plate, each gauge's pivot and where its numbers sit (`points`: `[value, x, y]` in cluster pixels), the needle, the readouts' places, sizes and colour |
| `assets/` | the source pictures (the render; the plate once made) |
| `designer/index.html` | the preset designer (cluster, head unit, HUD); Christmas Wood shows the render exactly |
| `src/themes.js` | the app: the page, the setting, the show rule |
| `src/cluster.js` | the layers on cluster-render: plate, needles (turned and stretched to the numbers), hub caps, readouts |
| `src/car.js` | speed, rpm and gear from `Vehicle2`, `CDS` and `VehicleInformation`, scaled as BMW scales them, with how fresh each is |
| `src/png.js`, `src/glyphs.js` | reading the pictures and drawing the readouts' text on the car |
| `lib/cluster_render_client.js` | cluster-render's Node client, copied unchanged (MPL-2.0, `lib/MPL-2.0.txt`) |
| `package/assets/` | what the car loads, made by `tools/build_assets.js` (committed) |
| `tools/` | `build_assets.js`, `gen_rhmi.js`, `check.js`, `sim.js`, `build.js`, `pngenc.js` |

The digits are Barlow SemiBold (SIL Open Font License,
`package/assets/fonts/OFL-Barlow.txt`), from idrive7-apps' baked atlas,
widened and thickened per readout (`stretch`, `bold`) to match the render.

## Changing where things go

Everything is in `themes/christmas.json`, in cluster pixels (the render
scaled to 1920×720). After a change: `node tools/build_assets.js`, then
`node tools/sim.js` and look at `sim-out/`.

## Build and test

```sh
node tools/build_assets.js          # needs ffmpeg and ../ref-idrive7-apps (or --fonts <dir>)
node tools/check.js                 # offline checks (--allow-render-plate while there is no plate)
node tools/sim.js                   # the app against stand-ins; pictures in sim-out/
node tools/build.js --mgu-store ../../../mgu-store-ref   # packs daniel_themes@<v>.src.tgz with the Store's linker
```

`tools/sim.js` runs the real app code and the real cluster-render client
against a stand-in service that speaks its protocol and composes the layers
as placed, a scripted car and the page. It checks: hidden without a speed;
shown parked; each needle at the angle and length for 0, 35, 60 and 180 mph
and 780 to 7,000 rpm; taken off within 3.3 s when the car goes silent;
back when it returns; Turn theme off/on (and the saved setting); everything
made again after the renderer restarts.

## Not tested

- **Not run on a car.** Nothing here has been on a head unit or cluster.
- The car fields' **names and shapes through the oap-sdk's typed proxies**
  (`someipBuilders`) are taken from idrive7-apps, which reads them through its
  own SOME/IP binding; the app logs the first value of each field
  (`car: first ...`) so a car log shows what arrives.
- Whether these fields **answer reads** on a car (the freshness rule
  depends on it while standing still; without reads, a value seen once
  counts as fresh while its interface is there).
- How the KOMBI shows a `panel` scene: timing, the 3 s linger, whether BMW's
  own content holds the slot, and the telltales over it.
- The upload: the plate is 5.5 MB of pixels, sent once per connection, within
  cluster-render's budget; needles move by small `set` messages, readouts send
  only the columns that change, at most 4 times a second.
- Linked against BMW's real SDK: needs a donor app off the head unit
  (`node tools/build.js --mgu-store <checkout> --sdk <donor>`).

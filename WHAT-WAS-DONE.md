# What was done, and why

This file records how this starter repository was made: what was read in
[mgu-store](https://github.com/robertnisipeanu/mgu-store), what was learned
about building apps for it, what each file here is, how it was tested, and
what is still untested. For *using* the repo, see [README.md](README.md).

---

## 1. Reading mgu-store

The mgu-store repository was cloned (shallow, read-only) and these parts were
read:

| Read | What it gave |
|---|---|
| `README.md`, `CONTRIBUTING.md`, `AGENTS.md` | What the Store installs, the rules every app follows, the "updates in any order" principle |
| `docs/PUBLISHING.md` | The full app format: the three source layouts, `mgu-repo.json`, `mgu-app.json`, build scripts, tools, catalogs |
| `deploy/README.md` | What the car's deploy tool does with an app: source packages, packages built elsewhere, `package.json` fields (`mguHmi`, `mguInternet`, `mguAppStartType`), tool kits (`component.json`), iDrive 8 install behaviour |
| `native/mgu-render/README.md` | How apps draw custom graphics through the renderer |
| `native/mgu-python/README.md` | What the Python on the car is for |
| `apps/robertn_store/` | The Store app itself, the best worked example: its manifests, its `rhmiData`, `src/store.js` (app lifecycle) and `tools/gen_rhmi.js` (screen generator) |
| `tools/oap_link.js` | The linker the car uses to turn a source package into an installable app |

### What was learned

- **An app is a BMW OAP app**: JavaScript running on the head unit's
  **Node 8**. Its main class extends the oap-sdk's `OnlineApp`.
- **BMW's SDK is never shipped.** The car takes it from a stock BMW app
  already installed (the *donor*) and links your code against it when it
  installs your app.
- **Python on the car only runs build scripts** (`"build": {"python": ...}`),
  not apps. **Tailscale is not part of mgu-store**; it comes from another
  source. An app that needs internet sets `"internet": true` and gets it
  through the Store's uplink.
- **Screens are BMW's own widgets**, described in `rhmiData/uiDescriptions/`
  (`application.xml` + `uiDescription.json`), with words in
  `rhmiData/variantGroups/Common/texts/*.json` as string ids (`SID_...`).
- **iDrive 7 and iDrive 8 use different widgets.** From the Store's
  generator: iDrive 7 pages are `LT_State_Wide` with `LT_Button_1Row` buttons
  (text cell `Text`); iDrive 8 pages are `LT_State_Wide_List` with
  `LT_Button_MediaEntry_1Row` buttons (text cell `PrimaryText`), and iDrive 8
  pages must not have a `ParentState`.
- **Three ways to publish**: Releases (built `.tgz` files), Catalog
  (`catalog.json`), or Repo tree (`mgu-repo.json`, the car builds from
  source). The repo tree with a source package (`"build": "unit"`) is the
  simplest, and is how the Store publishes itself.
- **Rules**: a unique, prefixed id; `mguHmi` saying which head units; no SDK
  files and no built `javascript/app.js` in the repository; modules may only
  require each other (`'./file'`), the oap-sdk names listed in `sdk`, and
  Node builtins.

---

## 2. Choices made

| Choice | Why |
|---|---|
| Repo-tree layout with a source package | No build step on your side: push, add the source, install. The car's update follows the branch. |
| Modelled on the Store app | It is a working app on both head units; copying its structure is lower risk than guessing. |
| `manifest.json` and `permissions.json` copied unchanged from the Store | These declare the car interfaces the app may call. Trimming them risks a missing interface the SDK needs; unused entries cost nothing. |
| Screens written by a generator (`tools/gen_rhmi.js`) | Keeps ids, names, widgets and cells in step across the XML, the JSON and both head units, the same approach the Store uses. |
| One simple page: status line, counter, reset | Shows the three things every app needs: registering the tile, reacting to presses, writing text to the screen. |
| Supports both ID7 and ID8 | The Store does; the app detects which by a hidden label only the iDrive 8 description has. |
| Id `daniel_hello` | A prefixed id as the rules require. Rename it for your own apps (README, "Making it your own"). |
| Desktop simulator | The real SDK can't be in the repo, so a stand-in lets you test logic and screen names on your PC. |

---

## 3. Every file, explained

```
idrive-hello-apps/
├── README.md                    how to use the repo
├── WHAT-WAS-DONE.md             this file
├── .gitignore                   keeps build output and BMW SDK files out of git
├── mgu-repo.json                the source's list of components
└── apps/daniel_hello/
    ├── mgu-app.json
    ├── src/hello.js
    ├── package/
    │   ├── package.json
    │   ├── npm-shrinkwrap.json
    │   ├── manifest.json
    │   ├── permissions.json
    │   ├── config/base.json
    │   └── rhmiData/
    │       ├── application.json
    │       ├── uiDescriptions/ID7/{application.xml, uiDescription.json}
    │       ├── uiDescriptions/ID8/{application.xml, uiDescription.json}
    │       └── variantGroups/Common/
    │           ├── texts/{en_GB.json, en_US.json}
    │           └── images/hello_icon.png
    └── tools/
        ├── gen_rhmi.js
        ├── make_icon.js
        ├── check.js
        ├── sim.js
        └── build.js
```

### Repository level

- **`mgu-repo.json`**: tells the Store this repository holds one app,
  `daniel_hello`, at `apps/daniel_hello`, built on the car (`"build": "unit"`).
- **`.gitignore`**: ignores `*.tgz`/`*.mgu` build output, any built
  `javascript/app.js`, and `donor/`, where a BMW app copied off the car would
  go for local builds. That must never be committed.

### The app

- **`mgu-app.json`**: the source package manifest the car's deploy tool reads:
  id, version `0.1.0`, `tree: "package"`, the one module `src/hello.js`, and the
  two SDK names it uses (`OnlineApp`, `logging`).
- **`src/hello.js`**: the app. In order, it:
  1. extends `OnlineApp` and listens for `initialized`, `entryPointExecute`
     (tile pressed), `shutdown` and `error`;
  2. on start, finds its page `ST_Hello_Main` and the components
     `helloStatus`, `helloCount`, `helloReset`, and works out ID7 vs ID8;
  3. binds the buttons, both through each component's `action` event and the
     raw `userEvent`, with a 400 ms de-duplication, as the Store does, since a
     press can arrive both ways;
  4. registers the tile (entry point), maps it to the page, enables it, and
     calls `initialized()`;
  5. writes the texts (`_render`), using cell `Text` for labels and
     `Text`/`PrimaryText` for buttons depending on the head unit;
  6. writes everything again on `restoreHmi` (the HMI restarted) and when the
     page becomes visible;
  7. on shutdown, releases its bundles and exits.

  It uses only Node 8 syntax (no `?.` or `??`).

### `package/`: what gets installed

- **`package.json`**: name and version (must match `mgu-app.json`), `main:
  javascript/runner.js` (the car supplies that entry point from the donor),
  app limits (disk, CPU, memory), logging id `HELO`, `mguHmi: ["ID7","ID8"]`.
- **`npm-shrinkwrap.json`**: empty lock file, as the Store has.
- **`manifest.json`, `permissions.json`**: copied from the Store app (see
  choices above).
- **`config/base.json`**: empty config, as the Store has.
- **`rhmiData/application.json`**: the app description: four fresh random
  UUIDs (application, string bundle, resource bundle, entry point), the two UI
  descriptions, the text and image folders, and the entry point (tile) with
  title `SID_HELLO_TITLE` and icon `hello_icon.png`. The tile's menu position
  values were copied from the Store.
- **`uiDescriptions/ID7|ID8/`**: one page with a title, a 4-row status label
  and two buttons. iDrive 8 adds the hidden `helloHmiID8` label. Generated.
- **`texts/en_GB.json`, `en_US.json`**: `SID_HELLO_TITLE` "Hello",
  `SID_HELLO_HELLO` "Hello", `SID_HELLO_PRESS_ME` "Press me",
  `SID_HELLO_RESET` "Reset". Generated. English only.
- **`images/hello_icon.png`**: 140 × 140 tile icon (a white hand on
  transparent), 893 bytes. Generated.

### `tools/`: run on your computer, never on the car

- **`gen_rhmi.js`**: holds the page table (`STATES`) and writes the screen
  files and text files for both head units. Edit the table, run it.
- **`make_icon.js`**: draws the default icon with no dependencies (its own
  PNG encoder, 4× supersampled edges).
- **`check.js`**: offline checks: manifest rules (same as the car's linker),
  matching ids/versions across the three files, `mguHmi` present, no SDK or
  built bundle in the folder, every module compiles and only requires allowed
  names, no Node 9+ syntax, XML and JSON agree, ids unique, no `ParentState` on
  iDrive 8, every screen name used in `src/` exists, every string id has a
  text, the icon is a PNG under 128 KiB.
- **`sim.js`**: loads `src/hello.js` with a fake oap-sdk and fake HMI built
  from the app's own `uiDescription.json`, for ID7 and ID8: starts it, opens
  the tile, presses "Press me" three times (the first delivered twice) and
  Reset, prints the page after each step and checks the expected texts. A
  write to a cell the widget doesn't have fails, as it would on the car.
- **`build.js`**: regenerates, runs `check.js`, then packs the source package
  with mgu-store's own `tools/oap_link.js` (`--mgu-store <checkout>`). With
  `--sdk <donor>` it also links the full installable app as the car would.

---

## 4. How it was tested, and what happened

| Step | Result |
|---|---|
| `node tools/gen_rhmi.js`, `node tools/make_icon.js` | Wrote the screens, texts and icon |
| `node tools/check.js`, first run | **Failed**, correctly: (a) the status label's starting text `SID_HELLO_HELLO` had no entry in `en_GB.json`, because the generator skipped words equal to the title; (b) the name check was too broad and treated event names like `userEvent` as screen names |
| Fixes | The generator now writes a text for every word; `check.js` now only treats `ST_...` and `hello...` (the id after its prefix) as screen names |
| `node tools/check.js` | `ok: daniel_hello@0.1.0, 1 module(s), screens for ID7 and ID8` |
| `node tools/sim.js` | Passed on ID7 and ID8: page showed "Hello from your own app!" → "Pressed 3 times" / "Press me (3)" → back after Reset; the double delivery counted once |
| Negative test: a copy with iDrive 8's button cell changed to `Text` | `sim.js` **failed** as it should: `helloCount (button) has no cell Text on ID8` |
| `node tools/build.js --mgu-store <checkout>` | mgu-store's own `readManifest` and `packSource` accepted the folder and packed `daniel_hello@0.1.0.src.tgz` with 15 files |

Run on the desktop with Node 24. The car runs Node 8.16.2; the app code uses
only Node 8 features, but it was not run on Node 8 itself.

---

## 5. Not tested

- **Not run on a car**, on iDrive 7 or iDrive 8.
- **Not linked against BMW's real SDK**: that needs a donor app copied off the
  head unit, which wasn't available. `sim.js` is a stand-in that checks the
  app's logic and screen names, not how the real SDK or HMI behaves.
- **How the page looks** (layout, sizes, focus order with the controller) is
  only known on the car.
- **The tile's position** in the apps menu uses the Store's values; not seen
  on screen.
- **Other display languages**: only English texts exist; the app sets
  `defaultLanguage: en_GB`, but what the HMI shows in another language wasn't
  checked.

---

## 6. Next steps

1. Rename the id from `daniel_hello` to your own prefix and make new UUIDs
   (README, "Making it your own").
2. Push to GitHub, add it in Store → Settings → Add source, install, and see
   it on the car.
3. If something fails on the car, the Store's phone page (Settings → Phone
   access) shows errors and logs. The app logs under `HELO`.
4. Optionally copy a stock BMW app off the head unit into `donor/` and run
   `node tools/build.js --mgu-store <checkout> --sdk donor/<app>` to link it
   locally the way the car will.

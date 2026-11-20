# idrive-hello-apps

A starter repository of apps for [mgu-store](https://github.com/robertnisipeanu/mgu-store),
the app store for BMW iDrive 7 and iDrive 8 head units. It holds one app,
**Hello** (`daniel_hello`): a tile in the car's apps, and a page with a status
line, a **Press me** button that counts presses and **Reset**.

It is a *repo tree* source: the head unit downloads the repository and
builds the app itself, linking it against BMW's SDK from a stock app already
on the car. Nothing BMW's is in here.

How this repo was made, tested, and what is still untested:
[WHAT-WAS-DONE.md](WHAT-WAS-DONE.md).

Also in this repo:

- **AirPlay Mirror** (`daniel_airplay`, iDrive 7) with its system tool
  **AirPlay receiver** (`tools/daniel-airplay`): your iPhone's screen on the
  centre display through Screen Mirroring, over the car's Wi-Fi, only while
  parked. See [apps/daniel_airplay/README.md](apps/daniel_airplay/README.md).

## Install it on the car

1. Push this folder to a GitHub repository (public, or private with a token
   in the Store's Settings → Accounts).
2. On the car: Store → Settings → **Add source**, type `<you>/<repo>`, and
   pick the branch (`main`).
3. The Store lists **Hello**. Open it and press **Install**. On iDrive 8 it
   takes effect at the next head-unit restart (Settings → Restart head unit).

Every new commit on that branch is offered as an update. Bump `version` in
`apps/daniel_hello/mgu-app.json`, `package/package.json` and
`package/rhmiData/application.json` together when you release one (the car
only installs a higher version).

## Layout

```
mgu-repo.json                         the source's component list
apps/daniel_hello/
  mgu-app.json                        id, version, the modules, the oap-sdk names they use
  src/hello.js                        the app (Node 8, extends the oap-sdk's OnlineApp)
  package/                            the staged package tree
    package.json                      name, version, mguHmi, app settings
    manifest.json, permissions.json   the car interfaces it may call (copied from the Store app)
    rhmiData/application.json         the tile: entry point uuid, title text id, icon
    rhmiData/uiDescriptions/ID7|ID8/  the screens         (written by tools/gen_rhmi.js)
    rhmiData/variantGroups/Common/
      texts/en_GB.json, en_US.json    the words           (written by tools/gen_rhmi.js)
      images/hello_icon.png           the tile icon       (written by tools/make_icon.js)
  tools/
    gen_rhmi.js                       the page table: edit it to change the screens
    make_icon.js                      draws the default icon (replace the PNG with your own)
    check.js                          offline checks before you push
    sim.js                            runs the app on your PC against a stand-in HMI
    build.js                          packs it with mgu-store's own linker
```

## Working on it

Needs Node.js on your computer (any recent version).

```sh
cd apps/daniel_hello
node tools/gen_rhmi.js     # after editing the page table
node tools/check.js        # names, ids, texts, versions, Node 8 syntax, icon
node tools/sim.js          # press through the page on ID7 and ID8
```

`sim.js` is not BMW's SDK: it checks your logic, your screen names and that
each write goes to a cell the widget has (iDrive 8's buttons call their text
`PrimaryText`, iDrive 7's `Text`). How it really looks is only known on the car.

Optional, to check the car's build will accept the folder, with a checkout of
mgu-store:

```sh
node tools/build.js --mgu-store ../mgu-store                       # daniel_hello@0.1.0.src.tgz
node tools/build.js --mgu-store ../mgu-store --sdk donor/app.tgz   # and the linked daniel_hello@0.1.0.tgz
```

The donor is a stock BMW app copied off your head unit. It contains BMW's
SDK: keep it in `donor/` (git-ignored) and never commit it.

## Making it your own

- **Rename the app:** pick an id with your own prefix (`acme_gauges`) and use
  it in `mgu-repo.json`, `mgu-app.json`, `package/package.json` (`name`) and
  `rhmiData/application.json` (`name`, entry point `name`). Make new uuids for
  `rhmiData/application.json` (`node -e "console.log(require('crypto').randomUUID())"`).
  Component names start with the id after its prefix (`gaugesSpeed`), which
  `check.js` relies on.
- **Change the page:** edit `STATES` in `tools/gen_rhmi.js` (`text`, `label`,
  `button`), run it, and bind the new names in `src/hello.js`.
- **Another page:** a new `state(...)` with a `parent` (iDrive 7), then open it
  from a button handler with the state from `rhmiApplication.getByName(...)`.
  See how mgu-store's Store does it (`apps/robertn_store/src/store.js`, `_openState`).
- **Internet:** `"internet": true` in `mgu-app.json`. The app gets internet
  while the Store's uplink is online.
- **Only one head unit:** set `mguHmi` in `package/package.json` to `["ID7"]` or
  `["ID8"]` (the check and the simulator follow it).
- **More code:** add files to `src/`, list them in `mgu-app.json` `modules`
  (the entry first) and require them as `'./file'`. No npm packages.
- **Another app:** copy `apps/daniel_hello` and add an entry to `mgu-repo.json`.
- **Custom graphics** (gauges, games): the Store's renderer, mgu-render; see
  `native/mgu-render/README.md` in mgu-store, section "Apps".

The rules and every option are in mgu-store's
[docs/PUBLISHING.md](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md).

# From local Docker preview to production — how multiple developers converge

Extra reading alongside the "Developer workflow" section in `readme.md`.
That section covers one developer, one branch, one local Docker preview.
This doc covers what happens once *several* developers are doing that at
the same time, and who actually ships to production.

## 1. Multiple developers working in parallel — no conflict by construction

Each developer:
- has their **own branch** (`git checkout -b <yourname>/<feature>`),
- previews in their **own local Docker container**, on their **own port**
  (`dev1` → 8081, `dev2` → 8082, `dev3` → 8083, ...).

Nothing here touches a shared resource — not the GitHub repo (separate
branches), not a server (separate local containers), not CF (no deploy
happens at this stage). Any number of developers can do this literally
simultaneously with zero coordination needed.

## 2. Getting everyone's work into `main`

Each developer pushes **their own branch** and opens a PR into `main`:
```bash
git push -u origin <yourname>/<feature>
```
From there it's a normal GitHub PR: review, then merge. If two developers
touched the same file (most likely `app/aiconx/webapp/btp_app.js`), the
*second* PR to merge will show a merge conflict in GitHub/git the normal
way — resolve it like any other git conflict, there's nothing
Docker-specific about this part. Keeping changes small and merging often
(rather than letting branches live for weeks) keeps these conflicts rare
and small.

**Nobody pushes straight to `main`.** Every change lands via a branch + PR,
even small ones — that's what keeps `main` always equal to "what's actually
agreed to ship."

## 3. Shipping to production — who, and how

Only `main` ever gets deployed. Whoever owns production access runs:
```bash
cd ZR_SDAINTAI_V01   # on main, pulled fresh
mbt build -f mta-sdaintai.yaml
cf deploy mta_archives/sdaintai_<version>.mtar
```
A few things that matter here, learned the hard way:

- **Bump the version in `mta-sdaintai.yaml` before every deploy**, to a
  number higher than whatever's currently live. `cf deploy` refuses to
  "downgrade" an already-deployed MTA version unless you pass
  `--version-rule ALL` — don't use that flag to skip past this; just bump
  the version. Check what's live first: `cf app sdaintai` won't show the
  MTA version, but the deploy command itself prints
  `Detected deployed MTA with ID "sdaintai" and version "X.X.X"` — bump
  above that.
- **This repo shares its production app with the main `SDAINTAI` repo.**
  `sdaintai.cfapps.us10.hana.ondemand.com` is one CF app, and
  `mta-sdaintai.yaml` in *both* `SDAKB1/SDAINTAI` and
  `SDAKB1/ZR_SDAINTAI_V01` deploys to it under the same MTA ID (`sdaintai`).
  `cf deploy` **fully replaces** the app's static files with whatever's in
  the mtar you just built — there's no merge between the two repos' file
  sets. This repo's `app/aiconx/webapp/` only has the `btp_*` files (BW
  Cockpit, SDADATAAI, SDAFINAI, etc. are deliberately excluded here) — so a
  deploy from *this* repo will remove those other pages from production if
  they aren't also present here. In practice: confirm with whoever manages
  the main SDAINTAI repo before deploying from this one to the shared
  route, so you're not erasing pages this repo doesn't know about.
- **`app/aiconx/` needs `Staticfile` (`root: webapp`), `xs-app.json`,
  `sda.png`, and `package.json` present**, not just the `webapp/` folder
  itself. Without `Staticfile`, the `staticfile_buildpack` defaults to
  serving a `public/` directory that doesn't exist here, and every page
  404s. These four files are already committed in this repo — if you ever
  rebuild `app/aiconx/` from scratch, don't drop them.
- After deploying, **verify with curl**, not just "deploy succeeded" —
  `cf deploy`'s own success message doesn't catch a wrong `Staticfile` or a
  wiped sibling app. Check a few known pages return `200` before calling it
  done.

## 4. Summary

| Stage | Who | Touches production? |
|---|---|---|
| Clone + branch + local Docker preview | any developer | No |
| Push branch + open PR | any developer | No (GitHub only) |
| Review + merge to `main` | reviewer/maintainer | No (GitHub only) |
| `mbt build` + `cf deploy` from `main` | production owner only | **Yes** |

Local Docker preview and GitHub PRs are unlimited-concurrency, zero-risk.
The actual `cf deploy` to the shared route is the one step that's
intentionally narrow — one person, one `main` branch, one version bump at a
time — because it's the only step that can affect what every other
developer (and the other repo) sees live.

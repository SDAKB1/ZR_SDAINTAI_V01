# How to use your own branch on SDAINTAI and deploy to your own Docker instance

Welcome — this is the onboarding doc for any developer working on the
SDAINTAI migration cockpit (`btp_cockpit.html`). Read this start to finish
before you touch anything. It covers: cloning the repo, working on your own
branch, previewing your changes in your own local Docker container, and how
everyone's work eventually comes together for a real production deploy.

Repo: **https://github.com/SDAKB1/ZR_SDAINTAI_V01**

## 0. The one rule that makes all of this safe

**Nobody ever pushes directly to `main`.** Every change — no matter how
small — goes through: your own branch → your own local Docker preview →
push your branch → open a Pull Request → someone reviews and merges it.

This isn't bureaucracy for its own sake. `main` is the only branch that
ever gets deployed to the real, shared production route
(`sdaintai.cfapps.us10.hana.ondemand.com`). That route is also used by a
second, separate repo (`SDAKB1/SDAINTAI`), and a `cf deploy` **completely
replaces** whatever's live with whatever's in the branch you deployed from —
there's no merge. A bad push straight to `main` doesn't just break your own
work, it can silently wipe pages that belong to the other repo. Branches +
PRs + local Docker previews are what keep that from ever happening by
construction, not by everyone remembering to be careful.

## 1. One-time setup

You need: `git`, Docker (Desktop or Engine), and a GitHub account with
**Write** access to this repo (ask whoever administers it — see §6 (Write-access policy) for why
this is safe to grant).

```bash
git clone https://github.com/SDAKB1/ZR_SDAINTAI_V01.git
cd ZR_SDAINTAI_V01
```

## 2. Create your own branch

Branch naming convention: `<yourname>/<short-feature-name>`.

```bash
git checkout -b developer1/my-feature
```

(If you were thinking of something like `BRANCHDEVELOPER1` — close, but use
your actual name/handle instead of a generic placeholder. It makes PRs and
`git blame` readable once there are several developers' branches in flight
at once.)

## 3. Make your changes

Everything relevant lives under `app/aiconx/webapp/`:

| File | What it is |
|---|---|
| `btp_cockpit.html` | The main cockpit page (also mirrored as `btp_cockpit_ZR_SDAINTAI_V01.html` in this repo) |
| `btp_app.js` | All the JS logic — Lumi chat flow, screens, state |
| `btp_style.css` / `btp_lumi.css` | Styling |

**Important:** any time you touch `btp_cockpit.html`, `btp_app.js`, or
`btp_lumi.css`, bump the cache-bust query tag on every `<link>`/`<script>`
tag in `btp_cockpit.html` in the *same* commit:

```html
<link rel="stylesheet" href="btp_style.css?v=lumi31">   <!-- was lumi30 -->
<script src="btp_app.js?v=lumi31"></script>              <!-- was lumi30 -->
```

If you skip this, your own browser (and everyone else's) will keep running
the *old* cached JS against your *new* HTML, and your change will look like
it silently didn't happen — it deployed fine, it's just invisible until
someone hard-refreshes or the tag changes.

## 4. Preview your changes locally — your own Docker instance

This is **not** a public route or a cloud deployment — it's a container
running on your own machine, reachable only at `localhost`. That's
deliberate: the shared production CF space is already at its route quota,
so there's no spare public route to hand out per developer anyway. Local
Docker gives you a fully isolated, zero-cost, zero-coordination preview
instead.

```bash
docker compose -f docker-compose.dev.yml up --build dev1
```

Then open: `http://localhost:8081/btp_cockpit_ZR_SDAINTAI_V01.html`

`docker-compose.dev.yml` has one service block per developer — `dev1` on
port 8081, `dev2` on port 8082. **If both are already taken by other
developers**, copy the commented-out `dev3` template at the bottom of that
file, give it your own name and the next free port (8083, 8084, ...), and
use that instead:

```yaml
dev3:
  build:
    context: .
    dockerfile: Dockerfile.webapp
  container_name: sdaintai-docker3
  ports:
    - "8083:80"
```

Don't reuse someone else's block while they're using it — each developer
gets their own container, their own port, no coordination needed because
nothing is shared.

Under the hood, `Dockerfile.webapp` is just nginx serving the static
`app/aiconx/webapp` folder — there's no backend/CAP service running in this
preview, so anything that calls a real API (the PI8 MCP bridge, the Brain,
etc.) will behave as it does for any unauthenticated browser hitting those
same public endpoints; it's the frontend/UX you're previewing, not a full
backend stack.

## 5. Get it informally approved before you open the PR

Before you push and open a PR, get a go-ahead on what you built — demo your
local Docker preview (screen-share, screen recording, or screenshots) to
whoever signs off on changes for this project.

This matters because of how branch protection on `main` is actually
configured here: **PR required, but 0 required approvals** (see §6, Write-access policy, below).
That means once a PR is open, you can merge it yourself immediately — there
is no GitHub reviewer gate stopping you. The review is meant to happen
*before* that point, informally, exactly like this. "Go ahead, open a PR
and merge" **is** the approval — it just happens outside GitHub instead of
as a formal PR review.

Two things worth knowing about this step:

- **Nobody else can browse to your local Docker container** — it's bound to
  `localhost` on your own machine (ports 8081/8082/...), not reachable from
  anyone else's browser. That's why the demo has to be screen-shared,
  recorded, or screenshotted — there's no URL you can just send someone.
- **GitHub does not verify that this step happened.** It's a team-process
  checkpoint, not a technical one — trust-based, by design, to keep this
  low-friction. If the team ever wants that enforced technically instead of
  by process, that's the point at which required approvals on `main` would
  go from 0 to 1+.

## 6. Push your branch and open a Pull Request

```bash
git add -A
git commit -m "describe what you changed, in your own words"
git push -u origin developer1/my-feature
```

Then open a PR on GitHub, targeting `main`. Someone reviews it, resolves
any merge conflicts (most likely in `btp_app.js` if two people touched it),
and merges when it's ready. **This is the only way anything reaches
`main`** — see §0.

### Why "Write access" is safe here, and what must be true first

Being given **Write** access to this repo means you *can* push branches and
open PRs — which is required for the workflow above. It does **not** mean
you should ever push directly to `main`, and it shouldn't even be *possible*
to by accident. Before any developer is granted Write access, the repo
admin needs to confirm `main` has a **branch protection rule** configured
(GitHub → repo **Settings → Branches → Branch protection rules → Add rule**,
pattern `main`):

- ✅ Require a pull request before merging — **required approvals: 0**
- ✅ Do not allow bypassing the above settings (applies to admins too)
- ✅ Block force pushes

With that rule in place, Write access only ever lets a developer push their
*own* branches and open PRs — pushing straight to `main`, or force-pushing
it, is rejected by GitHub itself, not just by convention. If that rule
isn't set up yet, set it up *before* onboarding the next developer, not
after.

**Required approvals is deliberately 0, not 1** — the point of this rule
isn't to gate every change behind a reviewer (that's more friction than
this team wants), it's to guarantee every change on `main` exists as a
proper PR: isolated, diffed, with a visible commit history. A developer can
open a PR and merge it themselves immediately with no one else signing off
— that's expected, not a gap. What you get in exchange for that low
friction is that nothing can land on `main` any other way (no raw push, no
force push), so if a merged PR ever breaks something, reverting it is a
single click — GitHub's **Revert** button on the merged PR, or
`git revert <merge-commit-sha>` — because it's always a clean, identifiable
commit (or set of commits), never an untracked direct push. If the team
later wants a pre-merge safety net instead of (or in addition to) that
trace-and-revert approach, come back to this setting and raise required
approvals to 1+.

## 7. How it all comes together — merging to `main` and going live

This is the part that matters once there's more than one developer working
at the same time.

| Stage | Who does it | Touches production? |
|---|---|---|
| Clone + branch + local Docker preview | any developer | No |
| Push branch + open PR | any developer | No (GitHub only) |
| Review + merge PR into `main` | reviewer/maintainer | No (GitHub only) |
| `mbt build` + `cf deploy` from `main` | production owner only | **Yes** |

Every developer can clone, branch, and run their own local Docker preview
completely independently and simultaneously — there's no shared resource at
that stage, so there's nothing to coordinate. Conflicts only ever show up
as a normal git merge conflict when two PRs touch the same lines of the
same file (again, most likely `btp_app.js`) — resolve it the normal git
way. Keeping PRs small and merging often (instead of letting a branch sit
for weeks) keeps this rare.

**Only `main` ever gets deployed, and only one person does the actual
deploy.** Once `main` has everything that's meant to ship:

```bash
cd ZR_SDAINTAI_V01   # on main, pulled fresh
mbt build -f mta-sdaintai.yaml
cf deploy mta_archives/sdaintai_<version>.mtar
```

A few things the production owner needs to know, learned the hard way:

- **Bump the version in `mta-sdaintai.yaml` before every deploy**, higher
  than whatever's currently live. `cf deploy` prints
  `Detected deployed MTA with ID "sdaintai" and version "X.X.X"` — bump
  above that number. Don't use `--version-rule ALL` to skip this; just bump
  the version.
- **This repo shares its production app with the main `SDAINTAI` repo.**
  `sdaintai.cfapps.us10.hana.ondemand.com` is one CF app that both
  `SDAKB1/SDAINTAI` and `SDAKB1/ZR_SDAINTAI_V01` deploy to under the same
  MTA ID (`sdaintai`). `cf deploy` fully replaces the live static files with
  whatever's in the mtar you just built — this repo's `app/aiconx/webapp/`
  only has the `btp_*` files (it deliberately excludes the BW Cockpit,
  SDADATAAI, SDAFINAI, etc.), so a deploy from here would remove those other
  pages from production if they aren't also present in this repo. **Confirm
  with whoever manages the main SDAINTAI repo before deploying from this one
  to the shared route.**
- **`app/aiconx/` needs `Staticfile`, `xs-app.json`, `sda.png`, and
  `package.json` present**, not just `webapp/` itself — without
  `Staticfile`, the buildpack serves a nonexistent `public/` folder and
  everything 404s. These are already committed; don't drop them if you ever
  rebuild `app/aiconx/` from scratch.
- **Because of the shared-route gotcha above and the dual-app serving
  pattern** (the same route is also served by a separate CAP backend app
  that mirrors these same static files at its own build time), a full go-live
  deploy needs *both* halves refreshed, or roughly half of all requests will
  keep serving the old content. Whoever owns production deploys should
  confirm this detail with the main SDAINTAI repo's maintainer rather than
  guessing — it's not something you can tell from `ZR_SDAINTAI_V01` alone.
- **Verify with `curl` after deploying** — don't trust `cf deploy`'s own
  success message, it won't catch a wrong `Staticfile` or a wiped sibling
  app. Hit a few known pages and confirm `200` + expected content before
  calling it done.

## 8. Quick reference

```bash
# One-time
git clone https://github.com/SDAKB1/ZR_SDAINTAI_V01.git
cd ZR_SDAINTAI_V01

# Per feature
git checkout -b yourname/feature-name
# ... edit app/aiconx/webapp/*, bump ?v=lumiN on every edit ...
docker compose -f docker-compose.dev.yml up --build dev1   # preview at localhost:8081
# ... demo that preview, get an informal go-ahead ...
git add -A && git commit -m "..."
git push -u origin yourname/feature-name
# ... open PR into main on GitHub, merge it yourself (0 required approvals) ...

# Go-live (production owner only, from main, after confirming with the main SDAINTAI repo owner)
mbt build -f mta-sdaintai.yaml
cf deploy mta_archives/sdaintai_<version>.mtar
```

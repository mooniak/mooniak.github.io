# mooniak.github.io

The site at [src.mooniak.com](https://src.mooniak.com): a dashboard of Mooniak's
open-source fonts and the tools and standards behind them. Each font's own site
is a project page under it (`src.mooniak.com/<repo>/`).

- **`/`**: the dashboard. Open-source projects and tooling at the top, then
  every open-source font with its CI status, fontspector QA, design stage,
  version, open issues and PRs, then the newest open issues across the fonts.
- **`/data/dashboard.json`**: the same data, for other tools.
- **`/tools/`** and **`TOOLS.md`**: the map of how the repos and apps fit
  together.

## How it is built

`.github/workflows/dashboard.yml` runs every 6 hours, on push to `main`, by
hand, and on a `font-built` repository dispatch. It runs two dependency-free
Node scripts and deploys `_site/` to GitHub Pages:

1. `scripts/collect.mjs` writes `_site/data/dashboard.json` from:
   - **GitHub GraphQL**: the org's public, non-archived repos. A repo with a
     `fontpackage.json` is a font. `dashboard.config.json` adds repos without
     one (`fonts.include`) and drops ones that have one (`fonts.exclude`).
     Name, scripts, license and designers come from `fontpackage.json`;
     issue and PR counts, latest release and the newest open issues come from GitHub.
   - **GitHub Actions**: the latest build run on `dev` or the default branch
     (Pages deploys and dependabot branches are skipped).
   - **Each font's Pages site**: `build.json` and `<channel>/builds.json`,
     which the font repo's CI publishes (version, fontspector QA, design
     stage, build history). Fonts not yet on the current build setup show CI only.
   - **The website's tools list**: `content/tools/tools.json` in
     `mooniak/mooniak.com`, read with the `WEBSITE_TOKEN` secret. Without the
     secret, or if the read fails, `data/tools.json` is used. Refresh that
     copy when the website's list changes.
2. `scripts/render.mjs` writes `_site/index.html` (works without JavaScript;
   a small script adds search, filters, sorting and relative dates) and copies
   `tools/`, `TOOLS.md` and `CNAME` alongside it.

A repo that can't be read never fails the run. It is listed under *errors*
in `dashboard.json` and in the run summary, and its row shows what is known.

### Run it locally

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/collect.mjs
node scripts/render.mjs
python3 -m http.server -d _site 8000
```

### Setup

- **Pages source**: Settings → Pages → Build and deployment → *GitHub Actions*.
- **`WEBSITE_TOKEN`** (optional): a fine-grained token, resource owner
  `mooniak`, repository `mooniak.com`, permission *Contents: read*, saved as an
  Actions secret here.

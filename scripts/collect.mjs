#!/usr/bin/env node
// Collects everything the dashboard shows into _site/data/dashboard.json.
//
// Sources:
//   - GitHub GraphQL: the org's public repos, each one's fontpackage.json,
//     license, open issue/PR counts, latest release and newest open issues.
//   - GitHub REST: each font repo's latest CI run (pages deploys skipped).
//   - GitHub Pages: <siteBase>/<repo>/build.json and <channel>/builds.json,
//     written by the font repos' own CI (version, QA, design stage, history).
//   - The website's tools list (private repo, read with WEBSITE_TOKEN),
//     falling back to the copy committed in data/tools.json.
//
// Needs GITHUB_TOKEN (Actions provides one; locally: GITHUB_TOKEN=$(gh auth token)).
// One repo failing never fails the run: it is recorded in `errors` and its row
// shows what is known.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(path.join(root, "dashboard.config.json"), "utf8"));
const outDir = path.join(root, process.env.OUT_DIR || "_site", "data");

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is not set. Locally: GITHUB_TOKEN=$(gh auth token) node scripts/collect.mjs");
  process.exit(1);
}

const errors = [];
const warnings = [];
const note = (where, err) => {
  const message = err instanceof Error ? err.message : String(err);
  errors.push({ where, message });
  console.warn(`! ${where}: ${message}`);
};

const ghHeaders = (auth = token) => ({
  Authorization: `Bearer ${auth}`,
  "User-Agent": "mooniak-dashboard",
  "X-GitHub-Api-Version": "2022-11-28",
});

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  return body.data;
}

async function rest(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

// Pages files are public; a 404 just means the repo doesn't publish that file.
async function pagesJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mooniak-dashboard" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function pagesExists(url) {
  const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": "mooniak-dashboard" } });
  return res.ok;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- repos

const REPOS_QUERY = `
query($org: String!, $after: String, $issues: Int!) {
  organization(login: $org) {
    repositories(first: 50, after: $after, privacy: PUBLIC, orderBy: {field: NAME, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name description url homepageUrl isArchived isFork pushedAt stargazerCount
        hasIssuesEnabled
        licenseInfo { spdxId name }
        defaultBranchRef { name }
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
        latestRelease { tagName publishedAt url }
        fontpackage: object(expression: "HEAD:fontpackage.json") { ... on Blob { text } }
        openIssues: issues(states: OPEN, first: $issues, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            number title url createdAt
            author { login }
            labels(first: 5) { nodes { name color } }
          }
        }
      }
    }
  }
}`;

async function listRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await gql(REPOS_QUERY, { org: config.org, after, issues: config.recentIssues });
    const page = data.organization.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

// ---------------------------------------------------------------- per font

const SKIP_WORKFLOWS = new Set(["pages build and deployment"]);

// The font's own build: newest run on dev or the default branch, so a
// dependabot or feature branch doesn't stand in for the font's state.
async function latestCiRun(repo, defaultBranch) {
  const data = await rest(`/repos/${config.org}/${repo}/actions/runs?per_page=30&exclude_pull_requests=true`);
  const builds = data.workflow_runs.filter((r) => !SKIP_WORKFLOWS.has(r.name) && r.event !== "dynamic");
  const main = new Set(["dev", defaultBranch]);
  const run = builds.find((r) => main.has(r.head_branch)) ?? builds.find((r) => !r.head_branch?.startsWith("dependabot/"));
  if (!run) return null;
  return {
    workflow: run.name,
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | cancelled | ...
    branch: run.head_branch,
    commit: run.head_sha?.slice(0, 7),
    date: run.updated_at,
    url: run.html_url,
  };
}

function parseFontpackage(repo) {
  const text = repo.fontpackage?.text;
  if (!text) return null;
  try {
    const fp = JSON.parse(text);
    // A fontpackage.json copied from mooniak-font-project-template and never
    // filled in describes "My Font"; ignore it rather than show that name.
    if (fp?.id === "my-font") {
      warnings.push({ repo: repo.name, message: "fontpackage.json still has the template's placeholder values" });
      return null;
    }
    return fp;
  } catch (err) {
    note(`${repo.name}/fontpackage.json`, `invalid JSON: ${err.message}`);
    return null;
  }
}

const names = (list) =>
  (Array.isArray(list) ? list : [])
    .map((d) => (typeof d === "string" ? d : d?.name))
    .filter(Boolean);

function slimBuild(b) {
  if (!b) return null;
  return {
    version: b.version ?? null,
    channel: b.channel ?? null,
    commit: b.commit_short ?? b.commit?.slice(0, 7) ?? null,
    ref: b.ref_name ?? null,
    runUrl: b.run_url ?? null,
    date: b.generated_at ?? null,
    qa: b.qa
      ? {
          profile: b.qa.profile ?? null,
          verdict: b.qa.verdict ?? null,
          passRate: b.qa.pass_rate ?? null,
          fail: b.qa.counts?.FAIL ?? 0,
          warn: b.qa.counts?.WARN ?? 0,
          pass: b.qa.counts?.PASS ?? 0,
          total: b.qa.total_checks ?? null,
        }
      : null,
    stage: b.stage ? { n: b.stage.n ?? null, name: b.stage.name ?? null } : null,
    woff2Bytes: (b.files ?? []).filter((f) => f.format === "woff2").reduce((s, f) => s + (f.bytes ?? 0), 0) || null,
  };
}

async function collectFont(repo) {
  const fp = parseFontpackage(repo);
  const site = `${config.siteBase}/${repo.name}/`;
  const font = {
    repo: repo.name,
    id: fp?.id ?? repo.name.replace(/-font$/, ""),
    name: fp?.name ?? repo.name.replace(/-font$/, "").replace(/(^|-)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase()),
    description: fp?.description ?? repo.description ?? "",
    scripts: fp?.scripts ?? [],
    license: fp?.license ?? (repo.licenseInfo?.spdxId && repo.licenseInfo.spdxId !== "NOASSERTION" ? repo.licenseInfo.spdxId : null),
    designers: names(fp?.designers).length ? names(fp?.designers) : names(fp?.designer),
    channels: fp?.channels ?? [],
    url: repo.url,
    homepage: null,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    pushedAt: repo.pushedAt,
    stars: repo.stargazerCount,
    issues: repo.hasIssuesEnabled ? repo.issues.totalCount : null,
    issuesUrl: `${repo.url}/issues`,
    prs: repo.pullRequests.totalCount,
    release: repo.latestRelease
      ? { tag: repo.latestRelease.tagName, date: repo.latestRelease.publishedAt, url: repo.latestRelease.url }
      : null,
    build: null,
    history: [],
    ci: null,
    reports: {},
  };

  const tasks = [
    pagesJson(`${site}build.json`).then(async (b) => {
      font.build = slimBuild(b);
      if (!b) return;
      if (await pagesExists(`${site}reports/fontspector/fontspector-report.html`)) {
        font.reports.fontspector = `${site}reports/fontspector/fontspector-report.html`;
      }
      if (b.channel) {
        const hist = await pagesJson(`${site}${b.channel}/builds.json`).catch((e) => note(`${repo.name}/builds.json`, e));
        if (Array.isArray(hist)) {
          font.history = hist
            .filter((h) => h?.generated_at)
            .sort((a, b) => a.generated_at.localeCompare(b.generated_at))
            .slice(-12)
            .map((h) => ({ date: h.generated_at, passRate: h.qa?.pass_rate ?? null, version: h.version ?? null, commit: h.commit_short ?? null }));
        }
      }
    }),
    latestCiRun(repo.name, repo.defaultBranchRef?.name).then((ci) => (font.ci = ci)),
    (async () => {
      // The repo's own Pages site wins: template-made fontpackage.json files
      // can still point homepage_url at another font's site.
      if (await pagesExists(site)) font.homepage = site;
      else {
        const own = (u) => u && !(u.replace(/^http:/, "https:").startsWith(config.siteBase) && !u.includes(`/${repo.name}/`));
        font.homepage = [fp?.homepage_url, repo.homepageUrl].find(own) || null;
      }
    })(),
  ];

  const results = await Promise.allSettled(tasks);
  results.forEach((r) => r.status === "rejected" && note(repo.name, r.reason));
  return font;
}

// ---------------------------------------------------------------- tools

async function collectTools() {
  const { repo, toolsPath } = config.website;
  const websiteToken = process.env.WEBSITE_TOKEN;
  if (websiteToken) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${toolsPath}`, {
        headers: { ...ghHeaders(websiteToken), Accept: "application/vnd.github.raw+json" },
      });
      if (!res.ok) throw new Error(`GET ${repo}/${toolsPath} → ${res.status}`);
      return { source: `${repo}/${toolsPath}`, tools: await res.json() };
    } catch (err) {
      note("tools", `${err.message}; using data/tools.json`);
    }
  }
  const tools = JSON.parse(await readFile(path.join(root, "data", "tools.json"), "utf8"));
  return { source: "data/tools.json", tools };
}

// ---------------------------------------------------------------- main

const include = new Set(config.fonts.include);
const exclude = new Set(config.fonts.exclude);

const [repos, toolsResult] = await Promise.all([listRepos(), collectTools()]);
const fontRepos = repos.filter(
  (r) => !r.isArchived && !exclude.has(r.name) && (r.fontpackage?.text || include.has(r.name)),
);
console.log(`${repos.length} public repos, ${fontRepos.length} fonts`);

const fonts = await mapLimit(fontRepos, 6, async (r) => {
  try {
    return await collectFont(r);
  } catch (err) {
    note(r.name, err);
    return null;
  }
});

const fontByRepo = new Map(fonts.filter(Boolean).map((f) => [f.repo, f]));
const issues = fontRepos
  .flatMap((r) =>
    r.openIssues.nodes.map((i) => ({
      repo: r.name,
      font: fontByRepo.get(r.name)?.name ?? r.name,
      number: i.number,
      title: i.title,
      url: i.url,
      createdAt: i.createdAt,
      author: i.author?.login ?? null,
      labels: i.labels.nodes.map((l) => ({ name: l.name, color: l.color })),
    })),
  )
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, config.recentIssues);

const tools = toolsResult.tools.map((t) => ({
  id: t.id,
  name: t.name?.en ?? t.id,
  description: t.description?.en ?? "",
  category: t.category ?? null,
  type: t.type ?? null,
  license: t.license ?? null,
  scripts: t.scripts ?? [],
  links: t.links ?? {},
  featured: Boolean(t.featured),
}));

const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const dashboard = {
  generatedAt: new Date().toISOString(),
  org: config.org,
  siteBase: config.siteBase,
  websiteUrl: config.website.url,
  runUrl,
  toolsSource: toolsResult.source,
  tools,
  fonts: [...fontByRepo.values()].sort((a, b) => a.name.localeCompare(b.name)),
  issues,
  errors,
  warnings,
};

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "dashboard.json"), JSON.stringify(dashboard, null, 2) + "\n");
console.log(
  `wrote ${path.relative(root, path.join(outDir, "dashboard.json"))}: ${dashboard.fonts.length} fonts, ` +
    `${tools.length} tools (${toolsResult.source}), ${issues.length} recent issues, ${errors.length} errors`,
);
warnings.forEach((w) => console.warn(`~ ${w.repo}: ${w.message}`));

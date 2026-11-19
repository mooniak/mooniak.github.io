#!/usr/bin/env node
// Renders _site/data/dashboard.json (from collect.mjs) into _site/index.html.
// The page is complete without JavaScript; a small inline script adds
// filtering, sorting and relative dates.

import { readFile, writeFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const site = path.join(root, process.env.OUT_DIR || "_site");
const d = JSON.parse(await readFile(path.join(site, "data", "dashboard.json"), "utf8"));

// ---------------------------------------------------------------- helpers

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SCRIPTS = { Sinh: "Sinhala", Taml: "Tamil", Latn: "Latin", Deva: "Devanagari", Thaa: "Thaana", Zsym: "Symbols", Symbols: "Symbols" };
const scriptName = (s) => SCRIPTS[s] ?? s;

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const time = (iso) => (iso ? `<time datetime="${esc(iso)}" title="${esc(fmtDate(iso))}">${esc(fmtDate(iso))}</time>` : "—");

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const CI = {
  success: { cls: "good", icon: "✓", label: "Passing" },
  failure: { cls: "critical", icon: "✕", label: "Failing" },
  startup_failure: { cls: "critical", icon: "✕", label: "Failing" },
  timed_out: { cls: "critical", icon: "✕", label: "Timed out" },
  cancelled: { cls: "muted", icon: "–", label: "Cancelled" },
  skipped: { cls: "muted", icon: "–", label: "Skipped" },
  running: { cls: "warning", icon: "●", label: "Running" },
  none: { cls: "muted", icon: "–", label: "No CI" },
};
const ciKey = (ci) => (!ci ? "none" : ci.status !== "completed" ? "running" : CI[ci.conclusion] ? ci.conclusion : "none");
const ciGroup = (k) => (k === "success" ? "passing" : CI[k].cls === "critical" ? "failing" : "other");

function sparkline(history, name) {
  const pts = history.filter((h) => typeof h.passRate === "number");
  if (pts.length < 2) return "";
  const W = 72, H = 22, P = 3;
  const xs = pts.map((_, i) => P + (i * (W - 2 * P)) / (pts.length - 1));
  // Each row's own range, at least 20 points tall so small wobbles stay small.
  const vals = pts.map((p) => p.passRate);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = mid - 10; hi = mid + 10; }
  const ys = pts.map((p) => H - P - ((p.passRate - lo) / (hi - lo)) * (H - 2 * P));
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join("");
  const dots = pts
    .map((p, i) => {
      const last = i === pts.length - 1;
      const tip = `${fmtDate(p.date)} · ${p.passRate}% pass${p.version ? ` · v${p.version}` : ""}${p.commit ? ` · ${p.commit}` : ""}`;
      return `<g class="pt${last ? " last" : ""}"><circle class="hit" cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="6"/><circle class="dot" cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="${last ? 2.5 : 1.6}"/><title>${esc(tip)}</title></g>`;
    })
    .join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${name}: QA pass rate over the last ${pts.length} builds, ${pts[0].passRate}% to ${pts.at(-1).passRate}%`)}"><path d="${line}"/>${dots}</svg>`;
}

const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;

// ---------------------------------------------------------------- sections

const fonts = d.fonts;
const withCi = fonts.filter((f) => f.ci);
const passing = withCi.filter((f) => ciKey(f.ci) === "success").length;
const rates = fonts.map((f) => f.build?.qa?.passRate).filter((x) => typeof x === "number");
const openIssues = fonts.reduce((s, f) => s + (f.issues ?? 0), 0);
const openPrs = fonts.reduce((s, f) => s + (f.prs ?? 0), 0);
const scriptCounts = {};
fonts.forEach((f) => f.scripts.forEach((s) => (scriptCounts[scriptName(s)] = (scriptCounts[scriptName(s)] ?? 0) + 1)));
const scriptList = Object.entries(scriptCounts).sort((a, b) => b[1] - a[1]);

const CATEGORY = { developer: "Developer tool", standards: "Standard", learning: "Learning" };

const toolsHtml = d.tools
  .map((t) => {
    const links = [
      t.links.website && `<a href="${esc(t.links.website)}">Open →</a>`,
      t.links.github && `<a href="${esc(t.links.github)}">GitHub →</a>`,
      t.links.npm && `<a href="${esc(t.links.npm)}">npm →</a>`,
      t.links.pypi && `<a href="${esc(t.links.pypi)}">PyPI →</a>`,
    ].filter(Boolean);
    return `<article class="card">
      <h3>${t.links.website || t.links.github ? `<a href="${esc(t.links.website || t.links.github)}">${esc(t.name)}</a>` : esc(t.name)}</h3>
      <div class="badges">${[CATEGORY[t.category] ?? t.category, t.type, t.license].filter(Boolean).map((x) => pill(x)).join("")}</div>
      <p class="tagline">${esc(t.description)}</p>
      <div class="card-links">${links.join("")}</div>
    </article>`;
  })
  .join("\n");

const tiles = [
  { label: "Open-source fonts", value: fonts.length, sub: scriptList.map(([s, n]) => `${s} ${n}`).join(" · ") },
  { label: "CI passing", value: withCi.length ? `${passing} / ${withCi.length}` : "—", sub: "latest build on dev or the default branch" },
  { label: "Median QA pass rate", value: rates.length ? `${median(rates)}%` : "—", sub: `fontspector, ${rates.length} fonts reporting` },
  { label: "Open issues", value: openIssues, sub: `${openPrs} open pull request${openPrs === 1 ? "" : "s"}` },
]
  .map((t) => `<div class="tile"><div class="tile-label">${esc(t.label)}</div><div class="tile-value">${esc(t.value)}</div><div class="tile-sub">${esc(t.sub)}</div></div>`)
  .join("");

function fontRow(f) {
  const k = ciKey(f.ci);
  const ci = CI[k];
  const b = f.build;
  const qa = b?.qa;
  const scripts = f.scripts.map(scriptName);
  const links = [
    f.homepage && `<a href="${esc(f.homepage)}">Site</a>`,
    `<a href="${esc(f.url)}">Repo</a>`,
    f.reports.fontspector && `<a href="${esc(f.reports.fontspector)}">QA report</a>`,
    f.release && `<a href="${esc(f.release.url)}" title="${esc(`Released ${fmtDate(f.release.date)}`)}">${esc(f.release.tag)}</a>`,
  ].filter(Boolean);
  const search = [f.name, f.repo, f.description, ...scripts, ...f.designers].join(" ").toLowerCase();

  return `<tr data-search="${esc(search)}" data-scripts="${esc(scripts.join("|"))}" data-ci="${ciGroup(k)}">
    <td data-v="${esc(f.name.toLowerCase())}" class="font">
      <a class="font-name" href="${esc(f.homepage || f.url)}">${esc(f.name)}</a>
      <div class="sub">${esc(f.repo)}${f.designers.length ? ` · ${esc(f.designers.slice(0, 2).join(", "))}${f.designers.length > 2 ? " +" + (f.designers.length - 2) : ""}` : ""}</div>
    </td>
    <td data-v="${esc(scripts.join(","))}">${scripts.length ? esc(scripts.join(", ")) : "—"}</td>
    <td data-v="${esc(f.license ?? "")}">${f.license ? esc(f.license) : "—"}</td>
    <td data-v="${esc(b?.version ?? "")}" class="num">${b?.version ? esc(b.version) : "—"}${b?.channel ? `<div class="sub">${esc(b.channel)}</div>` : ""}</td>
    <td data-v="${{ passing: 0, failing: 2, other: 1 }[ciGroup(k)]}">
      ${f.ci ? `<a class="status ${ci.cls}" href="${esc(f.ci.url)}" title="${esc(`${f.ci.workflow} on ${f.ci.branch}, ${fmtDate(f.ci.date)}`)}"><span aria-hidden="true">${ci.icon}</span> ${ci.label}</a><div class="sub">${esc(f.ci.branch ?? "")} · ${time(f.ci.date)}</div>` : `<span class="status muted"><span aria-hidden="true">${ci.icon}</span> ${ci.label}</span>`}
    </td>
    <td data-v="${qa?.passRate ?? -1}" class="qa">
      ${
        qa
          ? `<div class="qa-top"><span class="num">${qa.passRate}%</span><span class="meter" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, qa.passRate))}%"></span></span></div>
             <div class="sub">${qa.fail} fail · ${qa.warn} warn${sparkline(f.history, f.name)}</div>`
          : `<span class="dim">—</span>`
      }
    </td>
    <td data-v="${b?.stage?.n ?? -1}">${b?.stage?.n != null ? `<span class="num">${esc(b.stage.n)}</span> <span class="sub inline">${esc(b.stage.name ?? "")}</span>` : "—"}</td>
    <td data-v="${f.issues ?? -1}" class="num">${f.issues == null ? `<span class="dim" title="Issues are turned off">off</span>` : `<a href="${esc(f.issuesUrl)}">${f.issues}</a>`}</td>
    <td data-v="${f.prs}" class="num">${f.prs ? `<a href="${esc(f.url)}/pulls">${f.prs}</a>` : "0"}</td>
    <td data-v="${esc(f.pushedAt ?? "")}">${time(f.pushedAt)}</td>
    <td class="links">${links.join("")}</td>
  </tr>`;
}

const scriptOptions = scriptList.map(([s]) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");

const issuesHtml = d.issues.length
  ? d.issues
      .map(
        (i) => `<li>
      <a class="issue-title" href="${esc(i.url)}">${esc(i.title)}</a>
      <div class="sub">${esc(i.font)} #${i.number} · opened ${time(i.createdAt)}${i.author ? ` by ${esc(i.author)}` : ""}${i.labels.map((l) => ` <span class="label">${esc(l.name)}</span>`).join("")}</div>
    </li>`,
      )
      .join("\n")
  : `<li class="dim">No open issues.</li>`;

const columns = [
  ["Font", "font"],
  ["Scripts", ""],
  ["License", ""],
  ["Version", ""],
  ["CI", ""],
  ["QA", ""],
  ["Stage", ""],
  ["Issues", "num"],
  ["PRs", "num"],
  ["Updated", ""],
];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mooniak open source — fonts, tools and build status</title>
<meta name="description" content="Every open-source Mooniak font with its build, QA and issue status, and the open tools and standards behind them.">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#ffffff; --ink:#0a0a0a; --ink-dim:#5c5c5c; --ink-muted:#8a8a8a;
    --line:#d9d9d9; --wash:#f5f5f5; --track:#e6e6e6; --fill:#0a0a0a;
    --good:#0ca30c; --good-ink:#006300; --warning:#fab219; --critical:#d03b3b; --critical-ink:#b42d2d;
    --shadow:0 1px 2px rgba(0,0,0,.04), 0 6px 20px rgba(0,0,0,.05);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#111110; --ink:#f2f2f0; --ink-dim:#a8a8a3; --ink-muted:#7a7a75;
      --line:#2f2f2c; --wash:#1c1c1a; --track:#2c2c2a; --fill:#f2f2f0;
      --good-ink:#0ca30c; --critical-ink:#e06666; --shadow:none;
    }
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.5 "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:inherit; text-decoration-thickness:1px; text-underline-offset:2px}
  a:hover{text-decoration-thickness:2px}
  :focus-visible{outline:2px solid var(--ink); outline-offset:2px}
  .wrap{max-width:1440px; margin:0 auto; padding:48px 24px 96px}
  .mono,.pill,.label,code{font-family:"IBM Plex Mono", ui-monospace, monospace}

  header.top{display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; gap:12px 24px;
    border-bottom:1px solid var(--line); padding-bottom:14px}
  .brand{font-weight:700; letter-spacing:-.01em; text-decoration:none; font-size:17px}
  nav.top-links{display:flex; flex-wrap:wrap; gap:6px 18px; font-size:14px}
  h1{font-size:clamp(28px,4vw,38px); letter-spacing:-.02em; margin:40px 0 8px}
  .lede{color:var(--ink-dim); max-width:66ch; margin:0; font-size:16.5px}
  h2{font-size:21px; letter-spacing:-.01em; margin:56px 0 6px}
  .section-lede{color:var(--ink-dim); margin:0 0 18px; font-size:14.5px}

  .grid{display:grid; grid-template-columns:repeat(auto-fill, minmax(270px,1fr)); gap:14px}
  .card{border:1px solid var(--line); border-radius:12px; padding:18px 20px; box-shadow:var(--shadow);
    display:flex; flex-direction:column; gap:9px; background:var(--bg)}
  .card h3{margin:0; font-size:16.5px}
  .card h3 a{text-decoration:none}
  .card h3 a:hover{text-decoration:underline}
  .badges{display:flex; gap:6px; flex-wrap:wrap}
  .pill{display:inline-block; font-size:11px; font-weight:600; letter-spacing:.02em; padding:2px 8px;
    border-radius:999px; border:1px solid var(--line); color:var(--ink-dim); white-space:nowrap}
  .tagline{margin:0; color:var(--ink-dim); font-size:14px}
  .card-links{margin-top:auto; display:flex; gap:14px; flex-wrap:wrap; font-size:13.5px; padding-top:2px}
  .more{margin:14px 0 0; font-size:14px}

  .tiles{display:grid; grid-template-columns:repeat(auto-fit, minmax(210px,1fr)); gap:14px; margin-top:8px}
  .tile{border:1px solid var(--line); border-radius:12px; padding:16px 18px}
  .tile-label{font-size:13px; color:var(--ink-dim)}
  .tile-value{font-size:30px; font-weight:600; letter-spacing:-.01em; line-height:1.2; margin:4px 0 2px}
  .tile-sub{font-size:12.5px; color:var(--ink-muted)}

  .filters{display:flex; flex-wrap:wrap; gap:10px 14px; align-items:end; margin:18px 0 12px}
  .filters label{display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--ink-dim)}
  .filters input,.filters select{font:inherit; font-size:14px; color:var(--ink); background:var(--bg);
    border:1px solid var(--line); border-radius:8px; padding:6px 10px; min-width:150px}
  .filters input{min-width:240px}
  .count{font-size:13px; color:var(--ink-dim); margin-left:auto; padding-bottom:7px}

  .table-wrap{overflow-x:auto; border:1px solid var(--line); border-radius:12px}
  table{border-collapse:collapse; width:100%; font-size:14px; min-width:1240px}
  th,td{text-align:left; padding:10px 10px; border-bottom:1px solid var(--line); vertical-align:top}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--wash)}
  th{font-size:12.5px; font-weight:600; color:var(--ink-dim); white-space:nowrap; background:var(--wash); position:sticky; top:0}
  th button{all:unset; cursor:pointer}
  th button::after{content:" ↕"; color:var(--ink-muted)}
  th[aria-sort=ascending] button::after{content:" ↑"; color:var(--ink)}
  th[aria-sort=descending] button::after{content:" ↓"; color:var(--ink)}
  .num{font-variant-numeric:tabular-nums}
  th.num,td.num{text-align:right}
  .sub{font-size:12.5px; color:var(--ink-dim); margin-top:2px}
  .sub.inline{display:inline}
  .dim{color:var(--ink-muted)}
  td.font{min-width:210px}
  .font-name{font-weight:600; text-decoration:none}
  .font-name:hover{text-decoration:underline}
  td.links{white-space:nowrap}
  td.links a{margin-right:10px; font-size:13px}

  .status{display:inline-flex; gap:5px; align-items:baseline; font-weight:600; font-size:13px; text-decoration:none; white-space:nowrap}
  .status span{font-size:12px}
  .status.good span{color:var(--good)} .status.good{color:var(--good-ink)}
  .status.critical span,.status.critical{color:var(--critical-ink)}
  .status.warning span{color:var(--warning)}
  .status.muted{color:var(--ink-muted); font-weight:500}
  a.status:hover{text-decoration:underline}

  .qa{min-width:150px}
  .qa-top{display:flex; align-items:center; gap:8px}
  .qa-top .num{min-width:3.2ch; font-weight:600}
  .meter{flex:1; max-width:90px; height:6px; border-radius:3px; background:var(--track); overflow:hidden}
  .meter span{display:block; height:100%; background:var(--fill); border-radius:3px}
  .qa .sub{display:flex; align-items:center; gap:8px; white-space:nowrap}
  .spark{overflow:visible}
  .spark path{fill:none; stroke:var(--ink-muted); stroke-width:1.5; stroke-linejoin:round; stroke-linecap:round}
  .spark .dot{fill:var(--ink-muted)}
  .spark .last .dot{fill:var(--ink)}
  .spark .hit{fill:transparent}
  .spark .pt:hover .dot{fill:var(--ink); r:3}

  ul.issues{list-style:none; padding:0; margin:0; border:1px solid var(--line); border-radius:12px}
  ul.issues li{padding:11px 16px; border-bottom:1px solid var(--line)}
  ul.issues li:last-child{border-bottom:0}
  .issue-title{font-weight:500; text-decoration:none}
  .issue-title:hover{text-decoration:underline}
  .label{font-size:11px; border:1px solid var(--line); border-radius:999px; padding:0 7px; margin-left:4px; color:var(--ink-dim)}

  footer{margin-top:64px; padding-top:18px; border-top:1px solid var(--line); color:var(--ink-dim); font-size:13px; display:flex; flex-wrap:wrap; gap:6px 18px}
  .empty{padding:24px; text-align:center; color:var(--ink-dim)}
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <a class="brand" href="${esc(d.websiteUrl)}">mooniak</a>
    <nav class="top-links" aria-label="Mooniak">
      <a href="#tools">Tools</a>
      <a href="#fonts">Fonts</a>
      <a href="#issues">Issues</a>
      <a href="tools/">How it fits together</a>
      <a href="${esc(d.websiteUrl)}">mooniak.com</a>
      <a href="https://github.com/${esc(d.org)}">GitHub</a>
    </nav>
  </header>

  <h1>Mooniak open source</h1>
  <p class="lede">The open tools and standards Mooniak builds for Sri Lankan scripts, and every
    open-source font we make, with each one's latest build, quality checks and open issues.</p>

  <section id="tools" aria-labelledby="tools-h">
    <h2 id="tools-h">Open-source projects and tooling</h2>
    <p class="section-lede">The tools and standards listed on <a href="${esc(d.websiteUrl)}/en/tools">mooniak.com</a>.</p>
    <div class="grid">
${toolsHtml}
    </div>
    <p class="more"><a href="https://github.com/orgs/${esc(d.org)}/repositories?q=visibility%3Apublic">All public Mooniak repositories on GitHub →</a></p>
  </section>

  <section id="fonts" aria-labelledby="fonts-h">
    <h2 id="fonts-h">Font directory</h2>
    <p class="section-lede">CI is the latest build workflow run on dev or the default branch. QA, version and stage come from the
      <code>build.json</code> each font's CI publishes, and so appear only for repos on the current build setup.</p>
    <div class="tiles">${tiles}</div>

    <form class="filters" role="search" onsubmit="return false">
      <label>Search<input type="search" id="q" placeholder="Name, designer, script…" autocomplete="off"></label>
      <label>Script<select id="script"><option value="">All scripts</option>${scriptOptions}</select></label>
      <label>CI<select id="ci"><option value="">Any status</option><option value="passing">Passing</option><option value="failing">Failing</option><option value="other">No CI or other</option></select></label>
      <span class="count" id="count" aria-live="polite">${fonts.length} fonts</span>
    </form>

    <div class="table-wrap">
      <table id="fonts-table">
        <thead><tr>
          ${columns.map(([label, cls], i) => `<th scope="col" class="${cls}" data-col="${i}"><button type="button">${label}</button></th>`).join("")}
          <th scope="col">Links</th>
        </tr></thead>
        <tbody>
${fonts.map(fontRow).join("\n")}
        </tbody>
      </table>
      <div class="empty" id="empty" hidden>No fonts match these filters.</div>
    </div>
  </section>

  <section id="issues" aria-labelledby="issues-h">
    <h2 id="issues-h">Newest open issues</h2>
    <p class="section-lede">Across all the font repositories above. Found a problem in a font? Open an issue on its repository.</p>
    <ul class="issues">
${issuesHtml}
    </ul>
  </section>

  <footer>
    <span>Updated ${time(d.generatedAt)} ${d.runUrl ? `by <a href="${esc(d.runUrl)}">this run</a>` : ""}</span>
    <span>Data: <a href="data/dashboard.json">dashboard.json</a></span>
    <span>Source: <a href="https://github.com/${esc(d.org)}/mooniak.github.io">${esc(d.org)}/mooniak.github.io</a></span>
    ${d.errors.length ? `<span>${d.errors.length} source${d.errors.length === 1 ? "" : "s"} could not be read this run</span>` : ""}
  </footer>
</div>

<script>
(() => {
  const tbody = document.querySelector("#fonts-table tbody");
  const rows = [...tbody.rows];
  const q = document.getElementById("q"), script = document.getElementById("script"), ci = document.getElementById("ci");
  const count = document.getElementById("count"), empty = document.getElementById("empty");

  function filter() {
    const text = q.value.trim().toLowerCase(), s = script.value, c = ci.value;
    let shown = 0;
    for (const r of rows) {
      const ok = (!text || r.dataset.search.includes(text)) &&
        (!s || r.dataset.scripts.split("|").includes(s)) && (!c || r.dataset.ci === c);
      r.hidden = !ok; if (ok) shown++;
    }
    count.textContent = shown === rows.length ? rows.length + " fonts" : shown + " of " + rows.length + " fonts";
    empty.hidden = shown > 0;
  }
  [q, script, ci].forEach((el) => el.addEventListener("input", filter));

  document.querySelectorAll("#fonts-table th[data-col]").forEach((th) => {
    th.querySelector("button").addEventListener("click", () => {
      const col = +th.dataset.col;
      const dir = th.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
      document.querySelectorAll("#fonts-table th").forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", dir);
      const val = (r) => r.cells[col].dataset.v ?? "";
      const numeric = rows.every((r) => val(r) === "" || !isNaN(+val(r)));
      rows.sort((a, b) => {
        const x = val(a), y = val(b);
        const cmp = numeric ? (+x || 0) - (+y || 0) : x.localeCompare(y, undefined, { numeric: true });
        return dir === "ascending" ? cmp : -cmp;
      });
      rows.forEach((r) => tbody.appendChild(r));
    });
  });

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
  document.querySelectorAll("time[datetime]").forEach((t) => {
    const diff = new Date(t.getAttribute("datetime")) - Date.now();
    const [unit, ms] = units.find(([, ms]) => Math.abs(diff) >= ms) || ["minute", 6e4];
    t.textContent = rtf.format(Math.round(diff / ms), unit);
  });
})();
</script>
</body>
</html>
`;

await writeFile(path.join(site, "index.html"), html);

// Pages deploys only _site, so carry over what the repo already served:
// the tools map at /tools/ and TOOLS.md (Jekyll also served it as /TOOLS.html).
for (const f of ["tools", "TOOLS.md", "CNAME"]) {
  await cp(path.join(root, f), path.join(site, f), { recursive: true });
}
await writeFile(
  path.join(site, "TOOLS.html"),
  `<!doctype html><meta charset="utf-8"><title>Tools &amp; apps</title><meta http-equiv="refresh" content="0; url=tools/"><link rel="canonical" href="tools/"><a href="tools/">Tools &amp; apps</a>\n`,
);
await writeFile(path.join(site, ".nojekyll"), "");
console.log(`wrote ${path.relative(root, path.join(site, "index.html"))} (${fonts.length} fonts, ${d.tools.length} tools)`);

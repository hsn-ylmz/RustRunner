#!/usr/bin/env node
/**
 * Builds the static project site in docs/ (GitHub Pages) from the app's own data, so the numbers and
 * lists on it cannot drift from the app:
 *
 *   docs/index.html        what RustRunner is, the recordings, downloads
 *   docs/ribo-seq.html     the Ribo-seq walkthrough (template, settings, expected results)
 *   docs/library.html      every template and every catalog tool, generated from
 *                          src/renderer/tools/catalog.json and src/renderer/templates/*.json
 *
 * docs/style.css is written by hand. No script, font or image is loaded from another site.
 *
 *   npm run docs:site
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DESKTOP = path.join(REPO, 'RustRunner-Desktop');
const OUT = path.join(REPO, 'docs');

/** Where releases and the source live. Must match build.publish in package.json. */
const GITHUB = 'https://github.com/hsn-ylmz/RustRunner';
const RELEASES = `${GITHUB}/releases`;
/** Zenodo concept DOI: always resolves to the latest archived release. */
const DOI = '10.5281/zenodo.22177901';

/** The words the app's template gallery uses (templates/schema.ts). */
const DOMAINS = {
  qc: 'Read quality',
  dna: 'DNA sequencing',
  rna: 'RNA sequencing',
  epigenomics: 'Epigenomics',
  longread: 'Long reads',
  metagenomics: 'Metagenomics',
  assembly: 'Genome assembly',
  general: 'General',
};
const DIFFICULTIES = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const LAYOUTS = { single: 'Single-end reads', paired: 'Paired-end reads', either: 'Single- or paired-end reads' };

const MEDIA = {
  template: { file: 'media/template-to-run.gif', alt: 'Choosing the Ribo-seq template, picking the input files, creating the workflow and running it; the steps turn from waiting to running to done.' },
  catalog: { file: 'media/catalog-and-slots.gif', alt: 'Searching the tool catalog, filtering to tools that fit after the selected step, connecting two steps so the file slot fills in, and an orange edge where the file type does not fit.' },
  failure: { file: 'media/failure-and-report.gif', alt: 'A step fails an output check, the failure card names it, Edit step opens the setting, the run is repeated and the run report opens from the run history.' },
};

// -----------------------------------------------------------------------------
// Data
// -----------------------------------------------------------------------------

function loadLibrary(desktop = DESKTOP) {
  const renderer = path.join(desktop, 'src', 'renderer');
  const catalog = JSON.parse(fs.readFileSync(path.join(renderer, 'tools', 'catalog.json'), 'utf8'));
  const dir = path.join(renderer, 'templates');
  const templates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  return { catalog, templates, version: pkg.version };
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "1.0.0-beta.1" for a beta build is "open beta"; other versions are shown as they are. */
function isBeta(version) {
  return /-beta(\.|$)/.test(version);
}

function toolIndex(catalog) {
  return new Map(catalog.tools.map((t) => [t.id, t]));
}

/** The distinct tool names a template uses, in the order its steps use them. */
function templateTools(template, tools) {
  const seen = [];
  for (const step of template.steps) {
    const name = tools.get(step.tool)?.name ?? step.tool;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

function typeList(slots) {
  const types = new Set();
  for (const s of slots) for (const t of s.types ?? []) types.add(t);
  return [...types];
}

function installText(install) {
  if (install.kind === 'conda') return `${install.package} ${install.version} (${install.channel})`;
  if (install.kind === 'external') return `${install.binary} ${install.version} (downloaded from the vendor${install.license ? `, ${install.license}` : ''})`;
  return install.kind;
}

// -----------------------------------------------------------------------------
// Page frame
// -----------------------------------------------------------------------------

const NAV = [
  ['index.html', 'Home'],
  ['ribo-seq.html', 'Ribo-seq walkthrough'],
  ['library.html', 'Templates and tools'],
];

function page({ file, title, description, body, version }) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === file ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="style.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="index.html">RustRunner <span class="badge">${esc(isBeta(version) ? 'open beta' : `v${version}`)}</span></a>
    <nav aria-label="Main">
      ${nav}
      <a href="${GITHUB}">GitHub</a>
    </nav>
  </div>
</header>
<main id="main" class="wrap">
${wrapTables(body)}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>RustRunner ${esc(version)}${isBeta(version) ? ' (open beta)' : ''}. MIT License. <a href="${GITHUB}">Source code</a> | <a href="${RELEASES}">Releases</a> | <a href="${GITHUB}/issues">Report a problem</a></p>
    <p>Cite RustRunner: Yilmaz H. RustRunner: a visual, no-code workflow builder for bioinformatics. Zenodo. <a href="https://doi.org/${DOI}">doi:${DOI}</a></p>
  </div>
</footer>
</body>
</html>
`;
}

/** Every table scrolls sideways inside its own box on a narrow screen instead of widening the page. */
function wrapTables(html) {
  return html.replace(/<table( [^>]*)?>/g, (open) => `<div class="table-wrap">${open}`).replace(/<\/table>/g, '</table></div>');
}

function figure(key, caption) {
  const m = MEDIA[key];
  return `<figure>
  <img src="${m.file}" alt="${esc(m.alt)}" width="1280" height="800" loading="lazy">
  <figcaption>${esc(caption)}</figcaption>
</figure>`;
}

// -----------------------------------------------------------------------------
// Pages
// -----------------------------------------------------------------------------

function renderIndex(lib) {
  const nTools = lib.catalog.tools.length;
  const nTemplates = lib.templates.length;
  const beta = isBeta(lib.version);
  const domains = [...new Set(lib.templates.map((t) => DOMAINS[t.domain] ?? t.domain))];
  const body = `
<section class="hero">
  <h1>Build and run bioinformatics pipelines by drawing them.</h1>
  <p class="lead">RustRunner is a desktop app for biologists. Pick a template or add tools from a catalog, connect them, press Run. No workflow language to learn, no command line needed. The tools install themselves into isolated environments.</p>
  <p class="actions">
    <a class="button primary" href="${RELEASES}">Download ${esc(lib.version)}</a>
    <a class="button" href="ribo-seq.html">Follow the Ribo-seq example</a>
  </p>
${
  beta
    ? `  <p class="notice" role="note"><strong>Open beta.</strong> Version ${esc(lib.version)} is the first public beta of RustRunner 1.0. It is tested most on macOS with Apple silicon; Windows and Linux builds are published but not yet tested end to end. Please <a href="${GITHUB}/issues">report what breaks</a>. <a href="#limits">Known limitations</a>.</p>`
    : ''
}
</section>

<section>
  <h2>From a template to a finished run</h2>
  <p>This recording is the real app running the Ribo-seq with UMIs template on a public human dataset. Steps turn from waiting to running to done as the tools run; long waits are cut from the video, nothing is simulated.</p>
  ${figure('template', 'Template, input files, Create workflow, Run.')}
</section>

<section>
  <h2>What you get</h2>
  <div class="grid">
    <div class="card"><h3>${nTemplates} ready-made templates</h3><p>${esc(domains.join(', '))}. Choose your files, check a few settings that depend on your library, and the whole pipeline appears on the canvas.</p></div>
    <div class="card"><h3>${nTools}-tool catalog</h3><p>Every entry names its input and output files, installs the tool at a pinned version, and was run against the real program. <a href="library.html#tools">See the list</a>.</p></div>
    <div class="card"><h3>Named file slots</h3><p>Connect two steps and the output goes to the input that accepts its file type. Green edges fit, orange edges say what is wrong.</p></div>
    <div class="card"><h3>Safe to rerun</h3><p>Steps whose inputs did not change are skipped. Failed steps can retry, time out and be checked (file exists, not empty, enough lines). Keep going runs the independent branches after a failure.</p></div>
    <div class="card"><h3>Live status</h3><p>Every step shows waiting, running, retrying, done, failed or skipped with words and icons, and the log can be searched and filtered.</p></div>
    <div class="card"><h3>Reports and history</h3><p>Each run writes a self-contained HTML report and is listed in the run history. Templates that end in MultiQC give one combined quality report.</p></div>
  </div>
</section>

<section>
  <h2>A catalog that tells you what fits</h2>
  <p>Search by name, job or file type. "Only tools that fit after the selected step" hides what cannot read the selected step's output. When you connect two steps, the file slot fills in by itself.</p>
  ${figure('catalog', 'Palette search, the fits-after filter, an automatic slot binding, a green and an orange edge.')}
</section>

<section>
  <h2>When something fails, it says what and where</h2>
  <p>A failed check shows a card that names the step, the file and the setting. Edit step opens exactly that setting. Every run is kept in the run history with an HTML report.</p>
  ${figure('failure', 'A blocking output check fails, the step is edited, the run repeated and the report opened.')}
</section>

<section id="download">
  <h2>Download</h2>
  <p>Builds for each release are on the <a href="${RELEASES}">GitHub releases page</a>${beta ? ' (the open beta is marked as a pre-release)' : ''}.</p>
  <table>
    <thead><tr><th scope="col">System</th><th scope="col">File</th><th scope="col">Notes</th></tr></thead>
    <tbody>
      <tr><th scope="row">macOS, Apple silicon</th><td>.dmg or .zip (arm64)</td><td>The best tested system. Not signed: see below.</td></tr>
      <tr><th scope="row">macOS, Intel</th><td>.dmg or .zip (x64)</td><td>Not signed.</td></tr>
      <tr><th scope="row">Windows 64-bit</th><td>.exe installer</td><td>Not yet tested end to end.</td></tr>
      <tr><th scope="row">Linux 64-bit</th><td>.AppImage</td><td>Not yet tested end to end.</td></tr>
    </tbody>
  </table>
  <p><strong>macOS says the app cannot be opened?</strong> The builds are not signed with an Apple developer certificate. Drag RustRunner to Applications, then Control-click (right-click) it and choose Open, then Open again. If macOS still refuses, run <code>xattr -dr com.apple.quarantine /Applications/RustRunner.app</code> once.</p>
  <p>The app checks for updates on start. On Windows and Linux it downloads and installs them; on macOS it tells you and links to the download page, because the builds are unsigned. A beta build is offered the next beta and then the final 1.0; a stable build is never offered a beta.</p>
  <p>On first run the app downloads the tool installer (micromamba) if it is missing, and each tool the first time a workflow needs it. Allow several GB of disk space and a network connection for that first run.</p>
</section>

<section id="limits">
  <h2>Known limitations of the beta</h2>
  <ul>
    <li>macOS on Apple silicon is the primary tested system. Windows and Linux builds are published but have not been tested end to end.</li>
    <li>STAR and a few other tools have no native Apple-silicon build and run as Intel builds, which needs Rosetta.</li>
    <li>Tool versions are pinned, but their dependencies are not fully locked, so a future install may resolve a dependency differently.</li>
    <li>Commands were validated on synthetic and small real data, not on every kind of project.</li>
    <li>Builds are not code-signed, so macOS and Windows show a warning on first start.</li>
  </ul>
</section>
`;
  return page({
    file: 'index.html',
    title: 'RustRunner: visual bioinformatics pipelines',
    description: `RustRunner ${lib.version}: a desktop app to build and run bioinformatics pipelines without a workflow language.`,
    body,
    version: lib.version,
  });
}

function renderRibo(lib) {
  const tpl = lib.templates.find((t) => t.id === 'riboseq-umi-ribowaltz');
  if (!tpl) throw new Error('the Ribo-seq template is missing');
  const tools = toolIndex(lib.catalog);
  const used = templateTools(tpl, tools);
  const inputs = tpl.inputs.map((i) => `<tr><th scope="row">${esc(i.label)}</th><td><code>${esc(i.example ?? '')}</code></td></tr>`).join('\n');
  const body = `
<h1>Ribo-seq with UMIs: from reads to a riboWaltz report</h1>
<p class="lead">A real run on public human HEK293T data (GEO GSE158374, run SRR12693498), start to finish in the app. ${tpl.steps.length} steps: ${esc(used.join(', '))}.</p>
${figure('template', 'The same walkthrough, recorded.')}

<h2>Before you start</h2>
<ul>
  <li>Install RustRunner (<a href="index.html#download">download</a>) or run it from source.</li>
  <li>Get the data: <code>./riboseq-test/prepare_data.sh</code> in the repository builds the reads and references (about 610 MB of checksummed downloads). Details and provenance are in <a href="${GITHUB}/blob/main/riboseq-test/DATA.md">DATA.md</a>.</li>
  <li>On Apple silicon STAR runs as an Intel build, so Rosetta must be installed.</li>
  <li>Allow network access and a few GB for the first run, which installs the tools.</li>
</ul>

<h2>1. Choose the template</h2>
<p>Click <strong>Templates</strong>, type <code>ribo</code>, and pick <strong>${esc(tpl.name)}</strong>. The right-hand column draws the pipeline and lists what you will get.</p>

<h2>2. Choose your files</h2>
<table>
  <thead><tr><th scope="col">Field</th><th scope="col">Example file</th></tr></thead>
  <tbody>
${inputs}
  </tbody>
</table>

<h2>3. Check the settings of your library</h2>
<p>These depend on the kit, so the template asks before it builds the workflow. The defaults are those of the public test library (Diagenode D-Plex: a 12-base UMI and 4 template-switch bases at the 5' end, poly(A) tail and adapter at the 3' end).</p>
<table>
  <thead><tr><th scope="col">Setting</th><th scope="col">Default</th></tr></thead>
  <tbody>
${tpl.settings.map((s) => `    <tr><th scope="row">${esc(s.label)}</th><td>${esc(settingDefault(s, tpl, tools))}</td></tr>`).join('\n')}
  </tbody>
</table>

<h2>4. Create the workflow and run it</h2>
<p>Click <strong>Create workflow</strong>. The ${tpl.steps.length} steps appear on the canvas, connected, with no problems listed. Choose an empty results folder outside the data folder, then click <strong>Run</strong>. The first run installs the tools into isolated environments (5 to 20 minutes on a normal connection); later runs reuse them. Independent steps, such as the three index builds, run side by side.</p>

<h2>5. What you get</h2>
<ul>
${tpl.outputs.map((o) => `  <li><strong>${esc(o.label)}.</strong> ${esc(o.hint)}</li>`).join('\n')}
</ul>

<h2>What the run looked like</h2>
<p>On the 5-million-read file, measured on an Apple M5 Pro (tools already installed, STAR under Rosetta), the whole workflow took about two minutes. 95.9 % of reads carried the adapter, about 70 % of them matched rRNA and were removed, and riboWaltz found P-site offsets of 12 to 13 nt with 96 % of P-sites in the coding sequence. The 200,000-read file is too small for riboWaltz to estimate offsets; the report says so instead of inventing numbers. See the <a href="${GITHUB}/blob/main/riboseq-test/README.md">test README</a> for every expected number and what to look at critically.</p>

<h2>References</h2>
<ul class="refs">
${tpl.references.map((r) => `  <li>${r.url ? `<a href="${esc(r.url)}">${esc(r.label)}</a>` : esc(r.label)}</li>`).join('\n')}
</ul>
`;
  return page({
    file: 'ribo-seq.html',
    title: 'Ribo-seq walkthrough - RustRunner',
    description: 'Run a Ribo-seq pipeline with UMIs and riboWaltz in RustRunner on public data, step by step.',
    body,
    version: lib.version,
  });
}

/** The value a template setting starts with: what its target step sets, else the catalog parameter's default. */
function settingDefault(setting, template, tools) {
  const target = (setting.targets ?? [])[0];
  if (!target) return '';
  const step = template.steps.find((st) => st.key === target.step);
  const param = (tools.get(step?.tool)?.params ?? []).find((p) => p.id === target.param);
  let value = step?.params?.[target.param] ?? param?.default;
  if (value === undefined || value === null) return '';
  if (param?.option_labels?.[value]) return param.option_labels[value];
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (param?.type === 'select' && Array.isArray(param.options) && param.option_labels) return String(param.option_labels[value] ?? value);
  return String(value);
}

function renderLibrary(lib) {
  const tools = toolIndex(lib.catalog);
  const cats = lib.catalog.categories;
  const nTools = lib.catalog.tools.length;

  const templateRows = lib.templates
    .map((t) => {
      const used = templateTools(t, tools);
      return `    <tr id="template-${esc(t.id)}">
      <th scope="row">${esc(t.name)}<div class="small">${esc(t.description)}</div></th>
      <td>${esc(DOMAINS[t.domain] ?? t.domain)}</td>
      <td>${esc(DIFFICULTIES[t.difficulty] ?? t.difficulty)}</td>
      <td>${esc(t.readLayout ? LAYOUTS[t.readLayout] ?? t.readLayout : 'Long reads or signal')}</td>
      <td>${t.steps.length}</td>
      <td>${esc(used.join(', '))}</td>
    </tr>`;
    })
    .join('\n');

  const sections = Object.keys(cats)
    .map((cat) => {
      const list = lib.catalog.tools.filter((t) => t.category === cat);
      if (list.length === 0) return '';
      const rows = list
        .map(
          (t) => `      <tr id="tool-${esc(t.id)}">
        <th scope="row"><a href="${esc(t.docs)}">${esc(t.name)}</a><div class="small">${esc(t.subcategory)}</div></th>
        <td>${esc(t.description)}${t.needs_database ? ` <span class="small">Needs a ${esc(t.needs_database.label)}.</span>` : ''}</td>
        <td>${esc(typeList(t.inputs).join(', '))}</td>
        <td>${esc(typeList(t.outputs).join(', '))}</td>
        <td class="small">${esc(installText(t.install))}</td>
      </tr>`
        )
        .join('\n');
      return `<h3 id="category-${esc(cat)}">${esc(cats[cat].label)} <span class="count">${list.length}</span></h3>
<table class="wide">
    <thead><tr><th scope="col">Tool</th><th scope="col">What it does</th><th scope="col">Reads</th><th scope="col">Makes</th><th scope="col">Installed as</th></tr></thead>
    <tbody>
${rows}
    </tbody>
</table>`;
    })
    .filter(Boolean)
    .join('\n');

  const toc = Object.keys(cats)
    .filter((cat) => lib.catalog.tools.some((t) => t.category === cat))
    .map((cat) => `<a href="#category-${esc(cat)}">${esc(cats[cat].label)}</a>`)
    .join(' | ');

  const body = `
<h1>Templates and tools</h1>
<p class="lead">This page is generated from the app's own catalog (version ${esc(lib.catalog.version)}), so it always matches what ships: ${lib.templates.length} templates and ${nTools} tools.</p>

<h2 id="templates">Templates</h2>
<p>A template builds a whole pipeline from your files. The settings that depend on your data (adapter, strandedness, genome size) are asked before the workflow is created.</p>
<table class="wide">
    <thead><tr><th scope="col">Template</th><th scope="col">Field</th><th scope="col">Level</th><th scope="col">Reads</th><th scope="col">Steps</th><th scope="col">Tools</th></tr></thead>
    <tbody>
${templateRows}
    </tbody>
</table>

<h2 id="tools">Catalog tools</h2>
<p>Each entry names every file it reads and writes, installs the tool at a pinned version and was run against the real program. Jump to: ${toc}</p>
${sections}
`;
  return page({
    file: 'library.html',
    title: 'Templates and tools - RustRunner',
    description: `The ${lib.templates.length} workflow templates and ${nTools} catalog tools that ship with RustRunner ${lib.version}.`,
    body,
    version: lib.version,
  });
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

function build(out = OUT, lib = loadLibrary()) {
  fs.mkdirSync(out, { recursive: true });
  const pages = { 'index.html': renderIndex(lib), 'ribo-seq.html': renderRibo(lib), 'library.html': renderLibrary(lib) };
  for (const [name, html] of Object.entries(pages)) fs.writeFileSync(path.join(out, name), html);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return Object.keys(pages);
}

if (require.main === module) {
  const written = build();
  console.log(`docs: wrote ${written.join(', ')} (${loadLibrary().catalog.tools.length} tools, ${loadLibrary().templates.length} templates)`);
}

module.exports = { settingDefault, loadLibrary, renderIndex, renderRibo, renderLibrary, build, esc, isBeta, templateTools, typeList, MEDIA };

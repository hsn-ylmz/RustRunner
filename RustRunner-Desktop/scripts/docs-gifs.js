#!/usr/bin/env node
/**
 * Converts the recordings of `docs-media/gifs.docs.ts` (.sandbox/docs-media/*.json + .webm) into
 * GIFs in docs/media/: cuts the parts the recorder marked as waiting time, then two-pass palette
 * conversion (palettegen/paletteuse) at 10 to 12 fps.
 *
 * ffmpeg is looked up in this order: $FFMPEG, .sandbox/tools/ffmpeg/bin/ffmpeg (a micromamba
 * environment, `micromamba create -p .sandbox/tools/ffmpeg -c conda-forge ffmpeg`), then PATH.
 *
 *   node scripts/docs-gifs.js [name ...]     (default: every manifest found)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const IN = path.join(REPO, '.sandbox', 'docs-media');
const OUT = path.join(REPO, 'docs', 'media');
const MAX_BYTES = 5 * 1024 * 1024;

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, path.join(REPO, '.sandbox', 'tools', 'ffmpeg', 'bin', 'ffmpeg')].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'ffmpeg';
}

/** The `select` expression that drops the trimmed start and every cut. */
function keepExpression(manifest) {
  const drops = [`lt(t,${manifest.trimStart})`, ...manifest.cuts.map((c) => `between(t,${c.from.toFixed(3)},${c.to.toFixed(3)})`)];
  return `not(${drops.join('+')})`;
}

function filterFor(manifest, width, colors, fps) {
  return (
    `select='${keepExpression(manifest)}',setpts=N/(FRAME_RATE*TB),fps=${fps},scale=${width}:-1:flags=lanczos,` +
    `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`
  );
}

function convert(ffmpeg, manifest) {
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, `${manifest.name}.gif`);
  // Full size first; shrink only if the file is too big for a README.
  for (const [width, colors, fps] of [[1280, 128, 12], [1280, 128, 10], [1120, 128, 10], [1000, 96, 10], [900, 64, 8], [800, 64, 8]]) {
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', manifest.video, '-filter_complex', filterFor(manifest, width, colors, fps), '-loop', '0', target], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${manifest.name}:\n${r.stderr}`);
    const size = fs.statSync(target).size;
    console.log(`${manifest.name}: ${width}px, ${colors} colours, ${fps} fps -> ${(size / 1048576).toFixed(2)} MB`);
    if (size <= MAX_BYTES) return target;
  }
  console.warn(`${manifest.name}: still above ${MAX_BYTES / 1048576} MB at the smallest setting`);
  return target;
}

function main() {
  const wanted = process.argv.slice(2);
  const ffmpeg = findFfmpeg();
  const manifests = fs
    .readdirSync(IN)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8')))
    .filter((m) => wanted.length === 0 || wanted.includes(m.name));
  if (manifests.length === 0) throw new Error(`no recordings in ${IN}; run the recorder first`);
  for (const m of manifests) {
    const cut = m.cuts.reduce((s, c) => s + (c.to - c.from), 0);
    console.log(`${m.name}: ${m.durationSeconds.toFixed(0)} s recorded, ${cut.toFixed(0)} s of waiting cut in ${m.cuts.length} places`);
    convert(ffmpeg, m);
  }
}

if (require.main === module) main();
module.exports = { keepExpression };

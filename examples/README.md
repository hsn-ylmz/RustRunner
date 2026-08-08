# Example Workflows

Two runnable workflows for exercising the desktop app end to end. Both are saved
in the app's own format, so they open with **File → Open** (or the toolbar
**Open** button).

| File | What it covers |
|---|---|
| `01-basic-chain.json` | Plain 3-step linear pipeline. No wildcards. |
| `02-wildcard-batch.json` | Per-sample batch processing — 2 steps that each expand across 3 input files. Also exercises the `threads` field. |

Sample inputs live in `data/` (`s1.txt`, `s2.txt`, `s3.txt` — 2, 3 and 1 lines
respectively, so you can tell the per-sample outputs apart).

## Running them

1. Open the workflow in RustRunner.
2. Click **Set Directory** and choose **this `examples/` folder**. The workflows
   use paths relative to it (`data/…`, `out/…`), so this matters.
3. Click **Dry Run** to preview, or **Run** to execute.

Outputs are written to `examples/out/`, which the first step creates. Delete it
between runs if you want a clean slate — it is gitignored.

### What you should see

`01-basic-chain` runs `prepare → shout → report` in sequence, producing
`out/greeting.txt`, `out/greeting.upper.txt` and `out/report.txt` (containing
`3`).

`02-wildcard-batch` expands each of its 2 steps into 3 instances — one per
sample — and runs the samples in parallel:

```
normalize_s1  normalize_s2  normalize_s3
     ↓             ↓             ↓
  count_s1      count_s2      count_s3
```

It produces `out/s{1,2,3}.upper` and `out/s{1,2,3}.count`. On the canvas, both
nodes should show a `3/3` progress count when finished.

## Notes on wildcards

A step opts into expansion by putting `{sample}` in its **input** or **output**
pattern, and by having files attached (the **Select Files for Batch Processing**
button in the properties panel). Both nodes in `02-wildcard-batch` have files
attached, because both use `{sample}`.

Two current engine limitations are worth knowing before you build on these:

- **One wildcard name per step.** `Step::validate_wildcards` rejects a step that
  uses more than one, so `{sample}` is the only name these examples use.
- **A wildcard step cannot connect to a non-wildcard step.** Expansion rewrites
  edge references by suffixing them with the wildcard value, so a `next: [report]`
  on an expanded step becomes `report_s1`, which does not exist, and the workflow
  fails to load with `references unknown step 'report_s1'`. In practice this means
  there is no way to express a **fan-in / aggregate** stage after a batch stage —
  every downstream step must also expand per sample. That is why
  `02-wildcard-batch` stops at `count` rather than summarising the results.

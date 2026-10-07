#!/usr/bin/env Rscript
# riboWaltz report for RustRunner.
#
# Reads one or more transcript-coordinate BAM files (STAR --quantMode
# TranscriptomeSAM, after filtering, sorting and UMI deduplication) and writes
#
#   <out>/ribowaltz_report.html   one self-contained page: figures are inline
#                                 base64 PNG images, there is no script, no
#                                 stylesheet link and no web font, and the page
#                                 needs neither pandoc nor a network
#   <out>/*.tsv                   the tables behind every figure
#
# The report holds: read-length distribution, the table of P-site offsets,
# read ends around start and stop codons, 3-nt periodicity by region and by
# read length, metaprofiles around start and stop codons, P-sites per region
# (5' UTR, CDS, 3' UTR) and codon usage (when a genome FASTA is given).
#
# Usage (the RustRunner catalog entry "riboWaltz report" runs exactly this):
#
#   Rscript --vanilla ribowaltz_report.R --gtf genes.gtf --out report_dir/ \
#       [--fasta genome.fa] [--min-length 28] [--max-length 34] \
#       [--extremity auto|5end|3end] [--flanking 6] [--threads 2] -- a.bam b.bam
#
# What it never does: it does not invent numbers. When riboWaltz cannot
# estimate P-site offsets (too few reads over annotated start codons), the
# report says so at the top, keeps the figures that do not need offsets, and
# the offsets table is empty.
#
# The functions below are plain and testable: the file can be `source()`d
# without running anything (see test-tools/riboseq/test_ribowaltz_report.R).

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

#' The analysis lengths and other options, from the command line.
#' Stops with a message that names the problem.
parse_args <- function(argv) {
  opt <- list(
    gtf = NULL, out = NULL, fasta = NULL, min_length = 28L, max_length = 34L,
    extremity = "auto", flanking = 6L, threads = 1L, bams = character()
  )
  need_value <- function(i, flag) {
    if (i >= length(argv)) stop(sprintf("%s needs a value", flag), call. = FALSE)
    argv[[i + 1L]]
  }
  as_count <- function(text, flag, low, high) {
    n <- suppressWarnings(as.numeric(text))
    if (is.na(n) || n != round(n) || n < low || n > high) {
      stop(sprintf("%s must be a whole number from %d to %d, not '%s'", flag, low, high, text), call. = FALSE)
    }
    as.integer(n)
  }
  i <- 1L
  while (i <= length(argv)) {
    a <- argv[[i]]
    if (a == "--") {
      opt$bams <- c(opt$bams, argv[-seq_len(i)])
      break
    }
    switch(a,
      "--gtf" = { opt$gtf <- need_value(i, a); i <- i + 1L },
      "--out" = { opt$out <- need_value(i, a); i <- i + 1L },
      "--fasta" = { opt$fasta <- need_value(i, a); i <- i + 1L },
      "--min-length" = { opt$min_length <- as_count(need_value(i, a), a, 10L, 200L); i <- i + 1L },
      "--max-length" = { opt$max_length <- as_count(need_value(i, a), a, 10L, 200L); i <- i + 1L },
      "--flanking" = { opt$flanking <- as_count(need_value(i, a), a, 0L, 100L); i <- i + 1L },
      "--threads" = { opt$threads <- as_count(need_value(i, a), a, 1L, 256L); i <- i + 1L },
      "--extremity" = {
        v <- need_value(i, a)
        if (!v %in% c("auto", "5end", "3end")) stop("--extremity must be auto, 5end or 3end", call. = FALSE)
        opt$extremity <- v
        i <- i + 1L
      },
      {
        if (startsWith(a, "--")) stop(sprintf("unknown option %s", a), call. = FALSE)
        opt$bams <- c(opt$bams, a)
      }
    )
    i <- i + 1L
  }
  if (is.null(opt$gtf)) stop("--gtf is required (the annotation the STAR index was built with)", call. = FALSE)
  if (is.null(opt$out)) stop("--out is required (the report folder)", call. = FALSE)
  if (length(opt$bams) == 0L) stop("no BAM file was given (list them after --)", call. = FALSE)
  if (opt$min_length > opt$max_length) {
    stop(sprintf("the shortest length (%d) is larger than the longest (%d)", opt$min_length, opt$max_length), call. = FALSE)
  }
  opt
}

#' One name per BAM file for the report. The file name without extension; when
#' that is not unique (every sample's file is called deduplicated.bam) the name
#' of its folder is put in front, and a number as the last resort. Only letters,
#' digits, `_` and `-` are kept, because riboWaltz names samples after files.
sample_names <- function(paths) {
  clean <- function(x) gsub("^_+|_+$", "", gsub("[^A-Za-z0-9_-]+", "_", x))
  stem <- function(p) sub("\\.bam$", "", basename(p), ignore.case = TRUE)
  names1 <- clean(stem(paths))
  names1[names1 == ""] <- "sample"
  if (anyDuplicated(names1) == 0L) return(names1)
  parent <- clean(basename(dirname(normalizePath(paths, mustWork = FALSE))))
  names2 <- ifelse(parent == "", names1, paste(parent, names1, sep = "_"))
  if (anyDuplicated(names2) == 0L) return(names2)
  # Still the same: number every repeat, keeping the first as it is.
  made <- names2
  for (nm in unique(names2[duplicated(names2)])) {
    at <- which(names2 == nm)
    made[at] <- paste0(nm, "_", seq_along(at))
  }
  made
}

html_escape <- function(x) {
  x <- as.character(x)
  x <- gsub("&", "&amp;", x, fixed = TRUE)
  x <- gsub("<", "&lt;", x, fixed = TRUE)
  x <- gsub(">", "&gt;", x, fixed = TRUE)
  x <- gsub("\"", "&quot;", x, fixed = TRUE)
  gsub("'", "&#39;", x, fixed = TRUE)
}

.b64_alphabet <- c(LETTERS, letters, 0:9, "+", "/")

#' Base64 text of a raw vector (RFC 4648, with padding). Plain R, so the report
#' does not depend on a package that happens to be installed.
b64encode <- function(bytes) {
  n <- length(bytes)
  if (n == 0L) return("")
  pad <- (3L - n %% 3L) %% 3L
  m <- matrix(c(as.integer(bytes), rep(0L, pad)), nrow = 3L)
  v <- bitwShiftL(m[1L, ], 16L) + bitwShiftL(m[2L, ], 8L) + m[3L, ]
  codes <- rbind(
    bitwShiftR(v, 18L), bitwAnd(bitwShiftR(v, 12L), 63L),
    bitwAnd(bitwShiftR(v, 6L), 63L), bitwAnd(v, 63L)
  )
  chars <- .b64_alphabet[as.vector(codes) + 1L]
  if (pad > 0L) chars[(length(chars) - pad + 1L):length(chars)] <- "="
  paste(chars, collapse = "")
}

#' A number for a table cell: whole numbers without decimals, other numbers
#' rounded; NA becomes a dash.
format_cell <- function(x, digits = 2L) {
  if (is.factor(x)) x <- as.character(x)
  if (is.logical(x)) return(ifelse(is.na(x), "–", ifelse(x, "yes", "no")))
  if (is.numeric(x)) {
    out <- ifelse(is.na(x), "–", ifelse(x == round(x), format(x, scientific = FALSE, trim = TRUE),
      format(round(x, digits), nsmall = digits, scientific = FALSE, trim = TRUE)))
    return(out)
  }
  ifelse(is.na(x), "–", as.character(x))
}

#' An HTML table of a data frame, with the column headings given in `headers`
#' (same order as the columns), every value escaped.
html_table <- function(df, headers = names(df), digits = 2L, class = "data") {
  if (nrow(df) == 0L) return("<p class=\"note\">No rows.</p>")
  head <- paste0("<th>", html_escape(headers), "</th>", collapse = "")
  rows <- vapply(seq_len(nrow(df)), function(i) {
    cells <- vapply(seq_along(df), function(j) {
      v <- format_cell(df[[j]][i], digits)
      paste0("<td", if (is.numeric(df[[j]]) || is.logical(df[[j]])) " class=\"num\"" else "", ">", html_escape(v), "</td>")
    }, character(1))
    paste0("<tr>", paste(cells, collapse = ""), "</tr>")
  }, character(1))
  sprintf("<table class=\"%s\"><thead><tr>%s</tr></thead><tbody>%s</tbody></table>", class, head, paste(rows, collapse = "\n"))
}

#' A figure with its caption. `uri` is a data: URI.
html_figure <- function(uri, caption, alt = caption) {
  sprintf("<figure><img src=\"%s\" alt=\"%s\"><figcaption>%s</figcaption></figure>", uri, html_escape(alt), html_escape(caption))
}

#' The first ggplot object of a riboWaltz result (a list with the plot, the
#' plotted values and the counts), or NULL.
first_plot <- function(result) {
  if (!is.list(result)) return(NULL)
  found <- Filter(function(x) inherits(x, "ggplot"), result)
  if (length(found) == 0L) NULL else found[[1L]]
}

#' Draws a ggplot into a PNG file and returns it as a data: URI.
plot_uri <- function(plot, width = 8, height = 4.5, res = 110) {
  file <- tempfile(fileext = ".png")
  on.exit(unlink(file), add = TRUE)
  opened <- tryCatch({
    grDevices::png(file, width = width, height = height, units = "in", res = res, type = "cairo")
    TRUE
  }, error = function(e) FALSE, warning = function(w) FALSE)
  if (!opened) grDevices::png(file, width = width, height = height, units = "in", res = res)
  tryCatch(print(plot), finally = grDevices::dev.off())
  size <- file.info(file)$size
  if (is.na(size) || size == 0) stop("the figure could not be drawn")
  paste0("data:image/png;base64,", b64encode(readBin(file, "raw", size)))
}

#' Reads of one sample that cover the whole start codon with `flanking` bases
#' on both sides: what riboWaltz needs to estimate offsets.
start_codon_reads <- function(reads, flanking) {
  if (is.null(reads) || nrow(reads) == 0L) return(0L)
  sum(reads$cds_start > 0 & reads$end5 <= reads$cds_start - flanking &
        reads$end3 >= reads$cds_start + 2L + flanking, na.rm = TRUE)
}

#' Share (percent) of the CDS P-sites that fall in the most frequent frame.
dominant_frame_share <- function(frame_counts) {
  if (is.null(frame_counts) || nrow(frame_counts) == 0L) return(NA_real_)
  cds <- frame_counts[frame_counts$region == "CDS", , drop = FALSE]
  if (nrow(cds) == 0L || sum(cds$count) == 0) return(NA_real_)
  100 * max(cds$count) / sum(cds$count)
}

# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------

PAGE_STYLE <- "
:root { --bg:#ffffff; --surface:#f5f6f8; --text:#1c2230; --muted:#566074; --line:#d5d9e2; --accent:#27509b; --warn-bg:#fff4d6; --warn-line:#a86b00; --warn-text:#4d3000; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171f; --surface:#1d222d; --text:#e6e9f0; --muted:#a3adc2; --line:#343b4c; --accent:#8fb0f0; --warn-bg:#3a2d0c; --warn-line:#e0a53a; --warn-text:#f6e3b4; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.7rem; margin: 0 0 4px; }
h2 { font-size: 1.25rem; margin: 40px 0 8px; padding-top: 8px; border-top: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 24px 0 6px; }
p, li { max-width: 72ch; }
.note, .meta { color: var(--muted); }
nav ul { padding-left: 20px; }
a { color: var(--accent); }
.warn { background: var(--warn-bg); color: var(--warn-text); border-left: 4px solid var(--warn-line); padding: 8px 16px; margin: 16px 0; border-radius: 4px; }
.warn p { margin: 6px 0; }
table.data { border-collapse: collapse; margin: 8px 0 16px; font-size: .92rem; display: block; overflow-x: auto; max-width: 100%; }
table.data th, table.data td { border-bottom: 1px solid var(--line); padding: 4px 10px; text-align: left; white-space: nowrap; }
table.data th { background: var(--surface); position: sticky; top: 0; }
table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
figure { margin: 8px 0 20px; }
figure img { max-width: 100%; height: auto; background: #fff; border: 1px solid var(--line); border-radius: 4px; }
figcaption { color: var(--muted); font-size: .9rem; margin-top: 4px; }
code { background: var(--surface); padding: 1px 5px; border-radius: 3px; }
"

section_html <- function(id, title, intro, body) {
  sprintf("<section id=\"%s\"><h2>%s</h2>%s%s</section>", id, html_escape(title),
          if (nzchar(intro)) paste0("<p>", html_escape(intro), "</p>") else "", body)
}

build_page <- function(title, meta_lines, warnings, summary_html, sections) {
  warn_html <- if (length(warnings) == 0L) "" else paste0(
    "<div class=\"warn\" role=\"alert\"><strong>Read this first</strong>",
    paste0("<p>", html_escape(warnings), "</p>", collapse = ""), "</div>")
  nav <- paste0("<li><a href=\"#", names(sections), "\">", html_escape(vapply(sections, function(s) s$title, character(1))), "</a></li>", collapse = "")
  body <- paste(vapply(sections, function(s) section_html(s$id, s$title, s$intro, s$body), character(1)), collapse = "\n")
  paste0(
    "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>", html_escape(title), "</title><style>", PAGE_STYLE, "</style></head><body><main>",
    "<h1>", html_escape(title), "</h1>",
    "<p class=\"meta\">", paste(html_escape(meta_lines), collapse = "<br>"), "</p>",
    warn_html, summary_html,
    "<nav aria-label=\"Sections\"><ul>", nav, "</ul></nav>",
    body, "</main></body></html>\n")
}

# ---------------------------------------------------------------------------
# The analysis
# ---------------------------------------------------------------------------

quiet <- function(expr) {
  # riboWaltz and txdbmaker print progress and a note about a renamed function;
  # keep the real warnings.
  withCallingHandlers(
    suppressMessages(expr),
    warning = function(w) {
      if (grepl("has moved to the txdbmaker|phase.*stop_codon|The \"phase\" metadata", conditionMessage(w))) {
        invokeRestart("muffleWarning")
      }
    }
  )
}

#' riboWaltz 2.0 stops with "the condition has length > 1" when two offsets tie
#' for the highest count at the start codon, which happens with a few hundred
#' start-codon reads. Nothing in the data is wrong, so the offsets are worked
#' out again with one or two more or fewer bases around the start codon (the
#' tie is then almost always gone) and the caller says that it did so. Any other
#' error is raised as it is. Returns the table, the lines riboWaltz printed and
#' the number of flanking bases that was used.
psite_with_tie_fallback <- function(data, flanking, extremity, max_shift = 3L) {
  tried <- unique(c(flanking, as.vector(rbind(flanking + seq_len(max_shift), flanking - seq_len(max_shift)))))
  tried <- tried[tried >= 0L]
  last <- NULL
  for (f in tried) {
    printed <- character()
    result <- tryCatch({
      printed <- utils::capture.output(
        table <- suppressWarnings(quiet(psite(data, flanking = f, extremity = extremity))),
        type = "output")
      list(table = table, printed = printed, flanking = f)
    }, error = function(e) e)
    if (!inherits(result, "error")) return(result)
    last <- result
    if (!grepl("condition has length > 1", conditionMessage(result), fixed = TRUE)) break
  }
  stop(last)
}

write_tsv <- function(df, path) {
  data.table::fwrite(as.data.frame(df), path, sep = "\t", quote = FALSE, na = "NA")
}

OFFSET_COLUMNS <- c("sample", "length", "total_percentage", "start_percentage", "around_start",
                    "offset_from_5", "offset_from_3", "corrected_offset_from_5", "corrected_offset_from_3")

run_report <- function(opt) {
  .libPaths(.Library) # this R's own packages only, whatever the user has installed
  suppressPackageStartupMessages({
    library(data.table)
    library(ggplot2)
    library(riboWaltz)
  })
  data.table::setDTthreads(opt$threads)

  for (f in c(opt$gtf, opt$bams, opt$fasta)) {
    if (!is.null(f) && !file.exists(f)) stop(sprintf("file not found: %s", f), call. = FALSE)
  }
  dir.create(opt$out, recursive = TRUE, showWarnings = FALSE)
  if (!dir.exists(opt$out)) stop(sprintf("cannot create the report folder %s", opt$out), call. = FALSE)

  warnings_out <- character()
  warn <- function(text) {
    message("WARNING: ", text)
    warnings_out <<- c(warnings_out, text)
  }
  sections <- list()
  add_section <- function(id, title, intro, body) {
    sections[[id]] <<- list(id = id, title = title, intro = intro, body = body)
  }
  lengths_text <- sprintf("%d to %d", opt$min_length, opt$max_length)
  window <- opt$min_length:opt$max_length

  # --- annotation and reads -------------------------------------------------
  message("Reading the annotation: ", opt$gtf)
  annotation <- quiet(create_annotation(gtfpath = opt$gtf))
  n_coding <- sum(annotation$l_cds > 0)
  if (n_coding == 0L) {
    stop("the annotation has no transcript with a coding sequence (CDS lines): use the GTF the STAR index was built with", call. = FALSE)
  }

  names_in <- sample_names(opt$bams)
  stage <- tempfile("riboseq_bams_")
  dir.create(stage)
  on.exit(unlink(stage, recursive = TRUE), add = TRUE)
  for (i in seq_along(opt$bams)) {
    target <- file.path(stage, paste0(names_in[i], ".bam"))
    original <- normalizePath(opt$bams[i], mustWork = TRUE)
    if (!isTRUE(suppressWarnings(file.symlink(original, target)))) file.copy(original, target)
  }
  message("Reading ", length(opt$bams), " BAM file(s)")
  reads <- quiet(bamtolist(bamfolder = stage, annotation = annotation, transcript_align = TRUE))
  samples <- names(reads)
  loaded <- vapply(reads, nrow, integer(1))
  empty <- samples[loaded == 0L]
  if (length(empty) == length(samples)) {
    stop(paste("no read could be used: none of the BAM alignments names a transcript of the annotation (or all are on the reverse strand).",
               "Use the GTF the genome index was built with, and a BAM in transcript coordinates (STAR Aligned.toTranscriptome.out.bam)."),
         call. = FALSE)
  }
  for (s in empty) warn(sprintf("Sample %s has no usable reads (no alignment names a transcript of the annotation) and is left out.", s))
  samples <- setdiff(samples, empty)
  reads <- reads[samples]

  # --- read lengths ---------------------------------------------------------
  in_window <- vapply(reads, function(d) sum(d$length %in% window), integer(1))
  lengths_table <- rbindlist(lapply(samples, function(s) {
    d <- reads[[s]][, .(reads = .N), by = length][order(length)]
    d[, `:=`(sample = s, percent = 100 * reads / sum(reads))]
    setcolorder(d, c("sample", "length", "reads", "percent"))
    d
  }))
  write_tsv(lengths_table, file.path(opt$out, "read_lengths.tsv"))

  filtered <- quiet(length_filter(reads, length_filter_mode = "custom", length_range = window))
  short <- samples[vapply(filtered, nrow, integer(1)) == 0L]
  for (s in short) warn(sprintf("Sample %s has no reads of %s nt; it is left out of the P-site analysis.", s, lengths_text))
  analysed <- setdiff(samples, short)

  figure_blocks <- function(make, samples_to_use, caption, width = 8, height = 4.5) {
    # One figure per sample; a figure that cannot be drawn is named, not hidden.
    paste(vapply(samples_to_use, function(s) {
      tryCatch({
        p <- make(s)
        if (is.null(p)) stop("nothing to draw")
        html_figure(plot_uri(p, width, height), sprintf(caption, s))
      }, error = function(e) {
        warn(sprintf("The figure \"%s\" could not be drawn: %s", sprintf(caption, s), conditionMessage(e)))
        sprintf("<p class=\"note\">Not drawn for sample %s: %s</p>", html_escape(s), html_escape(conditionMessage(e)))
      })
    }, character(1)), collapse = "\n")
  }

  length_plot <- function(s) {
    r <- quiet(rlength_distr(reads, sample = s, cl = 99))
    p <- first_plot(r)
    p + annotate("rect", xmin = opt$min_length - 0.5, xmax = opt$max_length + 0.5, ymin = -Inf, ymax = Inf, alpha = 0.10, fill = "#27509b")
  }
  add_section("lengths", "Read lengths",
    sprintf("How long the aligned reads are, as a share of all reads of the sample. The shaded band (%s nt) is the window analysed below; ribosome footprints are usually 28 to 32 nt, and a library with a different peak needs a different window.", lengths_text),
    paste0(figure_blocks(length_plot, samples, "Read-length distribution of sample %s."),
           html_table(lengths_table[order(sample, -reads)][, head(.SD, 12L), by = sample][order(sample, length)],
                      c("Sample", "Length (nt)", "Reads", "% of reads"), digits = 2L),
           "<p class=\"note\">The twelve most frequent lengths of each sample; the full table is read_lengths.tsv.</p>"))

  # --- offsets --------------------------------------------------------------
  offset_table <- NULL
  psite_list <- NULL
  offset_note <- character()
  if (length(analysed) > 0L) {
    # One sample at a time: a sample with too few start-codon reads must not
    # take the others down with it.
    offset_parts <- list()
    for (s in analysed) {
      covering <- start_codon_reads(filtered[[s]], opt$flanking)
      message("Estimating P-site offsets of ", s, " (", covering, " reads over start codons)")
      printed <- character()
      outcome <- tryCatch({
        found <- psite_with_tie_fallback(filtered[s], opt$flanking, opt$extremity)
        printed <- found$printed
        if (found$flanking != opt$flanking) {
          warn(sprintf("riboWaltz stopped on sample %s because two offsets had exactly the same count at the start codon (a known fault of riboWaltz 2.0 for a tie). The offsets were worked out with %d bases around the start codon instead of %d; they differ little, but check them against the figure of read ends around start codons.",
                       s, found$flanking, opt$flanking))
        }
        found$table
      }, error = function(e) e)
      if (inherits(outcome, "error")) {
        warn(sprintf("riboWaltz could not estimate the P-site offsets of sample %s: only %d read(s) of %s nt cover an annotated start codon with %d bases on each side, which is too few (riboWaltz said: %s). Sequence more reads, include more of the genome, or lower \"Bases around the start codon\". The P-site sections leave this sample out.",
                     s, covering, lengths_text, opt$flanking, conditionMessage(outcome)))
      } else {
        offset_parts[[s]] <- outcome
        offset_note <- c(offset_note, paste0(s, ": ", trimws(printed[grepl("best offset", printed)])))
      }
    }
    if (length(offset_parts) > 0L) {
      offset_table <- rbindlist(offset_parts, use.names = TRUE)
      psite_list <- quiet(psite_info(filtered[names(offset_parts)], offset_table))
    }
  }
  if (is.null(offset_table)) {
    write_tsv(setNames(as.data.frame(matrix(character(), 0, length(OFFSET_COLUMNS))), OFFSET_COLUMNS),
              file.path(opt$out, "psite_offsets.tsv"))
    add_section("offsets", "P-site offsets", "", "<p class=\"note\">No offsets could be estimated; see the note at the top.</p>")
  } else {
    write_tsv(offset_table[, intersect(OFFSET_COLUMNS, names(offset_table)), with = FALSE], file.path(opt$out, "psite_offsets.tsv"))
    shown <- as.data.frame(offset_table[order(sample, length)])[, c("sample", "length", "total_percentage", "start_percentage",
                                                                   "around_start", "corrected_offset_from_5", "corrected_offset_from_3")]
    shown$around_start <- ifelse(shown$around_start %in% c("T", "TRUE", TRUE), "yes", "no")
    add_section("offsets", "P-site offsets",
      "The P-site offset is the distance from the end of a read to the first base of the ribosome's P-site codon. It is worked out for each read length from the reads that sit on annotated start codons, where the ribosome pauses on initiation.",
      paste0(if (length(offset_note)) paste0("<p>riboWaltz: <code>", html_escape(paste(offset_note, collapse = "; ")), "</code></p>") else "",
             html_table(shown, c("Sample", "Read length (nt)", "% of reads", "% of start-codon reads", "Seen at start codons",
                                 "P-site offset from the 5' end (nt)", "P-site offset from the 3' end (nt)"), digits = 2L),
             "<p class=\"note\">Lengths marked \"no\" had no reads on a start codon; their offset was taken from the neighbouring lengths (riboWaltz's correction step). The uncorrected values are in psite_offsets.tsv.</p>"))
  }

  # --- read ends around start and stop (needs no offsets) --------------------
  ends_plot <- function(s) first_plot(quiet(rends_heat(reads, annotation, sample = s, cl = 85)))
  add_section("ends", "Read ends around start and stop codons",
    "Where the 5' and 3' ends of reads fall around annotated start and stop codons, for each read length (brighter is more reads). The offsets above are read off this picture: the ends of footprints of one length pile up at a fixed distance from the start codon.",
    figure_blocks(ends_plot, samples, "5' and 3' read ends around start and stop codons, sample %s.", width = 9, height = 6.5))

  # --- everything below needs P-sites ---------------------------------------
  need_psites <- "<p class=\"note\">Not available: the P-site offsets could not be estimated (see the note at the top).</p>"
  frame_all <- NULL
  if (is.null(psite_list)) {
    for (sec in list(c("periodicity", "3-nucleotide periodicity"), c("profiles", "Profiles around start and stop codons"),
                     c("regions", "P-sites per region"), c("codons", "Codon usage"))) {
      add_section(sec[1], sec[2], "", need_psites)
    }
  } else {
    ps <- names(psite_list)

    frame_plot <- function(s) first_plot(quiet(frame_psite(psite_list, annotation, sample = s, region = "all")))
    framelen_plot <- function(s) first_plot(quiet(frame_psite_length(psite_list, annotation, sample = s, region = "all")))
    frame_all <- rbindlist(lapply(ps, function(s) {
      tryCatch(quiet(frame_psite(psite_list, annotation, sample = s, region = "all"))$count_dt, error = function(e) NULL)
    }), fill = TRUE)
    framelen_all <- rbindlist(lapply(ps, function(s) {
      tryCatch(quiet(frame_psite_length(psite_list, annotation, sample = s, region = "all"))$count_dt, error = function(e) NULL)
    }), fill = TRUE)
    if (nrow(frame_all) > 0L) write_tsv(frame_all, file.path(opt$out, "periodicity_by_region.tsv"))
    if (nrow(framelen_all) > 0L) write_tsv(framelen_all, file.path(opt$out, "periodicity_by_length.tsv"))
    add_section("periodicity", "3-nucleotide periodicity",
      "A translating ribosome moves one codon (3 nt) at a time, so P-sites inside a coding sequence fall mostly into one of the three reading frames, while UTRs show no preference. Frame 0 is the frame of the start codon. The first figure is by region, the second by read length inside the CDS.",
      paste0(figure_blocks(frame_plot, ps, "P-sites per reading frame in the 5' UTR, CDS and 3' UTR, sample %s."),
             figure_blocks(framelen_plot, ps, "P-sites per reading frame for each read length (all regions), sample %s.")))

    meta_plot <- function(s) first_plot(quiet(metaprofile_psite(psite_list, annotation, sample = s)))
    meta_all <- rbindlist(lapply(ps, function(s) {
      tryCatch(quiet(metaprofile_psite(psite_list, annotation, sample = s))$count_dt, error = function(e) NULL)
    }), fill = TRUE)
    if (nrow(meta_all) > 0L) write_tsv(meta_all, file.path(opt$out, "metaprofile_start_stop.tsv"))
    add_section("profiles", "Profiles around start and stop codons",
      "The number of P-sites at each position around the start codon (left) and the stop codon (right), summed over all coding transcripts that are long enough. Ribosomes accumulate at the start codon and at the stop codon, and the signal inside the CDS is periodic.",
      figure_blocks(meta_plot, ps, "P-site metaprofile around start and stop codons, sample %s.", width = 10, height = 4.5))

    region_plot <- function(s) first_plot(quiet(region_psite(psite_list, annotation, sample = s)))
    region_all <- rbindlist(lapply(ps, function(s) {
      tryCatch(quiet(region_psite(psite_list, annotation, sample = s))$count_dt, error = function(e) NULL)
    }), fill = TRUE)
    if (nrow(region_all) > 0L) write_tsv(region_all, file.path(opt$out, "psites_per_region.tsv"))
    add_section("regions", "P-sites per region",
      "How the P-sites divide between the 5' UTR, the CDS and the 3' UTR, as a percentage of all P-sites of the sample, next to the share of the transcript length each region makes up. Footprints should be strongly enriched in the CDS.",
      paste0(figure_blocks(region_plot, ps, "Percentage of P-sites in the 5' UTR, CDS and 3' UTR, sample %s."),
             if (nrow(region_all) > 0L) html_table(as.data.frame(region_all[, c("sample", "region", "count", "scaled_count")]),
                                                  c("Sample", "Region", "P-sites", "% of P-sites"), digits = 1L) else "",
             "<p class=\"note\">The row called RNAs is the reference: the share of the transcripts' length that each region makes up, so a footprint library should be far above it in the CDS.</p>"))

    if (is.null(opt$fasta)) {
      add_section("codons", "Codon usage", "",
        "<p class=\"note\">Not made: no genome FASTA was given. Add the genome FASTA of the annotation's release to the step to get the P-site codon usage.</p>")
    } else {
      codon_plot <- function(s) first_plot(quiet(codon_usage_psite(psite_list, annotation, sample = s, fastapath = opt$fasta,
                                                                     fasta_genome = TRUE, gtfpath = opt$gtf)))
      codon_all <- rbindlist(lapply(ps, function(s) {
        tryCatch(quiet(codon_usage_psite(psite_list, annotation, sample = s, fastapath = opt$fasta,
                                         fasta_genome = TRUE, gtfpath = opt$gtf))$count_dt, error = function(e) NULL)
      }), fill = TRUE)
      if (nrow(codon_all) > 0L) write_tsv(codon_all, file.path(opt$out, "codon_usage.tsv"))
      add_section("codons", "Codon usage",
        "How often each codon sits in the ribosome's P-site, normalised for how often the codon occurs in the coding sequences (frequency normalisation).",
        figure_blocks(codon_plot, ps, "P-site codon usage, sample %s."))
    }
  }

  # --- summary and page -----------------------------------------------------
  summary_df <- data.frame(
    sample = samples,
    bam = vapply(samples, function(s) basename(opt$bams[match(s, names_in)]), character(1)),
    reads = as.integer(loaded[samples]),
    in_window = as.integer(in_window[samples]),
    stringsAsFactors = FALSE
  )
  summary_df$in_frame_percent <- vapply(samples, function(s) {
    if (is.null(frame_all) || nrow(frame_all) == 0L) return(NA_real_)
    dominant_frame_share(as.data.frame(frame_all[frame_all$sample == s, ]))
  }, numeric(1))
  write_tsv(summary_df, file.path(opt$out, "samples.tsv"))
  summary_html <- paste0(
    "<h2>Samples</h2>",
    html_table(summary_df, c("Sample", "BAM file", "Reads used", sprintf("Reads of %s nt", lengths_text), "CDS P-sites in the main frame (%)"), digits = 1L),
    "<p class=\"note\">\"Reads used\" are alignments on the forward strand of transcripts of the annotation, after the STAR and deduplication steps. A strongly periodic library has 60 % or more of its CDS P-sites in one frame (a third each means no periodicity).</p>")

  meta_lines <- c(
    sprintf("Created %s", format(Sys.time(), "%Y-%m-%d %H:%M")),
    sprintf("riboWaltz %s, %s", as.character(utils::packageVersion("riboWaltz")), R.version.string),
    sprintf("Annotation: %s (%d transcripts with a CDS)", basename(opt$gtf), n_coding),
    sprintf("Read lengths analysed: %s nt. Bases around the start codon: %d. Offset read end: %s.", lengths_text, opt$flanking, opt$extremity)
  )
  page <- build_page("riboWaltz report", meta_lines, warnings_out, summary_html, sections)
  report_path <- file.path(opt$out, "ribowaltz_report.html")
  writeLines(page, report_path, useBytes = TRUE)
  message("Report written: ", report_path, " (", round(file.info(report_path)$size / 1024), " KiB)")
  invisible(list(report = report_path, warnings = warnings_out, samples = samples))
}

main <- function(argv = commandArgs(trailingOnly = TRUE)) {
  status <- tryCatch({
    run_report(parse_args(argv))
    0L
  }, error = function(e) {
    message("ERROR: ", conditionMessage(e))
    1L
  })
  if (status != 0L) quit(status = status, save = "no")
  invisible(0L)
}

# Run when called with Rscript; stay quiet when the file is source()d for tests.
if (sys.nframe() == 0L) main()

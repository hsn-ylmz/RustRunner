# Unit tests for the pure helpers of the riboWaltz report script
# (RustRunner/runtime/app_resources/ribowaltz/ribowaltz_report.R).
#
# Run with the Rscript of the riboWaltz environment:
#
#   Rscript --vanilla test_ribowaltz_report.R <path to ribowaltz_report.R>
#
# No testthat needed: a failed check prints FAIL and the exit status is 1.
# The real-tool suite (npm run test:tools, domain "riboseq") runs this file
# after its chain.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) stop("usage: Rscript test_ribowaltz_report.R <ribowaltz_report.R>")
source(args[[1]], local = TRUE) # does not run main(): sys.nframe() is not 0 here

failures <- 0L
passed <- 0L
check <- function(name, ok) {
  if (isTRUE(ok)) {
    passed <<- passed + 1L
  } else {
    failures <<- failures + 1L
    cat("FAIL:", name, "\n")
  }
}
raises <- function(expr, pattern) {
  out <- tryCatch({ force(expr); NA_character_ }, error = function(e) conditionMessage(e))
  !is.na(out) && grepl(pattern, out, fixed = TRUE)
}

# --- base64 -----------------------------------------------------------------
plain_text <- c("", "f", "fo", "foo", "foob", "fooba", "foobar")
encoded <- c("", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy")
for (i in seq_along(plain_text)) {
  check(paste0("base64 of '", plain_text[i], "' (RFC 4648 test vector)"), identical(b64encode(charToRaw(plain_text[i])), encoded[i]))
}
decode <- function(text) {
  chars <- strsplit(sub("=+$", "", text), "")[[1]]
  vals <- match(chars, .b64_alphabet) - 1L
  bits <- unlist(lapply(vals, function(v) rev(as.integer(intToBits(v))[1:6])))
  bits <- bits[seq_len(floor(length(bits) / 8) * 8)]
  as.raw(vapply(split(bits, ceiling(seq_along(bits) / 8)), function(b) sum(b * 2^(7:0)), numeric(1)))
}
every_byte <- as.raw(0:255)
check("base64 round trip of all 256 byte values", identical(decode(b64encode(every_byte)), every_byte))
set.seed(1)
random_bytes <- as.raw(sample(0:255, 1001, replace = TRUE))
check("base64 round trip of 1001 random bytes (length not a multiple of 3)", identical(decode(b64encode(random_bytes)), random_bytes))
check("base64 has no line breaks", !grepl("[\r\n]", b64encode(random_bytes)))

# --- sample names -------------------------------------------------------------
tmp <- tempfile("names_")
for (d in c("a", "b", "x/same", "y/same")) dir.create(file.path(tmp, d), recursive = TRUE)
p <- function(...) file.path(tmp, ...)
check("names are the file stems", identical(sample_names(c(p("a", "one.bam"), p("b", "two.bam"))), c("one", "two")))
check("the extension is matched without regard to case", identical(sample_names(p("a", "one.BAM")), "one"))
check("equal stems get their folder in front", identical(sample_names(c(p("a", "dedup.bam"), p("b", "dedup.bam"))), c("a_dedup", "b_dedup")))
check("equal stems in equal-named folders are numbered", identical(sample_names(c(p("x/same", "d.bam"), p("y/same", "d.bam"))), c("same_d_1", "same_d_2")))
check("unsafe characters become underscores", identical(sample_names(p("a", "my sample (1).bam")), "my_sample_1"))
check("a name made only of unsafe characters is not empty", nzchar(sample_names(p("a", "!!!.bam"))))
check("sample names are unique", anyDuplicated(sample_names(c(p("a", "x.bam"), p("b", "x.bam"), p("x/same", "x.bam"), p("y/same", "x.bam")))) == 0L)

# --- command line ---------------------------------------------------------------
o <- parse_args(c("--gtf", "g.gtf", "--out", "o/", "--", "a.bam", "b.bam"))
check("defaults: 28 to 34 nt, auto, flanking 6", o$min_length == 28L && o$max_length == 34L && o$extremity == "auto" && o$flanking == 6L)
check("the files after -- are the BAMs", identical(o$bams, c("a.bam", "b.bam")))
o <- parse_args(c("--gtf", "g", "--out", "o", "--min-length", "25", "--max-length", "40", "--extremity", "5end", "--flanking", "9",
                  "--threads", "3", "--fasta", "genome.fa", "x.bam"))
check("every option is read", o$min_length == 25L && o$max_length == 40L && o$extremity == "5end" && o$flanking == 9L && o$threads == 3L && o$fasta == "genome.fa")
check("a BAM without -- is accepted", identical(o$bams, "x.bam"))
check("a BAM called like an option is safe after --", identical(parse_args(c("--gtf", "g", "--out", "o", "--", "--odd.bam"))$bams, "--odd.bam"))
check("missing --gtf is named", raises(parse_args(c("--out", "o", "--", "a.bam")), "--gtf is required"))
check("missing --out is named", raises(parse_args(c("--gtf", "g", "--", "a.bam")), "--out is required"))
check("no BAM is named", raises(parse_args(c("--gtf", "g", "--out", "o")), "no BAM file"))
check("a length that is not a number is refused", raises(parse_args(c("--gtf", "g", "--out", "o", "--min-length", "abc", "a.bam")), "--min-length must be a whole number"))
check("a fractional length is refused", raises(parse_args(c("--gtf", "g", "--out", "o", "--min-length", "28.5", "a.bam")), "--min-length must be a whole number"))
check("the shortest length may not exceed the longest", raises(parse_args(c("--gtf", "g", "--out", "o", "--min-length", "35", "--max-length", "30", "a.bam")), "larger than the longest"))
check("an unknown option is refused", raises(parse_args(c("--gtf", "g", "--out", "o", "--frobnicate", "a.bam")), "unknown option --frobnicate"))
check("a wrong extremity is refused", raises(parse_args(c("--gtf", "g", "--out", "o", "--extremity", "middle", "a.bam")), "--extremity must be"))
check("an option without a value is refused", raises(parse_args(c("--gtf", "g", "--out")), "--out needs a value"))

# --- HTML -----------------------------------------------------------------------
check("html_escape handles the five characters", identical(html_escape("<a href=\"x\">'&'</a>"), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"))
hostile <- data.frame(name = "<script>alert(1)</script>", n = 3L, stringsAsFactors = FALSE)
table_html <- html_table(hostile, c("Name <b>", "Count"))
check("table cells and headings are escaped", !grepl("<script>", table_html, fixed = TRUE) && !grepl("<b>", table_html, fixed = TRUE) && grepl("&lt;script&gt;", table_html, fixed = TRUE))
check("numbers are right-aligned cells", grepl("<td class=\"num\">3</td>", table_html, fixed = TRUE))
check("an empty table says so", grepl("No rows", html_table(hostile[0, ]), fixed = TRUE))
check("NA shows as a dash", identical(format_cell(c(1, NA)), c("1", "–")))
check("whole numbers carry no decimals", identical(format_cell(12), "12"))
check("other numbers are rounded", identical(format_cell(0.12345, 2L), "0.12"))
check("logicals are words", identical(format_cell(c(TRUE, FALSE)), c("yes", "no")))
page <- build_page("A <title>", c("line one", "line <two>"), c("Careful: <b>this</b>"), "<h2>Samples</h2>",
                   list(a = list(id = "a", title = "Section A", intro = "Intro <i>text</i>", body = "<p>body</p>")))
check("the page escapes title, meta lines, warnings and intros",
      !grepl("<title>A <title>", page, fixed = TRUE) && !grepl("<b>this</b>", page, fixed = TRUE) && !grepl("<i>text</i>", page, fixed = TRUE) && !grepl("<two>", page, fixed = TRUE))
check("a warning is shown as an alert before everything else", regexpr("role=\"alert\"", page, fixed = TRUE) < regexpr("Section A", page, fixed = TRUE))
check("the page is complete HTML5 with a language", startsWith(page, "<!DOCTYPE html>") && grepl("<html lang=\"en\">", page, fixed = TRUE) && grepl("</html>", page, fixed = TRUE))
check("the page has no script and no external address", !grepl("<script", page, fixed = TRUE) && !grepl("http://|https://|//cdn", page) && !grepl("<link", page, fixed = TRUE))
check("without a warning there is no alert", !grepl("role=\"alert\"", build_page("t", "m", character(), "", list()), fixed = TRUE))

# --- figures ----------------------------------------------------------------------
suppressPackageStartupMessages(library(ggplot2))
uri <- plot_uri(ggplot(data.frame(x = 1:3, y = c(2, 1, 3)), aes(x, y)) + geom_col(), width = 3, height = 2, res = 72)
check("a figure is a PNG data URI", startsWith(uri, "data:image/png;base64,"))
png_bytes <- decode(sub("^data:image/png;base64,", "", uri))
check("the data decodes to a PNG file", identical(png_bytes[1:8], as.raw(c(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))))
check("a figure tag carries its caption, escaped", grepl("<figcaption>Sample &lt;1&gt;</figcaption>", html_figure(uri, "Sample <1>"), fixed = TRUE))
check("first_plot picks the ggplot out of a riboWaltz-style result", inherits(first_plot(list(count_dt = data.frame(), plot_dt = data.frame(), plot_s = ggplot())), "ggplot"))
check("first_plot of a result without a plot is NULL", is.null(first_plot(list(count_dt = data.frame()))))

# --- numbers behind the report ------------------------------------------------------
reads <- data.frame(cds_start = c(100, 100, 100, 0, 100, 100), end5 = c(80, 94, 95, 1, 70, 60),
                    end3 = c(110, 120, 120, 200, 101, 130), stringsAsFactors = FALSE)
# flanking 6: end5 <= 94 and end3 >= 100 + 2 + 6 = 108. Rows: 1 yes, 2 yes, 3 no (end5 95), 4 no (no CDS), 5 no (end3 101), 6 yes.
check("reads that cover the start codon with flanks are counted", start_codon_reads(reads, 6L) == 3L)
check("no reads, no count", start_codon_reads(reads[0, ], 6L) == 0L && start_codon_reads(NULL, 6L) == 0L)
frames <- data.frame(region = c("5' UTR", "CDS", "CDS", "CDS", "3' UTR"), count = c(10, 600, 250, 150, 5), stringsAsFactors = FALSE)
check("the main frame share is read from the CDS rows only", abs(dominant_frame_share(frames) - 60) < 1e-9)
check("no CDS rows give NA", is.na(dominant_frame_share(frames[frames$region != "CDS", ])) && is.na(dominant_frame_share(NULL)))

# --- riboWaltz's tie fault ----------------------------------------------------------
calls <- integer()
psite <- function(data, flanking, extremity) {
  calls <<- c(calls, flanking)
  if (flanking %in% fail_at) stop(fail_message)
  data.frame(length = 31L, flanking = flanking, extremity = extremity)
}
tie <- "the condition has length > 1"
fail_at <- integer(); fail_message <- tie
r <- psite_with_tie_fallback(list(), 6L, "auto")
check("no tie: the first try is used", r$flanking == 6L && identical(calls, 6L) && r$table$extremity == "auto")
calls <- integer(); fail_at <- 6L
r <- psite_with_tie_fallback(list(), 6L, "5end")
check("a tie is retried with one more flanking base", r$flanking == 7L && identical(calls, c(6L, 7L)) && r$table$extremity == "5end")
calls <- integer(); fail_at <- c(6L, 7L, 5L)
r <- psite_with_tie_fallback(list(), 6L, "auto")
check("the shifts alternate up and down", r$flanking == 8L && identical(calls, c(6L, 7L, 5L, 8L)))
calls <- integer(); fail_at <- 0:20
check("when every try ties, the tie error is raised after 7 tries", raises(psite_with_tie_fallback(list(), 6L, "auto"), tie) && length(calls) == 7L)
calls <- integer(); fail_at <- 0L
r <- psite_with_tie_fallback(list(), 0L, "auto")
check("flanking never goes below 0", r$flanking == 1L && identical(calls, c(0L, 1L)))
calls <- integer(); fail_at <- 6L; fail_message <- "no reads on the start codon"
check("any other error is raised at once, without retries", raises(psite_with_tie_fallback(list(), 6L, "auto"), "no reads on the start codon") && identical(calls, 6L))

cat(sprintf("%d checks passed, %d failed\n", passed, failures))
if (failures > 0L) quit(status = 1L, save = "no")

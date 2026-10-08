#!/usr/bin/env bash
# Prepare the real-data test set for the Ribo-seq workflow. Re-runnable and
# idempotent: finished outputs are verified against checksums.sha256 and kept.
# Everything lands in riboseq-test/data (gitignored). Needs curl, gzip, shasum, python3.
#
#   ./prepare_data.sh            build whatever is missing, verify the rest
#   ./prepare_data.sh --record   (re)write checksums.sha256 from the current files
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HERE/data"
SUMS="$HERE/checksums.sha256"
PY=(python3 -I "$HERE/prepare_helpers.py")

RUN=SRR12693498                       # GSE158374 / GSM4798525 "WT-HEK-1_ribo", see DATA.md
RUN_URL="https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR126/098/$RUN/$RUN.fastq.gz"
FULL_READS="${FULL_READS:-5000000}"   # override to stream more of the run
TINY_READS="${TINY_READS:-200000}"
SEED=42
ENSEMBL="https://ftp.ensembl.org/pub/release-115"
CHROMS=(17 19 22)
GTRNADB="https://gtrnadb.ucsc.edu/genomes/eukaryota/Hsapi38/hg38-mature-tRNAs.fa"
NCBI_RRNA="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=NR_046235.3,NR_023363.1&rettype=fasta"

RECORD=0
[[ "${1:-}" == "--record" ]] && RECORD=1

mkdir -p "$DATA/full" "$DATA/tiny" "$DATA/ref" "$DATA/downloads"
touch "$SUMS"

# sha256 of the decompressed content for .gz files (gzip bytes differ between
# gzip builds), of the raw bytes otherwise.
digest() {
  case "$1" in
    *.gz) gzip -dc "$1" | shasum -a 256 | cut -d' ' -f1 ;;
    *) shasum -a 256 "$1" | cut -d' ' -f1 ;;
  esac
}

# check FILE: ok when the file exists and matches its recorded digest.
# A file without a recorded digest is accepted (and reported) unless --record.
check() {
  local rel="${1#"$HERE"/}" want got
  [[ -s "$1" ]] || return 1
  got="$(digest "$1")"
  want="$(awk -v f="$rel" '$2 == f { print $1 }' "$SUMS")"
  if [[ $RECORD -eq 1 ]]; then
    grep -v " $rel\$" "$SUMS" > "$SUMS.tmp" || true
    echo "$got  $rel" >> "$SUMS.tmp" && mv "$SUMS.tmp" "$SUMS"
    return 0
  fi
  if [[ -z "$want" ]]; then
    echo "note: no recorded checksum for $rel (run --record to pin it)" >&2
    return 0
  fi
  if [[ "$got" != "$want" ]]; then
    echo "ERROR: checksum mismatch for $rel (expected $want, got $got)" >&2
    echo "       delete the file and re-run, or investigate an upstream change." >&2
    exit 1
  fi
}

download() { # download URL DEST
  [[ -s "$2" ]] && return 0
  echo "downloading $1"
  curl -fsSL --retry 5 --retry-delay 5 -o "$2.part" "$1" && mv "$2.part" "$2"
}

# ---------------------------------------------------------------- reads
FULL="$DATA/full/${RUN}_${FULL_READS}reads.fastq.gz"
if ! check "$FULL"; then
  echo "streaming the first $FULL_READS reads of $RUN (not the whole run)"
  # head closes the pipe early, so curl/gzip exit non-zero by design: no pipefail here.
  ( set +o pipefail
    curl -fsSL --retry 5 "$RUN_URL" | gzip -dc 2>/dev/null | head -n $((FULL_READS * 4)) | gzip -n -6 > "$FULL.part" )
  lines="$(gzip -dc "$FULL.part" | wc -l | tr -d ' ')"
  [[ "$lines" -eq $((FULL_READS * 4)) ]] || { echo "ERROR: got $lines lines, expected $((FULL_READS * 4))" >&2; rm -f "$FULL.part"; exit 1; }
  mv "$FULL.part" "$FULL"
  check "$FULL"
fi

TINY="$DATA/tiny/${RUN}_${TINY_READS}reads_seed${SEED}.fastq.gz"
if ! check "$TINY"; then
  "${PY[@]}" subsample "$FULL" "$TINY.part" "$TINY_READS" "$SEED"
  mv "$TINY.part" "$TINY"
  check "$TINY"
fi

# ------------------------------------------------------------ references
GENOME="$DATA/ref/genome_chr17_19_22.fa"
GTF="$DATA/ref/annotation_chr17_19_22.gtf"
if ! { check "$GENOME" && check "$GTF"; }; then
  chr_files=()
  for c in "${CHROMS[@]}"; do
    f="$DATA/downloads/Homo_sapiens.GRCh38.dna.chromosome.$c.fa.gz"
    download "$ENSEMBL/fasta/homo_sapiens/dna/$(basename "$f")" "$f"
    chr_files+=("$f")
  done
  gtf_gz="$DATA/downloads/Homo_sapiens.GRCh38.115.gtf.gz"
  download "$ENSEMBL/gtf/homo_sapiens/$(basename "$gtf_gz")" "$gtf_gz"
  "${PY[@]}" concat-fasta "$GENOME.part" "${chr_files[@]}" && mv "$GENOME.part" "$GENOME"
  "${PY[@]}" subset-gtf "$gtf_gz" "$GTF.part" "$(IFS=,; echo "${CHROMS[*]}")" && mv "$GTF.part" "$GTF"
  check "$GENOME"; check "$GTF"
fi

DEPL=("$DATA/ref/rRNA.fa" "$DATA/ref/tRNA.fa" "$DATA/ref/ncRNA.fa")
ok=1; for f in "${DEPL[@]}"; do check "$f" || ok=0; done
if [[ $ok -eq 0 ]]; then
  nc="$DATA/downloads/Homo_sapiens.GRCh38.ncrna.fa.gz"
  tr="$DATA/downloads/hg38-mature-tRNAs.fa"
  rr="$DATA/downloads/NCBI_NR_046235.3_NR_023363.1.fa"
  download "$ENSEMBL/fasta/homo_sapiens/ncrna/$(basename "$nc")" "$nc"
  download "$GTRNADB" "$tr"
  download "$NCBI_RRNA" "$rr"
  "${PY[@]}" build-depletion "$DATA/ref" "$nc" "$tr" "$rr"
  for f in "${DEPL[@]}"; do check "$f"; done
fi

# --------------------------------------------------------------- summary
echo
echo "== reads =="
for f in "$FULL" "$TINY"; do
  printf '%s  %s reads  %s\n' "$(basename "$f")" "$(( $(gzip -dc "$f" | wc -l) / 4 ))" "$(du -h "$f" | cut -f1)"
done
echo "== references =="
for f in "$GENOME" "$GTF" "${DEPL[@]}"; do
  printf '%s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
echo "ready: $DATA"

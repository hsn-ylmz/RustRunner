#!/usr/bin/env python3
"""Stdlib-only helpers for prepare_data.sh (run with `python3 -I`).

Sub-commands
  subsample IN.fastq.gz OUT.fastq.gz N SEED
      Keep N reads chosen with random.Random(SEED); original order is preserved.
  subset-gtf IN.gtf.gz OUT.gtf CHROM[,CHROM...]
      Keep the header and, on the listed chromosomes, every protein_coding gene
      plus its Ensembl_canonical protein_coding transcript with all of that
      transcript's features, unchanged. One transcript per gene keeps the
      transcript-coordinate BAM and riboWaltz free of isoform multi-mapping.
      Transcript ids and versions are never edited.
  concat-fasta OUT.fa CHROM_FA.gz [CHROM_FA.gz ...]
      Concatenate Ensembl chromosome FASTAs, reducing each header to its name.
  build-depletion DIR NCRNA.fa.gz GTRNADB.fa NCBI_RRNA.fa
      Write DIR/rRNA.fa, DIR/tRNA.fa and DIR/ncRNA.fa (rules in DATA.md).
"""
import gzip
import random
import re
import sys

# Ensembl gene_biotype values routed to each depletion reference.
RRNA_BIOTYPES = {"rRNA", "Mt_rRNA", "rRNA_pseudogene"}
TRNA_BIOTYPES = {"Mt_tRNA", "tRNA"}
# Small ncRNA classes that are abundant contaminants. lncRNA is excluded on
# purpose: lncRNAs carry real translated ORFs and belong to the genome step.
NCRNA_BIOTYPES = {"miRNA", "misc_RNA", "scaRNA", "scRNA", "snRNA", "snoRNA",
                  "sRNA", "vault_RNA", "ribozyme", "Y_RNA"}


def open_text(path, mode="rt"):
    return gzip.open(path, mode) if str(path).endswith(".gz") else open(path, mode)


def fasta_records(path):
    header, seq = None, []
    with open_text(path) as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith(">"):
                if header is not None:
                    yield header, "".join(seq)
                header, seq = line[1:], []
            elif line:
                seq.append(line)
    if header is not None:
        yield header, "".join(seq)


def write_fasta(out, header, seq):
    out.write(">" + header + "\n")
    for i in range(0, len(seq), 80):
        out.write(seq[i:i + 80] + "\n")


def subsample(src, dst, n, seed):
    total = 0
    with open_text(src) as fh:
        for _ in fh:
            total += 1
    reads = total // 4
    if n > reads:
        raise SystemExit(f"cannot sample {n} reads from {reads}")
    keep = set(random.Random(seed).sample(range(reads), n))
    with open_text(src) as fh, open(dst, "wb") as raw, \
            gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=6, mtime=0) as out:
        rec = []
        for i, line in enumerate(fh):
            rec.append(line)
            if i % 4 == 3:
                if (i // 4) in keep:
                    out.write("".join(rec).encode())
                rec = []
    print(f"sampled {n} of {reads} reads (seed {seed})")


def keep_gtf_line(fields):
    """True for a protein_coding gene, or a feature of its canonical protein_coding transcript."""
    attrs = fields[8]
    if fields[2] == "gene":
        return 'gene_biotype "protein_coding"' in attrs
    return ('transcript_biotype "protein_coding"' in attrs
            and 'tag "Ensembl_canonical"' in attrs)


def subset_gtf(src, dst, chroms):
    wanted = set(chroms.split(","))
    kept = 0
    with open_text(src) as fh, open(dst, "w") as out:
        for line in fh:
            if line.startswith("#"):
                out.write(line)
                continue
            fields = line.split("\t")
            if len(fields) >= 9 and fields[0] in wanted and keep_gtf_line(fields):
                out.write(line)
                kept += 1
    print(f"kept {kept} canonical protein_coding GTF features on {sorted(wanted)}")


def concat_fasta(dst, sources):
    with open(dst, "w") as out:
        for path in sources:
            for header, seq in fasta_records(path):
                write_fasta(out, header.split()[0], seq.upper())


def build_depletion(outdir, ncrna, gtrnadb, ncbi_rrna):
    biotype = re.compile(r"gene_biotype:(\S+)")
    symbol = re.compile(r"gene_symbol:(\S+)")
    counts = {"rRNA": 0, "tRNA": 0, "ncRNA": 0}
    with open(f"{outdir}/rRNA.fa", "w") as rrna, \
            open(f"{outdir}/tRNA.fa", "w") as trna, \
            open(f"{outdir}/ncRNA.fa", "w") as nc:
        for header, seq in fasta_records(ncbi_rrna):
            write_fasta(rrna, "NCBI|" + header.split()[0], seq.upper())
            counts["rRNA"] += 1
        for header, seq in fasta_records(gtrnadb):
            write_fasta(trna, "GtRNAdb|" + header.split()[0], seq.upper().replace("U", "T"))
            counts["tRNA"] += 1
        for header, seq in fasta_records(ncrna):
            # Skip alt-haplotype and patch scaffolds: they duplicate chromosome genes.
            if " ncrna chromosome:" not in header:
                continue
            m = biotype.search(header)
            if not m:
                continue
            bt = m.group(1)
            sym = symbol.search(header)
            name = f"{header.split()[0]}|{bt}" + (f"|{sym.group(1)}" if sym else "")
            seq = seq.upper().replace("U", "T")
            if bt in RRNA_BIOTYPES:
                write_fasta(rrna, name, seq)
                counts["rRNA"] += 1
            elif bt in TRNA_BIOTYPES:
                write_fasta(trna, name, seq)
                counts["tRNA"] += 1
            elif bt in NCRNA_BIOTYPES:
                write_fasta(nc, name, seq)
                counts["ncRNA"] += 1
    print("depletion references:", counts)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "subsample" and len(argv) == 6:
        subsample(argv[2], argv[3], int(argv[4]), int(argv[5]))
    elif cmd == "subset-gtf" and len(argv) == 5:
        subset_gtf(argv[2], argv[3], argv[4])
    elif cmd == "concat-fasta" and len(argv) >= 4:
        concat_fasta(argv[2], argv[3:])
    elif cmd == "build-depletion" and len(argv) == 6:
        build_depletion(*argv[2:])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)

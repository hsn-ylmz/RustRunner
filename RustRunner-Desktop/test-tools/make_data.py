#!/usr/bin/env python3
"""Deterministic synthetic data for the real-tool suite (Python stdlib only).

Usage: python3 -I make_data.py OUTDIR [SEED]

Writes into OUTDIR:
  ref.fa              two contigs (chr1 3000 bp, chr2 2000 bp), random sequence
  genes.gtf           three genes (two exons each, one on the minus strand)
  transcripts.fa      the spliced transcript of each gene (for salmon)
  dna_se.fastq.gz     single-end 100 bp reads from a SNP-carrying copy of the
                      reference (about 10% carry a 3' adapter read-through)
  dna_R1.fastq.gz / dna_R2.fastq.gz   paired-end 100 bp reads, same source
  rna_se.fastq.gz     single-end 75 bp reads from the spliced transcripts
  truth_snps.tsv      the SNPs put into the sample (contig, 1-based pos, ref, alt)
"""
import gzip
import os
import random
import sys

ADAPTER = "AGATCGGAAGAGC"
COMP = str.maketrans("ACGT", "TGCA")


def revcomp(seq):
    return seq.translate(COMP)[::-1]


def random_seq(rng, n):
    return "".join(rng.choice("ACGT") for _ in range(n))


def wrap(seq, width=60):
    return "\n".join(seq[i:i + width] for i in range(0, len(seq), width))


def write_fastq(path, records):
    with gzip.GzipFile(path, "wb", mtime=0) as raw:  # mtime=0: reproducible bytes
        for name, seq in records:
            raw.write(f"@{name}\n{seq}\n+\n{'I' * len(seq)}\n".encode())


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    outdir = sys.argv[1]
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    rng = random.Random(seed)
    os.makedirs(outdir, exist_ok=True)

    ref = {"chr1": random_seq(rng, 3000), "chr2": random_seq(rng, 2000)}
    with open(os.path.join(outdir, "ref.fa"), "w") as fh:
        for name, seq in ref.items():
            fh.write(f">{name}\n{wrap(seq)}\n")

    # Genes: (id, contig, strand, [(start, end)] 1-based inclusive exons)
    genes = [
        ("geneA", "chr1", "+", [(201, 500), (801, 1100)]),
        ("geneB", "chr1", "-", [(1601, 1900), (2201, 2500)]),
        ("geneC", "chr2", "+", [(301, 600), (901, 1200)]),
    ]
    transcripts = {}
    with open(os.path.join(outdir, "genes.gtf"), "w") as gtf:
        for gid, contig, strand, exons in genes:
            tid = gid.replace("gene", "tx")
            lo, hi = exons[0][0], exons[-1][1]
            attrs = f'gene_id "{gid}"; transcript_id "{tid}";'
            gtf.write(f"{contig}\tsynthetic\ttranscript\t{lo}\t{hi}\t.\t{strand}\t.\t{attrs}\n")
            for start, end in exons:
                gtf.write(f"{contig}\tsynthetic\texon\t{start}\t{end}\t.\t{strand}\t.\t{attrs}\n")
            spliced = "".join(ref[contig][s - 1:e] for s, e in exons)
            transcripts[tid] = revcomp(spliced) if strand == "-" else spliced
    with open(os.path.join(outdir, "transcripts.fa"), "w") as fh:
        for tid, seq in transcripts.items():
            fh.write(f">{tid}\n{wrap(seq)}\n")

    # Sample genome = reference + SNPs placed away from the contig ends.
    sample = {name: list(seq) for name, seq in ref.items()}
    snps = []
    for name, seq in ref.items():
        for pos in sorted(rng.sample(range(200, len(seq) - 200), 6)):
            old = seq[pos]
            new = rng.choice([b for b in "ACGT" if b != old])
            sample[name][pos] = new
            snps.append((name, pos + 1, old, new))
    sample = {name: "".join(seq) for name, seq in sample.items()}
    with open(os.path.join(outdir, "truth_snps.tsv"), "w") as fh:
        for row in snps:
            fh.write("\t".join(map(str, row)) + "\n")

    contigs = list(sample)
    total = sum(len(s) for s in sample.values())

    def pick_fragment(length):
        name = rng.choices(contigs, weights=[len(sample[c]) for c in contigs])[0]
        start = rng.randrange(0, len(sample[name]) - length + 1)
        return sample[name][start:start + length]

    n_pairs = total * 40 // 200  # about 40x coverage by 2 x 100 bp
    se, r1, r2 = [], [], []
    for i in range(n_pairs):
        frag = pick_fragment(rng.randint(250, 350))
        if rng.random() < 0.5:
            frag = revcomp(frag)
        r1.append((f"pair{i}/1", frag[:100]))
        r2.append((f"pair{i}/2", revcomp(frag)[:100]))
    for i in range(total * 40 // 100):
        if rng.random() < 0.10:  # short fragment: the read runs into the adapter
            frag = pick_fragment(rng.randint(60, 85))
            read = (frag + ADAPTER + random_seq(rng, 100))[:100]
        else:
            read = pick_fragment(100)
            if rng.random() < 0.5:
                read = revcomp(read)
        se.append((f"read{i}", read))
    write_fastq(os.path.join(outdir, "dna_se.fastq.gz"), se)
    write_fastq(os.path.join(outdir, "dna_R1.fastq.gz"), r1)
    write_fastq(os.path.join(outdir, "dna_R2.fastq.gz"), r2)

    rna = []
    tids = list(transcripts)
    for i in range(1500):
        seq = transcripts[rng.choice(tids)]
        start = rng.randrange(0, len(seq) - 75 + 1)
        read = seq[start:start + 75]
        rna.append((f"rna{i}", revcomp(read) if rng.random() < 0.5 else read))
    write_fastq(os.path.join(outdir, "rna_se.fastq.gz"), rna)


if __name__ == "__main__":
    main()

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
  unnormalized.vcf    three records that bcftools norm must change: a site with two
                      alternative alleles, a deletion written on the right side of
                      a 2-base repeat (left-aligning moves its position by one) and
                      a plain SNP
  dup_R1.fastq.gz / dup_R2.fastq.gz   paired-end 100 bp reads with PCR duplicates:
                      DUP_UNIQUE_PAIRS distinct fragments plus DUP_COPIES exact
                      copies of some of them (so 2 * DUP_COPIES reads are
                      duplicates). Made from a separate random stream, so the
                      other files are the same as before this one was added.
  rna_R1/R2.fastq.gz  paired-end 75 bp stranded RNA reads (dUTP kit: read 1 is the
                      antisense of the transcript, read 2 the sense), RNA_PAIRS pairs
                      from the spliced transcripts at RNA_WEIGHTS abundance, from a
                      third random stream (earlier files unchanged)
  rna_truth.tsv       transcript id and the number of pairs drawn from it
"""
import gzip
import os
import random
import sys

ADAPTER = "AGATCGGAAGAGC"
DUP_UNIQUE_PAIRS = 600
DUP_COPIES = 200
RNA_PAIRS = 2000
RNA_WEIGHTS = (6, 3, 1)  # tx1 : tx2 : tx3 abundance
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

    write_duplicate_pairs(outdir, sample, random.Random(seed + 1))
    write_unnormalized_vcf(outdir, ref)
    write_stranded_rna_pairs(outdir, transcripts, random.Random(seed + 2))


def write_stranded_rna_pairs(outdir, transcripts, rng):
    """Paired stranded RNA reads at known, unequal abundance (see the module doc)."""
    tids = list(transcripts)
    counts = {tid: 0 for tid in tids}
    r1, r2 = [], []
    for i in range(RNA_PAIRS):
        tid = rng.choices(tids, weights=RNA_WEIGHTS)[0]
        counts[tid] += 1
        seq = transcripts[tid]
        length = rng.randint(150, 250)
        start = rng.randrange(0, len(seq) - length + 1)
        frag = seq[start:start + length]  # sense strand
        r1.append((f"rnap{i}/1", revcomp(frag)[:75]))  # dUTP: read 1 is antisense
        r2.append((f"rnap{i}/2", frag[:75]))
    write_fastq(os.path.join(outdir, "rna_R1.fastq.gz"), r1)
    write_fastq(os.path.join(outdir, "rna_R2.fastq.gz"), r2)
    with open(os.path.join(outdir, "rna_truth.tsv"), "w") as fh:
        for tid in tids:
            fh.write(f"{tid}\t{counts[tid]}\n")


def write_unnormalized_vcf(outdir, ref):
    """A VCF with a multi-allelic site, a right-aligned deletion and a SNP (see the module doc)."""

    def others(base, count):
        return [b for b in "ACGT" if b != base][:count]

    chr1, chr2 = ref["chr1"], ref["chr2"]
    # A run of exactly two equal bases, far from position 100 and from the ends.
    run = next(i for i in range(300, len(chr1) - 300) if chr1[i] == chr1[i + 1] != chr1[i - 1] and chr1[i + 1] != chr1[i + 2])
    # 0-based run = [run, run + 1]. Deleting one of the two bases, written right-aligned:
    # POS = run + 1 (1-based, the first base of the run), REF = both bases, ALT = the first.
    # Left-aligned it is POS = run (the base before the run), REF = that base + the first base of the run.
    lines = [
        "##fileformat=VCFv4.2",
        "##contig=<ID=chr1,length=%d>" % len(chr1),
        "##contig=<ID=chr2,length=%d>" % len(chr2),
        '##INFO=<ID=DP,Number=1,Type=Integer,Description="Read depth">',
        "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO",
        "chr1\t100\t.\t%s\t%s\t50\t.\tDP=30" % (chr1[99], ",".join(others(chr1[99], 2))),
        "chr1\t%d\t.\t%s\t%s\t50\t.\tDP=30" % (run + 1, chr1[run:run + 2], chr1[run]),
        "chr2\t100\t.\t%s\t%s\t50\t.\tDP=30" % (chr2[99], others(chr2[99], 1)[0]),
    ]
    with open(os.path.join(outdir, "unnormalized.vcf"), "w") as fh:
        fh.write("\n".join(lines) + "\n")


def write_duplicate_pairs(outdir, sample, rng):
    """Paired reads where DUP_COPIES fragments appear twice, exactly alike."""
    contigs = list(sample)
    weights = [len(sample[c]) for c in contigs]
    fragments = []
    for _ in range(DUP_UNIQUE_PAIRS):
        name = rng.choices(contigs, weights=weights)[0]
        length = rng.randint(250, 350)
        start = rng.randrange(0, len(sample[name]) - length + 1)
        frag = sample[name][start:start + length]
        fragments.append(revcomp(frag) if rng.random() < 0.5 else frag)
    for index in rng.sample(range(DUP_UNIQUE_PAIRS), DUP_COPIES):
        fragments.append(fragments[index])
    rng.shuffle(fragments)
    r1 = [(f"dup{i}/1", frag[:100]) for i, frag in enumerate(fragments)]
    r2 = [(f"dup{i}/2", revcomp(frag)[:100]) for i, frag in enumerate(fragments)]
    write_fastq(os.path.join(outdir, "dup_R1.fastq.gz"), r1)
    write_fastq(os.path.join(outdir, "dup_R2.fastq.gz"), r2)


if __name__ == "__main__":
    main()

"""Tests for prepare_helpers.py. Run: python3 -I -m unittest riboseq-test/test_prepare_helpers.py
(or `python3 -I test_prepare_helpers.py` from this folder). Standard library only."""
import gzip
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prepare_helpers as h  # noqa: E402


def write(path, text):
    with open(path, "w") as fh:
        fh.write(text)


class SubsampleTest(unittest.TestCase):
    def make_fastq(self, path, n):
        with gzip.open(path, "wt") as fh:
            for i in range(n):
                fh.write(f"@r{i}\nACGT\n+\nIIII\n")

    def names(self, path):
        with gzip.open(path, "rt") as fh:
            return [line.strip() for i, line in enumerate(fh) if i % 4 == 0]

    def test_reproducible_ordered_and_whole_records(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.fastq.gz")
            self.make_fastq(src, 1000)
            a, b, c = (os.path.join(d, x) for x in ("a.gz", "b.gz", "c.gz"))
            h.subsample(src, a, 100, 42)
            h.subsample(src, b, 100, 42)
            h.subsample(src, c, 100, 7)
            na, nb, nc = self.names(a), self.names(b), self.names(c)
            self.assertEqual(len(na), 100)
            self.assertEqual(na, nb)
            self.assertNotEqual(na, nc)
            self.assertEqual(na, sorted(na, key=lambda x: int(x[2:])))
            with open(a, "rb") as x, open(b, "rb") as y:
                self.assertEqual(x.read(), y.read())  # byte-identical (mtime 0)

    def test_too_many_reads_requested(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "in.fastq.gz")
            self.make_fastq(src, 10)
            with self.assertRaises(SystemExit):
                h.subsample(src, os.path.join(d, "o.gz"), 11, 1)


class GtfTest(unittest.TestCase):
    def line(self, chrom, feat, attrs):
        return "\t".join([chrom, "src", feat, "1", "10", ".", "+", ".", attrs]) + "\n"

    def test_keeps_canonical_protein_coding_on_chosen_chromosomes_untouched(self):
        keep_tx = 'gene_id "G1"; transcript_id "ENST1"; transcript_version "3"; gene_biotype "protein_coding"; transcript_biotype "protein_coding"; tag "Ensembl_canonical";'
        lines = [
            "#!genome-build GRCh38\n",
            self.line("17", "gene", 'gene_id "G1"; gene_biotype "protein_coding";'),
            self.line("17", "transcript", keep_tx),
            self.line("17", "exon", keep_tx),
            self.line("17", "exon", keep_tx.replace("ENST1", "ENST2").replace('tag "Ensembl_canonical";', 'tag "basic";')),
            self.line("17", "gene", 'gene_id "G2"; gene_biotype "lncRNA";'),
            self.line("1", "gene", 'gene_id "G3"; gene_biotype "protein_coding";'),
            self.line("1", "exon", keep_tx),
        ]
        with tempfile.TemporaryDirectory() as d:
            src, dst = os.path.join(d, "a.gtf"), os.path.join(d, "b.gtf")
            write(src, "".join(lines))
            h.subset_gtf(src, dst, "17,19,22")
            out = open(dst).read().splitlines(True)
        self.assertEqual(out, [lines[0], lines[1], lines[2], lines[3]])
        self.assertIn('transcript_id "ENST1"; transcript_version "3"', out[2])


class DepletionTest(unittest.TestCase):
    def test_routing_by_biotype_and_skipping_patches(self):
        nc = (
            ">T1 ncrna chromosome:GRCh38:1:1:10:1 gene:G1 gene_biotype:rRNA transcript_biotype:rRNA gene_symbol:RNA5S1\nACGU\n"
            ">T2 ncrna chromosome:GRCh38:MT:1:10:1 gene:G2 gene_biotype:Mt_tRNA transcript_biotype:Mt_tRNA gene_symbol:MT-TF\nGGGG\n"
            ">T3 ncrna chromosome:GRCh38:2:1:10:1 gene:G3 gene_biotype:snoRNA transcript_biotype:snoRNA\nCCCC\n"
            ">T4 ncrna chromosome:GRCh38:3:1:10:1 gene:G4 gene_biotype:lncRNA transcript_biotype:lncRNA\nAAAA\n"
            ">T5 ncrna scaffold:GRCh38:HG1_PATCH:1:10:1 gene:G5 gene_biotype:snoRNA transcript_biotype:snoRNA\nTTTT\n"
        )
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "nc.fa"), nc)
            write(os.path.join(d, "gt.fa"), ">Homo_sapiens_tRNA-Ala-AGC-1-1\nGGGGAUUA\n")
            write(os.path.join(d, "rr.fa"), ">NR_046235.3 Homo sapiens RNA\nacgtn\n")
            h.build_depletion(d, os.path.join(d, "nc.fa"), os.path.join(d, "gt.fa"), os.path.join(d, "rr.fa"))
            names = {k: [r[0].split()[0] for r in h.fasta_records(os.path.join(d, f"{k}.fa"))] for k in ("rRNA", "tRNA", "ncRNA")}
            rrna_seqs = [r[1] for r in h.fasta_records(os.path.join(d, "rRNA.fa"))]
            trna_seqs = [r[1] for r in h.fasta_records(os.path.join(d, "tRNA.fa"))]
        self.assertEqual(names["rRNA"], ["NCBI|NR_046235.3", "T1|rRNA|RNA5S1"])
        self.assertEqual(names["tRNA"], ["GtRNAdb|Homo_sapiens_tRNA-Ala-AGC-1-1", "T2|Mt_tRNA|MT-TF"])
        self.assertEqual(names["ncRNA"], ["T3|snoRNA"])  # lncRNA and patch scaffold excluded
        self.assertEqual(rrna_seqs, ["ACGTN", "ACGT"])  # upper case, U to T
        self.assertEqual(trna_seqs, ["GGGGATTA", "GGGG"])


class FastaTest(unittest.TestCase):
    def test_concat_keeps_first_token_and_wraps(self):
        with tempfile.TemporaryDirectory() as d:
            write(os.path.join(d, "1.fa"), ">17 dna:chromosome chromosome:GRCh38:17:1:10:1 REF\nacgt\nacgt\n")
            write(os.path.join(d, "2.fa"), ">19 dna:chromosome\n" + "A" * 100 + "\n")
            out = os.path.join(d, "o.fa")
            h.concat_fasta(out, [os.path.join(d, "1.fa"), os.path.join(d, "2.fa")])
            lines = open(out).read().splitlines()
        self.assertEqual(lines[:2], [">17", "ACGTACGT"])
        self.assertEqual(lines[2:], [">19", "A" * 80, "A" * 20])


if __name__ == "__main__":
    unittest.main()

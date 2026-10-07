#!/usr/bin/env python3
"""Deterministic synthetic nanopore signal files for the real-tool suite.

Usage: <venv>/bin/python -I make_pod5.py OUTDIR [SEED]

Needs the `pod5`, `ont-fast5-api` and `setuptools<81` packages, which the harness
installs into a virtual environment under `.sandbox` (never into the real Python).
`make_data.py` stays standard-library only; this file is the one place that needs
the pod5 Python API, because pod5 files cannot be written without it.

Writes into OUTDIR:
  nano_a.pod5       10 reads on channels 1 to 4 (one run, 5 kHz)
  nano_b.pod5       6 reads on channels 5 and 6 (a second run id), to merge with nano_a
  nano_fast5.fast5  4 reads of a third run in one multi-read FAST5 file (for convert)
  nano_ids.txt      the read ids of 4 reads of nano_a, one per line
  nano_truth.tsv    file, read id, channel, number of samples of every read written

The signal is a step pattern (a level per "base", 6 to 16 samples each) with noise, like
the shape of real raw signal. It is not a real DNA signal: a basecaller will call a
sequence from it, but not one that means anything.
"""
import datetime
import os
import random
import sys
import uuid

import numpy as np
import pod5

SAMPLE_RATE = 5000
OFFSET, SCALE = 4.0, 0.2  # pA = (adc + OFFSET) * SCALE
KIT = "sqk-lsk114"
FLOW_CELL = "FLO-MIN114"


def signal(rng, bases):
    levels = [rng.gauss(95.0, 12.0) for _ in range(bases)]
    samples = []
    for pa in levels:
        for _ in range(rng.randint(6, 16)):
            samples.append(int(round((pa + rng.gauss(0, 2.0)) / SCALE - OFFSET)))
    return np.array(samples, dtype=np.int16)


def read_id(rng):
    return uuid.UUID(int=rng.getrandbits(128), version=4)


def run_info(tag):
    when = datetime.datetime(2025, 3, 1, 9, 0, 0, tzinfo=datetime.timezone.utc)
    return pod5.RunInfo(
        acquisition_id=f"acq-{tag}",
        acquisition_start_time=when,
        adc_max=2047,
        adc_min=-2048,
        context_tags={
            "sample_frequency": str(SAMPLE_RATE),
            "sequencing_kit": KIT,
            "flow_cell_product_code": FLOW_CELL.lower(),
            "experiment_type": "genomic_dna",
            "basecall_config_filename": "dna_r10.4.1_e8.2_400bps_5khz_hac.cfg",
        },
        experiment_name="synthetic",
        flow_cell_id=f"FC{tag}",
        flow_cell_product_code=FLOW_CELL,
        protocol_name="sequencing/sequencing_MIN114_DNA_e8_2_400K:FLO-MIN114:SQK-LSK114",
        protocol_run_id=f"run-{tag}",
        protocol_start_time=when,
        sample_id="synthetic",
        sample_rate=SAMPLE_RATE,
        sequencing_kit=KIT,
        sequencer_position="MN00000",
        sequencer_position_type="minion",
        software="synthetic",
        system_name="synthetic",
        system_type="synthetic",
        tracking_id={"run_id": f"run-{tag}", "sample_id": "synthetic"},
    )


def write_pod5(path, tag, channels, count, rng, truth):
    info = run_info(tag)
    ids = []
    with pod5.Writer(path) as writer:
        for i in range(count):
            rid = read_id(rng)
            channel = channels[i % len(channels)]
            sig = signal(rng, rng.randint(450, 700))
            writer.add_read(
                pod5.Read(
                    read_id=rid,
                    pore=pod5.Pore(channel=channel, well=1 + i % 4, pore_type="not_set"),
                    calibration=pod5.Calibration(offset=OFFSET, scale=SCALE),
                    read_number=i,
                    start_sample=1000 * i,
                    median_before=210.0,
                    end_reason=pod5.EndReason(pod5.EndReasonEnum.SIGNAL_POSITIVE, forced=False),
                    run_info=info,
                    signal=sig,
                )
            )
            ids.append(str(rid))
            truth.append((os.path.basename(path), str(rid), channel, len(sig)))
    return ids


def write_fast5(path, tag, count, rng, truth):
    from ont_fast5_api.compression_settings import GzipCompression
    from ont_fast5_api.multi_fast5 import MultiFast5File

    run = f"run-{tag}"
    with MultiFast5File(path, "w") as f5:
        for i in range(count):
            rid = str(read_id(rng))
            sig = signal(rng, rng.randint(450, 700))
            read = f5.create_empty_read(rid, run)
            read.add_raw_data(
                sig,
                attrs={
                    "duration": len(sig),
                    "median_before": 210.0,
                    "read_id": rid,
                    "read_number": i,
                    "start_mux": 1,
                    "start_time": 1000 * i,
                },
                compression=GzipCompression(),  # no VBZ plugin needed to read it
            )
            read.add_channel_info(
                {
                    "channel_number": str(7 + i % 2),
                    "digitisation": 4096.0,
                    "offset": OFFSET,
                    "range": SCALE * 4096.0,
                    "sampling_rate": float(SAMPLE_RATE),
                }
            )
            read.add_tracking_id(
                {
                    "run_id": run,
                    "exp_start_time": "2025-03-01T09:00:00Z",
                    "flow_cell_id": f"FC{tag}",
                    "flow_cell_product_code": FLOW_CELL,
                    "sample_id": "synthetic",
                    "device_id": "MN00000",
                    "protocol_run_id": run,
                    "hostname": "synthetic",
                    "asic_id": "1",
                    "version": "synthetic",
                }
            )
            read.add_context_tags(
                {
                    "sample_frequency": str(SAMPLE_RATE),
                    "sequencing_kit": KIT,
                    "flow_cell_product_code": FLOW_CELL.lower(),
                    "experiment_type": "genomic_dna",
                }
            )
            truth.append((os.path.basename(path), rid, 7 + i % 2, len(sig)))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    outdir = sys.argv[1]
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    os.makedirs(outdir, exist_ok=True)
    for name in ("nano_a.pod5", "nano_b.pod5", "nano_fast5.fast5"):  # the writers refuse to overwrite
        if os.path.exists(os.path.join(outdir, name)):
            os.remove(os.path.join(outdir, name))
    rng = random.Random(seed + 100)
    truth = []
    ids = write_pod5(os.path.join(outdir, "nano_a.pod5"), "a", [1, 2, 3, 4], 10, rng, truth)
    write_pod5(os.path.join(outdir, "nano_b.pod5"), "b", [5, 6], 6, rng, truth)
    write_fast5(os.path.join(outdir, "nano_fast5.fast5"), "c", 4, rng, truth)
    with open(os.path.join(outdir, "nano_ids.txt"), "w") as fh:
        for rid in (ids[0], ids[3], ids[5], ids[8]):
            fh.write(rid + "\n")
    with open(os.path.join(outdir, "nano_truth.tsv"), "w") as fh:
        for row in truth:
            fh.write("\t".join(map(str, row)) + "\n")


if __name__ == "__main__":
    main()

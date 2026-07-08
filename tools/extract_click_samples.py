#!/usr/bin/env python3
import struct
import subprocess
import sys
import wave
from pathlib import Path


DEFAULT_SOURCE = Path(
    "/run/media/henry/macOS/Users/henry/Music/Audio Music Apps/Samples/ProToolsClick/CLICK_1.wav"
)
OUT_DIR = Path(__file__).resolve().parents[1] / "audio"
SAMPLE_RATE = 44100
WINDOW_SECONDS = 0.16
PRE_ROLL_SECONDS = 0.004
MIN_GAP_SECONDS = 0.28
HEAD_SECONDS = 12
PEAK_TARGET = 0.98


def load_mono_head(path):
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-t",
        str(HEAD_SECONDS),
        "-i",
        str(path),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "f32le",
        "-",
    ]
    raw = subprocess.check_output(command)
    return struct.unpack(f"<{len(raw) // 4}f", raw)


def detect_hits(samples):
    threshold = max(abs(sample) for sample in samples) * 0.32
    min_gap = int(MIN_GAP_SECONDS * SAMPLE_RATE)
    hits = []
    cursor = 0

    while cursor < len(samples):
        if abs(samples[cursor]) < threshold:
            cursor += 1
            continue

        search_end = min(len(samples), cursor + int(0.035 * SAMPLE_RATE))
        peak_index = max(range(cursor, search_end), key=lambda idx: abs(samples[idx]))
        hits.append(peak_index)
        cursor = peak_index + min_gap

    return hits


def slice_hit(samples, index):
    start = max(0, index - int(PRE_ROLL_SECONDS * SAMPLE_RATE))
    length = int(WINDOW_SECONDS * SAMPLE_RATE)
    chunk = list(samples[start : start + length])
    if len(chunk) < length:
        chunk.extend([0.0] * (length - len(chunk)))

    fade_samples = int(0.01 * SAMPLE_RATE)
    for i in range(fade_samples):
        chunk[-fade_samples + i] *= 1 - (i / fade_samples)

    peak = max(abs(sample) for sample in chunk) or 1
    gain = PEAK_TARGET / peak
    return [max(-1, min(1, sample * gain)) for sample in chunk]


def write_wav(path, samples):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        frames = bytearray()
        for sample in samples:
            frames.extend(struct.pack("<h", int(max(-1, min(1, sample)) * 32767)))
        wav.writeframes(frames)


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        sys.exit(f"Missing source sample: {source}")

    samples = load_mono_head(source)
    hits = detect_hits(samples)
    if len(hits) < 5:
        sys.exit("Could not detect enough click hits.")

    hit_levels = [
        max(abs(sample) for sample in samples[index : index + int(0.03 * SAMPLE_RATE)])
        for index in hits
    ]
    downbeat_position = max(range(min(8, len(hits))), key=lambda i: hit_levels[i])
    downbeat_index = hits[downbeat_position]

    weak_candidates = [
        i for i in range(min(8, len(hits))) if i != downbeat_position and hit_levels[i] < hit_levels[downbeat_position] * 0.95
    ]
    weak_position = weak_candidates[0] if weak_candidates else (downbeat_position + 1) % min(8, len(hits))
    weak_index = hits[weak_position]

    OUT_DIR.mkdir(exist_ok=True)
    write_wav(OUT_DIR / "click-downbeat.wav", slice_hit(samples, downbeat_index))
    write_wav(OUT_DIR / "click-beat.wav", slice_hit(samples, weak_index))

    print("Detected hits:", [round(index / SAMPLE_RATE, 3) for index in hits[:12]])
    print("Hit levels:", [round(level, 4) for level in hit_levels[:12]])
    print(f"Downbeat: hit {downbeat_position + 1} at {downbeat_index / SAMPLE_RATE:.3f}s")
    print(f"Weak beat: hit {weak_position + 1} at {weak_index / SAMPLE_RATE:.3f}s")


if __name__ == "__main__":
    main()

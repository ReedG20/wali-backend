#!/usr/bin/env bash
# Generates test WAVs (16 kHz mono s16le) with macOS `say` + ffmpeg:
#   out/two-speakers.wav  two voices (Samantha at full level, Daniel at -16 dB) alternating,
#                         with short pauses. Diarization should give Speaker 1 / Speaker 2.
#   out/one-speaker.wav   a single short line at full level.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out tmp
FMT=(-ar 16000 -ac 1 -c:a pcm_s16le)

line() { # voice volume_db text outfile
  say -v "$1" -o "tmp/$4.aiff" "$3"
  ffmpeg -loglevel error -y -i "tmp/$4.aiff" -af "volume=$2dB" "${FMT[@]}" "tmp/$4.wav"
}

line Samantha 0 "Hey, did you finish the slides for the demo tomorrow?" a1
line Daniel -16 "Almost. I still need to add the architecture diagram and the latency numbers." b1
line Samantha 0 "Great. Let's meet at nine thirty and rehearse it twice before lunch." a2
line Daniel -16 "Sounds good. I'll bring the pendant and a spare battery." b2
ffmpeg -loglevel error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 0.8 "${FMT[@]}" tmp/pause.wav

printf "file '%s'\n" a1.wav pause.wav b1.wav pause.wav a2.wav pause.wav b2.wav > tmp/list.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i tmp/list.txt "${FMT[@]}" out/two-speakers.wav

line Samantha 0 "This is a short test clip from the Mind pendant pipeline." one
cp tmp/one.wav out/one-speaker.wav
rm -rf tmp
ls -l out

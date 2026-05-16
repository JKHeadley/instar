#!/usr/bin/env bash
# Pulls auto-captions for each video in video-list.txt via yt-dlp,
# converts the VTT to clean text, and writes <video-id>.txt next to this
# script. Idempotent — skips videos whose .txt already exists.
#
# yt-dlp (latest from pip3) is the only fetcher that works against
# YouTube's current anti-bot measures (2026-05-15). The miniconda-env
# version (2025.7.21) is too old and gets 403s. The system yt-dlp on
# $PATH is the fresh one installed earlier in this session.

set -euo pipefail
cd "$(dirname "$0")"

while IFS='|' read -r vid title; do
  [[ -z "${vid:-}" || "${vid:0:1}" == "#" ]] && continue
  out="${vid}.txt"
  vtt="${vid}.en.vtt"
  if [[ -f "$out" ]]; then
    echo "[skip] $vid (already done)"
    continue
  fi
  echo "[pull] $vid — $title"
  yt-dlp \
    --skip-download \
    --write-auto-subs \
    --sub-lang en \
    --sub-format vtt \
    -o "%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v=$vid" 2>/dev/null | tail -2 || {
      echo "[fail] $vid — yt-dlp error"
      continue
    }
  if [[ ! -f "$vtt" ]]; then
    echo "[fail] $vid — no .vtt produced"
    continue
  fi
  # VTT to clean text: drop WEBVTT header, drop timestamp lines, drop
  # word-level <c> tags, dedupe consecutive identical lines, drop blanks.
  awk '
    /^WEBVTT/ { next }
    /^Kind:|^Language:/ { next }
    /^[0-9]+:[0-9]+:[0-9]+\.[0-9]+ -->/ { next }
    /^$/ { next }
    {
      gsub(/<[^>]*>/, "")
      gsub(/&amp;/, "\\&")
      gsub(/&#39;/, "'\''")
      gsub(/&quot;/, "\"")
      if ($0 != prev) print
      prev = $0
    }
  ' "$vtt" > "$out"
  rm -f "$vtt"
  wc=$(wc -w < "$out" | tr -d ' ')
  echo "[done] $vid — $wc words"
done < video-list.txt

echo ""
echo "Summary:"
echo "  $(ls *.txt 2>/dev/null | wc -l | tr -d ' ') transcripts pulled"
echo "  $(cat *.txt 2>/dev/null | wc -w | tr -d ' ') total words"

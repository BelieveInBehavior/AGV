#!/usr/bin/env bash
set -euo pipefail

# Video processing helpers migrated from web project:
# 1) merge two clips with transition + seam sharpen
# 2) reduce vocals on a video while keeping picture

usage() {
  cat <<'EOF'
Usage:
  scripts/video-process.sh merge <clip_a> <clip_b> <output_mp4> [transition_seconds]
  scripts/video-process.sh remove-vocals <input_mp4> <output_mp4> [soft|hard]

Examples:
  scripts/video-process.sh merge a.mp4 b.mp4 out.mp4 0.5
  scripts/video-process.sh remove-vocals in.mp4 out.mp4 soft
EOF
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

probe_duration() {
  ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"
}

merge_clips() {
  local clip_a="$1"
  local clip_b="$2"
  local output="$3"
  local transition="${4:-0.5}"

  local dur_a
  dur_a="$(probe_duration "$clip_a")"
  if [[ -z "$dur_a" ]]; then
    echo "Failed to probe duration for: $clip_a" >&2
    exit 1
  fi

  local offset
  offset="$(python3 - <<PY
dur_a = float("$dur_a")
transition = float("$transition")
print(max(dur_a - transition, 0.0))
PY
)"

  ffmpeg -y \
    -i "$clip_a" \
    -i "$clip_b" \
    -filter_complex "[0:v]format=yuv420p,settb=1/60000,setpts=PTS-STARTPTS[v0];\
[1:v]format=yuv420p,settb=1/60000,setpts=PTS-STARTPTS[v1];\
[v0][v1]xfade=transition=fade:duration=${transition}:offset=${offset}[vx];\
[vx]unsharp=5:5:1.2:5:5:0.0:enable='between(t,${offset}-0.1,${offset}+${transition}+0.1)'[vout];\
[0:a]aresample=44100,asetpts=PTS-STARTPTS[a0];\
[1:a]aresample=44100,asetpts=PTS-STARTPTS[a1];\
[a0][a1]acrossfade=d=${transition}:c1=tri:c2=tri[aout]" \
    -map "[vout]" \
    -map "[aout]" \
    -c:v libx264 \
    -crf 18 \
    -preset medium \
    -r 24 \
    -pix_fmt yuv420p \
    -c:a aac \
    -b:a 192k \
    "$output"
}

remove_vocals() {
  local input="$1"
  local output="$2"
  local strength="${3:-soft}"
  local af

  case "$strength" in
    soft)
      af="stereotools=mlev=0.2:slev=1,volume=1.6"
      ;;
    hard)
      af="pan=stereo|c0=FL-FR|c1=FR-FL,volume=1.8"
      ;;
    *)
      echo "Unknown strength: $strength (use soft|hard)" >&2
      exit 1
      ;;
  esac

  ffmpeg -y -i "$input" -af "$af" -c:v copy -c:a aac -b:a 192k "$output"
}

main() {
  need_cmd ffmpeg
  need_cmd ffprobe

  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    merge)
      if [[ $# -lt 3 ]]; then
        usage
        exit 1
      fi
      merge_clips "$@"
      ;;
    remove-vocals)
      if [[ $# -lt 2 ]]; then
        usage
        exit 1
      fi
      remove_vocals "$@"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"

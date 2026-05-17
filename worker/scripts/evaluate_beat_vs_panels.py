#!/usr/bin/env python3
"""
Offline comparison: beat-level first/last frames vs multi-panel storyboards.

Estimates image API calls per narrative unit for:
  - beat mode: 2 images per unit (first_frame + last_frame)
  - panel mode: configurable panels per clip (default 4).

Usage:
  python3 worker/scripts/evaluate_beat_vs_panels.py
  python3 worker/scripts/evaluate_beat_vs_panels.py --clips 12 --panels-per-clip 4
"""

from __future__ import annotations

import argparse
import json


def estimate(clips: int, panels_per_clip: int) -> dict:
    beat_images = clips * 2
    panel_images = clips * panels_per_clip
    return {
        'clips': clips,
        'beat_images_first_last': beat_images,
        'panel_images_estimate': panel_images,
        'panels_per_clip_assumption': panels_per_clip,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Compare beat first/last vs panel counts')
    parser.add_argument('--clips', type=int, default=1, help='Number of narrative clips / beats')
    parser.add_argument('--panels-per-clip', type=int, default=4, help='Assumed panels per clip (classic storyboard)')
    args = parser.parse_args()

    stats = estimate(max(args.clips, 0), args.panels_per_clip)
    print('AGV beat vs panel cost estimate')
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    b = stats['beat_images_first_last']
    p = stats['panel_images_estimate']
    if p:
        print(
            f"\nRatio (beat first/last vs panels): {b}/{p} = {b / p:.2f}x images "
            f"(~{(1 - b / p) * 100:.0f}% fewer than panels)"
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

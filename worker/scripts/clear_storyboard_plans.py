#!/usr/bin/env python3
"""
清空 clips.storyboardPlan，便于重新生成首尾帧 Prompt。

用法（在 worker 目录下）:
  python3 scripts/clear_storyboard_plans.py --episode-id <id>
  python3 scripts/clear_storyboard_plans.py --project-id <id>
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

_worker_root = Path(__file__).resolve().parents[1]
if str(_worker_root) not in sys.path:
    sys.path.insert(0, str(_worker_root))

from utils.db import get_db


def main() -> None:
    parser = argparse.ArgumentParser(description='Clear storyboardPlan on clips')
    parser.add_argument('--episode-id', dest='episode_id', help='Only clips for this episode')
    parser.add_argument('--project-id', dest='project_id', help='All clips in project')
    args = parser.parse_args()
    if not args.episode_id and not args.project_id:
        parser.error('Provide --episode-id or --project-id')

    db = get_db()
    base: dict = {}
    if args.episode_id:
        base['episodeId'] = args.episode_id
    if args.project_id:
        base['projectId'] = args.project_id

    now = datetime.now(timezone.utc)
    query = {**base, 'storyboardPlan': {'$ne': None}}

    r = db.clips.update_many(query, {'$set': {'storyboardPlan': None, 'updatedAt': now}})
    print(f'Matched {r.matched_count}, modified {r.modified_count}')


if __name__ == '__main__':
    main()

"""
Skill: 剧集输出质量评估 / 反思

纯函数 — 无 DB 副作用。
对故事分析结果与首尾帧 Prompt 做整集批量评估，返回结构化质量报告。
"""

from __future__ import annotations

import json
from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_ALLOWED_SCOPES = {'story_analysis', 'beat_frames'}
_ALLOWED_SEVERITIES = {'critical', 'major', 'minor', 'info'}
_ALLOWED_VERDICTS = {'pass', 'warning', 'fail'}

_STORY_CRITERIA = {
    'coverage': '剧情覆盖完整性：clips 是否覆盖原文关键剧情，无明显遗漏或凭空添加',
    'segmentation': '切分合理性与原子性：clip 边界是否自然；每个 clip 是否只包含一种主要变化（空间/姿态/道具/事件进度/对话）；是否存在一个 clip 同时跨空间+跨道具+跨动作的情况（如从卧室直接到厨房手里还凭空出现新道具）',
    'character_consistency': '角色提取与命名一致性：角色库、别名、clip.characters 是否一致',
    'location_consistency': '场景提取一致性：场景库与 clip.location 是否匹配，命名是否稳定',
    'clip_metadata': 'clip 元数据质量：summary、mood、location、characters、sceneComplexity 是否准确',
    'narrative_continuity': '叙事连贯性：clip 顺序、因果、情绪推进是否连贯',
    'visual_readiness': '视觉生产可用性：角色/场景 imagePrompt 是否可用于后续生成',
}

_BEAT_CRITERIA = {
    'completeness': '完整性：每个 clip 是否都有 first_frame 与 last_frame',
    'story_alignment': '剧情对齐：首帧对应本段开始，尾帧对应本段结束',
    'atomicity': '原子性：首帧到尾帧之间是否只有一种主要变化（空间/姿态/道具/事件进度），不得同时跨空间+跨道具+跨姿态；末帧出现的新道具是否在首帧可见或 motion_prompt 有交代',
    'character_consistency': '角色一致性：帧中角色名是否来自本段角色/项目角色库',
    'scene_prompt_quality': 'scene_prompt 质量：是否遵守 G1-G8 镜头和构图规则',
    'visual_only_compliance': '纯视觉合规：scene_prompt 是否避免气味、声音、温度、心理等非视觉描述',
    'inter_clip_continuity': '跨 clip 连贯性：上一段尾帧到下一段首帧是否可衔接',
    'motion_readiness': '视频运动可用性：motion_prompt / transition 是否清晰且不矛盾',
    'reference_friendliness': '参考图友好：scene_prompt 是否避免写入人物固定外貌，保留给参考图承担',
}

_STORY_SYSTEM_PROMPT = """你是专业剧本统筹与动画制片质检，负责评估「故事分析」输出质量。

【任务】
根据原文、角色库、场景库、情节切片 clips，对整个剧集的故事分析结果做批量质量评估。
你只评估，不改写，不重新生成。

【评分】
每个维度 0-100 分：
- 85-100：可直接进入下一阶段
- 65-84：基本可用，但有局部问题
- 0-64：建议重新生成或人工修改

【评估维度】
{criteria}

【输出 JSON】
{{
  "score": 0,
  "grade": "A|B|C|D",
  "verdict": "pass|warning|fail",
  "summary": "中文总体评价，说明是否适合进入首尾帧阶段",
  "criteria": {{
    "coverage": {{"score": 0, "comment": "中文"}},
    "segmentation": {{"score": 0, "comment": "中文"}},
    "character_consistency": {{"score": 0, "comment": "中文"}},
    "location_consistency": {{"score": 0, "comment": "中文"}},
    "clip_metadata": {{"score": 0, "comment": "中文"}},
    "narrative_continuity": {{"score": 0, "comment": "中文"}},
    "visual_readiness": {{"score": 0, "comment": "中文"}}
  }},
  "issues": [
    {{
      "severity": "critical|major|minor|info",
      "targetType": "episode|clip|character|location",
      "targetId": "clipId 或角色名或场景名，可为空",
      "title": "中文短标题",
      "detail": "中文问题说明，指出具体字段或具体 clip",
      "suggestion": "中文建议"
    }}
  ],
  "strengths": ["中文优点"]
}}

【硬性规则】
1. 只返回合法 JSON，禁止 markdown
2. issue 必须具体，能定位到 clipId/角色/场景时必须填写 targetId
3. 不要建议自动修复，只给用户判断所需的评估与建议
4. 最多返回 30 个 issues，优先 critical/major
"""

_BEAT_SYSTEM_PROMPT = """你是专业分镜导演与 AI 生图质检，负责评估「首尾帧 Prompt」输出质量。

【任务】
根据所有情节 clips 与 storyboardPlan，整体评估首帧/尾帧、运动描述、连续性说明是否适合后续生图和视频生成。
你只评估，不改写，不重新生成。

【关键规则 G1-G8】
G1. 景别一致：所选景别严格决定可见范围，不出现画外元素
G2. 液体局部化：泪/汗/血写具体部位
G3. 姿势简化：避免复杂跪姿、透视扭曲
G4. 单一视觉焦点：每帧一个主要关注点
G5. 强制景别开头：scene_prompt 以特写/近景/中景/中远景/全景/广角开头
G6. 角色完整性：可见角色都必须写明位置、姿态、动作
G7. 交互指向明确：多角色动作要写清主语、宾语、空间关系
G8. 只写可视化信息：不得写气味、声音、温度、触感、心理状态

【额外规则】
- scene_prompt 不应写人物固定外貌（脸型、发色、默认服装等），外貌由参考图承担
- first_frame 应对应 clip 开始状态，last_frame 应对应 clip 结束状态
- motion_prompt 应描述首帧到尾帧之间的动作/运镜变化
- transition_from_prev 应能帮助上一 clip 到当前 clip 衔接
- 原子性检查：首帧到尾帧之间不得同时跨空间、跨姿态、跨道具、跨事件进度；如果末帧出现新道具，必须在首帧可见或 motion_prompt 明确交代拿起过程
- 特别警惕「人物从卧室直接到厨房且手里突然出现锅铲/食物已在锅中」这类跨空间+道具凭空出现的问题，需标为 major 或 critical

【评分】
每个维度 0-100 分：
- 85-100：可直接进入生图
- 65-84：基本可用，但有局部问题
- 0-64：建议重新生成或人工修改

【评估维度】
{criteria}

【输出 JSON】
{{
  "score": 0,
  "grade": "A|B|C|D",
  "verdict": "pass|warning|fail",
  "summary": "中文总体评价，说明是否适合进入首尾帧图片生成",
  "criteria": {{
    "completeness": {{"score": 0, "comment": "中文"}},
    "story_alignment": {{"score": 0, "comment": "中文"}},
    "atomicity": {{"score": 0, "comment": "中文"}},
    "character_consistency": {{"score": 0, "comment": "中文"}},
    "scene_prompt_quality": {{"score": 0, "comment": "中文"}},
    "visual_only_compliance": {{"score": 0, "comment": "中文"}},
    "inter_clip_continuity": {{"score": 0, "comment": "中文"}},
    "motion_readiness": {{"score": 0, "comment": "中文"}},
    "reference_friendliness": {{"score": 0, "comment": "中文"}}
  }},
  "issues": [
    {{
      "severity": "critical|major|minor|info",
      "targetType": "episode|clip|first_frame|last_frame|transition",
      "targetId": "clipId，可为空",
      "frame": "first_frame|last_frame|null",
      "title": "中文短标题",
      "detail": "中文问题说明，指出具体字段或具体 clip",
      "suggestion": "中文建议"
    }}
  ],
  "strengths": ["中文优点"]
}}

【硬性规则】
1. 只返回合法 JSON，禁止 markdown
2. issue 必须具体，能定位到 clipId/frame 时必须填写
3. 不要建议自动修复，只给用户判断所需的评估与建议
4. 最多返回 30 个 issues，优先 critical/major
"""


def _criteria_text(criteria: dict[str, str]) -> str:
    return '\n'.join(f'- {key}: {desc}' for key, desc in criteria.items())


def _clamp_score(value: Any) -> int:
    try:
        score = int(round(float(value)))
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, score))


def _grade_for_score(score: int) -> str:
    if score >= 85:
        return 'A'
    if score >= 70:
        return 'B'
    if score >= 55:
        return 'C'
    return 'D'


def _verdict_for_score(score: int) -> str:
    if score >= 85:
        return 'pass'
    if score >= 65:
        return 'warning'
    return 'fail'


def _normalize_criteria(raw: Any, expected: dict[str, str]) -> dict[str, dict[str, Any]]:
    src = raw if isinstance(raw, dict) else {}
    out: dict[str, dict[str, Any]] = {}
    for key in expected:
        row = src.get(key)
        if not isinstance(row, dict):
            row = {}
        out[key] = {
            'score': _clamp_score(row.get('score')),
            'comment': str(row.get('comment') or ''),
        }
    return out


def _normalize_issues(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:30]:
        if not isinstance(item, dict):
            continue
        sev = str(item.get('severity') or 'minor').strip().lower()
        if sev not in _ALLOWED_SEVERITIES:
            sev = 'minor'
        out.append({
            'severity': sev,
            'targetType': str(item.get('targetType') or item.get('target_type') or 'episode'),
            'targetId': str(item.get('targetId') or item.get('target_id') or ''),
            'frame': item.get('frame') if item.get('frame') in ('first_frame', 'last_frame') else None,
            'title': str(item.get('title') or ''),
            'detail': str(item.get('detail') or ''),
            'suggestion': str(item.get('suggestion') or ''),
        })
    return out


def _normalize_strengths(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(x) for x in raw[:10] if str(x or '').strip()]


def _normalize_scope_result(raw: Any, expected: dict[str, str], scope: str) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    criteria = _normalize_criteria(data.get('criteria'), expected)
    criterion_scores = [v['score'] for v in criteria.values()]
    fallback_score = int(round(sum(criterion_scores) / len(criterion_scores))) if criterion_scores else 0
    score = _clamp_score(data.get('score') if data.get('score') is not None else fallback_score)
    grade = str(data.get('grade') or _grade_for_score(score)).strip().upper()
    if grade not in {'A', 'B', 'C', 'D'}:
        grade = _grade_for_score(score)
    verdict = str(data.get('verdict') or _verdict_for_score(score)).strip().lower()
    if verdict not in _ALLOWED_VERDICTS:
        verdict = _verdict_for_score(score)
    return {
        'scope': scope,
        'score': score,
        'grade': grade,
        'verdict': verdict,
        'summary': str(data.get('summary') or ''),
        'criteria': criteria,
        'issues': _normalize_issues(data.get('issues')),
        'strengths': _normalize_strengths(data.get('strengths')),
    }


def _compact_story_payload(episode: dict, project: dict, clips: list[dict]) -> dict[str, Any]:
    return {
        'novelText': str(episode.get('novelText') or '')[:20000],
        'characters': [
            {
                'name': c.get('name'),
                'aliases': c.get('aliases') or [],
                'introduction': str(c.get('introduction') or '')[:500],
                'description': str(c.get('description') or '')[:500],
                'role': c.get('role'),
                'imagePrompt': str(c.get('imagePrompt') or '')[:500],
            }
            for c in project.get('characters', [])
            if isinstance(c, dict)
        ],
        'locations': [
            {
                'name': l.get('name'),
                'description': str(l.get('description') or '')[:500],
                'imagePrompt': str(l.get('imagePrompt') or '')[:500],
            }
            for l in project.get('locations', [])
            if isinstance(l, dict)
        ],
        'clips': [
            {
                'clipId': c.get('clipId'),
                'clipIndex': c.get('clipIndex'),
                'content': str(c.get('content') or '')[:1500],
                'summary': c.get('summary'),
                'characters': c.get('characters') or [],
                'location': c.get('location'),
                'mood': c.get('mood'),
                'sceneComplexity': c.get('sceneComplexity'),
            }
            for c in clips
        ],
    }


def _compact_beat_payload(project: dict, clips: list[dict]) -> dict[str, Any]:
    return {
        'projectCharacters': [c.get('name') for c in project.get('characters', []) if isinstance(c, dict)],
        'projectLocations': [l.get('name') for l in project.get('locations', []) if isinstance(l, dict)],
        'clips': [
            {
                'clipId': c.get('clipId'),
                'clipIndex': c.get('clipIndex'),
                'content': str(c.get('content') or '')[:1200],
                'summary': c.get('summary'),
                'characters': c.get('characters') or [],
                'location': c.get('location'),
                'storyboardPlan': _compact_plan(c.get('storyboardPlan')),
            }
            for c in clips
        ],
    }


def _compact_plan(plan: Any) -> dict[str, Any] | None:
    if not isinstance(plan, dict):
        return None
    return {
        'dramatic_beat': str(plan.get('dramatic_beat') or '')[:800],
        'motion_prompt': str(plan.get('motion_prompt') or '')[:800],
        'continuity_notes': str(plan.get('continuity_notes') or '')[:800],
        'transition_from_prev': str(plan.get('transition_from_prev') or '')[:800],
        'included_character_ids': plan.get('included_character_ids') or [],
        'first_frame': _compact_frame(plan.get('first_frame')),
        'last_frame': _compact_frame(plan.get('last_frame')),
    }


def _compact_frame(frame: Any) -> dict[str, Any] | None:
    if not isinstance(frame, dict):
        return None
    return {
        'description': str(frame.get('description') or '')[:800],
        'scene_prompt': str(frame.get('scene_prompt') or frame.get('scenePrompt') or '')[:1200],
        'characters': frame.get('characters') or [],
    }


def evaluate_story_analysis_skill(
    *,
    episode: dict,
    project: dict,
    clips: list[dict],
    ai_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = ai_settings or get_default_ai_settings()
    payload = _compact_story_payload(episode, project, clips)
    text = chat_completion_text(
        system_prompt=_STORY_SYSTEM_PROMPT.format(criteria=_criteria_text(_STORY_CRITERIA)),
        user_prompt='请评估以下故事分析输出：\n' + json.dumps(payload, ensure_ascii=False),
        ai_settings=settings,
        max_tokens=8096,
        temperature=0.2,
    )
    parsed = safe_parse_json(text)
    return _normalize_scope_result(parsed, _STORY_CRITERIA, 'story_analysis')


def evaluate_beat_frames_skill(
    *,
    project: dict,
    clips: list[dict],
    ai_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = ai_settings or get_default_ai_settings()
    payload = _compact_beat_payload(project, clips)
    text = chat_completion_text(
        system_prompt=_BEAT_SYSTEM_PROMPT.format(criteria=_criteria_text(_BEAT_CRITERIA)),
        user_prompt='请评估以下首尾帧 Prompt 输出：\n' + json.dumps(payload, ensure_ascii=False),
        ai_settings=settings,
        max_tokens=8096,
        temperature=0.2,
    )
    parsed = safe_parse_json(text)
    return _normalize_scope_result(parsed, _BEAT_CRITERIA, 'beat_frames')


def _overall_from_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    if not results:
        return {
            'score': 0,
            'grade': 'D',
            'verdict': 'fail',
            'summary': '没有可评估的内容。',
            'criticalIssueCount': 0,
            'majorIssueCount': 0,
        }
    score = int(round(sum(r.get('score', 0) for r in results) / len(results)))
    issues = [issue for r in results for issue in r.get('issues', [])]
    critical = sum(1 for i in issues if i.get('severity') == 'critical')
    major = sum(1 for i in issues if i.get('severity') == 'major')
    summaries = [r.get('summary') for r in results if r.get('summary')]
    return {
        'score': score,
        'grade': _grade_for_score(score),
        'verdict': 'fail' if critical else _verdict_for_score(score),
        'summary': '；'.join(summaries[:2]) or '评估完成。',
        'criticalIssueCount': critical,
        'majorIssueCount': major,
    }


def evaluate_episode_skill(
    *,
    episode: dict,
    project: dict,
    clips: list[dict],
    scopes: list[str] | None = None,
    ai_settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    requested = [s for s in (scopes or ['story_analysis', 'beat_frames']) if s in _ALLOWED_SCOPES]
    if not requested:
        requested = ['story_analysis', 'beat_frames']

    out: dict[str, Any] = {'version': 1, 'scopes': requested}
    scope_results: list[dict[str, Any]] = []

    if 'story_analysis' in requested:
        story = evaluate_story_analysis_skill(
            episode=episode,
            project=project,
            clips=clips,
            ai_settings=ai_settings,
        )
        out['storyAnalysis'] = story
        scope_results.append(story)

    if 'beat_frames' in requested:
        beat = evaluate_beat_frames_skill(
            project=project,
            clips=clips,
            ai_settings=ai_settings,
        )
        out['beatFrames'] = beat
        scope_results.append(beat)

    out['overall'] = _overall_from_results(scope_results)
    return out

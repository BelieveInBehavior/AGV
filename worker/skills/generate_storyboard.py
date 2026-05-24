"""
Skill: 分镜生成 (Python)

纯函数 — 无 DB 副作用
输入情节片段 → OpenAI 兼容 API → 分镜面板列表
Prompt 风格对齐 waoowaoo agent_storyboard_plan（中文）
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """你是专业的分镜规划师。将一段情节拆成 3–6 个电影镜头（动作/复杂场景可更多）。

1. 精准覆盖关键画面：建立镜头、核心动作、重要对话、情绪转折点
2. 电影思维：每个 panel 是单一时间点的单一机位
3. 对话镜头：说话者需有聚焦脸部的独立镜头；禁止一镜两人同时说话
4. 角色名必须用资产库全名，禁止「母亲」「老板」等称呼代替
5. 只返回 JSON 数组，禁止 markdown
6. ⚠️ 在场角色必须出现在画面：输入 characters 列表中的所有角色，无论本 clip 是否有互动或动作，只要其物理在场（如在床上睡觉、站在角落），就必须在 imagePrompt 中写出其位置与状态，不得从画面中隐去

【角色外貌一致性】
characters 条目中每个角色有「基础形象 imagePrompt」— 为固定五官/发型/肤色/体型。写 imagePrompt 时必须完整保留基础形象，仅叠加本镜服装/表情/动作。

【imagePrompt 质量守则 G1–G5】
G1. 景别一致：特写不写全身姿态；中景不写脚；全景不写毛孔细节
G2. 液体局部化：泪汗血写在具体部位
G3. 姿势简化：避免复杂跪姿，用环境暗示
G4. 单一视觉焦点
G5. 空间坐标系：所有「左、右、前、后」均以画面坐标系为准（观众视角），不以人物自身朝向为准；同场景连续镜头必须继承场景图已建立的空间参照，不得重新解释左右方向

【景别 shotType】
大远景、远景、中景、中近景、近景、特写、过肩镜头、双人镜头、主观镜头

【运镜 cameraMovement】
固定、左摇、右摇、上摇、下摇、推轨、拉轨、升降、跟拍、手持、变焦

【输出 JSON 数组】
[
  {
    "panelIndex": 0,
    "description": "中文画面描述：人物动作、构图、环境",
    "characters": ["角色名"],
    "location": "场景名",
    "shotType": "景别",
    "cameraMovement": "运镜",
    "mood": "情绪基调",
    "action": "正在发生什么",
    "dialogue": "本镜台词或旁白，无则空字符串",
    "imagePrompt": "中文 AI 生图提示词：含画风、构图、光线、角色基础形象+本镜状态，遵守 G1–G4",
    "videoPrompt": "中文视频动态描述；说话镜头须写「正在说话」；用年龄段+性别指代角色（如年轻女子、中年男子），勿用角色名"
  }
]"""


def generate_storyboard_skill(
    clip: dict,
    characters: list,
    locations: list,
    art_style: str = 'cinematic realistic',
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> list:
    """
    为情节片段生成分镜面板列表
    """
    settings = ai_settings or get_default_ai_settings()

    clip_chars = set(clip.get('characters', []))
    char_ctx = '\n'.join(
        f"- {c['name']}\n"
        f"  基础形象（全片固定）：{c.get('imagePrompt') or c.get('description', '')}\n"
        f"  角色介绍：{c.get('introduction') or c.get('description', '')[:200]}"
        for c in characters
        if c['name'] in clip_chars
    ) or '（无角色档案）'

    loc_info = next((l for l in locations if l['name'] == clip.get('location')), None)
    if loc_info:
        loc_ctx = f"{loc_info['name']}：{loc_info['description']}"
        loc_image_prompt = loc_info.get('imagePrompt', '')
    else:
        loc_ctx = clip.get('location', '未知场景')
        loc_image_prompt = ''

    loc_image_section = (
        f'\n【场景空间基准（继承此镜头朝向与画面坐标，勿重新解释左右方向）】\n{loc_image_prompt}'
        if loc_image_prompt else ''
    )

    user_prompt = f"""画风：{art_style}

【场景】{loc_ctx}{loc_image_section}

【出场角色】
{char_ctx}

【情节摘要】{clip.get('summary', '')}

【情节正文】
{clip.get('content', '')}

⚠️ 角色在场推理：根据情节正文，逐一判断上方每个角色在本帧时刻是否物理在场（身体在画面对应空间内）。在场则必须写入 角色名 并注明位置与姿态；不在场则不写。禁止仅因角色无动作或非主角就从画面中省略。

请生成分镜 JSON 数组。每条 imagePrompt、videoPrompt 均为中文，imagePrompt 须体现画风「{art_style}」。"""

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=4096,
        temperature=0.3,
    )

    panels = safe_parse_json(text_content)

    if isinstance(panels, dict):
        panels = panels.get('panels', [])
    return panels if isinstance(panels, list) else []

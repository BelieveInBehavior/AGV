"""
Skill: 情节首尾关键帧规划 v2 — 扁平 storyboardPlan，场景/角色状态分离。
Prompt 风格对齐 waoowaoo 分镜规划（中文）
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """你是专业的分镜导演，负责为「短剧情节段」规划首尾两张关键帧（不是多分镜漫画条）。

【任务】
为本情节段输出：开场首帧 first_frame、收束末帧 last_frame，以及导演备注。每段只有 2 张关键图，衔接下一段剧情。

【核心原则 — 对齐 waoowaoo 分镜思维】
1. 首帧 = 本段剧情开始时的画面状态；末帧 = 本段结束、下一段开始前的画面状态
2. 聚焦核心动作与情绪转折点，镜头语言要有电影感
3. 角色名必须使用输入提供的资产库名字，禁止用「母亲」「老板」等身份称呼代替角色名
4. scene_prompt 只写镜头/构图/光线/环境/道具/角色动作姿态，禁止写入人物外貌（脸型发色服装等由参考图承担）
5. outfit / emotion 写在 characters 数组内，供后续「角色状态图」生成

【scene_prompt 质量守则 G1–G7】
G1. 景别一致：所选景别严格决定可见范围，scene_prompt 中不得出现该景别看不到的元素。特写（面部/局部）：只写面部或单一局部可见信息，禁止写窗外远景、全身姿态等画外内容；近景（胸部以上）：可含肩部以上环境光，禁止写腿脚或远处细节；中景（膝盖以上）：不写脚部细节；全景/广角：不写毛孔级皮肤纹理
G2. 液体局部化：泪/汗/血写在具体部位，勿写成整体湿润氛围
G3. 姿势简化：避免复杂跪姿、透视扭曲；用环境/道具暗示动作
G4. 单一视觉焦点：每帧一个主要关注点
G5. 强制景别开头：每条 scene_prompt 必须以明确景别开头（特写/近景/中景/中远景/全景/广角），不可省略
G6. 角色完整性：画面中所有可见角色都必须出现在 scene_prompt 中，写明每个角色的位置、姿态和动作；不可只写动作主体而遗漏被动方（如「A凝视B」必须同时描述B的状态和位置）
G7. 交互指向明确：涉及多角色的动作必须写清楚主语和宾语的空间关系（如「A侧卧于床左侧，手臂环住躺在身旁的B的腰部，俯身低头凝视B的面庞」），禁止出现无对象的悬空动作（如「手臂轻环」「低头凝视」）
G8. 只写可视化信息：scene_prompt 只包含可在画面中呈现的视觉元素（形状、颜色、材质、光影、空间关系、姿态、构图）；严禁气味（「弥漫着馨香」）、声音（「寂静无声」）、温度（「温暖的空气」）、触感等非视觉描述

【scene_prompt 常见错误 vs 正确写法 — 请严格对照】

❌ 错误1（G4 动作矛盾）：厉川俯身低头凝视User的面庞，轻吻User的唇瓣
→ 「凝视」与「轻吻」是两个不同时刻，单帧只能定格一个瞬间
✅ 正确：厉川俯身贴近，唇瓣轻触仰卧的User唇间，鼻尖几乎相碰

❌ 错误2（G1 景别越界）：近景，厉川手臂环住User的腰部，窗外天际线微亮
→ 近景为胸部以上，腰部和窗外远景均超出可见范围
✅ 正确：近景，厉川一手轻抚User肩侧，画面左侧透入淡金色晨光

❌ 错误3（G8 非视觉）：空气中弥漫着淡淡馨香，呼吸平稳
→ 气味和呼吸节奏无法在静态画面中呈现
✅ 正确：User面容恬静，双眼轻合，唇角微弛

❌ 错误4（G6 角色缺失）：厉川俯身轻吻，光线勾勒出脸颊轮廓
→ 被亲吻的角色完全缺失，「脸颊」不知是谁的
✅ 正确：厉川俯身贴近User面庞，唇瓣轻触，淡金色侧光勾勒出User的脸颊轮廓与厉川的下颌线

❌ 错误5（G7 悬空动作）：手臂轻环，低头凝视，床单整洁
→ 环住谁？凝视谁？动作没有对象
✅ 正确：厉川侧卧支起上身，左臂环住身旁仰卧的User肩部，低头凝视User恬静的面庞

【字段说明（中文）】
- dramatic_beat：本段戏剧转折一句话
- motion_prompt：首帧到末帧之间的运镜与动作变化（一段话）
- continuity_notes：服装、道具、光线连续性要点
- description：给人看的中文画面说明
- scene_prompt：给 AI 生图的中文镜头描述（含画风关键词），无人物外貌
- characters：[{name, outfit, emotion}] — outfit 为本帧衣着状态，emotion 为表情/情绪/微动作

【输出 JSON】
{
  "dramatic_beat": "中文",
  "motion_prompt": "中文",
  "continuity_notes": "中文",
  "included_character_ids": ["角色名"],
  "first_frame": {
    "description": "中文",
    "scene_prompt": "中文",
    "characters": [{"name": "角色名", "outfit": "衣着", "emotion": "情绪/动作"}]
  },
  "last_frame": {
    "description": "中文",
    "scene_prompt": "中文",
    "characters": [{"name": "角色名", "outfit": "衣着", "emotion": "情绪/动作"}]
  }
}

只返回 JSON，禁止 markdown。"""


def _normalize_characters(raw_list: Any) -> list[dict]:
    out: list[dict] = []
    if not isinstance(raw_list, list):
        return out
    for ch in raw_list:
        if isinstance(ch, dict):
            out.append({
                'name': ch.get('name', '') or '',
                'outfit': ch.get('outfit', '') or '',
                'emotion': ch.get('emotion', '') or '',
            })
    return out


def _normalize_frame(raw: dict | None) -> dict:
    r = raw if isinstance(raw, dict) else {}
    img_urls = r.get('characterImageUrls')
    if not isinstance(img_urls, dict):
        img_urls = {}
    return {
        'description': r.get('description', '') or '',
        'scene_prompt': r.get('scene_prompt') or r.get('scenePrompt') or '',
        'characters': _normalize_characters(r.get('characters')),
        'characterImageUrls': dict(img_urls),
        'imageUrl': r.get('imageUrl') or r.get('image_url'),
        'status': r.get('status'),
        'imageError': r.get('imageError'),
        'imagePromptUsed': r.get('imagePromptUsed'),
    }


def _normalize_plan(raw: dict) -> dict:
    ff = _normalize_frame(raw.get('first_frame'))
    lf = _normalize_frame(raw.get('last_frame'))
    return {
        'dramatic_beat': raw.get('dramatic_beat', '') or '',
        'motion_prompt': raw.get('motion_prompt', '') or '',
        'continuity_notes': raw.get('continuity_notes', '') or '',
        'transition_from_prev': raw.get('transition_from_prev') or '',
        'included_character_ids': raw.get('included_character_ids') or [],
        'first_frame': ff,
        'last_frame': lf,
    }


def generate_beat_frames_skill(
    clip: dict,
    characters: list,
    locations: list,
    art_style: str = 'cinematic realistic',
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> dict:
    """为单个情节片段生成扁平 storyboardPlan（首尾帧）。"""
    settings = ai_settings or get_default_ai_settings()

    clip_chars = list(clip.get('characters') or [])
    char_lines = [f'  - {name}' for name in clip_chars]
    char_ctx = '\n'.join(char_lines) if char_lines else '（本段无指定角色）'

    char_details = '\n'.join(
        f"- {c['name']}：{c.get('introduction') or c.get('description', '')[:400]}"
        for c in characters
        if c.get('name') in clip_chars
    ) or '（无额外角色档案）'

    loc_info = next((l for l in locations if l.get('name') == clip.get('location')), None)
    loc_ctx = (
        f"{loc_info['name']}：{loc_info.get('description', '')}"
        if loc_info
        else clip.get('location', '未知场景')
    )

    style_note = art_style if language == 'en' else f'画风：{art_style}'

    user_prompt = f"""{style_note}

【场景】{loc_ctx}

【本段出场角色（name 必须完全一致）】
{char_ctx}

【角色档案（勿将外貌抄入 scene_prompt）】
{char_details}

【情节摘要】{clip.get('summary', '')}

【情节正文】
{clip.get('content', '')}

【情绪基调】{clip.get('mood', '')}

请输出首尾帧 JSON。每个 scene_prompt 为中文，须包含画风「{art_style}」，且不含人物外貌描述。"""

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=8096,
        temperature=0.35,
    )

    parsed = safe_parse_json(text_content)
    if isinstance(parsed, dict) and 'storyboard_plan' in parsed:
        parsed = parsed['storyboard_plan']
    if not isinstance(parsed, dict):
        parsed = {}
    plan = _normalize_plan(parsed)
    return plan

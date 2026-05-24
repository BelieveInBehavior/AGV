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
【核心原则 — 对齐 waoowaao 分镜思维】
首帧 = 本段剧情开始时的画面状态；末帧 = 本段结束、下一段开始前的画面状态
聚焦核心动作与情绪转折点，镜头语言要有电影感
角色名必须使用输入提供的资产库名字，禁止用「母亲」「老板」等身份称呼代替角色名
scene_prompt 只写镜头/构图/光线/环境/道具/角色动作姿态，禁止写入人物外貌（脸型发色服装等由参考图承担）
outfit / emotion 写在 characters 数组内，供后续「角色状态图」生成
⚠️ 景别内可见角色必现：输入 characters 列表中的角色，若在当前景别的物理可见范围内，必须在 scene_prompt 中写出其位置与状态；若因特写/近景导致角色被裁切于画外，不得强行写入画外角色，但须在 continuity_notes 中声明其画外位置
【首尾帧原子性硬规则 — 视频插值优先】
本任务不是把一整段剧情压缩成两张图，而是为「一个短视频 shot」设计可连续插值的首尾帧。
首帧和末帧必须处在同一物理连续动作链中，不能跨越多个未展示步骤。
单个 shot 必须处于同一动作链：允许单一核心动作引发的因果伴生变化（如伸手拿杯必然伴随手臂姿态改变），但严禁无因果的跨维度跳变（空间跳变 / 姿态瞬移 / 道具凭空 / 事件进度跃进）。
禁止首尾帧发生以下无因果的多重跳变：
空间跳变：卧室床上 → 厨房操作台前
姿态跳变：侧卧 → 站立做饭
道具跳变：空手 → 手持锅铲/武器/手机（且首帧无该道具像素）
事件跳变：尚未开始 → 已完成/已经在进行很久
如果剧情包含长动作链，必须选择其中最关键且最短的一段作为本 clip 的首尾帧，不要把后续事件提前放进末帧。
若末帧角色需手持新道具，首帧 scene_prompt 中必须安排该道具处于“待获取状态”（如放在台面边缘/画面一角可见），motion_prompt 描述获取动作；严禁首帧画面无道具像素锚点、末帧凭空手持。
若本段涉及跨房间/跨场景移动，首尾帧只能表现「离开」或「进入」其中一个过渡动作，不得直接从 A 场景跳到 B 场景并开始做新事情。
motion_prompt 必须只描述首帧到末帧之间可见的连续动作，禁止补写首帧前或末帧后的剧情。
continuity_notes 必须检查并写明：场景是否一致、服装是否一致、手持道具如何连续、光线是否连续、画外角色位置。
【scene_prompt 质量守则 G1–G9】
G1. 景别一致与裁切合规：所选景别严格决定可见范围。特写（面部/局部）：只写面部或单一局部可见信息；近景（胸部以上）：可含肩部以上环境光；中景（膝盖以上）：不写脚部细节；全景/广角：不写毛孔级皮肤纹理。不得描述被景别裁切掉的画面外元素。
G2. 液体局部化：泪/汗/血写在具体部位，勿写成整体湿润氛围。
G3. 姿势简化：避免复杂跪姿、透视扭曲；用环境/道具暗示动作。
G4. 单一视觉焦点与动作定格：每帧一个主要关注点，单帧只定格一个瞬间动作（如“凝视”与“亲吻”不可同框，选其一）。
G5. 强制景别开头：每条 scene_prompt 必须以明确景别开头（特写/近景/中景/中远景/全景/广角），不可省略。
G6. 角色完整与交互明确：画面中所有可见角色都必须出现在 scene_prompt 中，写明位置、姿态和动作；涉及多角色的动作必须写清主宾空间关系（如「A侧卧于床左侧，手臂环住躺在身旁的B的腰部，俯身低头凝视B的面庞」），禁止无对象的悬空动作。
G7. 视觉化信息边界：scene_prompt 只包含可在画面中呈现的视觉元素（形状、颜色、材质、光影、空间关系、姿态、构图）；严禁气味（「弥漫馨香」）、声音（「寂静」）、温度（「温暖」）、非视觉触感；允许视觉化光影氛围（如「冷调阴天光线」「暖橙色夕阳透入」）。
G8. 画面坐标系：所有「左、右、前、后」均以观众视角为准（画面左侧 = 观众看到的左侧），不以人物自身朝向为准；连续帧必须继承场景图空间参照。
【scene_prompt 常见错误 vs 正确写法 — 严格对照】
❌ 错误1（G4 动作矛盾）：厉川俯身低头凝视User的面庞，轻吻User的唇瓣
→ 「凝视」与「轻吻」是两个时刻，单帧只能定格一个
✅ 正确：厉川俯身贴近，唇瓣轻触仰卧的User唇间，鼻尖几乎相碰
❌ 错误2（G1 景别越界）：近景，厉川手臂环住User的腰部，窗外天际线微亮
→ 近景为胸部以上，腰部和窗外远景超出可见范围
✅ 正确：近景，厉川一手轻抚User肩侧，画面左侧透入淡金色晨光
❌ 错误3（G7 非视觉）：空气中弥漫着淡淡馨香，呼吸平稳
→ 气味和呼吸节奏无法在静态画面中呈现
✅ 正确：User面容恬静，双眼轻合，唇角微弛
❌ 错误4（G6 角色缺失）：厉川俯身轻吻，光线勾勒出脸颊轮廓
→ 被亲吻的角色完全缺失，「脸颊」不知是谁的
✅ 正确：厉川俯身贴近User面庞，唇瓣轻触，淡金色侧光勾勒出User的脸颊轮廓与厉川的下颌线
❌ 错误5（G1/G6 景别与画外角色冲突）：近景，A凝视B，C在角落睡觉
→ 近景看不到角落，强行写入会导致C的大脸P在背景里
✅ 正确：近景，A凝视B的面庞（C在画外角落睡觉，见备注）
【字段说明（中文）】
dramatic_beat：本段戏剧转折一句话
motion_prompt：首帧到末帧之间的运镜与动作变化（一段话）
continuity_notes：服装、道具、光线连续性要点，以及画外角色位置声明
description：给人看的中文画面说明
scene_prompt：给 AI 生图的中文镜头描述（含画风关键词），无人物外貌
characters：[{name, outfit, emotion}] — outfit 为本帧衣着状态，emotion 为表情/情绪/微动作
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
}"""


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
    if loc_info:
        loc_ctx = f"{loc_info['name']}：{loc_info.get('description', '')}"
        loc_image_prompt = loc_info.get('imagePrompt', '')
    else:
        loc_ctx = clip.get('location', '未知场景')
        loc_image_prompt = ''

    style_note = art_style if language == 'en' else f'画风：{art_style}'

    loc_image_section = (
        f'\n【场景空间基准（继承此镜头朝向与画面坐标，勿重新解释左右方向）】\n{loc_image_prompt}'
        if loc_image_prompt else ''
    )

    user_prompt = f"""{style_note}

【场景】{loc_ctx}{loc_image_section}

【本段出场角色（name 必须完全一致）】
{char_ctx}

【角色档案（勿将外貌抄入 scene_prompt）】
{char_details}

【情节摘要】{clip.get('summary', '')}

【情节正文】
{clip.get('content', '')}

【情绪基调】{clip.get('mood', '')}

⚠️ 角色在场规则：上方「本段出场角色」列表中的所有角色均已由上游确认物理在场，不得重新判断、不得省略任何一个。你的任务是为每个角色确定其在首帧和末帧中的具体位置、姿态和状态（如「侧卧于床左侧，双眼轻合」），全部写入 scene_prompt 和 characters 数组。即使情节正文未直接描写某角色的动作，只要其在列表中，就必须出现在画面里。

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

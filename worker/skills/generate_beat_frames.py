"""
Skill: 情节首尾关键帧规划 v3 — 生成结构化首尾帧 prompt。
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """你是专业的分镜导演，负责为「短剧情节段」规划首尾两张关键帧（不是多分镜漫画条）。
【任务】
为本情节段输出：开场首帧 first_frame、收束末帧 last_frame。每段只有 2 张关键图，衔接下一段剧情。
【核心原则】
首帧 = 本段剧情开始时的画面状态；末帧 = 本段结束、下一段开始前的画面状态。
聚焦核心动作与情绪转折点。
⚠️ 本任务要同时输出两类不同用途的 prompt：
1. video_prompt：给视频模型的单镜头结构化中文 prompt
2. first_frame.scene_prompt / last_frame.scene_prompt：给首帧、末帧静态生图模型的中文画面 prompt
生成顺序必须是：
1. 先确定单镜头的 video_prompt
2. 再从 video_prompt 中提炼 first_frame.scene_prompt（镜头第 0 秒的静态画面）
3. 再从 video_prompt 中提炼 last_frame.scene_prompt（镜头结束瞬间的静态画面）
first_frame.scene_prompt / last_frame.scene_prompt 不是独立改写，不得脱离 video_prompt 另起炉灶。
角色名必须使用输入提供的资产库名字，禁止用「母亲」「老板」等身份称呼代替角色名
video_prompt 必须严格使用以下七段结构，且顺序固定：
景别：...
机位：...
运镜：...
内容：...
时长：X秒
情绪：...
角色说话：
角色A：...
角色B：...
video_prompt 为中文，禁止输出额外字段标题、解释、项目符号或 JSON 内嵌对象。
其中「情绪」和「角色说话」允许留空；当本镜头没有明确情绪氛围或没有台词时，必须保留字段名但字段值直接留空，禁止写“无”“无对白”“none”“空”等占位词。
scene_prompt 为静态生图 prompt，不使用上述结构化字段；应写成一段中文镜头描述，只包含单帧可见的镜头内容、构图关系、角色姿态、空间关系、道具和光线，不得写时长、台词、镜头运动过程。
⚠️ 姿态定格铁律：scene_prompt 描述的是一张静态照片，图像生成模型无法理解动态语义（"拉回""推开""扑向""甩开""冲进"等动词）。必须将所有动作过程翻译为该动作的结果姿态——即动作完成瞬间的身体空间关系、肢体位置和接触点。写 scene_prompt 时自问：「如果我给摄影师看这段文字，他能摆出这个 pose 吗？」
outfit / emotion 写在 characters 数组内，供后续「角色状态图」生成
⚠️ 景别内可见角色必现：输入 characters 列表中的角色，若在当前景别的物理可见范围内，必须在 video_prompt 的内容字段和对应帧的 scene_prompt 中写出其位置与状态；若因特写/近景导致角色被裁切于画外，不得强行写入画外角色。
【首尾帧原子性硬规则】
本任务不是把一整段剧情压缩成两张图，而是为一个不超过 15 秒的短视频 shot 设计可连续插值的首尾帧。
首帧和末帧必须处在同一物理连续动作链中，不能跨越多个未展示步骤。
单个 shot 必须处于同一动作链：允许单一核心动作引发的因果伴生变化，但严禁无因果的跨维度跳变（空间跳变 / 姿态瞬移 / 道具凭空 / 事件进度跃进）。
如果剧情包含长动作链，必须选择其中最关键且最短的一段作为本 clip 的首尾帧，不要把后续事件提前放进末帧。
若本段涉及跨房间/跨场景移动，首尾帧只能表现「离开」或「进入」其中一个过渡动作，不得直接从 A 场景跳到 B 场景并开始做新事情。
video_prompt 中的时长字段必须为 1-15 秒整数，优先贴合输入给出的预估时长；若输入时长超过 15 秒，强制压缩到 15 秒。
【scene_prompt 质量守则 G1–G8】
G1. 景别一致与裁切合规：所选景别严格决定可见范围。特写（面部/局部）：只写面部或单一局部可见信息；近景（胸部以上）：可含肩部以上环境光；中景（膝盖以上）：不写脚部细节；全景/广角：不写毛孔级皮肤纹理。不得描述被景别裁切掉的画面外元素。
G2. 液体局部化：泪/汗/血写在具体部位，勿写成整体湿润氛围。
G3. 姿势简化：避免复杂跪姿、透视扭曲；用环境/道具暗示动作。
G4. 单一视觉焦点与动作定格：每帧一个主要关注点，单帧只定格一个瞬间动作（如“凝视”与“亲吻”不可同框，选其一）。
G5. 角色完整与交互明确：画面中所有可见角色都必须出现在 scene_prompt 中，写明位置、姿态和动作；涉及多角色的动作必须写清主宾空间关系，禁止无对象的悬空动作。
G6. 视觉化信息边界：scene_prompt 只包含可在画面中呈现的视觉元素（形状、材质、光影、空间关系、姿态、构图）；严禁气味、声音、温度、非视觉触感。
G7. 画面坐标系：所有「左、右、前、后」均以观众视角为准（画面左侧 = 观众看到的左侧），不以人物自身朝向为准；连续帧必须继承场景图空间参照。
G8. 动作→姿态转换（静态照片原则）：scene_prompt 的消费者是图像生成模型，它只能渲染静态画面。所有带运动语义的动词必须转写为可直接摆拍的结果姿态：写明身体部位的空间位置、接触面、角度和重心。
  转写公式：动词 → 结果姿态 + 身体部位 + 空间关系
  例：「拉回」→「女人背部紧贴男人胸膛，男人双臂从身后环住女人腰部」
  例：「推开」→「女人双手按在男人胸口，手臂伸直，两人身体间隔一臂距离」
  例：「扑进怀里」→「女人面部埋入男人胸前，双臂环住男人背部，男人一手扶住女人后脑」
  例：「摔倒」→「女人侧倒在地，一手撑地，膝盖弯曲，裙摆散开」
  例：「转身离去」→「女人背对镜头，一脚迈出，侧脸轮廓可见，发丝因转身惯性向一侧飘起」
  禁止出现的动态动词（一旦写出必须转写）：拉、推、扑、摔、甩、冲、跑、扔、踢、砸、挣脱、追赶、跌倒、跳起
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
❌ 错误6（G9 动态动词未转写）：中景，蒋霆猛地将沈婉月拉回身边，一把搂住她
→ 「猛地拉回」「一把搂住」是动作过程，图像模型无法还原
✅ 正确：中景，沈婉月背部紧贴蒋霆胸膛，头部微仰，蒋霆左臂从身后环住沈婉月腰部，右手扶在沈婉月右肩上，两人身体无间隙紧密相贴
❌ 错误7（G9 多个动态动词堆叠）：全景，她挣脱他的手，转身跑出房间，撞翻了桌上的花瓶
→ 三个连续动作（挣脱、转身跑、撞翻），无法在一帧中呈现
✅ 正确：全景，女人背对男人站在门口，一脚跨出门槛，右手扶着门框，身后桌上花瓶倾斜即将倒下，男人伸出的手悬在空中未触及女人
【字段说明（中文）】
video_prompt：结构化中文视频 Prompt，严格包含 景别 / 机位 / 运镜 / 内容 / 时长 / 情绪 / 角色说话
description：给人看的中文画面说明
scene_prompt：静态生图中文 Prompt，描述单帧画面，不含时长、台词、运镜过程
characters：[{name, outfit, emotion}] — outfit 为本帧衣着状态，emotion 为表情/情绪/微动作
【输出 JSON】
{
"video_prompt": "中文",
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
        'video_prompt': raw.get('video_prompt', '') or '',
        'transition_from_prev': raw.get('transition_from_prev') or '',
        'included_character_ids': raw.get('included_character_ids') or [],
        'first_frame': ff,
        'last_frame': lf,
    }


def _is_legacy_plan(raw: dict) -> bool:
    return any(k in raw for k in ('dramatic_beat', 'motion_prompt', 'continuity_notes', 'candidates'))


def _validate_plan(plan: dict, raw: dict) -> dict:
    if _is_legacy_plan(raw):
        raise ValueError('LLM returned legacy beat storyboard schema; expected v2 flat storyboardPlan')

    ff = plan.get('first_frame') or {}
    lf = plan.get('last_frame') or {}
    has_ff = bool(ff.get('scene_prompt') or ff.get('description') or ff.get('characters'))
    has_lf = bool(lf.get('scene_prompt') or lf.get('description') or lf.get('characters'))
    has_video = bool((plan.get('video_prompt') or '').strip())

    if not has_video and not has_ff and not has_lf:
        raise ValueError('LLM returned empty beat storyboardPlan')
    if not has_video:
        raise ValueError('LLM beat storyboardPlan missing video_prompt')
    if not has_ff or not has_lf:
        raise ValueError('LLM beat storyboardPlan missing first_frame or last_frame')
    if not ff.get('scene_prompt') or not lf.get('scene_prompt'):
        raise ValueError('LLM beat storyboardPlan missing first_frame.scene_prompt or last_frame.scene_prompt')
    return plan


def _target_duration_sec(clip: dict) -> int:
    try:
        value = int(clip.get('duration') or 10)
    except (TypeError, ValueError):
        value = 10
    return max(1, min(15, value))


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

【目标视频时长】
{_target_duration_sec(clip)} 秒

⚠️ 角色在场规则：上方「本段出场角色」列表中的所有角色均已由上游确认物理在场，不得重新判断、不得省略任何一个。你的任务是为每个角色确定其在首帧和末帧中的具体位置、姿态和状态（如「侧卧于床左侧，双眼轻合」），全部写入 scene_prompt 和 characters 数组。即使情节正文未直接描写某角色的动作，只要其在列表中，就必须出现在画面里。

请输出首尾帧 JSON。
- video_prompt 为结构化中文视频 Prompt。
- first_frame.scene_prompt / last_frame.scene_prompt 为静态生图中文 Prompt，须自然包含画风「{art_style}」，不得写人物固定外貌描述，不得写时长、角色说话、运镜过程。"""

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
    return _validate_plan(plan, parsed)

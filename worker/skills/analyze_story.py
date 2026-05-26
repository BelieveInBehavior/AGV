"""
Skill: 故事分析 (Python)

纯函数 — 无 DB 副作用
输入文本 → OpenAI 兼容 API → 结构化角色/场景/情节片段
Prompt 风格对齐统一写作规范（中文）
"""

from typing import Any

from skills.llm_chat import chat_completion_text
from utils.ai_settings import get_default_ai_settings
from utils.clip_characters import backfill_clip_characters
from utils.json_utils import safe_parse_json

_SYSTEM_PROMPT = """你是专业的「剧本统筹 / 选角指导 / 场景资产师」。请基于用户提供的小说或剧本文本，一次性输出：角色档案、场景资产、情节切片。
【总规则】
只返回合法 JSON，禁止 markdown、注释、解释性文字
角色名、场景名、原文称呼保持原文语言（中文文本用中文名）
所有面向人的说明字段用中文；imagePrompt 为 AI 生图专用，也用中文撰写
JSON 字符串值内禁止出现未转义的英文双引号 "；原文引号统一改为「」
【一、角色提取 — 参考选角指导】
✅ 必须提取：有台词且参与互动、贯穿主线、需在画面中出镜的角色
❌ 不提取：无名路人、仅被提及未出场、无台词无互动的背景人、纯修辞意象
每个角色必须包含 introduction（帮助后续 AI 识别）：
叙述视角：第一人称「我」是否对应该角色
身份定位：主角/配角/反派等
关系：与其他主要角色的关系
称呼映射：他人对此角色的常用称呼（如「林总」「老婆」）
role 字段：protagonist（主角/S级视角）| antagonist（反派）| supporting（其他）
aliases：原文中的别名、称呼、真名补充（如「我」的真名为林墨则 aliases 含「林墨」）
imagePrompt（角色基础形象，用于后续 9:16 竖屏参考图生成）：
人类：竖屏全身立式构图、中性表情、简洁棚拍背景；详写脸型、五官、发型、肤色、体型、默认服装、配饰、年龄感；禁止情绪词、禁止剧情动作、禁止场景专属姿态
非人类：以角色名/物种名开头，按实际形态描述（动物、神话生物等不受人类模板限制）
描述默认「初始形象」only，不写换装/战斗特效/临时状态
长度：主角约 150–220 字，重要配角 120–180 字，次要角色 80–120 字
【二、场景提取 — 参考场景资产建立师】
✅ 必须提取：角色实际身处并产生互动的具体场所、多次出现或戏份重的地点
❌ 不提取：一笔带过的路过地、比喻修辞（如「从天堂打到地狱」）、无法具象的抽象空间
命名建议：「地点_时间/状态」，如「客厅_白天」「古道_黄昏」
description：中文简要说明场景用途、氛围（50–80 字）
imagePrompt（场景背景图，用于 AI 生图定调）：
⚠️ 必须按以下结构撰写，以自然语言流输出（不分行）：
【构图与视角】「场景名」开头，广角/全景，明确一个核心视觉焦点（如镜头正对大门/壁炉/窗景），描述光线时间（如晨光/昏暗夜景）。
【空间与布局】自然描述空间纵深与核心大件家具/地物的位置关系（如：尽头是壁炉，中央摆放长桌）。基于文本语境合理补全常识性环境道具（如厨房应有灶台，但严禁凭空添加原文未提及的剧情专属道具如带血的刀）。
【氛围与品质】整体空间规模、新旧程度与风格质感（如：破旧的赛博朋克风窄巷/豪华的欧式古典大殿）。
⚠️ 硬规则：
只写可视化信息（形状、颜色、材质、光影、空间关系）；严禁气味、声音、温度、触感
绝对不能出现任何有名有姓的角色或角色的具体部位
若原文描写了窗外景观（天际线、河面、远山等），必须作为背景元素融入描述
长度控制在 80-120 字，确保词元精炼，避免 AI 生图时元素过载
【三、情节切片 clips — 导演分镜粒度切割】
⚠️ 核心目标：每个 clip 对应一个连续的、目的明确的「戏剧节拍」（dramatic beat）。一个节拍 = 角色带着某个小目标完成一段连贯动作，直到目标达成或被打断。
将全文切成若干 clip（不限死数量，以节拍完整性为准）。
【节拍粒度规则 — 一个 clip = 一个完整的小型戏剧目的】
一个 clip 应包含一个连续的、目的明确的动作段落。只要角色在同一空间中的移动、对话没有被打断或出现重大情绪转折，就应合并在同一个 clip 内。
✅ 可以合并在一个 clip 的例子：
- 听到声音 → 起身 → 走到门口 → 开门（目的：「去开门」）
- 走进厨房 → 打开冰箱 → 取出食材 → 放在案板上（目的：「准备食材」）
- 两人对话 2-4 个来回，情绪方向一致（目的：「交流某个话题」）
- 角色在同一空间内的连续小动作链（如坐下 → 拿起杯子 → 喝水 → 放下）
【何时必须断开为新 clip】（切割优先级从高到低）
1. 场景/空间跳切：角色从 A 场景切到 B 场景（非连续移动，而是叙事跳转）
2. 重大情绪转折：情绪方向发生逆转（如从温馨突变为愤怒、从平静到惊恐）
3. 戏剧目的更替：上一个小目标完成，开始新的目标（如「做早餐」完成 →「叫孩子起床」开始）
4. 视角切换：叙事视角从 A 角色切到 B 角色
5. 时间跳跃：明确的时间省略（如「三天后」「当天晚上」）
【⚠️ 视频生成适配约束】
虽然允许更粗的节拍粒度，但仍需注意：
- 单个 clip 的首帧→尾帧之间的视觉状态差异不宜过大。如果一个动作段落跨越了明显不同的视觉构图（如从室内全景 → 特写面部），建议拆分
- 快节奏的动作戏（打斗、追逐）仍应切细，每 2-3 个显著动作为一个 clip
- 单个 clip 时长感控制在 5-15 秒的视频节奏，过长的段落应找自然断点拆分
【其他规则】
各 clip 的 content 应覆盖连续剧情，summary 一句话概括
第一人称文本：summary 标明「第一视角：角色名」
characters 数组只能填本段已提取角色库中的名字（严禁「老张」代替「张三」）
⚠️ characters 填写标准：只要角色在本段剧情对应的场景中物理在场（即身体在该空间内，无论是否有动作、对话、互动），就必须列入。例如角色在床上睡觉而环境发生变化，该角色仍须列入 characters，不得因「无动作」而遗漏
⚠️ 跨 clip 角色连贯性回查：全部 clip 切完后，必须逐对检查相邻 clip（clip[i] 与 clip[i+1]）：若 clip[i+1] 的 characters 中某角色在场且该 clip 无该角色「进入/到达/走进」的动作描写，说明该角色在 clip[i] 时已经物理在场，clip[i] 的 characters 必须补入该角色。典型场景：环境建立镜头（如「卧室清晨光线变化」）紧接「厉川醒来环住 User」→ clip[0] 的 characters 必须为 ["User","厉川"]（两人同床已睡），不得只写 User
location 填场景库中完全一致的名字，多场景用逗号分隔，无法匹配则最接近者或空字符串
sceneComplexity：
complex：快节奏打斗追逐、多人同时运动、难以用仅两张关键帧衔接的复杂视觉
simple：对话为主、静态张力、前后状态清晰
mood：tense|romantic|action|mystery|peaceful|dramatic 择一
duration（整数，单位秒，范围 5-15）：根据本 clip 包含的动作量、对话长度、情绪节奏估算合理的视频时长。参考：
- 纯环境建立/静态氛围：5-7 秒
- 1-2 轮简短对话或单个连贯动作：8-10 秒
- 多轮对话或包含 2-3 步动作链：11-13 秒
- 复杂动作戏/多角色互动：13-15 秒
【输出 JSON 结构】
{
"characters": [
{
"name": "角色名",
"aliases": ["别名"],
"introduction": "身份、视角、关系、称呼映射",
"description": "简要外貌与性格（中文）",
"role": "protagonist|antagonist|supporting",
"imagePrompt": "中文生图提示词：默认初始形象，全身中性表情，无剧情动作"
}
],
"locations": [
{
"name": "场景_时间",
"description": "场景简要说明",
"imagePrompt": "「场景名」开头的广角空镜中文生图描述，自然语言流，无角色"
}
],
"clips": [
{
"clipIndex": 0,
"content": "本段剧情正文摘录或连贯摘要",
"summary": "一句话概括；第一人称时注明视角",
"characters": ["角色名"],
"location": "场景名",
"mood": "tense",
"sceneComplexity": "simple",
"duration": 10
}
]
}
"""


def analyze_story_skill(
    text: str,
    language: str = 'zh',
    ai_settings: dict[str, Any] | None = None,
) -> dict:
    """
    分析故事文本，返回结构化数据

    Args:
        text: 小说/故事正文
        language: 'zh' 或 'en'
        ai_settings: 来自 get_ai_settings_for_project / get_default_ai_settings
    """
    settings = ai_settings or get_default_ai_settings()

    user_prompt = (
        f'请分析以下小说/故事文本，按照系统提示中的 JSON 结构输出（角色、场景、情节切片）：\n\n{text}'
        if language == 'zh'
        else f'Analyze the following story and output JSON per system instructions:\n\n{text}'
    )

    text_content = chat_completion_text(
        system_prompt=_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        ai_settings=settings,
        max_tokens=16000,
        temperature=0.25,
    )

    result = safe_parse_json(text_content)
    clips = backfill_clip_characters(result.get('clips', []) or [])
    return {
        'characters': result.get('characters', []),
        'locations': result.get('locations', []),
        'clips': clips,
    }

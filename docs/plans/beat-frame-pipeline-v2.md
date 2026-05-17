# 首尾帧生成架构 v2 — 角色/场景/动作分离

## 背景

当前 `storyboardPlan.candidates[].first_frame.imagePrompt` 把角色外貌、衣着、情绪、场景、镜头全部塞进一个英文字符串。问题:
- LLM 从 `clip.content` 抄人物外貌进 prompt,与 referenceImage 重复甚至冲突
- 多次禁用规则均失败,根因是字段没有物理分离
- candidates 三方案在实际使用中价值低,UI 也未深度利用

## 目标

把"角色外貌(基础形象)"、"角色当前状态(衣着+情绪)"、"场景/镜头/动作"拆成 3 个独立字段,各自走独立生成步骤。

## 完整流水线

```
[1] 情节分析 (沿用现有)
  → clips: content/summary/characters/location
  → project.characters[].referenceImageUrl  (基础形象, 无情绪)
  → project.locations[].referenceImageUrl   (场景含道具)

[2] 首尾帧规划 LLM (并行 per clip)
  → storyboardPlan.first_frame / last_frame
  → {scene_prompt, characters:[{name, outfit, emotion}]}
  → 不生成 transition_from_prev

[3] 角色状态图 (并行 per unique state, 带缓存)
  key  = hash(characterId + outfit + emotion + baseImageUrl)
  hot  = Redis  cs:{hash}  TTL 7d
  cold = MongoDB characterStates 集合
  输入 = 基础形象 refUrl + "outfit:xxx, emotion:yyy"
  → characterStateImageUrl

[4] 首尾帧合成 (并行 per frame)
  refs   = [场景图] + [角色状态图 × N]
  prompt = scene_prompt + style/shot/mood suffix
  模型   = 用户配置 (gemini-2.5-flash-image / doubao-seedream / ...)
  → first_frame.imageUrl / last_frame.imageUrl

[5] 过渡衔接批处理 (一次 LLM 调用, episode 维度)
  输入 = clips 按序的 [{clipId, first_frame.description, last_frame.description}]
  输出 = [{clipId, transition_from_prev}]  # 第一 clip 留空
  → 写回各 clip.storyboardPlan.transition_from_prev (供生视频用)
```

## 数据结构 (扁平化, 去 candidate 层)

```python
storyboardPlan = {
  "dramatic_beat": "string (zh)",
  "motion_prompt": "string (zh)",
  "continuity_notes": "string (zh)",
  "transition_from_prev": "string (zh)",   # 阶段5回写, 首 clip 为空
  "included_character_ids": ["1", "2"],
  "first_frame": {
    "description": "string (zh)",
    "scene_prompt": "string (en) — 镜头/构图/动作/光线, 无人物外貌",
    "characters": [
      {"name": "张三", "outfit": "黑色西装", "emotion": "愤怒, 紧握拳头"}
    ],
    "characterImageUrls": {},   # 阶段3产出, key=name → stateImageUrl
    "imageUrl": null,           # 阶段4产出
    "status": null,
    "imageError": null
  },
  "last_frame": { 同上 },
  "referenceStale": false
}
```

## Skill / 模块划分 (不为 skill 而 skill)

| 名称 | 形态 | 落点 | 复用价值 |
|---|---|---|---|
| `multi_ref_image_gen` | **真 skill** (provider 分派) | `worker/skills/multi_ref_image_gen.py` | panel/state/beat-frame 三处都用 |
| `generate_transitions` | 普通模块函数 | `worker/skills/generate_transitions.py` | 单点 LLM 调用,不包装抽象 |
| 角色状态图缓存 | image_task 内部 helper | `worker/utils/character_state.py` | 仅 image_task 一处用 |

## ai_settings.image 扩展

```json
{
  "provider": "fal" | "gemini" | "doubao",
  "model": "...",
  "apiKey": "...",
  "supportsMultiReference": true,
  "maxReferenceImages": 6
}
```

默认: fal=false/1, gemini=true/6, doubao=true/4。

provider 分派位置: `multi_ref_image_gen.py` 内根据 `provider_cfg.provider` 选择实现分支,不支持多参考时降级到首张参考(等价 i2i)。

## MongoDB 新集合 `characterStates`

```js
{
  _id: hash(characterId + outfit + emotion + baseImageUrl),
  projectId, characterId, characterName,
  outfit, emotion,
  baseImageUrl,         // 来源基础形象
  stateImageUrl,        // 阶段3产出
  createdAt, lastUsedAt,
  usageCount
}
```

Redis: `cs:{hash}` → stateImageUrl, TTL 7d, episode 内复用避免 DB 查询。

## 落地顺序

```
P1 基础  → 1. 扩展 ai_settings 多 provider 字段
P2 工具  → 2. skill: multi_ref_image_gen
P3 数据  → 3. 改造 generate_beat_frames (新 LLM 输出格式)
        → 4. 清空旧 storyboardPlan (一次性脚本)
P4 编排  → 5. 改造 image_task 两阶段生图 (含角色状态图缓存)
        → 6. 模块: generate_transitions
        → 7. 新增 transition_task (Celery 编排, 调 #6)
P5 UI    → 8. 前端 BeatKeyframeEditor 适配新结构
```

## 已确认的设计决策

- ✅ 去除 candidates 数组,扁平化为单方案
- ✅ 角色状态图冷热双存
- ✅ transition 后置批处理 (能看到定稿的首尾帧描述,衔接更准)
- ✅ provider 用户可配置 (gemini/doubao 等)
- ✅ 不为 skill 而 skill — 仅 multi_ref_image_gen 抽 skill

## 待确认问题

1. **provider 配置层级** — 项目级 (沿用现有 `ai_settings`) vs 全局 settings?
2. **gemini / doubao API 凭证** — 起步是否先只实现 fal 分支,留 provider 骨架?
3. **角色状态图缓存粒度** — 仅 `(characterId, outfit, emotion, baseImageUrl)`,光照交给 scene_prompt 控制? (倾向是)
4. **transition_from_prev 载体确认** — 给视频生成阶段用,运镜衔接文本 (需 review 现有 video_task 接口)
5. **第一 clip 的 transition_from_prev** — 直接空字符串/null,前端不渲染

## 不在本次范围

- video_task 的改动 (transition_from_prev 消费方,后续单独评估)
- panel 路径的 image_task 改造 (保留现有 i2i 单参考逻辑,后续可选迁移到 multi_ref_image_gen)
- 历史数据迁移 (确认直接清空重新生成)

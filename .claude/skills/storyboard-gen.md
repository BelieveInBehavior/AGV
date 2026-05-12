# Storyboard Generation Skill

Generate detailed cinematic storyboard panels for a story clip/scene.

## When to invoke
Use this skill when the user wants to:
- Break a story scene into visual storyboard panels
- Generate shot lists for video production
- Create image generation prompts for each panel
- Plan camera angles, movements, and compositions

## How to invoke
```
/storyboard-gen
```

## What this skill does

### Input
- `clip`: scene content, summary, characters, location, mood
- `characters`: array of character descriptions from the project
- `locations`: array of location descriptions from the project
- `artStyle`: visual style (cinematic, anime, realistic, etc.)

### Process
1. Break scene into 3–6 cinematic panels (shots)
2. For each panel: determine shot type, camera movement, composition
3. Generate English image prompts for AI image generation
4. Generate video motion prompts for video generation

### Output (JSON array)
```json
[
  {
    "panelIndex": 0,
    "description": "张明站在落地窗前，俯瞰城市夜景，手持神秘信封",
    "characters": ["张明"],
    "location": "上海办公室",
    "shotType": "medium shot",
    "cameraMovement": "slow dolly in",
    "mood": "mysterious",
    "action": "张明缓缓转过身，表情凝重",
    "dialogue": "这不可能是真的...",
    "imagePrompt": "A man in a dark suit standing by floor-to-ceiling windows in a modern Shanghai office, city lights at night visible behind him, holding a white envelope, cinematic lighting, medium shot, mysterious atmosphere, 8k quality",
    "videoPrompt": "slow dolly in toward the man, subtle camera movement"
  }
]
```

### Shot types
- `extreme wide shot` — 大远景，建立场景
- `wide shot` — 全景，展示环境
- `medium shot` — 中景，腰部以上
- `medium close-up` — 中近景，胸部以上
- `close-up` — 近景，面部特写
- `extreme close-up` — 大特写
- `over the shoulder` — 过肩镜头
- `point of view` — 主观镜头

## Implementation reference
Server skill: `server/src/skills/generate-storyboard.js`
Uses: Claude Opus 4.6 with adaptive thinking + prompt caching

## Usage in AGV project
This skill powers the **StoryboardAgent** (`server/src/agents/storyboard-agent.js`).
Triggered via `POST /api/generate/storyboard` → creates a `STORYBOARD_GEN` task.

## Tips
- Vary shot types for cinematic visual rhythm (wide → medium → close-up)
- Image prompts must be in English for best AI image generation results
- Include art style keywords in every image prompt
- Use contrast in mood between panels to create visual drama

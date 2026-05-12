# Story Analysis Skill

Analyze a story or novel excerpt and extract structured data: characters, locations, and dramatic clips (scenes).

## When to invoke
Use this skill when the user wants to:
- Analyze a novel/story text and extract structure
- Identify characters and their relationships
- Break a story into scenes/clips for video production
- Extract location/setting information from narrative text

## How to invoke
```
/story-analysis
```
Then paste the story text when prompted.

## What this skill does

### Input
- Story/novel text (any language, recommended 300–5000 characters)
- Optional: target language for output (`zh` or `en`)

### Process
1. Parse characters: name, aliases, description, role (protagonist/antagonist/supporting)
2. Parse locations: name, atmosphere, visual characteristics
3. Split into 3–8 dramatic clips with mood classification

### Output (JSON)
```json
{
  "characters": [
    {
      "name": "张明",
      "aliases": ["小张", "明哥"],
      "description": "30岁男性，沉稳内敛，穿着西装",
      "role": "protagonist"
    }
  ],
  "locations": [
    {
      "name": "上海办公室",
      "description": "现代高层写字楼，落地玻璃窗，城市天际线背景"
    }
  ],
  "clips": [
    {
      "clipIndex": 0,
      "content": "原文引用或场景摘要",
      "summary": "张明在办公室收到神秘文件",
      "characters": ["张明"],
      "location": "上海办公室",
      "mood": "mysterious"
    }
  ]
}
```

### Mood values
`tense` | `romantic` | `action` | `mystery` | `peaceful` | `dramatic` | `comedic` | `sad`

## Implementation reference
Server skill: `server/src/skills/analyze-story.js`
Uses: Claude Opus 4.6 with adaptive thinking + prompt caching

## Usage in AGV project
This skill powers the **StoryAgent** (`server/src/agents/story-agent.js`).
Triggered via `POST /api/generate/story` → creates a `STORY_ANALYSIS` task in MongoDB queue.

## Tips
- Longer, detailed text produces better character/location extraction
- Include emotional cues in text for better mood classification
- Works best with narrative fiction; also handles scripts and screenplays

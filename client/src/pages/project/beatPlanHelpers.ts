import type { BeatFrameSlot, StoryboardPlan } from '../../types/project';

/** 旧版多方案：首尾帧嵌在 candidates 内 */
export type BeatStoryboardCandidate = {
  id: string;
  variant_label?: string;
  first_frame?: BeatFrameSlot;
  last_frame?: BeatFrameSlot;
};

export type StoryboardPlanWithLegacy = StoryboardPlan & {
  candidates?: BeatStoryboardCandidate[];
  selected_candidate_id?: string;
};

/** 扁平 v2 或旧版 selected candidate 的首末帧 */
export function resolveBeatFrames(plan: StoryboardPlan | null | undefined): {
  first_frame?: BeatFrameSlot;
  last_frame?: BeatFrameSlot;
} {
  if (!plan) return {};
  if (plan.first_frame) {
    return { first_frame: plan.first_frame, last_frame: plan.last_frame };
  }
  const legacy = plan as StoryboardPlanWithLegacy;
  const candidates = legacy.candidates;
  if (!candidates?.length) return {};
  const sel = legacy.selected_candidate_id;
  const picked = candidates.find((c) => c.id === sel) ?? candidates[0];
  return {
    first_frame: picked?.first_frame,
    last_frame: picked?.last_frame,
  };
}

export function hasBeatStoryboardContent(plan: StoryboardPlan | null | undefined): boolean {
  return Boolean(resolveBeatFrames(plan).first_frame);
}

/** 供 UI 使用：保证顶层 first_frame / last_frame 已解析 */
export function storyboardPlanForDisplay(plan: StoryboardPlan): StoryboardPlan {
  const { first_frame, last_frame } = resolveBeatFrames(plan);
  return { ...plan, first_frame, last_frame };
}

export function isLegacyBeatPlan(plan: StoryboardPlan | null | undefined): boolean {
  if (!plan) return false;
  const legacy = plan as StoryboardPlanWithLegacy;
  return Boolean(legacy.candidates?.length && !plan.first_frame);
}

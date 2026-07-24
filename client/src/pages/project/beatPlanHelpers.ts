import type { BeatFrameSlot, StoryboardPlan } from '../../types/project';

/** 扁平 v2 首末帧 */
export function resolveBeatFrames(plan: StoryboardPlan | null | undefined): {
  first_frame?: BeatFrameSlot;
  last_frame?: BeatFrameSlot;
} {
  if (!plan) return {};
  return { first_frame: plan.first_frame, last_frame: plan.last_frame };
}

export function hasBeatStoryboardContent(plan: StoryboardPlan | null | undefined): boolean {
  return Boolean(resolveBeatFrames(plan).first_frame);
}

/** 供 UI 使用：保证顶层 first_frame / last_frame 已解析 */
export function storyboardPlanForDisplay(plan: StoryboardPlan): StoryboardPlan {
  return plan;
}

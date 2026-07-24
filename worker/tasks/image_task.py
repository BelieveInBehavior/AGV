"""
Celery Task: 图像生成

冷热分离:
  热 (Redis): 进度广播
  冷 (MongoDB): panels → imageUrl；clips.storyboardPlan → 首尾帧 imageUrl
"""

from datetime import datetime, timezone

from celery_app import app
from skills.build_image_prompt import build_image_prompt, get_resolution
from skills.multi_ref_image_gen import generate_image_with_provider, multi_ref_image_gen
from utils.ai_settings import get_ai_settings_for_project
from utils.character_state import get_or_create_character_state_image, resolve_character_row
from utils.db import get_db
from utils.redis_client import get_redis, publish_progress, publish_complete, publish_error, set_task_state
from utils import pipeline_telemetry
from utils.reference_assets import (
    collect_frame_reference_urls,
    collect_reference_urls,
    reference_descriptions_for_prompt,
)
import config

def _placeholder_image(description: str, width: int, height: int) -> str:
    """无 FAL key 时返回占位图"""
    import urllib.parse
    text = urllib.parse.quote(description[:30] or 'Panel')
    return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'


def _is_beat_plan(plan: dict) -> bool:
    return isinstance(plan.get('first_frame'), dict)


def _is_data_url(url: str) -> bool:
    """检查是否为 base64 data URL"""
    return isinstance(url, str) and url.startswith('data:')


def _collect_beat_jobs(db, episode_id: str) -> list[dict]:
    """未带 imageUrl 的扁平首尾帧任务。包括需要上传 base64 data URL 的任务。"""
    jobs: list[dict] = []
    clips = list(db.clips.find({'episodeId': episode_id, 'isActive': {'$ne': False}}).sort('clipIndex', 1))
    for clip in clips:
        plan = clip.get('storyboardPlan')
        if not plan:
            continue
        if not _is_beat_plan(plan):
            continue
        for slot in ('first_frame', 'last_frame'):
            fr = plan.get(slot) or {}
            if not isinstance(fr, dict):
                continue
            image_url = fr.get('imageUrl')
            # 跳过已有非 data URL 的图片
            if image_url and not _is_data_url(image_url):
                continue
            # 包括：1) 无 imageUrl，2) 有 data URL 需要上传
            jobs.append({
                'kind': 'beat_v2',
                'clipId': clip['clipId'],
                'slot': slot,
                'frame': fr,
                'clip': clip,
                'has_data_url': _is_data_url(image_url),  # 标记是否需要上传
            })
    return jobs


def _build_targeted_beat_job(db, clip_id: str, beat_slot: str) -> dict | None:
    """按 clip + slot 定向构建单个首尾帧生图任务。定向任务视为显式重生。"""
    print(f'[DEBUG] _build_targeted_beat_job: clip_id={clip_id}, beat_slot={beat_slot}')
    if beat_slot not in ('first_frame', 'last_frame'):
        print(f'[DEBUG] beat_slot invalid: {beat_slot}')
        return None
    clip = db.clips.find_one({'clipId': clip_id, 'isActive': {'$ne': False}})
    if not clip:
        print(f'[DEBUG] clip not found: {clip_id}')
        return None
    plan = clip.get('storyboardPlan')
    print(f'[DEBUG] plan exists: {bool(plan)}, is_beat_plan: {_is_beat_plan(plan) if plan else False}')
    if not plan or not _is_beat_plan(plan):
        print(f'[DEBUG] plan invalid or not beat plan')
        return None
    frame = plan.get(beat_slot) or {}
    print(f'[DEBUG] frame type: {type(frame)}, is dict: {isinstance(frame, dict)}')
    if not isinstance(frame, dict):
        print(f'[DEBUG] frame is not dict')
        return None

    print(f'[DEBUG] returning job for {beat_slot}')
    return {
        'kind': 'beat_v2',
        'clipId': clip['clipId'],
        'slot': beat_slot,
        'frame': frame,
        'clip': clip,
        'has_data_url': _is_data_url(frame.get('imageUrl')),  # 标记是否需要上传
        'force_regenerate': True,
    }


def _character_direction_hint_english(frame: dict) -> str:
    parts: list[str] = []
    for ch in frame.get('characters') or []:
        if not isinstance(ch, dict):
            continue
        name = (ch.get('name') or '').strip()
        if not name:
            continue
        outfit = (ch.get('outfit') or '').strip()
        emotion = (ch.get('emotion') or '').strip()
        parts.append(f'{name}: wardrobe {outfit}; acting {emotion}')
    if not parts:
        return ''
    return 'Character direction — ' + ' | '.join(parts)


@app.task(
    name='tasks.image_task.generate_images',
    bind=True,
    max_retries=1,
    default_retry_delay=5,
    queue='image',
)
def generate_images(self, task_id: str, project_id: str,
                    episode_id: str = None, panel_ids: list = None,
                    panel_id: str = None, clip_id: str = None,
                    beat_slot: str = None, **kwargs):
    db = get_db()
    now = datetime.now(timezone.utc)

    print(f'[DEBUG] generate_images called: task_id={task_id}, clip_id={clip_id}, beat_slot={beat_slot}')

    try:
        set_task_state(task_id, status='running', progress=5, message='准备图像生成...')

        project = db.projects.find_one({'projectId': project_id})
        art_style = project.get('artStyle', 'cinematic') if project else 'cinematic'
        video_ratio = project.get('videoRatio', '16:9') if project else '16:9'
        width, height = get_resolution(video_ratio)

        ai_settings = get_ai_settings_for_project(db, project_id)
        img_cfg = ai_settings['image']
        provider_name = (img_cfg.get('provider') or '').strip().lower()
        model_id = (
            (img_cfg.get('model') or '').strip()
            or (config.IMAGE_MODEL or '').strip()
            or 'gpt-image-1'
        )
        provider_for_beat = {**img_cfg, 'model': model_id}

        work: list[dict] = []

        if clip_id and beat_slot:
            job = _build_targeted_beat_job(db, clip_id, beat_slot)
            if job:
                work.append(job)
        elif panel_id:
            p = db.panels.find_one({'panelId': panel_id, 'isActive': {'$ne': False}})
            if p:
                work.append({'kind': 'panel', 'panel': p})
        elif panel_ids:
            for row in db.panels.find({'panelId': {'$in': panel_ids}, 'isActive': {'$ne': False}}):
                work.append({'kind': 'panel', 'panel': row})
        elif episode_id:
            for row in db.panels.find({'episodeId': episode_id, 'imageUrl': None, 'isActive': {'$ne': False}}):
                work.append({'kind': 'panel', 'panel': row})
            for job in _collect_beat_jobs(db, episode_id):
                work.append(job)
        else:
            raise ValueError('No panels specified')

        if not work:
            raise ValueError('No images to generate')

        success = 0
        item_errors: list[str] = []
        redis_cli = get_redis()
        ran_beat_v2 = False

        for i, item in enumerate(work):
            pct = 5 + int((i + 1) / len(work) * 90)
            publish_progress(task_id, pct, f'生成第 {i + 1}/{len(work)} 张图片...', 'generating')

            if item['kind'] == 'panel':
                panel = item['panel']
                db.panels.update_one(
                    {'panelId': panel['panelId']},
                    {'$set': {'status': 'generating_image', 'updatedAt': now}},
                )
                try:
                    clip_row = db.clips.find_one({'clipId': panel.get('clipId')})
                    ref_urls = collect_reference_urls(project, clip_row)
                    desc_suffix = reference_descriptions_for_prompt(project, clip_row)
                    positive, negative = build_image_prompt(
                        panel, art_style, video_ratio,
                        prompt_suffix=desc_suffix,
                    )
                    if provider_name in ('fal', 'openai'):
                        mx = int(provider_for_beat.get('maxReferenceImages') or 1)
                        image_url = generate_image_with_provider(
                            provider_cfg=provider_for_beat,
                            positive=positive,
                            negative=negative,
                            width=width,
                            height=height,
                            reference_urls=ref_urls[:max(1, mx)],
                        )
                    else:
                        image_url = _placeholder_image(panel.get('description', ''), width, height)
                    if not image_url:
                        raise RuntimeError('图片接口未返回可用图片 URL')

                    db.panels.update_one(
                        {'panelId': panel['panelId']},
                        {'$set': {
                            'imageUrl': image_url,
                            'imagePromptUsed': positive,
                            'status': 'image_ready',
                            'updatedAt': now,
                        }},
                    )
                    success += 1
                except Exception as panel_err:
                    item_errors.append(f'panel:{panel["panelId"]}: {panel_err}')
                    db.panels.update_one(
                        {'panelId': panel['panelId']},
                        {'$set': {'status': 'image_failed', 'imageError': str(panel_err), 'updatedAt': now}},
                    )

            elif item['kind'] == 'beat_v2':
                ran_beat_v2 = True
                clip = item['clip']
                slot = item['slot']
                frame = item['frame']
                path_base = f'storyboardPlan.{slot}'
                db.clips.update_one(
                    {'clipId': clip['clipId']},
                    {'$set': {f'{path_base}.status': 'generating_image', 'updatedAt': now}},
                )
                try:
                    # 如果已有 data URL，直接上传到 OSS，无需重新生成
                    force_regenerate = bool(item.get('force_regenerate'))

                    if item.get('has_data_url') and not force_regenerate:
                        existing_data_url = frame.get('imageUrl')
                        if _is_data_url(existing_data_url):
                            print(f'[INFO] Uploading existing data URL for {clip["clipId"]}:{slot}')
                            try:
                                from utils.reference_assets import upload_image_data_url_to_oss
                                oss_result = upload_image_data_url_to_oss(existing_data_url, f'{slot}.jpg', 'clips')
                                image_url = oss_result['url']
                                set_doc = {
                                    f'{path_base}.imageUrl': image_url,
                                    f'{path_base}.status': 'image_ready',
                                    'updatedAt': now,
                                }
                                db.clips.update_one({'clipId': clip['clipId']}, {'$set': set_doc})
                                success += 1
                                if episode_id and slot == 'first_frame':
                                    pipeline_telemetry.maybe_record_first_beat_frame_image(
                                        db,
                                        episode_id,
                                        project_id,
                                        slot=slot,
                                        now=now,
                                    )
                                continue
                            except Exception as upload_err:
                                print(f'[WARN] Failed to upload data URL: {upload_err}, will regenerate')

                    # 如果已有真实URL（且不是定向重新生成），跳过
                    existing_url = frame.get('imageUrl')
                    if existing_url and not _is_data_url(existing_url) and not force_regenerate:
                        print(f'[INFO] Image already exists with real URL, marking as ready: {clip["clipId"]}:{slot}')
                        set_doc = {
                            f'{path_base}.status': 'image_ready',
                            'updatedAt': now,
                        }
                        db.clips.update_one({'clipId': clip['clipId']}, {'$set': set_doc})
                        success += 1
                        if episode_id and slot == 'first_frame':
                            pipeline_telemetry.maybe_record_first_beat_frame_image(
                                db,
                                episode_id,
                                project_id,
                                slot=slot,
                                now=now,
                            )
                        continue

                    desc_suffix = reference_descriptions_for_prompt(project, clip)
                    scene_prompt = (frame.get('scene_prompt') or '').strip()
                    char_urls: dict[str, str] = {}
                    for ch in frame.get('characters') or []:
                        if not isinstance(ch, dict):
                            continue
                        name = (ch.get('name') or '').strip()
                        if not name:
                            continue
                        cid, base = resolve_character_row(project, name)
                        st_url = get_or_create_character_state_image(
                            db=db,
                            redis_cli=redis_cli,
                            project_id=project_id,
                            character_id=cid or name,
                            character_name=name,
                            outfit=str(ch.get('outfit') or ''),
                            emotion=str(ch.get('emotion') or ''),
                            base_image_url=base,
                            provider_cfg=provider_for_beat,
                            width=width,
                            height=height,
                            art_style=art_style,
                        )
                        if st_url:
                            char_urls[name] = st_url

                    ref_stack = collect_frame_reference_urls(
                        project,
                        clip,
                        frame,
                        character_state_urls=char_urls,
                    )
                    print(f'[DEBUG] ref_stack before truncate: {ref_stack}')
                    print(f'[DEBUG] char_urls: {char_urls}')
                    print(f'[DEBUG] frame.characters: {frame.get("characters")}')
                    mx = int(provider_for_beat.get('maxReferenceImages') or 1)
                    ref_stack = ref_stack[:max(1, mx)]
                    print(f'[DEBUG] ref_stack after truncate (max={mx}): {ref_stack}')

                    hint = _character_direction_hint_english(frame)
                    img_base_url = str(
                        provider_for_beat.get('baseUrl')
                        or config.IMAGE_BASE_URL
                        or config.LLM_BASE_URL
                        or ''
                    ).lower()
                    img_model = str(provider_for_beat.get('model') or config.IMAGE_MODEL or '').lower()
                    force_multi_openai = (
                        (provider_name == 'openai')
                        and ('openrouter.ai' in img_base_url or img_model.startswith('openai/') or img_model.startswith('gpt-image'))
                    )
                    sup_multi = bool(provider_for_beat.get('supportsMultiReference')) or force_multi_openai
                    extra = '' if sup_multi and len(ref_stack) > 1 else hint

                    image_url = multi_ref_image_gen(
                        provider_cfg=provider_for_beat,
                        scene_prompt=scene_prompt or (frame.get('description') or 'cinematic shot'),
                        reference_urls=ref_stack,
                        width=width,
                        height=height,
                        art_style=art_style,
                        prompt_suffix=desc_suffix,
                        single_ref_extra_hint=extra,
                    )
                    if not image_url:
                        raise RuntimeError('图片接口未返回可用图片 URL')
                    used = scene_prompt
                    if desc_suffix:
                        used = f'{used} || {desc_suffix}'

                    set_doc = {
                        f'{path_base}.imageUrl': image_url,
                        f'{path_base}.imagePromptUsed': used,
                        f'{path_base}.referenceImageUrlsUsed': ref_stack,
                        f'{path_base}.status': 'image_ready',
                        f'{path_base}.characterImageUrls': char_urls,
                        f'{path_base}.imageError': None,
                        'updatedAt': now,
                    }
                    db.clips.update_one({'clipId': clip['clipId']}, {'$set': set_doc})
                    success += 1
                    if episode_id and slot == 'first_frame':
                        pipeline_telemetry.maybe_record_first_beat_frame_image(
                            db,
                            episode_id,
                            project_id,
                            slot=slot,
                            now=now,
                        )
                except Exception as panel_err:
                    item_errors.append(f'beat:{clip["clipId"]}:{slot}: {panel_err}')
                    db.clips.update_one(
                        {'clipId': clip['clipId']},
                        {'$set': {
                            f'{path_base}.status': 'image_failed',
                            f'{path_base}.imageError': str(panel_err),
                            'updatedAt': now,
                        }},
                    )

            else:
                raise RuntimeError(f'Unknown image job kind: {item.get("kind")}')

        if episode_id and ran_beat_v2:
            try:
                from skills.generate_transitions import run_transition_batch_for_episode

                run_transition_batch_for_episode(db, episode_id, ai_settings=ai_settings)
            except Exception:
                pass

        if episode_id:
            db.episodes.update_one(
                {'episodeId': episode_id},
                {'$set': {'status': 'images_ready', 'updatedAt': now}},
            )

        failed_count = len(work) - success
        if success == 0:
            if len(item_errors) == 1:
                raise RuntimeError(item_errors[0])
            if item_errors:
                raise RuntimeError(
                    '图片生成全部失败: ' + ' | '.join(item_errors[:3])
                )
            raise RuntimeError('图片生成全部失败，未拿到任何可用结果')

        result_data = {'successCount': success, 'failedCount': failed_count, 'total': len(work)}
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc

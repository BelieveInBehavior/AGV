"""
Celery Task: 图像生成

冷热分离:
  热 (Redis): 进度广播
  冷 (MongoDB): panels → imageUrl；clips.storyboardPlan → 首尾帧 imageUrl
"""

from datetime import datetime, timezone

from celery_app import app
from skills.build_image_prompt import build_image_prompt, get_resolution
from skills.multi_ref_image_gen import multi_ref_image_gen
from utils.ai_settings import get_ai_settings_for_project
from utils.character_state import get_or_create_character_state_image, resolve_character_row
from utils.db import get_db
from utils.redis_client import get_redis, publish_progress, publish_complete, publish_error, set_task_state
from utils import pipeline_telemetry
from utils.reference_assets import collect_reference_urls, reference_descriptions_for_prompt, location_reference_url
import config


def _generate_image_fal(
    positive: str,
    negative: str,
    width: int,
    height: int,
    *,
    model_id: str,
    fal_key: str,
    reference_urls: list[str] | None = None,
) -> str | None:
    """调用 FAL AI 生成图片；若有参考图则走 image-to-image（首张为结构锚点）。"""
    import os

    import fal_client

    prev = os.environ.get('FAL_KEY')
    os.environ['FAL_KEY'] = fal_key
    try:
        ref = [u for u in (reference_urls or []) if isinstance(u, str) and u.strip()]
        i2i_model = (config.FAL_IMAGE_I2I_MODEL or '').strip() or 'fal-ai/flux/dev/image-to-image'

        if ref:
            prompt = (
                f'{positive}, maintain subjects, wardrobe, and environment '
                f'consistent with the reference image'
            )
            arguments: dict = {
                'prompt': prompt,
                'image_url': ref[0],
                'strength': 0.62,
                'image_size': {'width': width, 'height': height},
                'num_inference_steps': 28,
                'guidance_scale': 3.5,
            }
            try:
                result = fal_client.subscribe(i2i_model, arguments=arguments)
            except Exception:
                result = fal_client.subscribe(
                    model_id,
                    arguments={
                        'prompt': positive,
                        'negative_prompt': negative,
                        'image_size': {'width': width, 'height': height},
                        'num_inference_steps': 4,
                        'num_images': 1,
                    },
                )
        else:
            result = fal_client.subscribe(
                model_id,
                arguments={
                    'prompt': positive,
                    'negative_prompt': negative,
                    'image_size': {'width': width, 'height': height},
                    'num_inference_steps': 4,
                    'num_images': 1,
                },
            )
    finally:
        if prev is None:
            os.environ.pop('FAL_KEY', None)
        else:
            os.environ['FAL_KEY'] = prev

    images = result.get('images', [])
    return images[0]['url'] if images else None


def _placeholder_image(description: str, width: int, height: int) -> str:
    """无 FAL key 时返回占位图"""
    import urllib.parse
    text = urllib.parse.quote(description[:30] or 'Panel')
    return f'https://placehold.co/{width}x{height}/1a1f35/ffffff?text={text}'


def _is_beat_plan(plan: dict) -> bool:
    return isinstance(plan.get('first_frame'), dict)


def _collect_beat_jobs(db, episode_id: str) -> list[dict]:
    """未带 imageUrl 的扁平首尾帧任务。"""
    jobs: list[dict] = []
    clips = list(db.clips.find({'episodeId': episode_id}).sort('clipIndex', 1))
    for clip in clips:
        plan = clip.get('storyboardPlan')
        if not plan:
            continue
        if not _is_beat_plan(plan):
            continue
        for slot in ('first_frame', 'last_frame'):
            fr = plan.get(slot) or {}
            if not isinstance(fr, dict) or fr.get('imageUrl'):
                continue
            jobs.append({
                'kind': 'beat_v2',
                'clipId': clip['clipId'],
                'slot': slot,
                'frame': fr,
                'clip': clip,
            })
    return jobs


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
                    panel_id: str = None, **kwargs):
    db = get_db()
    now = datetime.now(timezone.utc)

    try:
        set_task_state(task_id, status='running', progress=5, message='准备图像生成...')

        project = db.projects.find_one({'projectId': project_id})
        art_style = project.get('artStyle', 'cinematic') if project else 'cinematic'
        video_ratio = project.get('videoRatio', '16:9') if project else '16:9'
        width, height = get_resolution(video_ratio)

        ai_settings = get_ai_settings_for_project(db, project_id)
        img_cfg = ai_settings['image']
        fal_key = (img_cfg.get('apiKey') or config.FAL_API_KEY or '').strip()
        model_id = (
            (project.get('imageModel') or '').strip()
            or (img_cfg.get('model') or '').strip()
            or config.FAL_IMAGE_MODEL
        )
        use_fal = img_cfg.get('provider') == 'fal' and bool(fal_key)
        provider_for_beat = {**img_cfg, 'model': model_id}

        work: list[dict] = []

        if panel_id:
            p = db.panels.find_one({'panelId': panel_id})
            if p:
                work.append({'kind': 'panel', 'panel': p})
        elif panel_ids:
            for row in db.panels.find({'panelId': {'$in': panel_ids}}):
                work.append({'kind': 'panel', 'panel': row})
        elif episode_id:
            for row in db.panels.find({'episodeId': episode_id, 'imageUrl': None}):
                work.append({'kind': 'panel', 'panel': row})
            for job in _collect_beat_jobs(db, episode_id):
                work.append(job)
        else:
            raise ValueError('No panels specified')

        if not work:
            raise ValueError('No images to generate')

        success = 0
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
                    if use_fal:
                        image_url = _generate_image_fal(
                            positive, negative, width, height,
                            model_id=model_id,
                            fal_key=fal_key,
                            reference_urls=ref_urls,
                        )
                    else:
                        image_url = _placeholder_image(panel.get('description', ''), width, height)

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

                    loc_u = location_reference_url(project, clip)
                    ref_stack: list[str] = []
                    if loc_u:
                        ref_stack.append(loc_u)
                    for ch in frame.get('characters') or []:
                        if not isinstance(ch, dict):
                            continue
                        nm = (ch.get('name') or '').strip()
                        u = char_urls.get(nm)
                        if u:
                            ref_stack.append(u)

                    mx = int(provider_for_beat.get('maxReferenceImages') or 1)
                    ref_stack = ref_stack[:max(1, mx)]

                    hint = _character_direction_hint_english(frame)
                    sup_multi = bool(provider_for_beat.get('supportsMultiReference'))
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
                    used = scene_prompt
                    if desc_suffix:
                        used = f'{used} || {desc_suffix}'

                    set_doc = {
                        f'{path_base}.imageUrl': image_url,
                        f'{path_base}.imagePromptUsed': used,
                        f'{path_base}.status': 'image_ready',
                        f'{path_base}.characterImageUrls': char_urls,
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

        result_data = {'successCount': success, 'total': len(work)}
        publish_complete(task_id, result_data)
        return result_data

    except Exception as exc:
        err_msg = str(exc)
        if self.request.retries < self.max_retries:
            set_task_state(task_id, status='retrying', message=f'任务重试中: {err_msg}')
            raise self.retry(exc=exc)

        publish_error(task_id, err_msg)
        raise exc

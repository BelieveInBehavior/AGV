from pathlib import Path

from tasks.video_task import (
    _build_ark_text,
    _build_clip_content,
    _persist_video_to_oss,
    _propagate_continuity_frame,
    _resume_provider_task_id,
)


def test_build_ark_text_prepends_mapping():
    text = _build_ark_text('这里是视频 Prompt', ['图片1为首帧参考', '图片2为角色小李参考'])
    assert text.startswith('素材参考：图片1为首帧参考；图片2为角色小李参考。')
    assert text.endswith('这里是视频 Prompt')


def test_build_clip_content_orders_assets_and_labels():
    project = {
        'locations': [{'name': '办公室', 'referenceImageUrl': 'https://example.com/location.jpg'}],
        'characters': [
            {'name': '小李', 'referenceImageUrl': 'https://example.com/li.jpg'},
            {'name': '小王', 'referenceImageUrl': 'https://example.com/wang.jpg'},
        ],
    }
    clip = {
        'location': '办公室',
        'characters': ['小李', '小王'],
        'videoReferenceAssets': {
            'videoUrls': ['https://example.com/ref-video.mp4'],
            'audioUrls': ['https://example.com/ref-audio.mp3'],
        },
    }
    previous_clip = {
        'storyboardPlan': {
            'last_frame': {'imageUrl': 'https://example.com/prev-tail.jpg'},
        },
    }
    plan = {
        'video_prompt': '镜头从桌面推到人物脸部。',
        'first_frame': {'imageUrl': 'https://example.com/first.jpg'},
    }

    content, prompt, errors = _build_clip_content(project, clip, plan, previous_clip=previous_clip)

    assert errors == []
    assert [item['type'] for item in content] == ['image_url', 'image_url', 'image_url', 'image_url', 'image_url', 'video_url', 'audio_url']
    assert '图片1为首帧参考' in prompt
    assert '图片2为上一情节尾帧连续性参考' in prompt
    assert '图片3为场景参考' in prompt
    assert '图片4为角色小李参考' in prompt
    assert '图片5为角色小王参考' in prompt
    assert '视频1为运镜/视角参考' in prompt
    assert '音频1为背景音乐参考' in prompt


def test_build_clip_content_prefers_continuity_image_over_previous_last_frame():
    project = {'locations': [], 'characters': []}
    clip = {
        'clipId': 'clip_2',
        'location': '',
        'characters': [],
        'videoReferenceAssets': {},
    }
    previous_clip = {
        'storyboardPlan': {
            'last_frame': {'imageUrl': 'https://example.com/prev-tail.jpg'},
        },
    }
    plan = {
        'video_prompt': '镜头衔接到下一段。',
        'first_frame': {
            'imageUrl': 'https://example.com/current-first.jpg',
            'continuityImageUrl': 'https://example.com/continuity.jpg',
        },
    }

    content, prompt, errors = _build_clip_content(project, clip, plan, previous_clip=previous_clip)

    assert errors == []
    assert content[0]['image_url']['url'] == 'https://example.com/current-first.jpg'
    assert content[1]['image_url']['url'] == 'https://example.com/continuity.jpg'
    assert '图片2为上一情节尾帧连续性参考' in prompt


def test_build_clip_content_requires_first_frame_and_character_refs():
    project = {
        'locations': [],
        'characters': [{'name': '小李', 'referenceImageUrl': ''}],
    }
    clip = {
        'location': '办公室',
        'characters': ['小李'],
        'videoReferenceAssets': {},
    }
    plan = {
        'video_prompt': '镜头推进。',
        'first_frame': {'imageUrl': ''},
    }

    content, prompt, errors = _build_clip_content(project, clip, plan)

    assert content == []
    assert prompt == '镜头推进。'
    assert '缺首帧图片' in errors
    assert '角色 小李 缺参考图' in errors


def test_build_clip_content_uploads_data_url_first_frame(monkeypatch):
    uploaded_urls = []

    def fake_resolver(value, file_name, sub_dir):
        if isinstance(value, str) and value.startswith('data:image/'):
            uploaded_urls.append((file_name, sub_dir))
            return 'https://example.com/uploaded-first-frame.jpg'
        return value if isinstance(value, str) and value.startswith('http') else ''

    project = {'locations': [], 'characters': []}
    clip = {'clipId': 'clip_1', 'location': '', 'characters': [], 'videoReferenceAssets': {}}
    plan = {
        'video_prompt': '镜头推进。',
        'first_frame': {'imageUrl': 'data:image/jpeg;base64,abc'},
    }

    content, prompt, errors = _build_clip_content(project, clip, plan, resolve_image_url=fake_resolver)

    assert errors == []
    assert content[0]['image_url']['url'] == 'https://example.com/uploaded-first-frame.jpg'
    assert '图片1为首帧参考' in prompt
    assert uploaded_urls == [('clip_1_first_frame.jpg', 'clips')]


def test_resume_provider_task_id_only_for_inflight_status():
    assert _resume_provider_task_id({
        'videoGeneration': {'status': 'running', 'providerTaskId': 'task_123'},
    }) == 'task_123'
    assert _resume_provider_task_id({
        'videoGeneration': {'status': 'completed', 'providerTaskId': 'task_123'},
    }) == ''


def test_persist_video_to_oss_downloads_and_uploads(monkeypatch, tmp_path):
    downloaded = tmp_path / 'ark-video.mp4'
    downloaded.write_bytes(b'fake-video')
    captured = {}

    def fake_download(url, suffix):
        captured['download'] = (url, suffix)
        return str(downloaded), 'video/mp4'

    def fake_upload(file_path, file_name, sub_dir, content_type):
        captured['upload'] = (file_path, file_name, sub_dir, content_type)
        assert Path(file_path).read_bytes() == b'fake-video'
        return {
            'url': 'https://example.com/oss-video.mp4',
            'objectKey': 'AGV/videos/proj_1/ep_1/123_clip_1.mp4',
        }

    monkeypatch.setattr('tasks.video_task._download_to_temp_file', fake_download)
    monkeypatch.setattr('tasks.video_task.upload_file_to_oss', fake_upload)

    result = _persist_video_to_oss(
        {'clipId': 'clip_1', 'projectId': 'proj_1', 'episodeId': 'ep_1'},
        'https://example.com/source.mp4?token=abc',
    )

    assert result == {
        'url': 'https://example.com/oss-video.mp4',
        'objectKey': 'AGV/videos/proj_1/ep_1/123_clip_1.mp4',
    }
    assert captured['download'] == ('https://example.com/source.mp4?token=abc', '.mp4')
    assert captured['upload'] == (
        str(downloaded),
        'clip_1.mp4',
        'videos/proj_1/ep_1',
        'video/mp4',
    )
    assert not downloaded.exists()


def test_propagate_continuity_frame_overwrites_next_first_frame(monkeypatch):
    class FakeClips:
        def __init__(self):
            self.updated = None

        def find_one(self, query):
            assert query['clipIndex'] == 2
            return {'clipId': 'clip_2'}

        def update_one(self, query, update):
            self.updated = (query, update)

    class FakeDb:
        def __init__(self):
            self.clips = FakeClips()

    monkeypatch.setattr('tasks.video_task._extract_last_frame_data_url', lambda _url: 'data:image/jpeg;base64,abc')
    monkeypatch.setattr(
        'tasks.video_task.upload_image_data_url_to_oss',
        lambda *args, **kwargs: {'url': 'https://example.com/continuity.jpg'},
    )

    db = FakeDb()
    result = _propagate_continuity_frame(
        db,
        {'clipId': 'clip_1', 'episodeId': 'ep_1', 'clipIndex': 1},
        'https://example.com/video.mp4',
        'now',
    )

    assert result == {
        'targetClipId': 'clip_2',
        'sourceClipId': 'clip_1',
        'continuityImageUrl': 'https://example.com/continuity.jpg',
    }
    assert db.clips.updated == (
        {'clipId': 'clip_2'},
        {'$set': {
            'storyboardPlan.first_frame.imageUrl': 'https://example.com/continuity.jpg',
            'storyboardPlan.first_frame.continuityImageUrl': 'https://example.com/continuity.jpg',
            'storyboardPlan.first_frame.continuitySourceClipId': 'clip_1',
            'updatedAt': 'now',
        }},
    )

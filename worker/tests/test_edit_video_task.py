from tasks.edit_video_task import _normalize_subtitle_cues, _normalize_subtitle_style_preset


def test_normalize_subtitle_style_preset_accepts_new_bubbles():
    assert _normalize_subtitle_style_preset('bubble-cloud') == 'bubble-cloud'
    assert _normalize_subtitle_style_preset('bubble-thought') == 'bubble-thought'
    assert _normalize_subtitle_style_preset('bubble-note') == 'bubble-note'
    assert _normalize_subtitle_style_preset('bubble-shout') == 'bubble-shout'
    assert _normalize_subtitle_style_preset('bubble-whisper') == 'bubble-whisper'


def test_normalize_subtitle_cues_preserves_supported_style_preset():
    cues = _normalize_subtitle_cues([
        {
            'start': 0.5,
            'end': 2.5,
            'text': '测试字幕',
            'vertical': 'bottom',
            'align': 'center',
            'x': 50,
            'y': 88,
            'animation': 'fade',
            'stylePreset': 'bubble-shout',
        },
    ], 6.0)

    assert len(cues) == 1
    assert cues[0]['stylePreset'] == 'bubble-shout'


def test_normalize_subtitle_cues_falls_back_for_unknown_style_preset():
    cues = _normalize_subtitle_cues([
        {
            'start': 0,
            'end': 1.5,
            'text': '测试字幕',
            'stylePreset': 'bubble-does-not-exist',
        },
    ], 5.0)

    assert len(cues) == 1
    assert cues[0]['stylePreset'] == 'caption-solid'

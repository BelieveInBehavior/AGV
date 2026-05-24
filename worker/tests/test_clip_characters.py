from utils.clip_characters import backfill_clip_characters, character_enters_in_clip


def test_backfill_same_bed_before_wake():
    clips = [
        {
            'clipIndex': 0,
            'summary': '智能系统为 User 苏醒做准备',
            'content': '卧室光线由暗转亮',
            'location': '卧室_清晨',
            'characters': ['User'],
        },
        {
            'clipIndex': 1,
            'summary': '厉川醒来后环住 User 并亲吻',
            'content': '厉川醒来后，轻环着 User 的腰肢，静静端详她的睡颜',
            'location': '卧室_清晨',
            'characters': ['User', '厉川'],
        },
    ]
    out = backfill_clip_characters(clips)
    assert out[0]['characters'] == ['User', '厉川']


def test_no_backfill_when_character_enters():
    clips = [
        {
            'clipIndex': 0,
            'summary': '空镜',
            'content': '走廊寂静',
            'location': '走廊',
            'characters': [],
        },
        {
            'clipIndex': 1,
            'summary': '厉川走进卧室',
            'content': '厉川推门进入卧室，看见 User',
            'location': '卧室_清晨',
            'characters': ['User', '厉川'],
        },
    ]
    out = backfill_clip_characters(clips)
    assert out[0]['characters'] == []

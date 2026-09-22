# -*- coding: utf-8 -*-
"""
寸进链 · 讲解视频 · 配音 + 时间轴

读 scenes.json，为每个场景用 edge-tts 生成中文配音 mp3，
同时把 WordBoundary 事件翻译成「每句字幕的起止时间」，
写回 scenes.json 的 .time 字段（供 compose.py 排字幕）。

    .venv/Scripts/python.exe tools/video/tts.py
"""
import asyncio
import json
import os
import re
import subprocess
import sys

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.join(HERE, 'scenes.json')
AUDIO = os.path.join(HERE, 'audio')

VOICE = os.environ.get('CJ_VOICE', 'zh-CN-YunyangNeural')
RATE = os.environ.get('CJ_RATE', '-4%')


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(path):
    """用 ffmpeg 把音频解成 wav 再数帧，拿到的时长最可靠。"""
    ff = ffmpeg_exe()
    out = path + '.probe.wav'
    subprocess.run([ff, '-y', '-loglevel', 'error', '-i', path, '-ar', '24000', '-ac', '1', out],
                   check=True, capture_output=True)
    import wave
    with wave.open(out, 'rb') as w:
        dur = w.getnframes() / float(w.getframerate())
    os.remove(out)
    return dur


async def synth(text, out_path):
    """合成一段配音，返回 [(字符结束位置, 该位置对应的秒), ...]"""
    comm = edge_tts.Communicate(text, VOICE, rate=RATE)
    marks = []
    with open(out_path, 'wb') as f:
        async for chunk in comm.stream():
            if chunk['type'] == 'audio':
                f.write(chunk['data'])
            elif chunk['type'] == 'WordBoundary':
                marks.append((chunk['offset'] / 1e7, chunk['duration'] / 1e7, chunk['text']))

    # 把 WordBoundary 累计成「读到第 N 个字符时，时间到了第几秒」
    timeline = []
    pos = 0
    for off, dur, txt in marks:
        pos += len(txt)
        timeline.append((pos, off + dur))
    return timeline


def sentence_times(sentences, timeline, total):
    """把句子边界对齐到 timeline 上，得到每句的 (start, end)"""
    full_len = sum(len(s) for s in sentences)
    ends, acc = [], 0
    for s in sentences:
        acc += len(s)
        ends.append(acc)

    out = []
    cursor_char = 0
    cursor_t = 0.0
    for i, (s, e) in enumerate(zip(sentences, ends)):
        # 找到第一个「读到的字符数 >= e」的时间点
        t_end = total
        for cpos, t in timeline:
            if cpos >= e:
                t_end = t
                break
        out.append({'text': s, 'start': round(cursor_t, 2), 'end': round(t_end, 2)})
        cursor_char = e
        cursor_t = t_end
    return out


async def main():
    with open(SCENES, 'r', encoding='utf-8') as f:
        scenes = json.load(f)
    os.makedirs(AUDIO, exist_ok=True)

    print(f'语音 {VOICE} · 语速 {RATE}')
    for sc in scenes:
        text = ''.join(sc['narr'])
        mp3 = os.path.join(AUDIO, sc['id'] + '.mp3')
        timeline = await synth(text, mp3)
        dur = probe_duration(mp3)
        sc['audio'] = os.path.basename(mp3)
        sc['audio_dur'] = round(dur, 3)
        sc['time'] = sentence_times(sc['narr'], timeline, dur)
        print(f"  {sc['id']}  {dur:6.2f}s  {len(sc['time'])} 句  {sc['title']}")

    with open(SCENES, 'w', encoding='utf-8') as f:
        json.dump(scenes, f, ensure_ascii=False, indent=2)

    total = sum(s['audio_dur'] for s in scenes)
    print(f'\n合计 {total:.1f} 秒（{total / 60:.1f} 分钟），写回 scenes.json')


if __name__ == '__main__':
    asyncio.run(main())

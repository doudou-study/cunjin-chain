# -*- coding: utf-8 -*-
"""
寸进链 · 讲解视频 · 合成

流程：
  1. 按 scenes.json 的时间轴，把「截图 + 字幕 + 章节角标」用 Pillow 排成一张张 1920×1080 的图
  2. ffmpeg 把这些图 concat 成无声视频
  3. ffmpeg 把各场景配音（中间插 0.6s 留白）concat 成音轨
  4. 合并成最终 mp4

    .venv/Scripts/python.exe tools/video/compose.py
"""
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SCENES = os.path.join(HERE, 'scenes.json')
FRAMES = os.path.join(HERE, 'frames')
AUDIO = os.path.join(HERE, 'audio')
SEGS = os.path.join(HERE, 'segs')
OUT = os.path.join(HERE, '..', '..', 'docs', '寸进链-运行讲解')

W, H = 1920, 1080
FPS = 30
GAP = 0.65          # 场景之间留白（秒）
TITLE_SEC = 3.2     # 片头
TAIL_SEC = 2.4      # 片尾

INK = (15, 23, 42)
INK_SOFT = (71, 85, 105)
INDIGO = (91, 108, 255)
PAPER = (246, 247, 251)


def ffmpeg():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def font(size, bold=False):
    for p in (r'C:\Windows\Fonts\msyhbd.ttc' if bold else r'C:\Windows\Fonts\msyh.ttc',
              r'C:\Windows\Fonts\msyh.ttc'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


F_SUB = font(41)
F_SUBB = font(41, True)
F_CH = font(25, True)
F_CH2 = font(25)
F_BRAND = font(23, True)
F_T1 = font(96, True)
F_T2 = font(40)
F_T3 = font(28)


def wrap(draw, text, f, maxw):
    lines, cur = [], ''
    for ch in text:
        if cur and draw.textlength(cur + ch, font=f) > maxw:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def base_layer(shot_path):
    img = Image.open(shot_path).convert('RGB')
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    return img


def draw_chrome(img, scene_no, scene_title, progress):
    """章节角标 + 品牌水印 + 底部进度条"""
    d = ImageDraw.Draw(img, 'RGBA')

    # 左上：章节胶囊
    label = f'{scene_no:02d}'
    tw = d.textlength(label, font=F_CH)
    pw, ph = 46, 40
    x0, y0 = 42, 36
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=12, fill=(15, 23, 42, 225))
    d.text((x0 + (pw - tw) / 2, y0 + 7), label, font=F_CH, fill=(255, 255, 255))

    tx = x0 + pw + 12
    tw2 = d.textlength(scene_title, font=F_CH2)
    d.rounded_rectangle([tx, y0, tx + tw2 + 40, y0 + ph], radius=12, fill=(255, 255, 255, 232))
    d.text((tx + 20, y0 + 7), scene_title, font=F_CH2, fill=INK)

    # 右上：品牌
    brand = '寸进链 · cunjin-chain'
    bw = d.textlength(brand, font=F_BRAND)
    d.rounded_rectangle([W - 42 - bw - 36, y0, W - 42, y0 + ph], radius=12, fill=(91, 108, 255, 232))
    d.text((W - 42 - bw - 18, y0 + 8), brand, font=F_BRAND, fill=(255, 255, 255))

    # 底部进度条
    d.rectangle([0, H - 6, W, H], fill=(226, 232, 240, 190))
    d.rectangle([0, H - 6, int(W * max(0.0, min(1.0, progress))), H], fill=INDIGO + (255,))


def draw_caption(img, text):
    if not text:
        return
    d = ImageDraw.Draw(img, 'RGBA')
    maxw = 1520
    lines = wrap(d, text, F_SUB, maxw)
    lh = 56
    padx, pady = 44, 26
    wmax = max(d.textlength(l, font=F_SUB) for l in lines)
    bw = int(wmax + padx * 2)
    bh = int(len(lines) * lh + pady * 2)
    x0 = (W - bw) // 2
    y1 = H - 78
    y0 = y1 - bh

    d.rounded_rectangle([x0 + 3, y0 + 5, x0 + bw + 3, y1 + 5], radius=20, fill=(15, 23, 42, 60))
    d.rounded_rectangle([x0, y0, x0 + bw, y1], radius=20, fill=(15, 23, 42, 214))
    ty = y0 + pady - 4
    for l in lines:
        lw = d.textlength(l, font=F_SUB)
        d.text(((W - lw) / 2, ty), l, font=F_SUB, fill=(248, 250, 252))
        ty += lh


def title_card(sub):
    img = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(img, 'RGBA')
    # 顶部一条靛蓝渐变带
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(246 - 12 * t), int(247 - 10 * t), int(251 - 6 * t)))
    d.rounded_rectangle([96, 300, 116, 760], radius=10, fill=INDIGO)
    d.text((170, 322), '寸进链', font=F_T1, fill=INK)
    d.text((178, 462), '每日打卡积分与链上成就存证平台', font=F_T2, fill=INK_SOFT)
    d.text((180, 524), sub, font=F_T3, fill=(148, 163, 184))
    tag = 'Node.js · Express · MySQL · 自研区块链内核'
    tw = d.textlength(tag, font=F_T3)
    d.rounded_rectangle([180, 596, 180 + tw + 56, 596 + 62], radius=14, fill=(91, 108, 255, 30))
    d.text((208, 610), tag, font=F_T3, fill=INDIGO)
    return img


def end_card():
    img = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(img, 'RGBA')
    d.text((W / 2 - 168, H / 2 - 90), '完', font=font(110, True), fill=INK)
    tips = '代码 · 数据库脚本 · 毕业论文 · 产品开发文档   均在项目目录内'
    tw = d.textlength(tips, font=F_T2)
    d.text(((W - tw) / 2, H / 2 + 60), tips, font=F_T2, fill=INK_SOFT)
    run = 'npm start   →   http://localhost:8901'
    rw = d.textlength(run, font=F_T3)
    d.rounded_rectangle([(W - rw) / 2 - 30, H / 2 + 140, (W + rw) / 2 + 30, H / 2 + 202],
                        radius=14, fill=(91, 108, 255, 30))
    d.text(((W - rw) / 2, H / 2 + 154), run, font=F_T3, fill=INDIGO)
    return img


def build_segments(scenes):
    """把每个场景切成 图+字幕 的小片段"""
    os.makedirs(SEGS, exist_ok=True)
    for f in os.listdir(SEGS):
        os.remove(os.path.join(SEGS, f))

    total = sum(s['audio_dur'] + GAP for s in scenes)
    segs = []            # [(png路径, 时长秒)]
    done = 0.0
    idx = 0

    # 片头
    p = os.path.join(SEGS, 'seg_%04d.png' % idx)
    title_card('运行讲解 · 从打卡到上链的全过程').save(p)
    segs.append((p, TITLE_SEC))
    idx += 1

    for si, sc in enumerate(scenes):
        shots = [os.path.join(FRAMES, s) for s in sc['shots'] if os.path.exists(os.path.join(FRAMES, s))]
        if not shots:
            continue
        dur = sc['audio_dur'] + GAP
        n = len(shots)

        # 切点：截图平分点 ∪ 字幕起止点
        cuts = {0.0, dur}
        for i in range(1, n):
            cuts.add(round(dur * i / n, 3))
        for t in sc['time']:
            cuts.add(max(0.0, min(dur, float(t['start']))))
            cuts.add(max(0.0, min(dur, float(t['end']))))
        cuts = sorted(cuts)

        for k in range(len(cuts) - 1):
            a, b = cuts[k], cuts[k + 1]
            if b - a < 0.05:
                continue
            mid = (a + b) / 2
            shot_i = min(n - 1, int(mid / dur * n))
            cap = ''
            for t in sc['time']:
                if float(t['start']) <= mid < float(t['end']):
                    cap = t['text']
                    break
            if not cap and mid >= sc['audio_dur']:
                # 尾部留白阶段，保持最后一句字幕
                cap = sc['time'][-1]['text'] if sc['time'] else ''

            img = base_layer(shots[shot_i])
            draw_chrome(img, si + 1, sc['title'], (done + a) / (total + TITLE_SEC + TAIL_SEC))
            draw_caption(img, cap)
            p = os.path.join(SEGS, 'seg_%04d.png' % idx)
            img.save(p, optimize=True)
            segs.append((p, round(b - a, 3)))
            idx += 1
        done += dur
        print(f"  {sc['id']}  {dur:6.2f}s  {n} 图  → 累计 {len(segs)} 个片段")

    # 片尾
    img = end_card()
    draw_chrome(img, len(scenes), '技术栈与收尾', 1.0)
    p = os.path.join(SEGS, 'seg_%04d.png' % idx)
    img.save(p)
    segs.append((p, TAIL_SEC))

    return segs


def build_audio(scenes):
    """配音拼接，场景之间插留白"""
    ff = ffmpeg()
    gap = os.path.join(AUDIO, '_gap.mp3')
    if not os.path.exists(gap):
        subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'lavfi',
                        '-i', 'anullsrc=r=24000:cl=mono', '-t', str(GAP), gap], check=True)

    parts = []
    for si, sc in enumerate(scenes):
        parts.append(os.path.join(AUDIO, sc['audio']))
        if si != len(scenes) - 1:
            parts.append(gap)

    head = os.path.join(AUDIO, '_head.mp3')
    tail = os.path.join(AUDIO, '_tail.mp3')
    for path, sec in ((head, TITLE_SEC), (tail, TAIL_SEC)):
        if not os.path.exists(path):
            subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'lavfi',
                            '-i', 'anullsrc=r=24000:cl=mono', '-t', str(sec), path], check=True)

    lst = os.path.join(AUDIO, 'list.txt')
    with open(lst, 'w', encoding='utf-8') as f:
        for p in [head] + parts + [tail]:
            f.write("file '%s'\n" % p.replace('\\', '/'))

    out = os.path.join(AUDIO, 'audio.m4a')
    subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
                    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', out], check=True)
    return out


def main():
    with open(SCENES, 'r', encoding='utf-8') as f:
        scenes = json.load(f)
    missing = [s['id'] for s in scenes if not s.get('audio_dur')]
    if missing:
        print('这些场景还没配音，先跑 tts.py：' + ', '.join(missing))
        sys.exit(1)

    print('① 排版切片')
    segs = build_segments(scenes)

    print('② 合成视频流')
    lst = os.path.join(SEGS, 'list.txt')
    with open(lst, 'w', encoding='utf-8') as f:
        for p, d in segs:
            f.write("file '%s'\nduration %.3f\n" % (p.replace('\\', '/'), d))
        f.write("file '%s'\n" % segs[-1][0].replace('\\', '/'))   # concat 要求末行重复

    ff = ffmpeg()
    video = os.path.join(SEGS, 'video.mp4')
    subprocess.run([ff, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst,
                    '-vf', f'fps={FPS},format=yuv420p', '-c:v', 'libx264',
                    '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', video], check=True)

    print('③ 合成音轨')
    audio = build_audio(scenes)

    print('④ 合并')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = OUT + '.mp4'
    subprocess.run([ff, '-y', '-loglevel', 'error', '-i', video, '-i', audio,
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest',
                    '-movflags', '+faststart', out], check=True)

    size = os.path.getsize(out) / 1024 / 1024
    dur = sum(s['audio_dur'] for s in scenes) + GAP * (len(scenes) - 1) + TITLE_SEC + TAIL_SEC
    print(f'\n完成：{out}')
    print(f'  时长约 {dur / 60:.1f} 分钟 · {size:.1f} MB · {len(segs)} 个片段')


if __name__ == '__main__':
    main()

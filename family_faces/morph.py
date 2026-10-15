"""Render a smooth "growing up" morph video for one person.

For each face in the timeline: re-crop it from the original photo at 512x640 with the
eyes and mouth in a fixed place, find 106 facial landmarks, even out its lighting
against its neighbours, and soften the background. Consecutive faces are then morphed:
the landmarks glide from one face's shape to the next (piecewise-affine warp over a
Delaunay mesh) while the images cross-fade, instead of two faces ghosting through each
other. Frames are piped to a bundled ffmpeg as H.264 MP4.
"""

import subprocess
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np
from insightface.app.common import Face
from insightface.model_zoo import get_model
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial import Delaunay

from family_faces import library
from family_faces.pipeline.attrs import TEMPLATE

HERE = Path(__file__).resolve().parent
W, H = 512, 640
FPS, HOLD, MORPH = 30, 3, 20          # frames resting on each face, frames morphing to the next
FACE_BOX = np.array([136, 195, 376, 455], dtype=np.float32)   # where every aligned face sits at 512x640
FONT = "/System/Library/Fonts/SFNS.ttf"

_lmk = None


def landmark_model():
    global _lmk
    if _lmk is None:
        _lmk = get_model(str(Path.home() / ".insightface/models/buffalo_l/2d106det.onnx"),
                         providers=["CPUExecutionProvider"])
        _lmk.prepare(ctx_id=0)
    return _lmk


def aligned_hires(photo, kps):
    img = cv2.imread(str(library.abspath(photo)))
    m, _ = cv2.estimateAffinePartial2D(np.array(kps, np.float32), TEMPLATE * 2, method=cv2.LMEDS)
    return cv2.warpAffine(img, m, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def landmarks(img):
    return landmark_model().get(img, Face(bbox=FACE_BOX.copy())).astype(np.float32)


def soften_background(img, pts):
    """Keep the face (plus room for hair) sharp; blur and mute everything else."""
    hull = cv2.convexHull(pts.astype(np.int32))
    (cx, cy), (ew, eh), ang = cv2.fitEllipse(hull)
    mask = np.zeros((H, W), np.float32)
    cv2.ellipse(mask, ((cx, cy - eh * 0.12), (ew * 1.45, eh * 1.6), ang), 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 28)[..., None]
    bg = cv2.GaussianBlur(img, (0, 0), 14).astype(np.float32)
    grey = bg.mean(axis=2, keepdims=True)
    bg = (0.55 * bg + 0.45 * grey) * 0.8
    return (mask * img + (1 - mask) * bg).astype(np.float32)


def even_out(frames, pts_list):
    """Pull each frame's face brightness/contrast/colour toward a rolling average of its
    neighbours (and partly toward the whole set), so the video doesn't flicker."""
    stats = []
    for img, pts in zip(frames, pts_list):
        mask = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(mask, cv2.convexHull(pts.astype(np.int32)), 1)
        lab = cv2.cvtColor(img / 255.0, cv2.COLOR_BGR2LAB)
        px = lab[mask > 0]
        stats.append((px.mean(0), px.std(0) + 1e-6))
    means = np.array([s[0] for s in stats])
    stds = np.array([s[1] for s in stats])
    k = np.ones(7) / 7
    pad = lambda a: np.pad(a, ((3, 3), (0, 0)), mode="edge")
    roll_m = np.stack([np.convolve(pad(means)[:, c], k, "valid") for c in range(3)], 1)
    roll_s = np.stack([np.convolve(pad(stds)[:, c], k, "valid") for c in range(3)], 1)
    target_m = 0.5 * roll_m + 0.5 * np.median(means, 0)
    target_s = 0.5 * roll_s + 0.5 * np.median(stds, 0)
    out = []
    for img, (m, s), tm, ts in zip(frames, stats, target_m, target_s):
        lab = cv2.cvtColor(img / 255.0, cv2.COLOR_BGR2LAB)
        lab[..., 0] = (lab[..., 0] - m[0]) / s[0] * ts[0] + tm[0]
        lab[..., 1:] = lab[..., 1:] - m[1:] + 0.6 * tm[1:] + 0.4 * m[1:]
        lab[..., 0] = np.clip(lab[..., 0], 0, 100)
        out.append(np.clip(cv2.cvtColor(lab.astype(np.float32), cv2.COLOR_LAB2BGR) * 255, 0, 255))
    return out


BORDER = np.array([[0, 0], [W / 2, 0], [W - 1, 0], [W - 1, H / 2], [W - 1, H - 1], [W / 2, H - 1],
                   [0, H - 1], [0, H / 2]], np.float32)
_grid = np.mgrid[0:H, 0:W].astype(np.float32)


def warp(img, src, dst, tris):
    """Piecewise-affine warp: move img's mesh points src onto dst."""
    owner = np.full((H, W), -1, np.int32)
    for k, t in enumerate(tris):
        cv2.fillConvexPoly(owner, np.round(dst[t]).astype(np.int32), k)
    owner[owner < 0] = 0
    mats = np.stack([cv2.getAffineTransform(dst[t], src[t]) for t in tris])   # dst -> src
    m = mats[owner]
    yy, xx = _grid
    mapx = m[..., 0, 0] * xx + m[..., 0, 1] * yy + m[..., 0, 2]
    mapy = m[..., 1, 0] * xx + m[..., 1, 1] * yy + m[..., 1, 2]
    return cv2.remap(img, mapx.astype(np.float32), mapy.astype(np.float32), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REFLECT)


def label(frame, text):
    im = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    d = ImageDraw.Draw(im, "RGBA")
    font = ImageFont.truetype(FONT, 30)
    w = d.textlength(text, font=font)
    d.rounded_rectangle([20, 20, 20 + w + 32, 70], radius=25, fill=(0, 0, 0, 150))
    d.text((36, 45), text, font=font, fill=(255, 255, 255, 255), anchor="lm")
    return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)


def age_text(a):
    return "baby" if a < 1.5 else f"about {round(a)}"


def render(frames_meta, out_path, attrs):
    """frames_meta: [{"id", "photo", "age"}] in play order. Returns start time of each face."""
    if len(frames_meta) < 2:
        raise ValueError("need at least two faces to morph")
    imgs = [aligned_hires(f["photo"], attrs[f["id"]]["kps"]) for f in frames_meta]
    return render_images(imgs, [age_text(f["age"]) for f in frames_meta], out_path)


def render_images(imgs, texts, out_path, hold=HOLD, morph=MORPH, linger=FPS):
    """Morph through already-aligned 512x640 BGR images (photos or composite faces), with a
    caption on each. Returns the start time of each image in the video."""
    if len(imgs) < 2:
        raise ValueError("need at least two faces to morph")
    pts = [np.vstack([landmarks(i), BORDER]) for i in imgs]
    imgs = [i.astype(np.float32) for i in imgs]
    imgs = [soften_background(i, p[:106]) for i, p in zip(even_out(imgs, [p[:106] for p in pts]), pts)]
    tris = Delaunay(np.mean(pts, axis=0)).simplices

    ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
                           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium",
                           "-movflags", "+faststart", str(out_path)], stdin=subprocess.PIPE)
    times = []
    n = len(imgs)
    for i in range(n):
        times.append(round(i * (hold + morph) / FPS, 3))
        still = label(np.clip(imgs[i], 0, 255).astype(np.uint8), texts[i])
        for _ in range(hold):
            ff.stdin.write(still.tobytes())
        if i == n - 1:
            for _ in range(linger):   # linger on the last face
                ff.stdin.write(still.tobytes())
            break
        a, b = imgs[i], imgs[i + 1]
        for s in range(1, morph + 1):
            t = s / (morph + 1)
            t = 0.7 * t + 0.3 * t * t * (3 - 2 * t)   # mostly steady motion, slight easing: flows instead of pausing
            mid = (1 - t) * pts[i] + t * pts[i + 1]
            blended = (1 - t) * warp(a, pts[i], mid, tris) + t * warp(b, pts[i + 1], mid, tris)
            frame = label(np.clip(blended, 0, 255).astype(np.uint8), texts[i + 1 if t > 0.5 else i])
            ff.stdin.write(frame.tobytes())
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    return times

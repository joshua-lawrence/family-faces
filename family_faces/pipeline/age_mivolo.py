"""MiVOLO v2 ages (face + body), run in its own environment because it needs an old timm:

    .venv-mivolo/bin/python age_mivolo.py REQUEST.json RESULT.json

REQUEST: [{"id": face id, "photo": absolute path, "bbox": [x1, y1, x2, y2]}, ...] (bbox in the photo's pixels)
RESULT:  {"<face id>": age}. Prints "progress DONE TOTAL" lines as it goes. age.py calls this.

Model and code: models/mivolo (https://huggingface.co/iitolstykh/mivolo_v2 and the authors' MiVOLO repo,
Apache-2.0; only the model and preprocessing modules). On 549 faces with known ages from this library it was
off by 8.1 years on average (the old FairFace + CLIP mix: 9.2), and by about 3 for children under 10 (was ~7).
"""

import json
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]   # the repository folder (this script runs in .venv-mivolo, outside the package)
M = HERE / "models" / "mivolo"
sys.path[:0] = [str(M)]

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
from safetensors.torch import load_file  # noqa: E402

from mivolo_v2.configuration_mivolo import MiVOLOConfig  # noqa: E402
from mivolo_v2.mivolo_image_processor import MiVOLOImageProcessor  # noqa: E402
from mivolo_v2.modeling_mivolo import MiVOLOForImageClassification  # noqa: E402

BATCH = 32


def crops(img, box):
    """The face box grown 10% each side (measured best), and a body box guessed from the face."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = box
    fw, fh, cx = x2 - x1, y2 - y1, (x1 + x2) / 2

    def cut(b):
        b = [max(0, int(round(b[0]))), max(0, int(round(b[1]))), min(w, int(round(b[2]))), min(h, int(round(b[3])))]
        return img[b[1]:b[3], b[0]:b[2]].copy() if b[2] > b[0] and b[3] > b[1] else None
    return (cut([x1 - .1 * fw, y1 - .1 * fh, x2 + .1 * fw, y2 + .1 * fh]),
            cut([cx - 1.75 * fw, y1 - .5 * fh, cx + 1.75 * fw, y1 + 7 * fh]))


def main(req_path, out_path):
    items = json.loads(Path(req_path).read_text())
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    cfg = MiVOLOConfig.from_json_file(M / "mivolo_v2" / "config.json")
    model = MiVOLOForImageClassification(cfg)
    r = model.load_state_dict(load_file(M / "mivolo_v2" / "model.safetensors"), strict=False)
    if r.missing_keys or r.unexpected_keys:
        sys.exit(f"MiVOLO weights don't match the model: {r.missing_keys[:3]} {r.unexpected_keys[:3]}")
    model.eval().to(dev).float()
    pc = json.loads((M / "mivolo_v2" / "preprocessor_config.json").read_text())
    proc = MiVOLOImageProcessor(input_size=pc["input_size"], mean=pc["mean"], std=pc["std"])

    by_photo = defaultdict(list)
    for it in items:
        by_photo[it["photo"]].append(it)
    photos = list(by_photo)

    def load(photo):   # BGR, like the model was trained on
        img = cv2.imread(photo)
        return [] if img is None else [(it["id"], *crops(img, it["bbox"])) for it in by_photo[photo]]

    out, pending, done = {}, [], 0

    @torch.no_grad()
    def flush():
        nonlocal pending
        ok = [p for p in pending if p[1] is not None]
        if ok:
            f = proc(images=[p[1] for p in ok])["pixel_values"].to(dev).float()
            b = proc(images=[p[2] for p in ok])["pixel_values"].to(dev).float()
            for p, a in zip(ok, model(faces_input=f, body_input=b).age_output.flatten().cpu().tolist()):
                out[str(p[0])] = round(float(np.clip(a, 0, 110)), 1)
        pending = []

    with ThreadPoolExecutor(8) as ex:
        for rows in ex.map(load, photos):
            pending += rows
            done += 1
            if len(pending) >= BATCH:
                flush()
                print(f"progress {len(out)} {len(items)}", flush=True)
        flush()
    Path(out_path).write_text(json.dumps(out))
    print(f"progress {len(out)} {len(items)}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

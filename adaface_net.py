"""AdaFace IR-101 (WebFace12M) network, re-declared here so its published safetensors
weights (huggingface.co/minchul/cvlface_adaface_ir101_webface12m) can be loaded
without running the repo's own loader, which unpickles a .pt file.

Architecture follows CVLFace's models/iresnet/model.py (IR-100 'ir' mode, 112x112 input).
Input: RGB, 112x112, aligned with the standard ArcFace 5-point template, scaled to [-1, 1].
"""

from pathlib import Path

import torch
from safetensors.torch import load_file
from torch import nn


class BasicBlockIR(nn.Module):
    def __init__(self, in_c, depth, stride):
        super().__init__()
        self.shortcut_layer = (nn.MaxPool2d(1, stride) if in_c == depth else
                               nn.Sequential(nn.Conv2d(in_c, depth, 1, stride, bias=False), nn.BatchNorm2d(depth)))
        self.res_layer = nn.Sequential(
            nn.BatchNorm2d(in_c), nn.Conv2d(in_c, depth, 3, 1, 1, bias=False), nn.BatchNorm2d(depth),
            nn.PReLU(depth), nn.Conv2d(depth, depth, 3, stride, 1, bias=False), nn.BatchNorm2d(depth))

    def forward(self, x):
        return self.res_layer(x) + self.shortcut_layer(x)


class IR101(nn.Module):
    STAGES = [(64, 64, 3), (64, 128, 13), (128, 256, 30), (256, 512, 3)]

    def __init__(self):
        super().__init__()
        self.input_layer = nn.Sequential(nn.Conv2d(3, 64, 3, 1, 1, bias=False), nn.BatchNorm2d(64), nn.PReLU(64))
        blocks = []
        for in_c, depth, n in self.STAGES:
            blocks.append(BasicBlockIR(in_c, depth, 2))
            blocks += [BasicBlockIR(depth, depth, 1) for _ in range(n - 1)]
        self.body = nn.Sequential(*blocks)
        self.output_layer = nn.Sequential(nn.BatchNorm2d(512), nn.Dropout(0.4), nn.Flatten(),
                                          nn.Linear(512 * 7 * 7, 512), nn.BatchNorm1d(512, affine=False))

    def forward(self, x):
        return self.output_layer(self.body(self.input_layer(x)))


def load(weights: Path, device="cpu"):
    net = IR101()
    state = load_file(str(weights))
    prefix = next(k for k in state if k.endswith("input_layer.0.weight")).removesuffix("input_layer.0.weight")
    state = {k[len(prefix):]: v for k, v in state.items() if k.startswith(prefix)}
    missing, unexpected = net.load_state_dict(state, strict=False)
    real_missing = [k for k in missing if "num_batches_tracked" not in k]
    if real_missing or unexpected:
        raise RuntimeError(f"AdaFace weights don't match: missing {real_missing[:5]}, unexpected {unexpected[:5]}")
    return net.to(device).eval()

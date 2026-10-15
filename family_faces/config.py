"""Where the photo library and the app's own data live, and optional integrations.

The library folder is the first of:
  1. the FAMILY_FACES_LIBRARY environment variable
  2. "library" in the settings file (~/.config/family-faces/config.json, or FAMILY_FACES_CONFIG)
  3. the folder above the app, when the app sits inside its library with a data/ folder
     (the original layout: <library>/_faces/data)

The data folder (faces, names, tree, thumbnails) is FAMILY_FACES_DATA, else "data" in the settings
file, else <app>/data in the original layout, else <library>/.family-faces. Photos are never moved
out of the library; the data folder only holds what the app derives from them.

Optional settings in the same file:
  "album_name": label for the photos that were in the library before any import (default: the
                library folder's name)
  "familysearch": {"connection_script": "...", "upload_script": "..."}: Node scripts that connect
                to FamilySearch. Without them the FamilySearch features stay switched off.
"""

import json
import os
from pathlib import Path

# The repository folder: models/, data/ (old layout) and .venv-mivolo/ live here, beside the package.
ROOT = HERE = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(os.environ.get("FAMILY_FACES_CONFIG")
                   or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "family-faces" / "config.json")


def load_settings():
    try:
        return json.loads(CONFIG_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_settings(**changes):
    settings = load_settings()
    settings.update(changes)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(settings, indent=2) + "\n")
    return settings


SETTINGS = load_settings()


def _path(value):
    return Path(value).expanduser().resolve() if value else None


CHOSEN = _path(os.environ.get("FAMILY_FACES_LIBRARY")) or _path(SETTINGS.get("library"))
# The original layout: no folder chosen, and the app sits inside its library with its data beside the code.
LEGACY = CHOSEN is None and (HERE / "data" / "faces.json").exists()
LIBRARY = CHOSEN or (HERE.parent if LEGACY else None)
DATA = (_path(os.environ.get("FAMILY_FACES_DATA")) or _path(SETTINGS.get("data"))
        or (HERE / "data" if LEGACY else (LIBRARY / ".family-faces" if LIBRARY else HERE / "data")))
CONFIGURED = LIBRARY is not None
if LIBRARY is None:   # nothing chosen yet: app.py asks for a folder before anything reads photos
    LIBRARY = HERE / "library-not-set"

ALBUM_NAME = SETTINGS.get("album_name") or LIBRARY.name
MODELS = HERE / "models"

_fs = SETTINGS.get("familysearch") or {}
FAMILYSEARCH_CONNECTION_SCRIPT = _path(os.environ.get("FAMILY_FACES_FS_CONNECTION_SCRIPT") or _fs.get("connection_script"))
FAMILYSEARCH_UPLOAD_SCRIPT = _path(os.environ.get("FAMILY_FACES_FS_UPLOAD_SCRIPT") or _fs.get("upload_script"))
FAMILYSEARCH_ENABLED = bool(FAMILYSEARCH_UPLOAD_SCRIPT or FAMILYSEARCH_CONNECTION_SCRIPT)


def onnx_providers():
    """Fastest ONNX Runtime backends on this machine: CoreML on a Mac, CUDA with an NVIDIA GPU, else CPU."""
    import onnxruntime
    available = onnxruntime.get_available_providers()
    preferred = [p for p in ("CoreMLExecutionProvider", "CUDAExecutionProvider") if p in available]
    return preferred + ["CPUExecutionProvider"]

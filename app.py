"""Start Family Faces.

    uv run python app.py --library ~/Pictures/Family   # first time: remember this folder
    uv run python app.py                               # later: open the same library

The first start on a library finds every face and groups them (this takes a while: about a
second per photo on a laptop), then opens the app at http://localhost:8765.
"""

import argparse
import os
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(script, *args):
    sys.argv = [str(HERE / script), *args]
    runpy.run_path(str(HERE / script), run_name="__main__")


def main():
    parser = argparse.ArgumentParser(description="Find, name and organize the people in your photos.")
    parser.add_argument("--library", type=Path, help="the folder with your photos (remembered for next time)")
    parser.add_argument("--data", type=Path, help="where the app keeps its own files (default: <library>/.family-faces)")
    parser.add_argument("--port", type=int, help="port for the local web app (default 8765)")
    parser.add_argument("--no-scan", action="store_true", help="open the app without looking for new faces first")
    args = parser.parse_args()

    import config
    if args.library or args.data:
        changes = {}
        if args.library:
            library = args.library.expanduser().resolve()
            if not library.is_dir():
                sys.exit(f"Can't find the folder {library}")
            changes["library"] = str(library)
        if args.data:
            changes["data"] = str(args.data.expanduser().resolve())
        config.save_settings(**changes)
        print(f"Saved to {config.CONFIG_PATH}")
        if args.library:
            os.environ["FAMILY_FACES_LIBRARY"] = changes["library"]
        if args.data:
            os.environ["FAMILY_FACES_DATA"] = changes["data"]
        import importlib
        importlib.reload(config)
    if not config.CONFIGURED:
        sys.exit("Choose your photo folder first:\n\n    uv run python app.py --library /path/to/your/photos\n")
    if args.port:
        os.environ["PORT"] = str(args.port)

    config.DATA.mkdir(parents=True, exist_ok=True)
    print(f"Library: {config.LIBRARY}\nApp data: {config.DATA}")
    if not args.no_scan and not (config.DATA / "clusters.json").exists():
        print("Looking for faces in your photos. This runs once; later photos go through the Inbox.")
        run("embed.py")
        run("cluster.py")
        run("map.py")
    run("serve.py")


if __name__ == "__main__":
    main()

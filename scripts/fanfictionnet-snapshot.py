"""Regenerate the bundled fandom snapshot of plugins/english/fanfictionnet.ts.

Reads the nine section pages of www.fanfiction.net and rewrites the block between the
SNAPSHOT markers in the plugin. Bump the plugin's version afterwards.

    python3 -I scripts/fanfictionnet-snapshot.py --flaresolverr http://localhost:8191
    python3 -I scripts/fanfictionnet-snapshot.py --from-dir saved_pages/   # <section>.html files

Plain requests are usually answered with a Cloudflare challenge, hence FlareSolverr.
"""
import argparse
import datetime
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent / "plugins" / "english" / "fanfictionnet.ts"
SECTIONS = ["anime", "book", "cartoon", "comic", "game", "misc", "movie", "play", "tv"]
START, END = "// SNAPSHOT:START", "// SNAPSHOT:END"


def fetch(section: str, flaresolverr: str) -> str:
    body = json.dumps({"cmd": "request.get", "url": f"https://www.fanfiction.net/{section}/", "maxTimeout": 90000})
    request = urllib.request.Request(
        flaresolverr.rstrip("/") + "/v1", data=body.encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)["solution"]["response"]


def story_count(text: str) -> int:
    match = re.search(r"([\d.,]+)\s*([KM]?)", text)
    if not match:
        return 0
    return int(float(match.group(1).replace(",", "")) * {"": 1, "K": 1_000, "M": 1_000_000}[match.group(2)])


def parse(section: str, page: str) -> list[tuple[str, str, int]]:
    if "<title>Just a moment" in page:
        sys.exit(f"{section}: Cloudflare challenge page instead of the fandom list")
    pattern = rf"<a[^>]+href=['\"]/{section}/([^/'\"]+)/['\"][^>]*>([^<]+)</a>\s*<span[^>]*>\s*\(([^)]*)\)"
    fandoms = [(html.unescape(name).strip(), slug, story_count(count)) for slug, name, count in re.findall(pattern, page)]
    if not fandoms:
        sys.exit(f"{section}: no fandoms found, the page layout may have changed")
    return sorted(fandoms, key=lambda f: -f[2])


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--flaresolverr", metavar="URL")
    source.add_argument("--from-dir", type=Path)
    args = parser.parse_args()

    blocks, total = [], 0
    for i, section in enumerate(SECTIONS):
        if args.from_dir:
            page = (args.from_dir / f"{section}.html").read_text(errors="replace")
        else:
            if i:
                time.sleep(5)
            page = fetch(section, args.flaresolverr)
        fandoms = parse(section, page)
        # name<TAB>slug<TAB>count per line; tabs and newlines never occur in fandom names.
        text = "\n".join(f"{name}\t{slug}\t{count}" for name, slug, count in fandoms)
        blocks.append(f"  {section}: {json.dumps(text, ensure_ascii=False)},")
        total += len(fandoms)
        print(f"{section}: {len(fandoms)}", file=sys.stderr)

    today = datetime.date.today()
    lines = [
        START,
        "// prettier-ignore",
        f"const SNAPSHOT_DATE = Date.UTC({today.year}, {today.month - 1}, {today.day});",
        "// prettier-ignore",
        "const SNAPSHOT: Record<string, string> = {",
        *blocks,
        "};",
        END,
    ]
    source = PLUGIN.read_text()
    block = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    if not block.search(source):
        sys.exit(f"{PLUGIN}: no {START} ... {END} block")
    PLUGIN.write_text(block.sub(lambda _: "\n".join(lines), source))
    print(f"wrote {total} fandoms", file=sys.stderr)


if __name__ == "__main__":
    main()

# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.65,<2", "pydantic>=2,<3"]
# ///
"""Read signed-in FanFiction.Net lists and write an additive LNReader 2.1.4 backup."""

import argparse
import json
import re
from pathlib import Path
from typing import Literal, NamedTuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile

from playwright.sync_api import Error as BrowserError
from playwright.sync_api import Page, sync_playwright
from pydantic import BaseModel, ValidationError

SITE = "https://www.fanfiction.net"
PLUGIN_ID = "fanfictionnet"
DEFAULT_CATEGORY_ID = 1
LIST_PATHS = ("/favorites/story.php", "/alert/story.php")
STORY_PATH = re.compile(r"^/?s/(\d+)(?:/|$)")
EMPTY_LIST = re.compile(
    r"\b(?:no|0) (?:story|stories|favorites|alerts|entries|records)\b", re.IGNORECASE
)


class ImportErrorDetail(Exception):
    """The import cannot safely continue with the supplied input."""


class BackupSections(BaseModel):
    library: Literal[True]


class BackupVersion(BaseModel):
    formatVersion: Literal[2]
    sections: BackupSections


class BackupNovelKey(BaseModel):
    pluginId: str
    path: str


class Story(NamedTuple):
    id: int
    name: str


def existing_story_ids(backup_path: Path) -> set[int]:
    """Read all stored FFN story identities, including stories outside the library."""
    with ZipFile(backup_path) as backup:
        BackupVersion.model_validate_json(backup.read("Version.json"))
        json.loads(backup.read("Category.json"))
        ids = set()
        for entry in backup.infolist():
            if not re.fullmatch(r"NovelAndChapters/[^/]+\.json", entry.filename):
                continue
            key = BackupNovelKey.model_validate_json(backup.read(entry))
            match = STORY_PATH.match(key.path)
            if key.pluginId == PLUGIN_ID and match:
                ids.add(int(match[1]))
        return ids


def read_story_list(page: Page, path: str) -> dict[int, Story]:
    """Follow only numeric pagination on the same list and collect stories in site order."""
    start = SITE + path
    pending = {start: None}
    visited: set[str] = set()
    stories: dict[int, Story] = {}
    while pending:
        url = next(iter(pending))
        del pending[url]
        visited.add(url)
        response = page.goto(url, wait_until="domcontentloaded")
        location = urlsplit(page.url)
        if (
            response is None
            or not response.ok
            or location.hostname != "www.fanfiction.net"
            or location.path != path
            or not page.locator(
                'a[href*="logout"], a[href*="/account/settings.php"]'
            ).count()
        ):
            raise ImportErrorDetail(
                "Could not open the signed-in list. Check the browser for a login or site prompt."
            )

        links = page.locator("a[href]").evaluate_all(
            "(anchors) => anchors.map(a => [a.href, a.textContent.trim()])"
        )
        before = len(stories)
        for href, title in links:
            link = urlsplit(href)
            if link.hostname != location.hostname:
                continue
            match = STORY_PATH.match(link.path)
            if match and title:
                story = Story(int(match[1]), title)
                stories.setdefault(story.id, story)
            if link.path != path:
                continue
            for key, value in parse_qsl(link.query):
                if (
                    key.lower() in ("p", "page", "ppage")
                    and value.isascii()
                    and value.isdigit()
                ):
                    next_url = start + "?" + urlencode({key: value})
                    if next_url not in visited:
                        pending.setdefault(next_url, None)
        if (
            len(visited) == 1
            and len(stories) == before
            and not EMPTY_LIST.search(page.locator("body").inner_text())
        ):
            raise ImportErrorDetail(
                "The account page did not contain a recognized story list."
            )
        print(
            f"  {len(stories)} unique stories after {len(visited)} page(s)", flush=True
        )
    return stories


def write_import(output: Path, stories: list[Story]) -> None:
    """Write a new ZIP limited to library entries, with no existing novel records."""
    manifest = {
        "appVersion": "2.1.4",
        "formatVersion": 2,
        "sections": {
            "library": True,
            "settings": False,
            "plugins": False,
            "downloadedFiles": False,
        },
    }
    with ZipFile(output, "x", compression=ZIP_DEFLATED) as backup:
        backup.writestr("Version.json", json.dumps(manifest))
        category = {
            "id": DEFAULT_CATEGORY_ID,
            "name": "Default",
            "sort": 1,
            "novelIds": [story.id for story in stories],
        }
        backup.writestr("Category.json", json.dumps([category]))
        for story in stories:
            entry = {
                "id": story.id,
                "pluginId": PLUGIN_ID,
                "path": f"s/{story.id}/",
                "name": story.name,
                "inLibrary": True,
                "chapters": [],
            }
            backup.writestr(
                f"NovelAndChapters/{story.id}.json",
                json.dumps(entry, ensure_ascii=False),
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--library-backup", type=Path, required=True, help="Fresh local LNReader backup"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="Destination for the import-only ZIP"
    )
    args = parser.parse_args()
    try:
        if args.output.exists():
            raise ImportErrorDetail(
                f"Choose a new output filename. {args.output} already exists."
            )
        existing = existing_story_ids(args.library_backup)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=False, channel="chromium")
            page = browser.new_page()
            page.goto(urljoin(SITE, "/login.php"), wait_until="domcontentloaded")
            input("Sign in to FanFiction.Net in Chromium, then press Enter here. ")
            print("Reading favorites...", flush=True)
            favorites = read_story_list(page, LIST_PATHS[0])
            print("Reading follows...", flush=True)
            follows = read_story_list(page, LIST_PATHS[1])
            browser.close()
        combined = favorites | follows
        new_stories = [story for story in combined.values() if story.id not in existing]
        print(
            f"{len(favorites)} favorites, {len(follows)} follows, "
            f"{len(combined) - len(new_stories)} existing LNReader entries skipped."
        )
        if new_stories:
            write_import(args.output, new_stories)
            print(f"Wrote {len(new_stories)} new library entries to {args.output}")
        else:
            print("There are no new stories to import.")
    except (
        ImportErrorDetail,
        BadZipFile,
        KeyError,
        ValidationError,
        OSError,
        EOFError,
        BrowserError,
    ) as error:
        parser.exit(1, f"Import stopped: {error}\n")


if __name__ == "__main__":
    main()

# Tao LNReader Plugins

This repository distributes the FanFiction.Net plugin for LNReader.

In LNReader, open **Browse → Plugins → Repositories**, add the URL below, then
install **FanFiction.Net** from the plugin list.

```text
https://raw.githubusercontent.com/saigauthamr/tao-lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json
```

For local testing, install dependencies with `pnpm install --frozen-lockfile`,
set `USER_CONTENT_BASE` in `.env` to your local server URL, and run
`pnpm run serve:dev` from the repository root.

The plugin and build tooling are based on the
[LNReader plugin repository](https://github.com/lnreader/lnreader-plugins).

## Favorites and follows

In FanFiction.Net's browse screen, tap the globe and sign in. Return to the
browse screen, open **Filter → List**, and choose **My favorites** or
**My follows**. Choose **Archive** to use the fandom filters.

## Import both lists into LNReader 2.1.4

1. Make a fresh local LNReader backup with **Library** enabled. Check that
   the backup completes without warnings, and keep a copy.
2. With [uv](https://docs.astral.sh/uv/) installed, run the commands below.
   Sign in in the Chromium window the script opens.
3. Review the printed totals, then restore the generated ZIP once in LNReader.
   Open an imported story and refresh it to fetch its chapters.

```sh
uv run --no-project --with 'playwright>=1.65,<2' python -m playwright install chromium
uv run --script scripts/fanfictionnet-import.py \
  --library-backup /path/to/current-library.zip \
  --output /path/to/fanfictionnet-import.zip
```

The script combines the lists by story ID and skips every FanFiction.Net story
already present in the supplied backup. LNReader replaces chapters and
reading progress when a restored story collides with an existing entry.
Keep the library as it was when you backed it up until the import finishes.
For another import, make a new backup first.

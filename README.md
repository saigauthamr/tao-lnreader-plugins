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

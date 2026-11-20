# FanFiction.Net plugin for LNReader

- `plugins/english/fanfictionnet.ts` is the sole plugin. Keep its ID and
  story paths stable and bump its version whenever plugin behavior changes.
- LNReader supplies the `@libs/*` modules and Cheerio on Android. The build
  targets ES5 and CommonJS for LNReader's Hermes runtime.
- Run `pnpm install --frozen-lockfile`, `pnpm run lint`, and `pnpm run build`.
  `pnpm run serve:dev` builds a local manifest using `.env`.
- The workflow publishes the compiled plugin, icon, and manifest on
  `plugins/v3.0.0`. Keep the manifest URL stable for installed clients.
- The import script targets LNReader 2.1.4. Matching backup records replace
  chapter rows on restore, so exclude stories already in the current backup.

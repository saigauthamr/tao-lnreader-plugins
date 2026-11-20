import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import ts from 'typescript';
import { minify_sync } from 'terser';

const source = 'plugins/english/fanfictionnet.ts';
const script = '.js/src/plugins/english/fanfictionnet.js';
const { outputText } = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  fileName: source,
  compilerOptions: {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
});

const { code } = minify_sync(outputText, {
  compress: { arrows: false },
  ecma: 5,
  module: true,
  toplevel: true,
});
if (!code) throw new Error('FanFiction.Net compilation produced no code.');

const stub = new Proxy({}, { get: () => stub });
const loadMetadata = new Function('require', 'exports', code);
const exports = {};
loadMetadata(() => stub, exports);
const { id, version, name, site, icon } = exports.default;
if (id !== 'fanfictionnet' || !version || !name || !site || !icon) {
  throw new Error('FanFiction.Net metadata is missing or invalid.');
}

let base = process.env.USER_CONTENT_BASE;
if (!base) {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim();
  const repo = origin.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if (!repo) throw new Error('Expected a GitHub origin for publishing.');
  base = `https://raw.githubusercontent.com/${repo}/${process.env.BRANCH || 'plugins/v3.0.0'}`;
}
base = base.replace(/\/$/, '');
const manifest = [
  {
    id,
    name,
    site,
    lang: 'English',
    version,
    url: `${base}/${script}`,
    iconUrl: `${base}/public/static/${icon}`,
  },
];

fs.mkdirSync('.dist', { recursive: true });
fs.mkdirSync('.js/src/plugins/english', { recursive: true });
fs.writeFileSync(script, code);
fs.writeFileSync('.dist/plugins.json', JSON.stringify(manifest, null, 2));
fs.writeFileSync('.dist/plugins.min.json', JSON.stringify(manifest));

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
const page = await build({
  entryPoints: [path.join(root, 'src/web/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
});
const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(
  /<script type="module" src="[^\"]+"><\/script>/,
  () => `<script type="module">${page.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`,
);
await writeFile(path.join(output, 'index.html'), html);
await build({
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(output, 'backend.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  loader: { '.md': 'text' },
  logLevel: 'warning',
});
await copyFile(path.join(root, 'agentdeck.plugin.json'), path.join(output, 'agentdeck.plugin.json'));
await copyFile(path.join(root, 'README.md'), path.join(output, 'README.md'));
console.log('已构建 Codex 委派插件包：' + output);

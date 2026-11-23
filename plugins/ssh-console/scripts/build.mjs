import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist');
await mkdir(output, { recursive: true });
const result = await build({
  configFile: false,
  root,
  plugins: [react(), tailwindcss()],
  build: {
    write: false,
    cssCodeSplit: false,
    assetsInlineLimit: 1024 * 1024,
    minify: true,
    rolldownOptions: { input: path.join(root, 'index.html'), output: { codeSplitting: false } },
  },
});
const files = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
let html = String(files.find((item) => item.fileName === 'index.html').source);
for (const item of files) {
  if (item.type === 'chunk')
    html = html.replace(
      /<script[^>]*src="[^"]*"[^>]*><\/script>/,
      () => `<script type="module">${item.code.replace(/<\/script/gi, '<\\/script')}</script>`,
    );
  else if (item.fileName.endsWith('.css'))
    html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/, () => `<style>${item.source}</style>`);
}
if (/(?:src|href)="\/assets\//.test(html)) throw new Error('插件页面存在未内联资源');
await writeFile(path.join(output, 'index.html'), html);
await bundle({
  entryPoints: [path.join(root, 'src/server/main.ts')],
  outfile: path.join(output, 'backend.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['cpu-features', '*.node'],
  logLevel: 'warning',
});
await copyFile(path.join(root, 'agentdeck.plugin.json'), path.join(output, 'agentdeck.plugin.json'));
console.log('已构建 SSH Console 插件包：' + output);

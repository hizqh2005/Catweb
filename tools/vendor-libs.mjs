#!/usr/bin/env node
/**
 * 一次性离线准备：把 CDN 依赖下载到 /libs（importmap 默认源）。
 * 运行：node tools/vendor-libs.mjs        （重新下载 = 升级版本前先改下方 VERSIONS）
 * 运行：node tools/vendor-libs.mjs --check  只校验已有文件完整性，不联网
 * 不引入 package.json、不参与日常运行——运行时仍是零构建（红线 1）。
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

const VERSIONS = { three: '0.170.0', gsap: '3.12.5', 'cannon-es': '0.20.0', howler: '2.2.4' };

// 源优先级：npmmirror（国内直连）→ jsdelivr → unpkg；cannon-es 在 npmmirror 是 403 白名单外，unpkg 优先。
const SOURCES = {
  npmmirror: (pkg, path) => `https://registry.npmmirror.com/${pkg}/${VERSIONS[pkg]}/files/${path}`,
  jsdelivr:  (pkg, path) => `https://cdn.jsdelivr.net/npm/${pkg}@${VERSIONS[pkg]}/${path}`,
  unpkg:     (pkg, path) => `https://unpkg.com/${pkg}@${VERSIONS[pkg]}/${path}`,
};

/** out: 相对 libs/ 的落盘路径；min: 最小字节数（防 HTML 错误页/截断）；order: 源优先级 */
const FILES = [
  { pkg: 'three',      path: 'build/three.module.js',              out: 'three/build/three.module.js',            min: 1_000_000, order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'three',      path: 'examples/jsm/controls/TransformControls.js', out: 'three/examples/jsm/controls/TransformControls.js', min: 20_000, order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'three',      path: 'LICENSE',                            out: 'three/LICENSE',                          min: 1_000,     order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'gsap',       path: 'index.js',                           out: 'gsap/index.js',                          min: 500,       order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'gsap',       path: 'gsap-core.js',                       out: 'gsap/gsap-core.js',                      min: 150_000,   order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'gsap',       path: 'CSSPlugin.js',                       out: 'gsap/CSSPlugin.js',                      min: 50_000,    order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  // gsap 包内不带 license 文件（package.json 声明 Standard 'no charge' license，见 gsap.com/standard-license）
  { pkg: 'cannon-es',  path: 'dist/cannon-es.js',                  out: 'cannon-es/dist/cannon-es.js',            min: 300_000,   order: ['unpkg', 'jsdelivr', 'npmmirror'] },
  { pkg: 'cannon-es',  path: 'LICENSE',                            out: 'cannon-es/LICENSE',                      min: 1_000,     order: ['unpkg', 'jsdelivr', 'npmmirror'] },
  { pkg: 'howler',     path: 'dist/howler.js',                     out: 'howler/dist/howler.js',                  min: 90_000,    order: ['npmmirror', 'jsdelivr', 'unpkg'] },
  { pkg: 'howler',     path: 'LICENSE.md',                         out: 'howler/LICENSE.md',                      min: 900,       order: ['npmmirror', 'jsdelivr', 'unpkg'] },
];

async function valid(buf, min) {
  if (!buf || buf.length < min) return false;
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('<') || head.startsWith('{')) return false; // HTML/JSON 错误页
  return true;
}

async function fetchFile(entry) {
  const dest = join(ROOT, 'libs', entry.out);
  if (CHECK_ONLY) {
    const ok = await readFile(dest).then((b) => valid(b, entry.min)).catch(() => false);
    console.log(`${ok ? 'OK  ' : 'FAIL'} libs/${entry.out}`);
    return ok;
  }
  for (const src of entry.order) {
    const url = SOURCES[src](entry.pkg, entry.path);
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { console.log(`  ${src} ${res.status}  ${entry.path}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!await valid(buf, entry.min)) { console.log(`  ${src} 内容异常（过短或非 JS）  ${entry.path}`); continue; }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      console.log(`OK  libs/${entry.out}  ${(buf.length / 1024).toFixed(1)} KB  ← ${src}`);
      return true;
    } catch (e) {
      console.log(`  ${src} 失败: ${e.message}  ${entry.path}`);
    }
  }
  console.error(`FAIL libs/${entry.out}  所有源均失败`);
  return false;
}

const results = await Promise.all(FILES.map(fetchFile));
const failed = results.filter((ok) => !ok).length;
if (failed) { console.error(`\n${failed} 个文件失败`); process.exit(1); }

if (!CHECK_ONLY) {
  let total = 0;
  for (const f of FILES) total += (await stat(join(ROOT, 'libs', f.out))).size;
  console.log(`\n完成：${FILES.length} 个文件，共 ${(total / 1024 / 1024).toFixed(2)} MB`);
}

#!/usr/bin/env node
/**
 * 核对脚本：防止整体重写文件时丢失工具函数/方法（"el is not defined" 这类病已犯两次）。
 *
 * 检查项：
 *   1. 构造器里 `this._x = this._foo.bind(this)` 的 _foo 是否在类里存在
 *   2. 文件里调用的所有顶层工具函数（裸调用名）是否都有定义
 *   3. `this.bar(...)` 调用的 bar 是否有定义（类方法或 this.bar = 赋值）
 *
 * 用法：node tools/check-fn-refs.mjs engine/SceneEditor.js [更多文件...]
 * 退出码 0 = 全部通过，1 = 有缺失
 */

import { readFileSync } from 'node:fs';

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new',
  'do', 'else', 'try', 'await', 'yield', 'void', 'delete', 'in', 'of', 'instanceof',
  'case', 'throw', 'super', 'this', 'finally', 'static', 'get', 'set', 'async',
  'constructor', 'class', 'import', 'export', 'default', 'from', 'as', 'let',
  'const', 'var', 'extends', 'with', 'debugger',
]);

// 浏览器 / 语言全局，不算缺失
const GLOBALS = new Set([
  'document', 'window', 'console', 'Math', 'JSON', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise',
  'Error', 'TypeError', 'Date', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'Blob', 'File', 'FileReader', 'Image', 'URL', 'URLSearchParams', 'HTMLElement',
  'CustomEvent', 'Event', 'KeyboardEvent', 'PointerEvent', 'alert', 'confirm',
  'prompt', 'undefined', 'NaN', 'Infinity', 'globalThis', 'navigator', 'location',
  'performance', 'fetch', 'addEventListener', 'removeEventListener', 'encodeURIComponent',
  'decodeURIComponent', 'Uint8Array', 'Float32Array', 'Int32Array', 'ArrayBuffer',
  'Proxy', 'Reflect', 'process', 'require', 'module', 'exports', '__dirname',
]);

/** 把注释与字符串挖成空格（保留换行与行号），模板字符串保留 ${} 内的代码 */
function blankStringsAndComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && next === '*') {
      out[i] = out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = out[i + 1] = ' '; i += 2; }
    } else if (c === '"' || c === "'") {
      out[i++] = ' ';
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') out[i++] = ' ';
        if (i < n && src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) out[i++] = ' ';
    } else if (c === '`') {
      out[i++] = ' ';
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out[i++] = ' '; if (i < n) out[i++] = ' '; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 保留插值表达式里的代码，只挖掉 ${ }
          out[i] = out[i + 1] = ' ';
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0 && src[i] !== '\n') i++;
            else if (depth === 0) { out[i] = ' '; i++; }
            else i++;
          }
          continue;
        }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) out[i++] = ' ';
    } else {
      i++;
    }
  }
  return out.join('');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function checkFile(path) {
  const raw = readFileSync(path, 'utf8');
  const code = blankStringsAndComments(raw);
  const problems = [];

  // ---------- 收集定义 ----------
  const defined = new Set(GLOBALS);
  const classMethods = new Set();
  const thisMembers = new Set();

  // import
  for (const m of code.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s*as\s+([\w$]+))?\s*from/g)) {
    if (m[1]) defined.add(m[1]);
    if (m[3]) defined.add(m[3]);
    if (m[2]) for (const part of m[2].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) defined.add(name);
    }
  }
  // export default class/function 名
  for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) defined.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:default\s+)?class\s+([\w$]+)/g)) defined.add(m[1]);
  // 顶层 function 声明
  for (const m of code.matchAll(/(?:^|[}\n;])\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) defined.add(m[1]);
  // const/let/var 绑定（含箭头函数）
  for (const m of code.matchAll(/(?:^|[}\n;])\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/g)) defined.add(m[1]);
  // 类声明
  for (const m of code.matchAll(/(?:^|[}\n;])\s*(?:export\s+)?(?:default\s+)?class\s+([\w$]+)/g)) defined.add(m[1]);

  // 类方法 / 对象方法：`name(params) {` 或 `async name(params) {` 或 get/set
  for (const m of code.matchAll(/(?:^|\{|;|\n)\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?([\w$]+)\s*(\([^)]*\))\s*\{/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    classMethods.add(name);
    defined.add(name);
    // 参数也算定义（避免 `(row) => row(x)` 类误报）
    for (const p of m[2].slice(1, -1).split(',')) {
      const pn = p.trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[\w$]+$/.test(pn)) defined.add(pn);
    }
  }
  // 箭头函数参数 (a, b) => / a =>
  for (const m of code.matchAll(/(\([^)]*\)|[\w$]+)\s*=>/g)) {
    for (const p of m[1].replace(/[()]/g, '').split(',')) {
      const pn = p.trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[\w$]+$/.test(pn)) defined.add(pn);
    }
  }
  // this.xxx = 赋值 → 视为成员已定义
  for (const m of code.matchAll(/this\.([\w$]+)\s*=(?!=)/g)) thisMembers.add(m[1]);

  // ---------- 检查 1：bind 的方法 ----------
  for (const m of code.matchAll(/this\.([\w$]+)\s*=\s*this\.([\w$]+)\.bind\(this\)/g)) {
    const handler = m[2];
    if (!classMethods.has(handler)) {
      problems.push({
        line: lineOf(raw, m.index),
        kind: 'bind 方法缺失',
        detail: `this.${m[1]} = this.${handler}.bind(this) → 类里找不到 ${handler}()`,
      });
    }
  }

  // ---------- 检查 2：裸调用的工具函数 ----------
  for (const m of code.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = m[2];
    if (KEYWORDS.has(name)) continue;
    if (defined.has(name)) continue;
    problems.push({
      line: lineOf(raw, m.index + m[1].length),
      kind: '工具函数缺失',
      detail: `调用了 ${name}(...)，但文件里没有它的定义`,
    });
  }

  // ---------- 检查 3：this.method(...) ----------
  for (const m of code.matchAll(/this\.([\w$]+)\s*\(/g)) {
    const name = m[1];
    if (classMethods.has(name) || thisMembers.has(name)) continue;
    problems.push({
      line: lineOf(raw, m.index),
      kind: 'this 方法缺失',
      detail: `调用了 this.${name}(...)，但既不是类方法也没有 this.${name} = 赋值`,
    });
  }

  return problems;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/check-fn-refs.mjs <file.mjs> [...更多文件]');
  process.exit(2);
}

let failed = false;
for (const f of files) {
  const problems = checkFile(f);
  if (problems.length === 0) {
    console.log(`OK  ${f}`);
  } else {
    failed = true;
    console.error(`FAIL ${f}  (${problems.length} 处)`);
    for (const p of problems) {
      console.error(`  L${p.line}  [${p.kind}] ${p.detail}`);
    }
  }
}
process.exit(failed ? 1 : 0);

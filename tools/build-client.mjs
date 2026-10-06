#!/usr/bin/env node
/**
 * 把 `client/plugin.js` 包成 DSH 浏览器模块系统认的客户端 bundle（`lib/client.js`）。
 *
 * 为什么不用打包器：这个客户端半侧只 require 平台模块表里的东西（React 与 UI 原子），
 * 没有自己的依赖树、没有拆分 chunk、没有 CSS module —— 需要的只是那一层
 * `window.__ModuleLoader__.load({ id, factory })` 外壳。手写包装换来的是：
 * 没有构建依赖、产物可逐字重放（`--check` 会钉住），以及这个仓库一直保持的
 * 「clone 下来就能跑」。
 *
 * bundle 的格式（照抄官方产物）：
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: "<package name>",                            // 必须是解析出来的包名，等于启动图里的 row id
 *   factory: (require) => {                          // 惰性 CJS：只注册 factory，物化时才跑
 *     var module = { exports: {} }; var exports = module.exports
 *     <client/plugin.js 原文>
 *     return module.exports
 *   }
 * })
 * ```
 *
 * ```
 * node tools/build-client.mjs           # 生成 lib/client.js
 * node tools/build-client.mjs --check   # 只校验产物与源码一致（CI/测试用）
 * ```
 *
 * @module dsh-session-persistence-in-project/tools/build-client
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 源码相对仓库根的位置。 */
export const CLIENT_SOURCE = 'client/plugin.js'
/** 产物相对仓库根的位置 —— 必须与 package.json 的 `exports["./client"]` 一致。 */
export const CLIENT_OUTPUT = 'lib/client.js'

/**
 * 解析仓库根目录。
 *
 * @returns 绝对路径。
 */
function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * 计算内容的 sha256。
 *
 * @param input - 文本。
 * @returns 十六进制摘要。
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 生成 bundle 内容。
 *
 * @param options - `root`（仓库根）。
 * @returns `{ content, packageName, source }`。
 */
export function build(options = {}) {
  const root = options.root ?? repoRoot()
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const source = fs.readFileSync(path.join(root, CLIENT_SOURCE), 'utf8')
  if (/^\s*(import|export)\s/m.test(source)) {
    throw new Error(`${CLIENT_SOURCE} 不能出现 import/export：它是 factory 体，平台模块靠作用域里的 require 取`)
  }
  const content = [
    '/* 生成物，勿手改：由 tools/build-client.mjs 从 client/plugin.js 生成。 */',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(manifest.name)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    source.replace(/\n+$/, ''),
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ].join('\n')
  return { content, packageName: manifest.name, source }
}

/**
 * 命令行入口。
 *
 * @param argv - `process.argv.slice(2)`。
 * @returns 退出码。
 */
export function main(argv) {
  const root = repoRoot()
  const check = argv.includes('--check')
  const unknown = argv.filter((arg) => arg !== '--check')
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(' ')}`)
    return 2
  }

  const { content, packageName } = build({ root })
  const target = path.join(root, CLIENT_OUTPUT)
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
      console.error(`${CLIENT_OUTPUT} 与 ${CLIENT_SOURCE} 不一致；跑 \`node tools/build-client.mjs\` 重新生成。`)
      return 1
    }
    console.log(`客户端 bundle 可重放：${CLIENT_OUTPUT} ← ${CLIENT_SOURCE}（id=${packageName}，${sha256(content).slice(0, 12)}）`)
    return 0
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  console.log(`已生成 ${CLIENT_OUTPUT}（id=${packageName}，${content.length} 字节）`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exit(main(process.argv.slice(2)))
}

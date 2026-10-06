#!/usr/bin/env node
/**
 * 从 DSH 的 `app.asar` 里抽出一份可运行的 `node_modules`，供本仓库的测试使用。
 *
 * 为什么需要它：`src/router.js` 的 peer 依赖（`@deepseek-ai/cordis`、
 * `@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-session-persistence-jsonl`）
 * 只随 DSH 一起分发、不在公共 registry 上，而它们的运行时代码在 `app.asar` 里。
 * 测试要跑真实后端，就得先把这些包还原成普通文件。
 *
 * ```
 * node tools/harness-sandbox.mjs                        # 装到 <repo>/node_modules
 * node tools/harness-sandbox.mjs --dest /tmp/harness    # 装到别处
 * node tools/harness-sandbox.mjs --asar /path/app.asar  # 指定别的 DSH 安装
 * node tools/harness-sandbox.mjs --list                 # 只列版本，不落盘
 * ```
 *
 * node_modules 已在 .gitignore 里；这是开发工具，不是发布产物。
 *
 * @module dsh-session-persistence-in-project/tools/harness-sandbox
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 默认的 DSH 安装位置（macOS 应用包）。 */
export const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * 本插件的 peer 依赖 —— 测试真正需要的最小闭包起点。
 *
 * 与 package.json 的 `peerDependencies` 保持一致：DSH 的插件解析只认**声明过**的
 * peer（未声明的名字会退回普通查找并失败），所以这份清单不是装饰。
 */
export const ROOT_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-format',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  // 扁平分叉（vendor/）与官方后端 import 的是同一批包，但它的 import 是**从本插件
  // 出发**解析的，所以必须在 package.json 里逐个声明成 peer，并在这里进入闭包。
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v3-to-v4',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/node-addon-system',
]

/** asar 里的包根目录前缀。 */
const NODE_MODULES_PREFIX = 'dsh/node_modules/'

/**
 * 打开 asar 并解析它的头部索引。
 *
 * 格式：`[u32 4][u32 头部缓冲区长度][u32 pickle 载荷长度][u32 JSON 文本长度][JSON...]`，
 * 文件数据从 `8 + 头部缓冲区长度` 开始。
 *
 * @param archive - asar 绝对路径。
 * @returns `{ entries, readEntry, packageDirs }`。
 */
export function openArchive(archive) {
  const fd = fs.openSync(archive, 'r')
  const sizeBuffer = Buffer.alloc(8)
  fs.readSync(fd, sizeBuffer, 0, 8, 0)
  const headerBufferSize = sizeBuffer.readUInt32LE(4)
  const headerBuffer = Buffer.alloc(headerBufferSize)
  fs.readSync(fd, headerBuffer, 0, headerBufferSize, 8)
  const header = JSON.parse(headerBuffer.subarray(8, 8 + headerBuffer.readUInt32LE(4)).toString('utf8'))
  const base = 8 + headerBufferSize

  const entries = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files) walk(entry, entryPath)
      else entries.push({ path: entryPath, size: entry.size, unpacked: entry.unpacked === true, offset: Number(entry.offset) })
    }
  }
  walk(header, '')

  const readEntry = (entry) => {
    if (entry.unpacked) return fs.readFileSync(`${archive}.unpacked/${entry.path}`)
    const buffer = Buffer.alloc(entry.size)
    fs.readSync(fd, buffer, 0, entry.size, base + entry.offset)
    return buffer
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const packageDirs = new Map()
  for (const entry of entries) {
    if (!entry.path.endsWith('/package.json')) continue
    const dir = entry.path.slice(0, -'/package.json'.length)
    const at = dir.lastIndexOf('/node_modules/')
    const name = at < 0 ? dir.slice(NODE_MODULES_PREFIX.length) : dir.slice(at + '/node_modules/'.length)
    if (name === '' || name.includes('node_modules')) continue
    if (!packageDirs.has(name)) packageDirs.set(name, [])
    packageDirs.get(name).push(dir)
  }

  return {
    entries,
    readEntry,
    byPath,
    packageDirs,
    readPackageJson: (dir) => JSON.parse(readEntry(byPath.get(`${dir}/package.json`)).toString('utf8')),
  }
}

/**
 * 解析从一个包出发的全部依赖（`dependencies` + `peerDependencies`）。
 *
 * @param archive - {@link openArchive} 的结果。
 * @param roots - 起始包名。
 * @returns 包名 → 该包在 asar 中的目录，按广度优先顺序。
 */
export function resolveClosure(archive, roots) {
  const resolved = new Map()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (resolved.has(name)) continue
    const candidates = archive.packageDirs.get(name)
    if (candidates === undefined) continue
    const dir = candidates[0]
    resolved.set(name, dir)
    let manifest
    try {
      manifest = archive.readPackageJson(dir)
    } catch {
      continue
    }
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      // 平台相关的原生包只出现在 optionalDependencies 里（如 node-addon-system-<platform>-<arch>），
      // 而 JSONL 后端在运行时按 platform/arch 拼名字 require，漏了它就拿不到文件锁。
      ...manifest.optionalDependencies,
    })) {
      if (!resolved.has(dependency)) queue.push(dependency)
    }
  }
  return resolved
}

/**
 * 把闭包里的包落到 `<dest>/node_modules`（扁平布局，与 DSH 自己的一致）。
 *
 * @param archive - {@link openArchive} 的结果。
 * @param resolved - {@link resolveClosure} 的结果。
 * @param dest - 目标根目录。
 * @returns 写入的包数与字节数。
 */
export function extractClosure(archive, resolved, dest) {
  let bytes = 0
  for (const [name, dir] of resolved) {
    for (const entry of archive.entries) {
      if (!entry.path.startsWith(`${dir}/`)) continue
      const relative = entry.path.slice(dir.length + 1)
      const target = path.join(dest, 'node_modules', name, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, archive.readEntry(entry))
      bytes += entry.size ?? 0
    }
  }
  return { packages: resolved.size, bytes }
}

/**
 * 命令行入口。
 *
 * @param argv - `process.argv.slice(2)`。
 */
export function main(argv) {
  const options = { dest: null, asar: DEFAULT_ASAR, list: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dest') options.dest = argv[++i]
    else if (arg === '--asar') options.asar = argv[++i]
    else if (arg === '--list') options.list = true
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  if (!fs.existsSync(options.asar)) {
    console.error(`asar not found: ${options.asar}\n（用 --asar 指定本机 DSH 的 app.asar）`)
    process.exit(1)
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dest = path.resolve(options.dest ?? repoRoot)

  const archive = openArchive(options.asar)
  const resolved = resolveClosure(archive, ROOT_PACKAGES)

  const missing = ROOT_PACKAGES.filter((name) => !resolved.has(name))
  if (missing.length > 0) {
    console.error(`asar 里缺少这些包：${missing.join(', ')}`)
    process.exit(1)
  }
  if (options.list) {
    for (const [name, dir] of resolved) {
      const manifest = archive.readPackageJson(dir)
      console.log(`${name}@${manifest.version}`)
    }
    return
  }

  const { packages, bytes } = extractClosure(archive, resolved, dest)
  console.log(`已写入 ${dest}/node_modules：${packages} 个包，${(bytes / 1048576).toFixed(1)} MiB`)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main(process.argv.slice(2))
}

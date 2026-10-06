/**
 * 落点登记表 —— 解决「冷启动看不见项目内会话」。
 *
 * `open(id)` / `stat(id)` / `list()` 只拿到 id，拿不到 cwd；而官方后端的查找范围
 * 就是它自己的 `root`（`findLog` 只在该 root 下扫项目目录）。所以只要知道
 * 「这个 id 可能在哪些 root 里」，问题就解决了 —— root 的数量是有限的、可枚举的，
 * 而 cwd 是无限的。
 *
 * 默认根永远在候选里；项目内的落点是本插件**见过**的那些。进程重启之后要还记得，
 * 就得落盘，于是有了这张登记表：
 *
 * ```
 * <DSH_HOME>/session-persistence-in-project/roots.json
 * { "version": 1, "roots": ["/abs/project/.dsh/sessions", ...] }   // 最近使用在前
 * ```
 *
 * 登记是**尽力而为**的：写失败只记一笔，绝不让会话操作失败。表丢了不算灾难 ——
 * 项目下次被使用时会被重新登记，只是那之前它的历史会话在 `list()` 里看不见。
 *
 * @module dsh-session-persistence-in-project/roots
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 登记表格式版本。 */
export const INDEX_VERSION = 1
/** DSH home 下本插件自己的目录名。 */
export const INDEX_DIR = 'session-persistence-in-project'
/** 登记表文件名。 */
export const INDEX_FILE = 'roots.json'

/**
 * 解析 harness home：`$DSH_HOME` 优先，其次 `~/.dsh`。
 *
 * 与官方 `resolveDshHome` 的约定一致（见 `@deepseek-ai/dsh-anonymous-user-id` 的说明）。
 *
 * @param env - 环境变量来源，便于测试注入。
 * @returns 绝对路径。
 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * 默认的登记表路径。
 *
 * @param env - 环境变量来源，便于测试注入。
 * @returns 绝对路径。
 */
export function defaultIndexFile(env = process.env) {
  return join(dshHome(env), INDEX_DIR, INDEX_FILE)
}

/**
 * 落点登记表：记住「哪些项目落点值得去找」，并在变更时落盘。
 */
export class RootIndex {
  /** 登记表中的项目落点，最近使用在前。 */
  roots = []

  /** 上次读盘/写盘的问题；`null` 表示一路顺利。 */
  lastError = null

  /**
   * @param options - `defaultRoot`（永不登记，因为它永远在候选里）、
   *   `indexFile`（登记表路径）、`maxRoots`（上限，超出时淘汰最久未用的）、
   *   `onError`（写盘/读盘失败的回调，默认吞掉）。
   */
  constructor(options = {}) {
    this.defaultRoot = resolve(options.defaultRoot ?? join(homedir(), '.dsh', 'sessions'))
    this.indexFile = resolve(options.indexFile ?? defaultIndexFile())
    this.maxRoots = options.maxRoots ?? 100
    this.onError = options.onError ?? (() => {})
  }

  /**
   * 读登记表。文件缺失、损坏、版本不符都退化成空表 —— 登记表是优化，不是真相来源。
   *
   * @returns 本对象，便于链式调用。
   */
  load() {
    if (!existsSync(this.indexFile)) return this
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== INDEX_VERSION) {
        throw new Error(`unsupported index version: ${String(parsed?.version)}`)
      }
      const roots = Array.isArray(parsed.roots) ? parsed.roots : []
      const seen = new Set()
      this.roots = roots
        .filter((root) => typeof root === 'string' && root !== '' && resolve(root) !== this.defaultRoot)
        .map((root) => resolve(root))
        .filter((root) => (seen.has(root) ? false : (seen.add(root), true)))
        .slice(0, this.maxRoots)
    } catch (error) {
      this.roots = []
      this.report(error)
    }
    return this
  }

  /**
   * 确认某个落点值得记住。
   *
   * 默认根不登记（它永远在候选里）；已在表里的会挪到最前（最近使用）。
   *
   * @param root - 绝对落点。
   * @returns 登记表是否发生了变化。
   */
  remember(root) {
    const target = resolve(root)
    if (target === this.defaultRoot) return false
    const previous = this.roots
    const next = [target, ...previous.filter((entry) => entry !== target)].slice(0, this.maxRoots)
    if (next.length === previous.length && next.every((entry, i) => entry === previous[i])) return false
    this.roots = next
    this.persist()
    return true
  }

  /**
   * 候选落点：默认根打头，其后依次是登记过的项目落点。
   *
   * @returns 去重后的绝对路径列表。
   */
  candidates() {
    return [this.defaultRoot, ...this.roots]
  }

  /** 把登记表写回磁盘（临时文件 + rename，避免读到半截）。 */
  persist() {
    const payload = `${JSON.stringify({ version: INDEX_VERSION, roots: this.roots }, null, 2)}\n`
    const temporary = `${this.indexFile}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.indexFile), { recursive: true })
      writeFileSync(temporary, payload)
      renameSync(temporary, this.indexFile)
      this.lastError = null
    } catch (error) {
      this.report(error)
    }
  }

  /**
   * 记一笔问题，不打断调用方。
   *
   * @param error - 读盘或写盘的失败。
   */
  report(error) {
    this.lastError = error instanceof Error ? error : new Error(String(error))
    try {
      this.onError(this.lastError)
    } catch {
      // 回调自己抛错也不能反过来影响会话操作
    }
  }
}

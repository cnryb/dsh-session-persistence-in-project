/**
 * 路径编解码与布局常量 —— 零依赖、纯逻辑。
 *
 * 这一层回答的是「官方后端会把某个会话的产物放在哪」，不含任何官方 import：
 * 官方那套 `encodeSegment` / `projectKey` 都在包内部，只能复刻，而复刻的部分
 * 越独立越好测 —— 本文件因此与 harness 无关，`node --test` 直接可跑。
 *
 * {@link module:dsh-session-persistence-in-project/jsonl-layout} 里的产物路径
 * 构造器建立在这些函数之上，并原样再导出它们（历史 import 路径不受影响）。
 *
 * @module dsh-session-persistence-in-project/path-encoding
 */

/** 官方默认的产物编码：带校验帧的 zstd。 */
export const DEFAULT_COMPRESSION = 'zstd'
/** header 里没有 cwd 时，官方使用的项目目录名。 */
export const NO_CWD_DIR = '_no-cwd'
/** 落点布局：官方布局，`root/<项目目录>/<id>/`。 */
export const LAYOUT_LAYERED = 'layered'
/** 落点布局：扁平布局（分叉后端），`root/<id>/`。 */
export const LAYOUT_FLAT = 'flat'

/**
 * 把任意字符串编码成一个安全路径段（官方的 `encodeSegment`）。
 *
 * `[A-Za-z0-9._-]` 之外（含 `~`）的每个 UTF-16 码元都写成 `~XXXX` 大写十六进制，
 * 因此 `.`/`..`/`/`/NUL 都不可能逃出这一段。
 *
 * @param raw - 原始字符串（会话 id）。
 * @returns 单段安全路径。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 把项目绝对路径压成可读的目录名（官方的 `projectKey`，即 `--Users-...--` 那一层）。
 *
 * 分隔符（`/` `\` `:`）的**连续串**折成一个 `-`；其余非法码元同样走 `~XXXX`。
 * 折叠与截断都是有意的有损设计（人可读优先），所以路径不同、目录名可能相同 ——
 * 真正区分会话的是下一层的 id。
 *
 * @param cwd - 项目的绝对路径。
 * @returns `--<可读主体>--`，长度不超过 255。
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

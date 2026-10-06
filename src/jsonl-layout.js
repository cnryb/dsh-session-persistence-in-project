/**
 * 官方 JSONL 后端磁盘布局的镜像 —— 只为**诊断定位**而存在。
 *
 * 官方后端把路径计算藏在包内部（`logPath` 未导出），而 `SessionPersistence` 接缝本身
 * 只约定 `create/open/stat/list/flush` 五个方法。本插件转发调用时并不需要自己算路径：
 * 真正的读写都交给官方子实例。唯一需要本地算路径的场景是 `locate(meta)` ——
 * 它必须**同步**返回一个位置（官方实现也是同步的），而此时子实例可能尚未创建
 * （`ctx.plugin()` 是异步生效的），所以保留一份纯函数镜像作为兜底。
 *
 * 镜像的漂移由 `test/jsonl-layout.test.mjs` 的差分测试钉住：那组测试会实例化真正的
 * 官方后端，对同一批 (cwd, id) 比较两边的路径，任何一侧变了就会红。
 *
 * @module dsh-session-persistence-in-project/jsonl-layout
 */

import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'

/** 官方默认的产物编码：带校验帧的 zstd。 */
export const DEFAULT_COMPRESSION = 'zstd'
/** header 里没有 cwd 时，官方使用的项目目录名。 */
export const NO_CWD_DIR = '_no-cwd'

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

/**
 * 算出某个会话在当前格式代际下的产物路径（官方的 `logPath`）。
 *
 * @param root - 该会话所在的落点根目录。
 * @param cwd - 会话 header 里的项目目录；缺省走 `_no-cwd`。
 * @param id - 会话 id。
 * @param compression - 产物编码，`zstd` 或 `none`。
 * @returns 绝对产物路径。
 */
export function sessionArtifactPath(root, cwd, id, compression = DEFAULT_COMPRESSION) {
  const project = cwd === undefined || cwd === null ? NO_CWD_DIR : projectKey(cwd)
  const suffix = compression === 'zstd' ? '.zstd' : ''
  return join(root, project, encodeSegment(id), `${sessionFormatLogFilename(SESSION_FORMAT_VERSION)}${suffix}`)
}

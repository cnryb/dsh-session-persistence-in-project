/**
 * 官方 JSONL 后端磁盘布局的镜像 —— 只为**诊断定位**而存在。
 *
 * 官方后端把路径计算藏在包内部（`logPath` 未导出），而 `SessionPersistence` 接缝本身
 * 只约定 `create/open/stat/list/flush` 五个方法。本插件转发调用时并不需要自己算路径：
 * 真正的读写都交给官方子实例。唯一需要本地算路径的场景是 `locate(meta)` ——
 * 它必须**同步**返回一个位置（官方实现也是同步的），而此时子实例可能尚未创建
 * （`ctx.plugin()` 是异步生效的），所以保留一份纯函数镜像作为兜底。
 *
 * 拆成两层：路径段编解码与布局常量（`./path-encoding.js`，零依赖、可脱离 harness
 * 测试）在这里再导出，本文件只保留需要官方常量的产物路径构造器。
 *
 * 镜像的漂移由 `test/jsonl-layout.test.mjs` 的差分测试钉住：那组测试会实例化真正的
 * 官方后端，对同一批 (cwd, id) 比较两边的路径，任何一侧变了就会红。
 *
 * @module dsh-session-persistence-in-project/jsonl-layout
 */

import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import {
  DEFAULT_COMPRESSION,
  LAYOUT_FLAT,
  LAYOUT_LAYERED,
  NO_CWD_DIR,
  encodeSegment,
  projectKey,
} from './path-encoding.js'

export {
  DEFAULT_COMPRESSION,
  LAYOUT_FLAT,
  LAYOUT_LAYERED,
  NO_CWD_DIR,
  encodeSegment,
  projectKey,
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

/**
 * 扁平布局的产物路径：`root/<id>/session.v<版本>.jsonl[.zstd]`。
 *
 * 官方后端没有这个布局（`projectDir()` 硬编码了项目层），它由
 * `vendor/dsh-session-persistence-jsonl-flat` 提供 —— 只在**项目内落点**上用：
 * 那里只有一个项目，再套一层 `--<cwd>--` 纯属重复。默认根不能用它：那是多个项目
 * 共用的容器，项目层是必需的。
 *
 * 与 {@link sessionArtifactPath} 一样，这是给同步的 `locate()` 兜底用的镜像；
 * 差分测试（`test/jsonl-layout.test.mjs`）会把它和分叉后端的 `locate()` 钉在一起。
 *
 * @param root - 项目内落点根目录。
 * @param id - 会话 id。
 * @param compression - 产物编码，`zstd` 或 `none`。
 * @returns 绝对产物路径。
 */
export function flatSessionArtifactPath(root, id, compression = DEFAULT_COMPRESSION) {
  const suffix = compression === 'zstd' ? '.zstd' : ''
  return join(root, encodeSegment(id), `${sessionFormatLogFilename(SESSION_FORMAT_VERSION)}${suffix}`)
}

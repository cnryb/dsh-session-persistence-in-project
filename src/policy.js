/**
 * 项目级落点决策 —— 零依赖、纯逻辑。
 *
 * 这一层只回答一个问题：某个项目目录里的会话，应该落在默认根，还是落在项目里？
 * 它不依赖 cordis、不依赖任何官方包，因此可以脱离 harness 单独测试。
 *
 * @module dsh-session-persistence-in-project/policy
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 开关文件所在目录，相对项目根。 */
export const SWITCH_DIR = '.dsh'
/** 首选开关文件名。 */
export const SWITCH_FILE = 'project.yml'
/** 备用开关文件名：纯 JSON，不需要 YAML 解析。 */
export const SWITCH_FILE_JSON = 'project.json'
/** 开启后项目内的默认落点，相对项目根。 */
export const DEFAULT_PROJECT_ROOT = '.dsh/sessions'
/** 未配置 defaultRoot 时的兜底默认根，与 DSH 自身的默认一致。 */
export const FALLBACK_DEFAULT_ROOT = join(homedir(), '.dsh', 'sessions')
/** 覆盖开关的环境变量（取 `project` 或 `default`）。 */
export const ENV_LOCATION = 'DSH_SESSION_LOCATION'

/** 落在默认根（`~/.dsh/sessions`）。 */
export const LOCATION_DEFAULT = 'default'
/** 落在项目内（默认 `<项目>/.dsh/sessions`）。 */
export const LOCATION_PROJECT = 'project'

/**
 * 解析开关文件用到的扁平 YAML 子集。
 *
 * 支持：整行注释、空行、`键: 值`、单/双引号、`true`/`false`。
 * 不支持：嵌套、数组、多行字符串 —— 需要时再引入 `yaml` 依赖，别在这里硬撑。
 *
 * @param text - 开关文件全文。
 * @returns 扁平键值表。
 */
export function parseSwitchYaml(text) {
  const values = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    if (key === '') continue
    values[key] = coerceScalar(line.slice(at + 1).trim())
  }
  return values
}

/**
 * 去掉一层引号，并把布尔字面量转成布尔值。
 *
 * @param value - 已 trim 的原始值文本。
 * @returns 标量值。
 */
function coerceScalar(value) {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/**
 * 读取项目下的开关文件。
 *
 * @param projectDir - 项目根目录。
 * @returns `null` 表示未开启；否则给出 `source`（文件路径）与 `values`。
 *   `invalid` 表示文件存在但无法解析 —— 调用方应据此退回默认落点并告警。
 */
export function readSwitch(projectDir) {
  const dir = join(projectDir, SWITCH_DIR)
  const yml = join(dir, SWITCH_FILE)
  const json = join(dir, SWITCH_FILE_JSON)
  if (existsSync(yml)) {
    try {
      return { source: yml, values: parseSwitchYaml(readFileSync(yml, 'utf8')), invalid: null }
    } catch (error) {
      return { source: yml, values: {}, invalid: String(error) }
    }
  }
  if (existsSync(json)) {
    try {
      return { source: json, values: JSON.parse(readFileSync(json, 'utf8')), invalid: null }
    } catch (error) {
      return { source: json, values: {}, invalid: String(error) }
    }
  }
  return null
}

/**
 * 把开关文件的字面内容翻译成落点判定。
 *
 * 语义：文件不在 → 默认；文件在但没写 `sessions` → 视为开启；写 `sessions: default`
 * 则显式否决（仓库里随代码分发开关文件时用得上）。取值非法一律退回默认 ——
 * 持久化插件宁可不动用户数据，也不能因为一个拼写错误把会话换个地方存。
 *
 * @param sw - {@link readSwitch} 的结果。
 * @returns 判定结果，含 `reason` 便于诊断。
 */
function interpretSwitch(sw) {
  if (sw === null) return { location: LOCATION_DEFAULT, reason: 'no-switch-file', switchFile: null }
  const raw = sw.values.sessions
  const custom = typeof sw.values.sessionsRoot === 'string' ? sw.values.sessionsRoot : undefined
  const base = { switchFile: sw.source, sessionsRoot: custom, invalid: sw.invalid }
  if (sw.invalid) return { ...base, location: LOCATION_DEFAULT, reason: 'unparsable-switch-file' }
  if (raw === undefined) return { ...base, location: LOCATION_PROJECT, reason: 'switch-present' }
  if (raw === true || raw === LOCATION_PROJECT) return { ...base, location: LOCATION_PROJECT, reason: 'switch-says-project' }
  if (raw === false || raw === LOCATION_DEFAULT) return { ...base, location: LOCATION_DEFAULT, reason: 'switch-says-default' }
  return { ...base, location: LOCATION_DEFAULT, reason: 'invalid-switch-value', invalidValue: raw }
}

/**
 * 定下某个项目的会话落点。
 *
 * @param projectDir - 会话所属项目目录（会话 header 里的 cwd）。
 * @param options - `defaultRoot` 覆盖默认根；`env` 覆盖环境变量来源（便于测试）。
 * @returns `location`、绝对 `root`、判定 `reason` 与命中的开关文件。
 */
export function resolveLocation(projectDir, options = {}) {
  const project = resolve(projectDir ?? process.cwd())
  const defaultRoot = resolve(options.defaultRoot ?? FALLBACK_DEFAULT_ROOT)
  const env = options.env ?? process.env
  const override = env[ENV_LOCATION]

  const decision = override === LOCATION_PROJECT || override === LOCATION_DEFAULT
    ? { location: override, reason: 'env-override', switchFile: null }
    : interpretSwitch(readSwitch(project))

  const root = decision.location === LOCATION_PROJECT
    ? resolveProjectRoot(project, decision.sessionsRoot)
    : defaultRoot

  return {
    projectDir: project,
    location: decision.location,
    root,
    reason: decision.reason,
    switchFile: decision.switchFile,
    invalidValue: decision.invalidValue,
  }
}

/**
 * 把项目内落点解析成绝对路径。
 *
 * @param project - 绝对项目路径。
 * @param sessionsRoot - 开关文件里的自定义落点，相对路径按项目根解析。
 * @returns 绝对落点。
 */
function resolveProjectRoot(project, sessionsRoot) {
  if (sessionsRoot === undefined) return resolve(project, DEFAULT_PROJECT_ROOT)
  return isAbsolute(sessionsRoot) ? sessionsRoot : resolve(project, sessionsRoot)
}

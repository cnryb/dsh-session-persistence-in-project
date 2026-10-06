/**
 * `dsh-session-persistence-in-project` 插件入口。
 *
 * 默认导出是可加载的插件类（与官方 `dsh-session-persistence-jsonl` 同形），
 * 另外导出策略层与落点登记表，便于宿主或测试直接复用。
 *
 * 装配方式：一个进程只能有一个 `ctx.sessionPersistence` 提供方，所以要先禁用
 * 官方 JSONL 后端，再插入本插件。片段见 README。
 *
 * @module dsh-session-persistence-in-project
 */

export { ProjectScopedSessionPersistence, ProjectScopedSessionPersistence as default } from './router.js'
export {
  DEFAULT_PROJECT_ROOT,
  ENV_LOCATION,
  FALLBACK_DEFAULT_ROOT,
  LOCATION_DEFAULT,
  LOCATION_PROJECT,
  SWITCH_DIR,
  SWITCH_FILE,
  SWITCH_FILE_JSON,
  parseSwitchYaml,
  readSwitch,
  resolveLocation,
} from './policy.js'
export {
  DEFAULT_COMPRESSION,
  NO_CWD_DIR,
  encodeSegment,
  projectKey,
  sessionArtifactPath,
} from './jsonl-layout.js'
export { INDEX_DIR, INDEX_FILE, INDEX_VERSION, RootIndex, defaultIndexFile, dshHome } from './roots.js'

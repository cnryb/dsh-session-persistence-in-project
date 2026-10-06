/**
 * 测试用的 harness 装载器。
 *
 * 本插件的 peer 依赖只随 DSH 分发，不在公共 registry 上。要跑真实后端的测试，
 * 先执行 `node tools/harness-sandbox.mjs`（从本机 DSH 的 app.asar 里还原这些包）。
 * 没还原时这些测试会**跳过**而不是失败 —— 纯逻辑测试（policy / roots / layout 的
 * 自洽部分）不需要 harness，任何时候都该能跑。
 *
 * @module dsh-session-persistence-in-project/test/helpers/harness
 */

/** 跳过测试时给出的提示。 */
export const HARNESS_HINT = '需要 harness 依赖：先运行 `node tools/harness-sandbox.mjs`（需本机装有 DSH）'

/**
 * 尝试装载 harness 侧的包。
 *
 * @returns 成功时给出各模块；失败时给出 `error`。
 */
export async function loadHarness() {
  try {
    const [cordis, persistence, jsonl, format, session] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-session-persistence'),
      import('@deepseek-ai/dsh-session-persistence-jsonl'),
      import('@deepseek-ai/dsh-session-format'),
      import('@deepseek-ai/dsh-session'),
    ])
    return { cordis, persistence, jsonl, format, session }
  } catch (error) {
    return { error }
  }
}

/**
 * 造一个合法的会话 header。
 *
 * 字段集由官方 v4 校验器定死：`version`/`id`/`createdAt`/`isSeeded`/`delegationDepth`
 * 必填，`cwd` 可省但必须绝对。
 *
 * @param id - 会话 id。
 * @param cwd - 项目目录；`undefined` 表示不带 cwd。
 * @param overrides - 额外字段。
 * @returns 会话 header。
 */
export function makeHeader(id, cwd, overrides = {}) {
  return {
    version: 4,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    delegationDepth: 0,
    ...(cwd === undefined ? {} : { cwd }),
    ...overrides,
  }
}

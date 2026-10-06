/**
 * 按项目路由的会话持久化后端。
 *
 * 它自己不做任何存储，而是按会话 header 里的 cwd 决定落点，再把调用转交给
 * 该落点上的官方 JSONL 后端子实例。这样压缩、格式迁移、崩溃恢复仍然由官方
 * 后端负责，本插件只负责「存哪儿」。
 *
 * 一个进程只能有一个 `ctx.sessionPersistence` 提供方，所以装配方式是
 * **禁用官方后端 + 插入本插件**（见 README 的安装片段）。
 *
 * ## 为什么是「每落点一个子实例」
 *
 * 官方后端的 `root` 在构造时就 `resolve()` 成定值，之后不再变；而落点必须按
 * **每次会话操作**决定（同一进程服务多个工作区）。官方文档自己把「项目本地 root」
 * 列为受支持用法，缺的只是「按项目切换」这一层路由。
 *
 * ## 三个必须知道的约束（都是实测结论，不是推演）
 *
 * 1. **子实例必须挂在隔离作用域里。** 官方后端把自己注册为 `sessionPersistence`；
 *    同一个 isolate 里注册第二次会抛
 *    `service "sessionPersistence" has been registered at <...>`。所以每个子实例
 *    走 `ctx.isolate('sessionPersistence')`，拿自己的一份注册位。
 * 2. **`ctx.plugin()` 是异步生效的。** 返回的对象是 thenable，必须 `await` 之后
 *    `fork.ctx.sessionPersistence` 才拿得到实例；同步取会抛
 *    `cannot get property "sessionPersistence" without inject`。
 * 3. **一个 id 只能落在一个子实例里。** 每个子实例都会监听 `session/event`，
 *    并按 id 路由到自己持有的写句柄；同一个 id 在两个 root 里都有活写句柄时，
 *    事件会被**静默写进两份日志**。所以 create 前有一道跨落点查重。
 *
 * ## 查找：root 是有限的，cwd 是无限的
 *
 * `open(id)` / `stat(id)` / `list()` 只拿到 id。好消息是官方后端的
 * `findLog(id)` 会扫自己 root 下的**所有**项目目录，所以不需要 id→cwd；
 * 只需要回答「这个 id 可能在哪些 root 里」—— 默认根 + 登记过的项目落点
 * （见 `./roots.js`），逐个 `stat(id)` 探测即可，命中即返回。
 *
 * @module dsh-session-persistence-in-project/router
 */

import z from '@deepseek-ai/schemastery'
import {
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { sessionArtifactPath } from './jsonl-layout.js'
import { FALLBACK_DEFAULT_ROOT, LOCATION_DEFAULT, LOCATION_PROJECT, resolveLocation } from './policy.js'
import { RootIndex, defaultIndexFile } from './roots.js'

/**
 * 按项目把会话分流到默认根或项目内落点的持久化服务。
 */
export class ProjectScopedSessionPersistence extends SessionPersistence {
  static Config = z.object({
    /** 未开启开关的项目共用的默认根，应与 DSH 自身的默认一致。 */
    defaultRoot: z.string().default(FALLBACK_DEFAULT_ROOT),
    /** 落点登记表路径；默认 `<DSH_HOME>/session-persistence-in-project/roots.json`。 */
    indexFile: z.string(),
    /** 登记表最多记多少个项目落点，超出时淘汰最久未用的。 */
    maxIndexedRoots: z.number().default(100),
  })

  /** 诊断用的后端标签；覆盖 `Service.name`，但不改服务键。 */
  name = 'session-persistence-in-project'

  /** 项目 cwd → 落点判定结果，避免每次调用都读盘。 */
  decisions = new Map()

  /** 落点 → `{ promise, backend, fork }`，即该落点上的官方 JSONL 子实例。 */
  children = new Map()

  /** 会话 id → 落点，命中后可跳过逐落点探测。 */
  idRoots = new Map()

  /**
   * 挂子实例时用的上下文 —— 必须是构造时拿到的那个，不能用 `this.ctx`。
   *
   * 服务被 `ctx.sessionPersistence` 取出来用的时候，cordis 会把方法绑到一个
   * **影子对象**上（影子指向取服务的那一侧），从影子出发解析服务会走到取服务
   * 那一侧的 fiber 上。于是用 `this.ctx.plugin(JsonlSessionPersistence)` 挂出来的
   * 子 fiber 里，`fork.ctx.sessionPersistence` 解析回来的是**路由器自己** ——
   * `create()` 一路递归下去，直到爆栈或 OOM。
   *
   * 用法上还有个后果：影子上下文挂在根 fiber 下，从它挂出去的子实例不归本插件所有，
   * 本插件被卸载时子实例不会跟着走、句柄不会被排空。用构造时的 ctx 两个问题一起解决。
   *
   * 注意这里是**普通字段**而不是 `#private`：影子对象是 `Object.create(服务实例)`
   * 出来的，私有字段不存在于影子对象上，读它会直接抛 TypeError。
   */
  spawnContext

  /**
   * @param ctx - cordis 上下文。
   * @param config - 见 {@link ProjectScopedSessionPersistence.Config}。
   */
  constructor(ctx, config) {
    super(ctx)
    this.spawnContext = ctx
    this.config = config
    this.defaultRoot = resolve(config.defaultRoot)
    this.index = new RootIndex({
      defaultRoot: this.defaultRoot,
      indexFile: resolve(config.indexFile ?? defaultIndexFile()),
      maxRoots: config.maxIndexedRoots,
      onError: (error) => this.warn(`落点登记表不可用（${this.index?.indexFile ?? '?'}）：${error.message}`),
    })
    this.index.load()
  }

  /**
   * 定下某个项目 cwd 的落点，并缓存判定结果。
   *
   * 缓存是刻意的：开关文件在进程生命周期内变动属于部署动作，重启即生效；
   * 每个会话操作都去 stat 一次磁盘不值当。
   *
   * 没有 cwd 的会话不猜 `process.cwd()` —— 那对 DSH 主进程来说毫无意义 ——
   * 直接按默认根处理；官方后端会把它归到该根下的 `_no-cwd`。
   *
   * @param cwd - 会话 header 里的项目目录。
   * @returns {@link resolveLocation} 的结果（无 cwd 时给出 `no-cwd` 判定）。
   */
  decide(cwd) {
    const key = typeof cwd === 'string' && cwd !== '' ? resolve(cwd) : ''
    let decision = this.decisions.get(key)
    if (decision === undefined) {
      decision = key === ''
        ? { projectDir: null, location: LOCATION_DEFAULT, root: this.defaultRoot, reason: 'no-cwd', switchFile: null }
        : resolveLocation(key, { defaultRoot: this.defaultRoot })
      this.decisions.set(key, decision)
    }
    return decision
  }

  /**
   * 取（或懒建）某个落点上的官方 JSONL 后端子实例。
   *
   * 同一落点只建一次：并发调用共享同一个 promise。构造失败时把条目清掉，
   * 让下一次调用有机会重试（比如目录权限被修好之后）。
   *
   * @param root - 绝对落点。
   * @returns 该落点上的后端实例。
   */
  async backendFor(root) {
    let entry = this.children.get(root)
    if (entry === undefined) {
      entry = { backend: null, promise: null }
      this.children.set(root, entry)
      entry.promise = (async () => {
        const scope = this.spawnContext.isolate('sessionPersistence')
        const fork = scope.plugin(JsonlSessionPersistence, { root })
        await fork
        entry.fork = fork
        entry.backend = fork.ctx.sessionPersistence
        return entry.backend
      })()
      // 没人 await 时不要让 Node 报 unhandled rejection；调用方拿到的仍是原 promise。
      entry.promise.catch(() => {})
      try {
        await entry.promise
      } catch (error) {
        this.children.delete(root)
        throw error
      }
    }
    return entry.promise
  }

  /**
   * 候选落点：默认根打头，其后是登记过的项目落点（最近使用在前，已去重）。
   *
   * @returns 绝对路径列表。
   */
  candidateRoots() {
    return this.index.candidates()
  }

  /**
   * 某个落点现在值得探测吗？
   *
   * 目录不存在就跳过（省一次 readdir）；但已经建过子实例的落点必须继续问 ——
   * 那里可能有「已创建、尚未落盘」的会话，磁盘上还什么都没有。
   *
   * @param root - 绝对落点。
   * @returns 是否探测。
   */
  probeable(root) {
    return this.children.has(root) || existsSync(root)
  }

  /**
   * 把 id 解析到落点。
   *
   * 先查缓存；缓存落空（或那个落点已经不认这个 id 了）再按
   * 「默认根 → 登记过的项目落点」逐个探测。逐个探测用 `stat`，因为它在
   * 会话不存在时返回 `undefined` 而不是抛错，正好当探针用。
   *
   * @param id - 会话 id。
   * @param options - 透传的 `signal`。
   * @returns `{ root, backend, snapshot }`，或 `undefined` 表示哪里都没有。
   */
  async resolveById(id, options) {
    const cached = this.idRoots.get(id)
    if (cached !== undefined) {
      const backend = await this.backendFor(cached)
      const snapshot = await backend.stat(id, options)
      if (snapshot !== undefined) return { root: cached, backend, snapshot }
      this.idRoots.delete(id)
    }

    const failures = []
    for (const root of this.candidateRoots()) {
      if (!this.probeable(root)) continue
      try {
        const backend = await this.backendFor(root)
        const snapshot = await backend.stat(id, options)
        if (snapshot !== undefined) {
          this.idRoots.set(id, root)
          return { root, backend, snapshot }
        }
      } catch (error) {
        failures.push(error)
      }
    }
    // 探测过程中的真实失败不能被伪装成「查无此会话」。
    if (failures.length > 0) throw failures[0]
    return undefined
  }

  /**
   * 新建会话：按 header 的 cwd 选落点后转交。
   *
   * @param header - 会话 header，`cwd` 决定落点。
   * @param options - 透传给后端的可选项。
   * @returns 写句柄。
   */
  async create(header, options) {
    const decision = this.decide(header?.cwd)
    await this.assertNoCrossRootDuplicate(header?.id, decision.root)
    const backend = await this.backendFor(decision.root)
    const handle = await backend.create(header, options)
    if (typeof header?.id === 'string' && header.id !== '') this.idRoots.set(header.id, decision.root)
    if (decision.location === LOCATION_PROJECT) this.index.remember(decision.root)
    return handle
  }

  /**
   * 挡住「同一个 id 在两个落点里各建一份」。
   *
   * 官方后端只在自己的 root 里查重。跨 root 重复不会报错，却会让两个子实例
   * 同时持有同一个 id 的活写句柄 —— 每个子实例都监听 `session/event`，
   * 结果是同一段事件被静默写进两份日志。所以建之前先确认 id 没有落在别处。
   *
   * 只有一个候选落点时直接跳过：那时后端自己的查重已经足够。
   *
   * @param id - 会话 id。
   * @param targetRoot - 本次要写入的落点。
   */
  async assertNoCrossRootDuplicate(id, targetRoot) {
    if (typeof id !== 'string' || id === '') return
    if (this.index.roots.length === 0) return
    const found = await this.resolveById(id)
    if (found !== undefined && found.root !== targetRoot) throw new SessionAlreadyExistsError(id)
  }

  /**
   * 打开已有会话：先解析落点，再转交。
   *
   * @param id - 会话 id。
   * @param access - `'read'` 或 `'write'`。
   * @param options - 透传给后端的可选项。
   * @returns 句柄。
   * @throws SessionPersistenceNotFoundError 当所有候选落点都没有这个 id。
   */
  async open(id, access, options) {
    const found = await this.resolveById(id, options)
    if (found === undefined) throw new SessionPersistenceNotFoundError(id)
    return found.backend.open(id, access, options)
  }

  /**
   * 观察已有会话，不需要读日志（`resolveById` 已经顺手拿到了快照）。
   *
   * @param id - 会话 id。
   * @param options - 透传给后端的可选项。
   * @returns 快照，或 `undefined`（接缝约定：不存在时不抛错）。
   */
  async stat(id, options) {
    const found = await this.resolveById(id, options)
    return found?.snapshot
  }

  /**
   * 合并所有可见落点的 `list()`。
   *
   * 可见 = 默认根 + 登记过的项目落点（目录存在的，或已经建过子实例的）。
   * 项目落点读失败只记一笔并跳过：一个陈旧的项目目录不该让整份历史消失；
   * 但默认根读失败会直接抛出，因为那时「合并结果完整」这个前提已经不成立。
   *
   * @param options - 透传给后端的可选项。
   * @returns 各落点快照的并集，顺序不承诺。
   */
  async list(options) {
    const roots = this.candidateRoots().filter((root) => this.probeable(root))
    const snapshots = []
    for (const root of roots) {
      let entries
      try {
        const backend = await this.backendFor(root)
        entries = await backend.list(options)
      } catch (error) {
        if (root === this.defaultRoot) throw error
        this.warn(`跳过落点 ${root}：${error.message}`)
        continue
      }
      for (const snapshot of entries) {
        if (typeof snapshot?.header?.id === 'string') this.idRoots.set(snapshot.header.id, root)
      }
      snapshots.push(...entries)
    }
    return snapshots
  }

  /**
   * 把所有子后端的写入排空 —— 关闭前必须走完，否则丢数据。
   *
   * @throws AggregateError 当任一子后端 flush 失败。
   */
  async flush() {
    const results = await Promise.allSettled(
      [...this.children.values()].map(async (entry) => (await entry.promise).flush()),
    )
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, `${this.name} flush failed`)
  }

  /**
   * 拒绝日志的定位信息：按 header 的 cwd 选落点后转交。
   *
   * 官方 `locate` 是同步的（纯路径计算，不碰磁盘），所以这里也保持同步：
   * 子实例已经建好就转交给它（拿到的就是官方原样的答案），否则用
   * `./jsonl-layout.js` 的镜像算一条等价路径 —— 那份镜像由差分测试钉住。
   *
   * @param meta - 存储的 header。
   * @returns 产物类型与绝对路径。
   */
  locate(meta) {
    const decision = this.decide(meta?.cwd)
    const entry = this.children.get(decision.root)
    if (entry?.backend) return entry.backend.locate(meta)
    return { kind: 'jsonl', path: sessionArtifactPath(decision.root, meta?.cwd, meta?.id) }
  }

  /**
   * 打一条诊断日志。`ctx.logger` 由 cordis 提供（官方后端也在用），
   * 但缺了也不能影响会话操作 —— 诊断失败不是失败。
   *
   * 走 `spawnContext` 而不是 `this.ctx`：后者在方法被代理调用时是影子上下文，
   * 解析结果取决于调用方，日志不该有这种不确定性。
   *
   * @param message - 日志正文。
   */
  warn(message) {
    try {
      this.spawnContext.logger?.warn?.(message)
    } catch {
      // 诊断失败不是失败
    }
  }
}

export default ProjectScopedSessionPersistence

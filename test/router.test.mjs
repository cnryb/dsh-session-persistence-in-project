/**
 * 路由器集成测试 —— 用**真正的官方 JSONL 后端**跑，不是假替身。
 *
 * 覆盖的是 README「未决问题」里那两件事最终落地的样子：
 *
 * - spike-1：父插件能不能拿到子实例（答案是 `ctx.plugin()` 是 thenable，
 *   `await fork` 之后 `fork.ctx.sessionPersistence` 才是实例；并且子实例必须
 *   挂在 `ctx.isolate('sessionPersistence')` 里，否则与父插件的服务名撞车）。
 * - spike-2：`open(id)` 只给 id，落点靠「默认根 + 登记过的项目落点」逐个探测；
 *   登记表落盘，所以冷启动之后仍然看得见项目内的历史会话。
 *
 * 需要 harness 依赖；缺失时整组跳过（见 test/helpers/harness.mjs）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { projectKey } from '../src/jsonl-layout.js'
import ProjectScopedSessionPersistence from '../src/router.js'
import { HARNESS_HINT, loadHarness, makeHeader } from './helpers/harness.mjs'

const harness = await loadHarness()
const skip = harness.error === undefined ? false : HARNESS_HINT

let sandbox
let ctx
let fork
let service
let defaultRoot
let indexFile
let enabledProject
let plainProject

/**
 * 一条能通过官方校验的最小事件批次。
 *
 * 注意 `time` 与 `data` 都是必需的：官方写路径只做 JSON 层面的准入，语义不合法的行
 * 会**照写不误**，等到读回来时才被判成坏行 —— 而读到坏行的表现是
 * `SessionPersistenceCorruptionError: ... torn JSONL record`，非常容易被误读成
 * 「文件被写坏了」。这里的事件形状是从真实会话日志里取的。
 */
const event = (seq) => ({ type: 'turn/start', seq, time: Date.now(), data: { turn: 1 } })

before(async () => {
  if (skip !== false) return
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-router-'))
  defaultRoot = join(sandbox, 'default-sessions')
  indexFile = join(sandbox, 'index', 'roots.json')
  plainProject = join(sandbox, 'projects', 'plain')
  enabledProject = join(sandbox, 'projects', 'enabled')
  mkdirSync(plainProject, { recursive: true })
  mkdirSync(join(enabledProject, '.dsh'), { recursive: true })
  writeFileSync(join(enabledProject, '.dsh', 'project.yml'), '# 文件存在即开启\nsessions: project\n')

  ctx = new harness.cordis.Context()
  fork = ctx.plugin(ProjectScopedSessionPersistence, { defaultRoot, indexFile, maxIndexedRoots: 20 })
  await fork
  service = fork.ctx.sessionPersistence
})

after(async () => {
  if (skip !== false) return
  await fork?.dispose()
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * 建一个会话，写一条事件，落盘并关闭。
 *
 * @param id - 会话 id。
 * @param cwd - 会话所属项目。
 * @returns 该会话的产物绝对路径。
 */
async function seed(id, cwd) {
  const handle = await service.create(makeHeader(id, cwd))
  await handle.append([event(0)])
  await handle.flush()
  const path = service.locate(handle.header).path
  await handle.close()
  return path
}

describe('路由器：服务身份', { skip }, () => {
  it('自己占住 sessionPersistence，而不是把位子让给某个子实例', async () => {
    assert.equal(service.constructor.name, 'ProjectScopedSessionPersistence')
    assert.equal(service.name, 'session-persistence-in-project')
    assert.equal(ctx.sessionPersistence.name, 'session-persistence-in-project')
  })

  it('子实例建了一堆之后，根上的服务仍然是路由器', async () => {
    await seed('identity-plain', plainProject)
    await seed('identity-enabled', enabledProject)
    assert.ok(service.children.size >= 2, `children=${service.children.size}`)
    assert.equal(ctx.sessionPersistence.constructor.name, 'ProjectScopedSessionPersistence')
  })
})

describe('路由器：按项目分流', { skip }, () => {
  it('没有开关文件的项目：落在默认根', async () => {
    const path = await seed('plain-1', plainProject)
    assert.ok(path.startsWith(`${defaultRoot}/`), path)
    assert.ok(existsSync(path), `产物不存在：${path}`)
    assert.equal(service.decide(plainProject).reason, 'no-switch-file')
  })

  it('有开关文件的项目：落在项目里，且不再进默认根', async () => {
    const path = await seed('enabled-1', enabledProject)
    assert.ok(path.startsWith(`${join(enabledProject, '.dsh', 'sessions')}/`), path)
    assert.ok(existsSync(path), `产物不存在：${path}`)
    // 多出来的 --<规范化 cwd>-- 那一层是官方后端加的，不是本插件加的
    assert.ok(path.includes(`/${projectKey(enabledProject)}/`), path)
    assert.equal(service.decide(enabledProject).reason, 'switch-says-project')
  })

  it('落点判定被缓存：同一次进程内不再重复读盘', () => {
    const first = service.decide(plainProject)
    const second = service.decide(plainProject)
    assert.equal(first, second)
  })

  it('header 没有 cwd 时不猜 process.cwd()，按默认根处理', () => {
    const decision = service.decide(undefined)
    assert.equal(decision.reason, 'no-cwd')
    assert.equal(decision.root, defaultRoot)
  })
})

describe('路由器：按 id 找回（spike-2）', { skip }, () => {
  it('stat(id) 不需要 cwd，两个落点都能找到', async () => {
    const plain = await service.stat('plain-1')
    const enabled = await service.stat('enabled-1')
    assert.equal(plain?.header.cwd, plainProject)
    assert.equal(enabled?.header.cwd, enabledProject)
    assert.ok(plain.sizeBytes > 0)
    assert.ok(enabled.sizeBytes > 0)
  })

  it('open(id, read) 读得回自己写的事件', async () => {
    const handle = await service.open('enabled-1', 'read')
    const { events } = await handle.read()
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'turn/start')
    await handle.close()
  })

  it('list() 合并所有可见落点', async () => {
    const ids = (await service.list()).map((snapshot) => snapshot.header.id)
    assert.ok(ids.includes('plain-1'), ids.join(','))
    assert.ok(ids.includes('enabled-1'), ids.join(','))
    assert.equal(new Set(ids).size, ids.length, '不应该出现重复 id')
  })

  it('查无此会话：open 抛 NotFound，stat 返回 undefined（与官方后端一致）', async () => {
    await assert.rejects(() => service.open('no-such-session', 'read'), (error) => {
      assert.equal(error.name, 'SessionPersistenceNotFoundError')
      return true
    })
    assert.equal(await service.stat('no-such-session'), undefined)
  })
})

describe('路由器：登记表与冷启动', { skip }, () => {
  it('项目内会话所在落点被登记，且登记表已落盘', async () => {
    assert.ok(service.index.roots.includes(join(enabledProject, '.dsh', 'sessions')), service.index.roots.join(','))
    assert.equal(existsSync(indexFile), true)
  })

  it('冷启动之后，项目内的历史会话仍然可见、可打开', async () => {
    // 完全换一个进程身份：新的 Context、新的路由器，只共享磁盘
    const cold = new harness.cordis.Context()
    const coldFork = cold.plugin(ProjectScopedSessionPersistence, { defaultRoot, indexFile })
    await coldFork
    const coldService = coldFork.ctx.sessionPersistence
    try {
      const ids = (await coldService.list()).map((snapshot) => snapshot.header.id)
      assert.ok(ids.includes('enabled-1'), `冷启动后看不见项目内会话：${ids.join(',')}`)

      const handle = await coldService.open('enabled-1', 'read')
      assert.equal(handle.header.cwd, enabledProject)
      await handle.close()

      const snapshot = await coldService.stat('enabled-1')
      assert.equal(snapshot?.header.cwd, enabledProject)
    } finally {
      await coldFork.dispose()
    }
  })

  it('登记表没了的极端情况下，会话仍在盘上（只是 list 看不见）', async () => {
    const cold = new harness.cordis.Context()
    const coldFork = cold.plugin(ProjectScopedSessionPersistence, {
      defaultRoot,
      indexFile: join(sandbox, 'index', 'nonexistent.json'),
    })
    await coldFork
    try {
      const coldService = coldFork.ctx.sessionPersistence
      const ids = (await coldService.list()).map((snapshot) => snapshot.header.id)
      assert.ok(ids.includes('plain-1'), '默认根里的会话不依赖登记表')
      assert.equal(ids.includes('enabled-1'), false, '没有登记表就看不见项目内落点')
      assert.ok(existsSync(join(enabledProject, '.dsh', 'sessions')), '但产物还在盘上')
    } finally {
      await coldFork.dispose()
    }
  })
})

describe('路由器：一个 id 只能落一个地方', { skip }, () => {
  it('同一个 id 先在默认根建过，再按项目建会被挡住', async () => {
    await seed('twice-1', plainProject)
    await assert.rejects(() => service.create(makeHeader('twice-1', enabledProject)), (error) => {
      assert.equal(error.name, 'SessionAlreadyExistsError')
      return true
    })
  })

  it('被挡住之后，原来的会话仍然完好', async () => {
    const snapshot = await service.stat('twice-1')
    assert.equal(snapshot?.header.cwd, plainProject)
    assert.equal(service.idRoots.get('twice-1'), defaultRoot)
  })
})

describe('路由器：flush 扇出', { skip }, () => {
  it('一次 flush 覆盖所有子后端，未落盘的会话也随之实体化', async () => {
    const handle = await service.create(makeHeader('flush-1', enabledProject))
    await handle.append([event(0)])
    // 故意不 flush 句柄：服务级 flush 必须替它做完
    await service.flush()
    await handle.close()
    const snapshot = await service.stat('flush-1')
    assert.ok(snapshot.sizeBytes > 0, '服务级 flush 之后产物应该已经落盘')
  })
})

describe('路由器：locate 与真实路径一致', { skip }, () => {
  it('子实例已在时转交官方实现；path 就是磁盘上的那个文件', async () => {
    const snapshot = await service.stat('enabled-1')
    const location = service.locate(snapshot.header)
    assert.equal(location.kind, 'jsonl')
    assert.ok(existsSync(location.path), location.path)
  })

  it('子实例还没建时用镜像兜底，算出来的仍是同一条路径', async () => {
    const cold = new harness.cordis.Context()
    const coldFork = cold.plugin(ProjectScopedSessionPersistence, { defaultRoot, indexFile })
    await coldFork
    try {
      const coldService = coldFork.ctx.sessionPersistence
      const header = { ...makeHeader('enabled-1', enabledProject) }
      const mirrored = coldService.locate(header)
      assert.equal(coldService.children.size, 0, '这一刻还没有任何子实例')
      assert.equal(mirrored.path, service.locate(header).path)
      assert.ok(existsSync(mirrored.path), mirrored.path)
    } finally {
      await coldFork.dispose()
    }
  })
})

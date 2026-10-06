/**
 * 扁平分叉（`vendor/dsh-session-persistence-jsonl-flat`）的行为测试 —— 用真后端跑。
 *
 * 分叉要成立，必须同时满足三件事，缺一件都不能上线：
 *
 * 1. **新的写路径是扁平的**：`<root>/<id>/session.v4.jsonl.zstd`，root 下没有
 *    任何 `--<cwd>--` 形状的目录。
 * 2. **旧的分层数据不能失联**：升级前写在 `<root>/--<cwd>--/<id>/` 的会话要能
 *    `list()` 看见、`open()` 打开、**续写回原目录**（凭空多出一份扁平副本 =
 *    同一个 id 两处文件，比不迁移危险得多）。
 * 3. **两种布局共存不炸**：官方 `listArtifacts()` 见到重复 id 会抛错，所以同一个
 *    id 同时出现在两处时以扁平那份为准。
 *
 * 需要 harness 依赖；缺失时整组跳过（见 test/helpers/harness.mjs）。
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { projectKey } from '../src/path-encoding.js'
import { HARNESS_HINT, loadHarness, makeHeader } from './helpers/harness.mjs'

const harness = await loadHarness()

let FlatBackend
let flatError
try {
  ;({ default: FlatBackend } = await import('../vendor/dsh-session-persistence-jsonl-flat/index.js'))
} catch (error) {
  flatError = error
}

const skip = harness.error === undefined && flatError === undefined ? false : HARNESS_HINT

/**
 * 一条合法的事件：会话级配置事件，不牵扯 turn 生命周期。
 *
 * 事件形状照抄真实会话日志（`turn/start` 一类的 turn 事件有严格的开合关系，
 * 随手造第二条会被关系校验判成坏行）。
 */
const presetEvent = (seq) => ({ type: 'permission/preset', seq, time: Date.now(), data: { preset: 'workspace-write' } })
/** 紧随其后的第二条事件，真实日志里就是这个顺序。 */
const modeEvent = (seq) => ({ type: 'sandbox/mode', seq, time: Date.now(), data: { mode: 'workspace-write' } })

let sandbox
let flatRoot
let legacyRoot
let project
let legacyId

/**
 * 起一个只装了扁平后端的 cordis 上下文。
 *
 * @param rootDir - 该后端的落点。
 * @returns `{ fork, service }`。
 */
async function start(rootDir) {
  const ctx = new harness.cordis.Context()
  const fork = ctx.plugin(FlatBackend, { root: rootDir })
  await fork
  return { fork, service: fork.ctx.sessionPersistence }
}

/**
 * 用**分叉**往某个 root 里写一个扁平会话。
 *
 * @param rootDir - 落点。
 * @param id - 会话 id。
 * @param cwd - 项目目录。
 */
async function seedFlat(rootDir, id, cwd) {
  const { fork, service } = await start(rootDir)
  try {
    const handle = await service.create(makeHeader(id, cwd))
    await handle.append([presetEvent(0)])
    await handle.flush()
    await handle.close()
  } finally {
    await fork.dispose()
  }
}

/**
 * 用**官方**后端往某个 root 里写一个分层会话，模拟升级前的存量数据。
 *
 * @param rootDir - 落点。
 * @param id - 会话 id。
 * @param cwd - 项目目录。
 */
async function seedLegacy(rootDir, id, cwd) {
  const ctx = new harness.cordis.Context()
  const fork = ctx.plugin(harness.jsonl.default, { root: rootDir })
  await fork
  try {
    const handle = await fork.ctx.sessionPersistence.create(makeHeader(id, cwd))
    await handle.append([presetEvent(0)])
    await handle.flush()
    await handle.close()
  } finally {
    await fork.dispose()
  }
}

before(async () => {
  if (skip !== false) return
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-flat-'))
  flatRoot = join(sandbox, 'flat-sessions')
  legacyRoot = join(sandbox, 'legacy-sessions')
  project = join(sandbox, 'project')
  mkdirSync(flatRoot, { recursive: true })
  mkdirSync(legacyRoot, { recursive: true })
  mkdirSync(project, { recursive: true })
  legacyId = 'legacy-1'
  await seedLegacy(legacyRoot, legacyId, project)
})

after(async () => {
  if (skip !== false) return
  rmSync(sandbox, { recursive: true, force: true })
})

describe('扁平分叉：写入布局', { skip }, () => {
  it('新会话直接落在 <root>/<id>/，不再追加 --<cwd>-- 层', async () => {
    const { fork, service } = await start(flatRoot)
    try {
      const handle = await service.create(makeHeader('flat-1', project))
      await handle.append([presetEvent(0)])
      await handle.flush()
      const location = service.locate(handle.header)
      await handle.close()

      assert.equal(location.kind, 'jsonl')
      assert.equal(location.path, join(flatRoot, 'flat-1', 'session.v4.jsonl.zstd'))
      assert.ok(existsSync(location.path), location.path)
    } finally {
      await fork.dispose()
    }
  })

  it('root 下只有会话目录，没有任何 projectKey 形状的目录', () => {
    assert.equal(existsSync(join(flatRoot, projectKey(project))), false, '不该出现 --<cwd>-- 层')
    const entries = readdirSync(flatRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    assert.deepEqual(entries, ['flat-1'])
  })

  it('stat 的 sizeBytes 来自真实文件', async () => {
    const { fork, service } = await start(flatRoot)
    try {
      const snapshot = await service.stat('flat-1')
      assert.equal(snapshot.header.cwd, project)
      assert.ok(snapshot.sizeBytes > 0)
    } finally {
      await fork.dispose()
    }
  })

  it('header 没有 cwd 时照样扁平落在 root 下', async () => {
    const { fork, service } = await start(flatRoot)
    try {
      const handle = await service.create(makeHeader('no-cwd-1', undefined))
      await handle.append([presetEvent(0)])
      await handle.flush()
      const location = service.locate(handle.header)
      await handle.close()
      assert.equal(location.path, join(flatRoot, 'no-cwd-1', 'session.v4.jsonl.zstd'))
      assert.ok(existsSync(location.path), location.path)
    } finally {
      await fork.dispose()
    }
  })
})

describe('扁平分叉：冷启动', { skip }, () => {
  it('换一个进程身份后，扁平会话仍可 list / stat / open', async () => {
    const { fork, service } = await start(flatRoot)
    try {
      const ids = (await service.list()).map((snapshot) => snapshot.header.id)
      assert.ok(ids.includes('flat-1'), ids.join(','))

      const snapshot = await service.stat('flat-1')
      assert.equal(snapshot?.header.cwd, project)

      const handle = await service.open('flat-1', 'read')
      const { events } = await handle.read()
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'permission/preset')
      await handle.close()
    } finally {
      await fork.dispose()
    }
  })

  it('root 还不存在时 list 是空数组、stat 是 undefined，都不抛错', async () => {
    const { fork, service } = await start(join(sandbox, 'not-yet'))
    try {
      assert.deepEqual(await service.list(), [])
      assert.equal(await service.stat('nope'), undefined)
    } finally {
      await fork.dispose()
    }
  })
})

describe('扁平分叉：旧的 --<cwd>-- 分层数据', { skip }, () => {
  it('list() 同时看得见两种布局，且不出现重复 id', async () => {
    await seedFlat(legacyRoot, 'flat-2', project)
    const { fork, service } = await start(legacyRoot)
    try {
      const ids = (await service.list()).map((snapshot) => snapshot.header.id)
      assert.ok(ids.includes(legacyId), ids.join(','))
      assert.ok(ids.includes('flat-2'), ids.join(','))
      assert.equal(new Set(ids).size, ids.length, '不应该出现重复 id')
    } finally {
      await fork.dispose()
    }
  })

  it('open(read) 读得到旧会话，locate() 报告的也是旧路径', async () => {
    const { fork, service } = await start(legacyRoot)
    try {
      const handle = await service.open(legacyId, 'read')
      const { events } = await handle.read()
      assert.equal(events.length, 1)
      const location = service.locate(handle.header)
      await handle.close()

      assert.ok(location.path.startsWith(`${join(legacyRoot, projectKey(project))}/`), location.path)
      assert.ok(existsSync(location.path), location.path)
    } finally {
      await fork.dispose()
    }
  })

  it('续写仍然写回旧目录，不会另造一份扁平副本', async () => {
    const { fork, service } = await start(legacyRoot)
    try {
      const handle = await service.open(legacyId, 'write')
      await handle.append([modeEvent(1)])
      await handle.flush()
      const location = service.locate(handle.header)
      await handle.close()

      assert.ok(location.path.startsWith(`${join(legacyRoot, projectKey(project))}/`), location.path)
      assert.equal(existsSync(join(legacyRoot, legacyId)), false, '不该在扁平位置另造一份')

      const reopened = await service.open(legacyId, 'read')
      const { events } = await reopened.read()
      assert.deepEqual(events.map((event) => event.type), ['permission/preset', 'sandbox/mode'])
      await reopened.close()
    } finally {
      await fork.dispose()
    }
  })

  it('create() 撞上旧会话的 id 会被挡住，不会两处各写一份', async () => {
    const { fork, service } = await start(legacyRoot)
    try {
      await assert.rejects(() => service.create(makeHeader(legacyId, project)), (error) => {
        assert.equal(error.name, 'SessionAlreadyExistsError')
        return true
      })
    } finally {
      await fork.dispose()
    }
  })

  it('同一个 id 在两处都有时，以扁平那份为准且不抛重复 id', async () => {
    // 人为把扁平会话复制进一个旧形状的项目目录
    cpSync(join(legacyRoot, 'flat-2'), join(legacyRoot, '--copied--', 'flat-2'), { recursive: true })
    const { fork, service } = await start(legacyRoot)
    try {
      const snapshots = await service.list()
      const ids = snapshots.map((snapshot) => snapshot.header.id)
      assert.equal(ids.filter((id) => id === 'flat-2').length, 1, ids.join(','))
      const flatHeader = snapshots.find((snapshot) => snapshot.header.id === 'flat-2').header
      assert.equal(service.locate(flatHeader).path, join(legacyRoot, 'flat-2', 'session.v4.jsonl.zstd'))
    } finally {
      await fork.dispose()
    }
  })
})

describe('扁平分叉：flush 扇出', { skip }, () => {
  it('未显式 flush 的句柄也会被服务级 flush 落盘', async () => {
    const { fork, service } = await start(flatRoot)
    try {
      const handle = await service.create(makeHeader('flush-1', project))
      await handle.append([presetEvent(0)])
      await service.flush()
      await handle.close()
      const snapshot = await service.stat('flush-1')
      assert.ok(snapshot.sizeBytes > 0)
    } finally {
      await fork.dispose()
    }
  })
})

describe('扁平分叉：产物仍是标准 jsonl', { skip }, () => {
  it('把扁平产物摆成官方认识的分层形状，官方后端照样读得出来', async () => {
    // 官方 root = probeRoot，会话摆成 probeRoot/<projectKey(cwd)>/<id>/ —— 这正是
    // 扁平产物的内容，证明分叉只改了「放在哪一层」，没有改格式。
    const probeRoot = join(sandbox, 'official-probe')
    cpSync(join(flatRoot, 'flat-1'), join(probeRoot, projectKey(project), 'flat-1'), { recursive: true })

    const ctx = new harness.cordis.Context()
    const fork = ctx.plugin(harness.jsonl.default, { root: probeRoot })
    await fork
    try {
      const service = fork.ctx.sessionPersistence
      const ids = (await service.list()).map((snapshot) => snapshot.header.id)
      assert.deepEqual(ids, ['flat-1'])
      const handle = await service.open('flat-1', 'read')
      const { events } = await handle.read()
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'permission/preset')
      await handle.close()
    } finally {
      await fork.dispose()
    }
  })
})

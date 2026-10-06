/**
 * 布局镜像的差分测试。
 *
 * `src/jsonl-layout.js` 复刻了官方后端的路径计算（未导出，只能复刻）。复刻的
 * 风险是**悄悄漂移**：某天官方改了转义规则，镜像还在按老规则算，`locate()`
 * 就会指到不存在的文件。所以这里不去断言"我认为正确的字符串"，而是实例化真正的
 * 官方后端，对同一批 (cwd, id) 逐条比对两边算出来的路径 —— 任一侧变了就红。
 *
 * 需要 harness 依赖；缺失时整组跳过（见 test/helpers/harness.mjs）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { DEFAULT_COMPRESSION, encodeSegment, flatSessionArtifactPath, projectKey, sessionArtifactPath } from '../src/jsonl-layout.js'
import { HARNESS_HINT, loadHarness } from './helpers/harness.mjs'

const harness = await loadHarness()

let FlatBackend
let flatError
try {
  ;({ default: FlatBackend } = await import('../vendor/dsh-session-persistence-jsonl-flat/index.js'))
} catch (error) {
  flatError = error
}

const skip = harness.error === undefined && flatError === undefined ? false : HARNESS_HINT

/** 有代表性的一批 cwd：分隔符、空格、中文、`~`、`:`、超长、重复斜杠。 */
const CWDS = [
  '/Users/alice/Desktop/github/example/dsh-session-persistence-in-project',
  '/tmp/plain',
  '/tmp/with space/dir',
  '/tmp/中文/项目',
  'C:\\Users\\me\\project',
  '/tmp/~/tilde',
  '/tmp//double//slash',
  '/tmp/trailing/',
  '/tmp/dots/./x/../y',
  `/${'x'.repeat(400)}`,
  '/',
]

/** 有代表性的一批 id：正常 id、空格、分隔符、`~`、点段、unicode。 */
const IDS = [
  'session-0286f8f1-f516-48e8-b3b8-398b892384b1',
  '19d00c4b-6ec3-4a72-81b2-29ecc7f6ffce',
  'with space',
  'with/slash',
  'with\\backslash',
  '~tilde',
  '.',
  '..',
  '中文 id',
  'ends.with.dot',
]

let sandbox
let ctx
let forks

before(async () => {
  if (skip !== false) return
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-layout-'))
  ctx = new harness.cordis.Context()
  forks = []
})

after(async () => {
  if (skip !== false) return
  for (const fork of forks) await fork.dispose()
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * 在临时目录里挂一个官方后端。
 *
 * @param name - 子目录名。
 * @param config - 额外配置（如 compression）。
 * @returns 后端实例。
 */
async function backend(name, config = {}) {
  const root = join(sandbox, name)
  const fork = ctx.isolate('sessionPersistence').plugin(harness.jsonl.default, { root, ...config })
  await fork
  forks.push(fork)
  return { root, instance: fork.ctx.sessionPersistence }
}

describe('jsonl-layout 与官方后端逐条对齐', { skip }, () => {
  it('zstd（默认编码）下每个 (cwd, id) 都与后端 locate() 一致', async () => {
    const { root, instance } = await backend('zstd')
    for (const cwd of CWDS) {
      for (const id of IDS) {
        assert.equal(
          sessionArtifactPath(root, cwd, id),
          instance.locate({ cwd, id }).path,
          `cwd=${cwd} id=${id}`,
        )
      }
    }
  })

  it('compression: none 只改后缀，路径主体一致', async () => {
    const { root, instance } = await backend('plain', { compression: 'none' })
    for (const cwd of CWDS) {
      for (const id of IDS) {
        assert.equal(
          sessionArtifactPath(root, cwd, id, 'none'),
          instance.locate({ cwd, id }).path,
          `cwd=${cwd} id=${id}`,
        )
      }
    }
  })

  it('没有 cwd 的会话走 _no-cwd，两边一致', async () => {
    const { root, instance } = await backend('no-cwd')
    for (const id of IDS) {
      assert.equal(sessionArtifactPath(root, undefined, id), instance.locate({ id }).path, `id=${id}`)
    }
  })

  it('空 id 两边都拒绝（不是只有镜像在拒绝）', async () => {
    const { instance } = await backend('empty-id')
    assert.throws(() => encodeSegment(''), /empty path segment/)
    assert.throws(() => instance.locate({ cwd: '/tmp/x', id: '' }), /empty path segment/)
  })

  it('产物一定落在自己的落点里，且最后一段就是编码后的 id', () => {
    const root = '/tmp/root'
    const path = sessionArtifactPath(root, '/tmp/proj', 'session-1')
    assert.ok(path.startsWith(`${root}/--`))
    assert.ok(path.endsWith(`/session-1/${path.split('/').at(-1)}`))
    assert.match(path.split('/').at(-1), /^session\.v\d+\.jsonl\.zstd$/)
  })
})

describe('扁平镜像与分叉后端逐条对齐', { skip }, () => {
  it('每个 id 都与分叉 locate() 一致，且 cwd 不再参与路径', async () => {
    const root = join(sandbox, 'flat')
    const fork = ctx.isolate('sessionPersistence').plugin(FlatBackend, { root })
    await fork
    forks.push(fork)
    const instance = fork.ctx.sessionPersistence
    for (const id of IDS) {
      assert.equal(flatSessionArtifactPath(root, id), instance.locate({ cwd: '/tmp/anywhere', id }).path, `id=${id}`)
    }
    const first = instance.locate({ cwd: '/tmp/one', id: IDS[0] }).path
    const second = instance.locate({ cwd: '/tmp/two', id: IDS[0] }).path
    assert.equal(first, second, '扁平布局下 cwd 不该影响路径')
  })

  it('没有 cwd 的会话在扁平布局里也是同一条路径', async () => {
    const root = join(sandbox, 'flat-no-cwd')
    const fork = ctx.isolate('sessionPersistence').plugin(FlatBackend, { root })
    await fork
    forks.push(fork)
    const instance = fork.ctx.sessionPersistence
    for (const id of IDS) {
      assert.equal(flatSessionArtifactPath(root, id), instance.locate({ id }).path, `id=${id}`)
    }
  })

  it('扁平路径就是 <root>/<id>/<产物>，没有项目层', () => {
    const root = '/tmp/root'
    const path = flatSessionArtifactPath(root, 'session-1')
    assert.equal(path, `${root}/session-1/${path.split('/').at(-1)}`)
    assert.match(path.split('/').at(-1), /^session\.v\d+\.jsonl\.zstd$/)
    assert.match(flatSessionArtifactPath(root, 'session-1', 'none'), /session\.v\d+\.jsonl$/)
  })
})

describe('编解码本身的语义（不依赖 harness）', () => {
  it('编码后的 id 永远是单段路径，`..` 逃不出去', () => {
    assert.equal(encodeSegment('..'), '~002E~002E')
    assert.equal(encodeSegment('.'), '~002E')
    assert.equal(encodeSegment('a/b'), 'a~002Fb')
    assert.equal(encodeSegment('a\\b'), 'a~005Cb')
    assert.equal(encodeSegment('~'), '~007E')
    assert.equal(encodeSegment('中文'), '~4E2D~6587')
    assert.equal(encodeSegment('plain-id.1_2'), 'plain-id.1_2')
  })

  it('项目目录名折叠连续分隔符、去掉前导横线、超长截断', () => {
    assert.equal(projectKey('/a/b'), '--a-b--')
    assert.equal(projectKey('//a//b'), '--a-b--')
    assert.equal(projectKey('C:\\Users\\me'), '--C-Users-me--')
    assert.equal(projectKey('/'), '--root--')
    const long = projectKey(`/${'x'.repeat(400)}`)
    assert.equal(long.length, 255)
    assert.ok(long.startsWith('--') && long.endsWith('--'))
  })

  it('默认编码是 zstd，产物名跟着格式代际走', () => {
    assert.equal(DEFAULT_COMPRESSION, 'zstd')
    const path = sessionArtifactPath('/root', '/proj', 'id')
    assert.match(path, /session\.v\d+\.jsonl\.zstd$/)
    assert.match(sessionArtifactPath('/root', '/proj', 'id', 'none'), /session\.v\d+\.jsonl$/)
  })
})

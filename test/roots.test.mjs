/**
 * 落点登记表的测试 —— 纯逻辑 + 真磁盘，不需要 harness。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { INDEX_VERSION, RootIndex, defaultIndexFile, dshHome } from '../src/roots.js'

let sandbox

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** 造一个隔离的临时布局。 */
function layout(name) {
  const base = join(sandbox, name)
  const indexFile = join(base, 'index', 'roots.json')
  mkdirSync(dirname(indexFile), { recursive: true })
  return {
    base,
    defaultRoot: join(base, 'default-sessions'),
    indexFile,
    root: (label) => join(base, 'projects', label, '.dsh', 'sessions'),
  }
}

describe('dshHome / defaultIndexFile', () => {
  it('$DSH_HOME 优先于 ~/.dsh', () => {
    assert.equal(dshHome({ DSH_HOME: '/tmp/custom-home' }), '/tmp/custom-home')
    assert.equal(dshHome({}), join(homedir(), '.dsh'))
    assert.equal(dshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  })

  it('登记表默认落在 DSH home 下的插件目录里', () => {
    assert.equal(
      defaultIndexFile({ DSH_HOME: '/tmp/custom-home' }),
      join('/tmp/custom-home', 'session-persistence-in-project', 'roots.json'),
    )
  })
})

describe('RootIndex', () => {
  it('文件缺失时是空表，候选里仍有默认根', () => {
    const { defaultRoot, indexFile } = layout('missing')
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    assert.deepEqual(index.roots, [])
    assert.deepEqual(index.candidates(), [defaultRoot])
    assert.equal(index.lastError, null)
  })

  it('remember 之后写盘，新实例能读回来', () => {
    const { defaultRoot, indexFile, root } = layout('persist')
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    assert.equal(index.remember(root('alpha')), true)
    assert.equal(index.remember(root('beta')), true)

    const reloaded = new RootIndex({ defaultRoot, indexFile }).load()
    assert.deepEqual(reloaded.roots, [root('beta'), root('alpha')])
    assert.deepEqual(reloaded.candidates(), [defaultRoot, root('beta'), root('alpha')])

    const written = JSON.parse(readFileSync(indexFile, 'utf8'))
    assert.equal(written.version, INDEX_VERSION)
    assert.deepEqual(written.roots, [root('beta'), root('alpha')])
  })

  it('默认根永不登记 —— 它本来就在候选里', () => {
    const { defaultRoot, indexFile } = layout('default-root')
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    assert.equal(index.remember(defaultRoot), false)
    assert.deepEqual(index.roots, [])
    assert.deepEqual(index.candidates(), [defaultRoot])
  })

  it('重复 remember 只挪位置，不重复登记', () => {
    const { defaultRoot, indexFile, root } = layout('dedupe')
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    index.remember(root('alpha'))
    index.remember(root('beta'))
    assert.deepEqual(index.roots, [root('beta'), root('alpha')])

    // 再记一次 alpha：位置挪到最前，长度不变（返回 true 表示表变了）
    assert.equal(index.remember(root('alpha')), true)
    assert.deepEqual(index.roots, [root('alpha'), root('beta')])
    assert.equal(new Set(index.roots).size, index.roots.length)

    // 已经在最前且内容不变时，不必再写盘
    assert.equal(index.remember(root('alpha')), false)
  })

  it('超过上限时淘汰最久未用的', () => {
    const { defaultRoot, indexFile, root } = layout('cap')
    const index = new RootIndex({ defaultRoot, indexFile, maxRoots: 2 }).load()
    index.remember(root('a'))
    index.remember(root('b'))
    index.remember(root('c'))
    assert.deepEqual(index.roots, [root('c'), root('b')])

    const reloaded = new RootIndex({ defaultRoot, indexFile, maxRoots: 2 }).load()
    assert.deepEqual(reloaded.roots, [root('c'), root('b')])
  })

  it('登记表损坏时退化成空表并记一笔，而不是抛错', () => {
    const { defaultRoot, indexFile } = layout('corrupt')
    writeFileSync(indexFile, '{ this is not json', { flag: 'w' })
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    assert.deepEqual(index.roots, [])
    assert.notEqual(index.lastError, null)
  })

  it('版本不符时同样退化成空表', () => {
    const { defaultRoot, indexFile } = layout('version')
    writeFileSync(indexFile, JSON.stringify({ version: 99, roots: ['/tmp/whatever'] }))
    const index = new RootIndex({ defaultRoot, indexFile }).load()
    assert.deepEqual(index.roots, [])
    assert.match(index.lastError.message, /unsupported index version/)
  })

  it('写盘失败只回调，不影响调用方', () => {
    const { defaultRoot } = layout('unwritable')
    const seen = []
    const index = new RootIndex({
      defaultRoot,
      // 父路径是文件，mkdir 必然失败
      indexFile: join(sandbox, 'unwritable-file', 'roots.json'),
      onError: (error) => seen.push(error),
    })
    writeFileSync(join(sandbox, 'unwritable-file'), 'not a directory')
    assert.equal(index.remember('/tmp/some-project/.dsh/sessions'), true)
    assert.equal(seen.length, 1)
    assert.notEqual(index.lastError, null)
  })
})

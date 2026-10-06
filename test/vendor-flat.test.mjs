/**
 * 分叉产物的可重放性测试 —— 不需要 harness，只要官方包在 `node_modules` 里。
 *
 * 分叉是**生成物**：`vendor/dsh-session-persistence-jsonl-flat/index.js` 必须能由
 * 补丁表逐字重放出来。这条不变量是分叉唯一的安全网 —— 一旦有人手改了 vendor 里的
 * 文件、或者上游改了被锚定的那几段代码，这里就红。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PATCHES, VENDOR_DIR, applyPatches, build, sha256 } from '../tools/vendor-jsonl-flat.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const vendorDir = join(repoRoot, VENDOR_DIR)
const upstreamSource = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js')
const skip = existsSync(upstreamSource) ? false : '需要官方包：先运行 `node tools/harness-sandbox.mjs`'

describe('分叉产物可重放', { skip }, () => {
  it('补丁表本身没有重复 id', () => {
    const ids = PATCHES.map((patch) => patch.id)
    assert.equal(new Set(ids).size, ids.length, ids.join(','))
  })

  it('每个补丁的锚点在官方源码里都恰好出现一次', () => {
    const source = readFileSync(upstreamSource, 'utf8')
    // applyPatches 会在锚点缺失或重复时抛错，这里显式跑一遍拿到更直白的失败
    const { applied } = applyPatches(source)
    assert.deepEqual(applied, PATCHES.map((patch) => patch.id))
  })

  it('vendor 里的文件与补丁表重放结果逐字一致', () => {
    const { files, manifest } = build()
    for (const file of files) {
      const target = join(vendorDir, file.relative)
      assert.ok(existsSync(target), `缺文件：${target}`)
      assert.equal(sha256(readFileSync(target, 'utf8')), sha256(file.content), `${file.relative} 与补丁表不一致`)
    }
    const onDiskManifest = JSON.parse(readFileSync(join(vendorDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(onDiskManifest, manifest)
  })

  it('产物里确实带了分叉标记，源码哈希与清单对得上', () => {
    const source = readFileSync(upstreamSource, 'utf8')
    const manifest = JSON.parse(readFileSync(join(vendorDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.sourceSha256, sha256(source), '官方源码变了（升级过 DSH？）—— 重新生成分叉')
    assert.equal(manifest.upstream.name, '@deepseek-ai/dsh-session-persistence-jsonl')

    const index = readFileSync(join(vendorDir, 'index.js'), 'utf8')
    assert.ok(index.includes('fork(flat)'), '分叉标记不见了')
    assert.ok(index.includes('legacySessionDirs'), '旧分层回退的代码不见了')
    assert.ok(!index.includes('return join(root, projectKey(cwd));'), 'projectDir 没被扁平化')
  })

  it('worker.cjs 与上游逐字一致（它是原样搬运的）', () => {
    const upstreamWorker = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'worker.cjs')
    assert.equal(sha256(readFileSync(upstreamWorker, 'utf8')), sha256(readFileSync(join(vendorDir, 'worker.cjs'), 'utf8')))
  })
})

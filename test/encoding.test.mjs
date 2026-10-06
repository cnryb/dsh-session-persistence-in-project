/**
 * 路径编解码的语义测试 —— 零依赖，不需要 harness，`node --test` 直接可跑。
 *
 * 这些规则是从官方后端复刻来的（`encodeSegment` / `projectKey` 都在包内部），
 * 所以刻意放在不 import 官方包的 `src/path-encoding.js` 里：镜像本身的语义
 * 任何时候都该能验证，不必先还原 peer 依赖。它算出来的路径是否正确，
 * 另由 `test/jsonl-layout.test.mjs` 的差分测试对着真后端钉住。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeSegment, projectKey } from '../src/path-encoding.js'

describe('路径编解码的语义（不依赖 harness）', () => {
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
})

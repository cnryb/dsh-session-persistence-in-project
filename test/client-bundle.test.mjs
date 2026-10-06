/**
 * 浏览器半侧的契约测试 —— 不需要浏览器，也不需要 harness。
 *
 * 这里验的是三件事，都是「错了会在用户面前才炸」的那种：
 *
 * 1. `lib/client.js` 与 `client/plugin.js` 一致（生成物可重放），并且是 DSH 认的
 *    `window.__ModuleLoader__.load({ id, factory })` 形状，`id` 就是包名；
 * 2. bundle 里没有 ESM 语法：它是惰性 CJS factory，平台模块只能从 factory 的
 *    `require` 取（require 了平台表以外的名字，浏览器里就是「缺提供方」）；
 * 3. 页面把槽注册在 `plugins.item`、命名空间是 profile 条目 id、字段名与
 *    Host Config 对得上，编辑 → 保存产生的是对 volatile 字段的 `set` 操作。
 *
 * `@deepseek-ai/dsh-client-ui-primitives` 与 React 在 Node 里装不出来（它们只在
 * 浏览器模块表里），所以这里的替身按官方文档的 API 形状实现：`SettingsFormModel`
 * 的分阶段/提交语义、`SettingsForm` 的 props。替身能验的是**接线**，真正的观感
 * 与交互留给真实 GUI 验收。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { CLIENT_OUTPUT, CLIENT_SOURCE, build } from '../tools/build-client.mjs'

const repoRoot = new URL('..', import.meta.url)
const packageName = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')).name

/**
 * 在 Node 里执行 bundle，拿到它注册给模块系统的定义。
 *
 * @returns `{ id, factory }`。
 */
function loadBundle() {
  const code = readFileSync(new URL(`../${CLIENT_OUTPUT}`, import.meta.url), 'utf8')
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
    },
  }
  vm.runInNewContext(code, sandbox, { filename: CLIENT_OUTPUT })
  assert.ok(definition !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load()')
  return definition
}

/**
 * 造一个按官方文档形状实现的 primitives 替身。
 *
 * @param calls - 收集 `scope.mutate` 的调用，供断言使用。
 * @returns 替身模块。
 */
function fakePrimitives(calls) {
  class SettingsFormModel {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = new Map(specs.map((spec) => [spec.field, spec]))
      this.staged = new Map()
      this.listeners = new Set()
      this.unsubscribe = scope.subscribe(() => this.publish())
    }

    bind(project) {
      const listeners = this.listeners
      const current = { value: project() }
      listeners.add(() => {
        current.value = project()
      })
      return {
        getSnapshot: () => current.value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    shell() {
      const snapshot = this.scope.getSnapshot()
      const plan = [...this.staged.entries()]
      return {
        available: snapshot.status === 'ready',
        writable: snapshot.writable,
        dirty: plan.length > 0,
        invalid: false,
        saving: false,
        failed: false,
      }
    }

    field(field) {
      const spec = this.specs.get(field)
      const staged = this.staged.get(field)
      if (staged === undefined) {
        return { text: spec.format(this.scope.getSnapshot().value?.[field]), overridden: false, invalid: false }
      }
      const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
      return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
    }

    actions() {
      return {
        edit: (field, text) => {
          this.staged.set(field, { text, clear: false })
          this.publish()
        },
        resetField: (field) => {
          this.staged.set(field, { text: this.specs.get(field).format(this.scope.getSnapshot().base?.[field]), clear: true })
          this.publish()
        },
        save: async () => {
          const ops = []
          for (const [field, staged] of this.staged) {
            const spec = this.specs.get(field)
            const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
            if (write === undefined) return
            ops.push(write.kind === 'clear' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: write.value })
          }
          if (ops.length === 0) return
          const accepted = await this.scope.mutate(ops, this.scope.getSnapshot().revision)
          if (accepted) this.staged.clear()
          this.publish()
        },
        discard: () => {
          this.staged.clear()
          this.publish()
        },
      }
    }

    publish() {
      for (const listener of this.listeners) listener()
    }

    dispose() {
      this.unsubscribe()
      this.listeners.clear()
    }
  }

  return {
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    SegmentedControl: 'SegmentedControl',
    SettingsFormModel,
    settingsNumberField: (field) => ({
      field,
      format: (value) => (typeof value === 'number' ? String(value) : ''),
      parse: (text) => {
        const trimmed = text.trim()
        if (trimmed === '') return { kind: 'clear' }
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
      },
    }),
    settingsTextField: (field) => ({
      field,
      format: (value) => (typeof value === 'string' ? value : ''),
      parse: (text) => {
        const trimmed = text.trim()
        return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
      },
    }),
  }
}

/**
 * 造一个 React 替身：只把元素记成普通对象，方便遍历断言。
 *
 * @returns `{ createElement }`。
 */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  }
}

/**
 * 造一个浏览器侧 cordis 上下文的替身。
 *
 * @param options - `served`：Host 服务的命名空间集合，空集合表示尚未服务。
 * @returns `{ ctx, captured }`。
 */
function fakeContext(options = {}) {
  const capturable = { dictionaries: undefined, slot: undefined, injected: undefined, effects: [] }
  const scopeSnapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { layout: 'flat', maxIndexedRoots: 100 },
    base: { maxIndexedRoots: 100 },
    user: {},
  }
  const mutates = []
  const scope = {
    getSnapshot: () => scopeSnapshot,
    subscribe: () => () => {},
    mutate: async (ops, revision) => {
      mutates.push({ ops, revision })
      return true
    },
    set: async (field, value) => {
      mutates.push({ ops: [{ op: 'set', path: [field], value }], revision: scopeSnapshot.revision })
      return true
    },
  }
  const ctx = {
    locale: {
      bind: () => (key) => `t:${key}`,
      register: (ns, dictionaries) => {
        capturable.dictionaries = { ns, dictionaries }
        return () => {}
      },
    },
    configForms: {
      get: (ns) => {
        capturable.formFor = ns
        return scope
      },
      whileServed: (namespaces, register) => {
        capturable.watched = namespaces
        if (options.served === true) register(new Set(namespaces))
        return () => {}
      },
    },
    slots: {
      inject: (name, factory) => {
        capturable.slot = { name, registration: factory() }
        return () => {}
      },
      register: (options, component) => {
        capturable.registration = { options, component }
        return () => {}
      },
    },
    effect: (factory) => {
      const disposer = factory()
      capturable.effects.push(disposer)
      return () => disposer?.()
    },
  }
  return { ctx, captured: capturable, scope, mutates }
}

/**
 * 在元素树里按 type 找节点。
 *
 * @param node - 元素。
 * @param type - 要找的 type（字符串或组件函数）。
 * @returns 命中列表。
 */
function findAll(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const hits = node.type === type ? [node] : []
  for (const child of node.children ?? []) hits.push(...findAll(child, type))
  return hits
}

describe('客户端 bundle：形状与可重放', () => {
  it('lib/client.js 与 client/plugin.js 一致', () => {
    const built = build()
    assert.equal(readFileSync(new URL(`../${CLIENT_OUTPUT}`, import.meta.url), 'utf8'), built.content)
  })

  it('id 是包名，factory 是函数（启动图按包名找模块）', () => {
    const definition = loadBundle()
    assert.equal(definition.id, packageName)
    assert.equal(typeof definition.factory, 'function')
  })

  it('源码里没有 import/export —— 平台模块只能从 factory 的 require 取', () => {
    const source = readFileSync(new URL(`../${CLIENT_SOURCE}`, import.meta.url), 'utf8')
    assert.equal(/^\s*(import|export)\s/m.test(source), false)
  })
})

describe('客户端 bundle：接线', () => {
  it('require 只拿平台模块表里的东西，多一个都会抛', () => {
    const definition = loadBundle()
    const seen = []
    const injected = fakePrimitives([])
    const exports = definition.factory((specifier) => {
      seen.push(specifier)
      if (specifier === 'react') return fakeReact()
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return injected
      throw new Error(`unexpected require: ${specifier}`)
    })
    assert.deepEqual(seen.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
    // bundle 跑在 vm 的 realm 里，数组/对象与宿主 realm 的原型不同，比较前先搬过来
    assert.deepEqual(structuredClone(exports.inject), ['slots', 'locale', 'configForms'])
  })

  it('注册进 plugins.item，命名空间就是 profile 条目 id', () => {
    const definition = loadBundle()
    const { ctx, captured } = fakeContext({ served: true })
    const exports = definition.factory((specifier) =>
      specifier === 'react' ? fakeReact() : fakePrimitives([]),
    )
    exports.apply(ctx)

    assert.equal(captured.formFor, 'session-persistence-in-project')
    assert.deepEqual(structuredClone(captured.watched), ['session-persistence-in-project'])
    assert.equal(captured.slot.name, 'plugins.item')
    const registration = captured.registration
    assert.equal(registration.options.id, 'session-persistence-in-project')
    assert.equal(registration.options.name, 'plugins.item')
    assert.equal(registration.options.locale, exports.NS)
    assert.equal(typeof registration.options.label(), 'string')
    assert.equal(typeof registration.component, 'function')
  })

  it('Host 还没服务这个命名空间时，页面上不留痕迹', () => {
    const definition = loadBundle()
    const { ctx, captured } = fakeContext({ served: false })
    definition.factory((specifier) => (specifier === 'react' ? fakeReact() : fakePrimitives([]))).apply(ctx)
    assert.equal(captured.watched[0], 'session-persistence-in-project')
    assert.equal(captured.slot, undefined)
  })

  it('摘要视图只给一行文案，页面视图给出三个字段', () => {
    const definition = loadBundle()
    const { ctx, captured } = fakeContext({ served: true })
    definition.factory((specifier) => (specifier === 'react' ? fakeReact() : fakePrimitives([]))).apply(ctx)
    const Component = captured.registration.component
    const injected = captured.registration.options.inject()

    assert.equal(typeof injected.hooks.storagePage, 'object')
    assert.equal(typeof injected.edit, 'function')
    assert.equal(typeof injected.save, 'function')
    assert.equal(typeof injected.resetField, 'function')

    const useStoragePage = (selector) => selector(injected.hooks.storagePage.getSnapshot())
    const summary = Component({ t: (key) => key, view: 'summary', useStoragePage, ...injected })
    assert.equal(summary, 'summary')

    const page = Component({ t: (key) => key, view: 'page', useStoragePage, ...injected })
    const primitives = fakePrimitives([])
    assert.equal(findAll(page, 'SettingsForm').length, 1)
    assert.equal(findAll(page, 'SegmentedControl').length, 1)
    assert.equal(findAll(page, 'SettingsValueField').length, 2)

    const fields = findAll(page, 'SettingsValueField').map((node) => node.props.id)
    assert.deepEqual(fields, ['plugin-config-session-storage-max-roots', 'plugin-config-session-storage-index-file'])
  })

  it('编辑三个字段后保存：只写 volatile 字段的三个操作', async () => {
    const definition = loadBundle()
    const { ctx, captured, mutates } = fakeContext({ served: true })
    definition.factory((specifier) => (specifier === 'react' ? fakeReact() : fakePrimitives([]))).apply(ctx)
    const injected = captured.registration.options.inject()

    injected.edit('layout', 'layered')
    injected.edit('maxIndexedRoots', '250')
    injected.edit('indexFile', '/tmp/roots.json')
    await injected.save()

    assert.equal(mutates.length, 1)
    assert.equal(mutates[0].revision, 7)
    assert.deepEqual(structuredClone(mutates[0].ops), [
      { op: 'set', path: ['layout'], value: 'layered' },
      { op: 'set', path: ['maxIndexedRoots'], value: 250 },
      { op: 'set', path: ['indexFile'], value: '/tmp/roots.json' },
    ])
  })

  it('非法数字不会变成写入：草稿留下、保存被挡住', async () => {
    const definition = loadBundle()
    const { ctx, captured, mutates } = fakeContext({ served: true })
    definition.factory((specifier) => (specifier === 'react' ? fakeReact() : fakePrimitives([]))).apply(ctx)
    const injected = captured.registration.options.inject()

    injected.edit('maxIndexedRoots', '很多')
    await injected.save()
    assert.equal(mutates.length, 0)
  })

  it('默认根不在可编辑字段里（它由装配层的 !!js 表达式提供）', () => {
    const definition = loadBundle()
    const { ctx, captured } = fakeContext({ served: true })
    definition.factory((specifier) => (specifier === 'react' ? fakeReact() : fakePrimitives([]))).apply(ctx)
    const injected = captured.registration.options.inject()
    const useStoragePage = (selector) => selector(injected.hooks.storagePage.getSnapshot())
    const page = captured.registration.component({ t: (key) => key, view: 'page', useStoragePage, ...injected })
    const ids = findAll(page, 'SettingsValueField').map((node) => node.props.id).join(',')
    assert.equal(ids.includes('defaultRoot'), false, ids)
  })
})

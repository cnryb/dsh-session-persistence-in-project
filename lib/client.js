/* 生成物，勿手改：由 tools/build-client.mjs 从 client/plugin.js 生成。 */
window.__ModuleLoader__.load({
	id: "dsh-session-persistence-in-project",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
/**
 * 会话落点配置页 —— 浏览器半侧的**源码**（不是最终产物）。
 *
 * 这个文件写成「factory 体」：没有 `import`/`export`，平台模块由作用域里的
 * `require` 取，最后用 `module.exports` 交出 `{ NS, inject, apply }`。
 * `tools/build-client.mjs` 会把它原样包进 `window.__ModuleLoader__.load({ id, factory })`
 * 生成 `lib/client.js` —— 之所以不引打包器，是因为这个页面只需要平台模块表里的
 * React 与 UI 原子（`@deepseek-ai/dsh-client-ui-primitives`），手写包装比维护一条
 * 构建链便宜，也和这个仓库「零运行时依赖」的形态一致。
 *
 * ## 页面挂在哪
 *
 * 挂进「插件」页的 `plugins.item` 槽（官方四个配置页走的就是这条路），并且用
 * `configForms.whileServed([ENTRY_ID])` 门控：Host 没有服务这个命名空间时，
 * 页面上不会留下任何痕迹。命名空间就是 profile 里的**条目 id**。
 *
 * ## 只暴露三个字段，而且都不是随口加的
 *
 * - `layout` / `maxIndexedRoots` / `indexFile` 都是宿主 Config 里标了 `.volatile()`
 *   的字段 —— 设置服务只接受对 volatile 字段的写入，其他字段它会直接拒绝。
 * - `defaultRoot` **故意不可编辑**：装配层写的通常是 `!!js dshHomePath('sessions')`，
 *   一旦在表单里保存就固化成字面路径，`DSH_HOME` 再变会话就劈成两半。
 * - 项目开关 `.dsh/project.yml` 也不在这里：它跟着仓库走，是每个项目自己的事，
 *   不是本部署的全局配置。
 *
 * @module dsh-session-persistence-in-project/client
 */

const react = require('react')
const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

const h = react.createElement

/** Host 侧的 profile 条目 id，同时也是设置命名空间。 */
const ENTRY_ID = 'session-persistence-in-project'
/** 本页自己的字典命名空间。 */
const NS = 'settings.sessionPersistenceInProject'
/** 需要的浏览器侧服务（cordis 注入）。 */
const inject = ['slots', 'locale', 'configForms']

/** 简体中文文案。 */
const zh = {
  title: '会话落点',
  summary: '决定会话存在项目里还是默认根，以及项目内用哪种目录布局。',
  intro: '本部署的全局配置。某个项目要不要把会话落在项目里，由那个项目的 .dsh/project.yml 决定。',
  layout: '项目内落点布局',
  layoutFlat: '扁平',
  layoutLayered: '官方分层',
  layoutFlatHint: '新会话直接落在 <项目>/.dsh/sessions/<会话 id>/。升级前写在 --<项目路径>--/ 下的老会话留在原地，照样能读、能续写。',
  layoutLayeredHint: '官方布局：<项目>/.dsh/sessions/--<项目路径>--/<会话 id>/。只适合还没写过扁平会话的项目 —— 官方后端看见扁平会话目录会拒绝服务。',
  maxRoots: '落点登记表上限',
  maxRootsHint: '登记表最多记多少个项目落点，超出时淘汰最久未用的。留空表示使用默认值 100。',
  indexFile: '落点登记表路径',
  indexFileHint: '默认是 <DSH_HOME>/session-persistence-in-project/roots.json。留空表示使用默认路径。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalidNumber: '请填数字；留空表示使用默认值。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  defaultRootNote: '默认根由装配层决定（一般是 !!js dshHomePath(\'sessions\')），不在这里改：保存成字面值之后，DSH_HOME 变化时它会失效。',
  switchNote: '项目开关在 <项目>/.dsh/project.yml：文件在即开启，跟着仓库走，headless 与 GUI 一视同仁。',
}

/** English copy. */
const en = {
  title: 'Session storage',
  summary: 'Whether sessions live in the project or in the default root, and which layout the project root uses.',
  intro: 'Deployment-wide settings. Whether one project stores its own sessions is decided by that project’s .dsh/project.yml.',
  layout: 'Layout inside a project root',
  layoutFlat: 'Flat',
  layoutLayered: 'Official layered',
  layoutFlatHint: 'New sessions land in <project>/.dsh/sessions/<session id>/. Sessions written before the upgrade stay where they are and remain readable and resumable.',
  layoutLayeredHint: 'The official layout: <project>/.dsh/sessions/--<project path>--/<session id>/. Only for projects that never wrote flat sessions — the official backend refuses a root containing flat session directories.',
  maxRoots: 'Root index limit',
  maxRootsHint: 'How many project roots the index remembers; the least recently used ones are evicted. Blank uses the default of 100.',
  indexFile: 'Root index path',
  indexFileHint: 'Defaults to <DSH_HOME>/session-persistence-in-project/roots.json. Blank uses the default path.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  defaultRootNote: 'The default root comes from the assembly patch (usually !!js dshHomePath(\'sessions\')) and is not editable here: saving it as a literal would stop it from following DSH_HOME.',
  switchNote: 'The per-project switch lives in <project>/.dsh/project.yml: its presence enables project storage, it travels with the repository, and it applies to headless runs too.',
}

/**
 * 布局字段的转换规则。
 *
 * `SettingsFormModel` 只内置了数字/文本/机密三种 spec，而布局是一个二选一，
 * 所以这里给它一个自定义 spec：解析只认 `flat` / `layered`，其他输入判为无效
 * （保存按钮会因此禁用），控件本身用 SegmentedControl 而不是文本框。
 */
const layoutSpec = {
  field: 'layout',
  format: (value) => (value === 'layered' ? 'layered' : 'flat'),
  parse: (text) => (text === 'flat' || text === 'layered' ? { kind: 'set', value: text } : undefined),
}

/**
 * 表单框架要的文案。
 *
 * @param t - 本页字典的读取器。
 * @returns `SettingsForm` 的 labels。
 */
function formLabels(t) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/** 纯展示用的信息块样式。 */
const noteStyle = {
  margin: '20px 0 0',
  padding: '12px 14px',
  border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.25))',
  borderRadius: 'var(--dsw-radius-lg, 10px)',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}
/** 信息块里的一行说明。 */
const noteLineStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary, #666)',
  fontSize: '12.5px',
  lineHeight: '18px',
}
/** 布局那一行的容器。 */
const layoutRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  margin: '0 0 4px',
}
/** 布局字段的标签。 */
const layoutLabelStyle = {
  fontSize: '13px',
  lineHeight: '20px',
}
/** 布局字段下方的说明。 */
const layoutHintStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary, #666)',
  fontSize: '12px',
  lineHeight: '18px',
}

/**
 * 渲染配置页。
 *
 * @param props - 插槽注入：本页表单的状态与动作，以及框架给的 `view` 与 `t`。
 * @returns 摘要一行，或完整表单。
 */
function StoragePage(props) {
  const { t } = props
  const state = props.useStoragePage((snapshot) => snapshot)
  if (props.view === 'summary') return t('summary')
  const layered = state.layout.text === 'layered'
  return h(
    'div',
    null,
    h(
      primitives.SettingsForm,
      {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
      h(
        'div',
        { style: layoutRowStyle },
        h('label', { style: layoutLabelStyle, htmlFor: 'plugin-config-session-storage-layout' }, t('layout')),
        h(primitives.SegmentedControl, {
          id: 'plugin-config-session-storage-layout',
          label: t('layout'),
          value: state.layout.text,
          disabled: !state.writable,
          options: [
            { value: 'flat', label: t('layoutFlat'), title: t('layoutFlatHint') },
            { value: 'layered', label: t('layoutLayered'), title: t('layoutLayeredHint') },
          ],
          onChange: (value) => props.edit('layout', value),
        }),
        h('p', { style: layoutHintStyle }, layered ? t('layoutLayeredHint') : t('layoutFlatHint')),
      ),
      h(primitives.SettingsValueField, {
        id: 'plugin-config-session-storage-max-roots',
        label: t('maxRoots'),
        hint: t('maxRootsHint'),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        numeric: true,
        disabled: !state.writable,
        ...state.maxIndexedRoots,
        onEdit: (text) => props.edit('maxIndexedRoots', text),
        onReset: () => props.resetField('maxIndexedRoots'),
      }),
      h(primitives.SettingsValueField, {
        id: 'plugin-config-session-storage-index-file',
        label: t('indexFile'),
        hint: t('indexFileHint'),
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        disabled: !state.writable,
        ...state.indexFile,
        onEdit: (text) => props.edit('indexFile', text),
        onReset: () => props.resetField('indexFile'),
      }),
    ),
    h(
      'section',
      { style: noteStyle },
      h('p', { style: noteLineStyle }, t('intro')),
      h('p', { style: noteLineStyle }, t('defaultRootNote')),
      h('p', { style: noteLineStyle }, t('switchNote')),
    ),
  )
}

/**
 * 把 `configForms` 的作用域桥到本页的分阶段表单上。
 *
 * 与官方配置页同构：草稿留在本地，只有「保存」才写；离开页面即丢弃。
 */
class StoragePageController {
  /**
   * @param scope - `configForms.get(ENTRY_ID)` 给出的该命名空间表单。
   */
  constructor(scope) {
    this.form = new primitives.SettingsFormModel(scope, [
      layoutSpec,
      primitives.settingsNumberField('maxIndexedRoots'),
      primitives.settingsTextField('indexFile'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /**
   * 组件读的那份状态。
   *
   * @returns 表单框架状态 + 三个字段各自的草稿。
   */
  projection() {
    return {
      ...this.form.shell(),
      layout: this.form.field('layout'),
      maxIndexedRoots: this.form.field('maxIndexedRoots'),
      indexFile: this.form.field('indexFile'),
    }
  }

  /**
   * 插槽注入面：`hooks.storagePage` 会被框架绑成组件的 `useStoragePage`。
   *
   * @returns 注入给页面组件的 props。
   */
  inject() {
    return {
      hooks: { storagePage: this.store },
      ...this.form.actions(),
    }
  }

  /** 释放对已接受值的订阅。 */
  dispose() {
    this.form.dispose()
  }
}

/**
 * 挂载配置页：Host 服务这个命名空间时它才出现。
 *
 * @param ctx - 浏览器侧插件上下文。
 */
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-storage: dictionaries')

  const page = new StoragePageController(ctx.configForms.get(ENTRY_ID))
  ctx.effect(() => () => {
    page.dispose()
  }, 'session-storage: form subscription')

  ctx.effect(
    () =>
      ctx.configForms.whileServed([ENTRY_ID], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: ENTRY_ID,
              order: 60,
              label: () => t('title'),
              locale: NS,
              inject: () => page.inject(),
            },
            StoragePage,
          ),
        ),
      ),
    'session-storage: page',
  )
}

module.exports = { NS, ENTRY_ID, inject, apply }
		return module.exports;
	}
});

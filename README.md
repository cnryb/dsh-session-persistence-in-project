# dsh-session-persistence-in-project

让会话"按项目"存放：默认仍然全部落在默认根 `$DSH_HOME/sessions`（未设置 `DSH_HOME` 时就是 `~/.dsh/sessions`）；某个项目里放了开关文件之后，**只有那个项目**的会话改存到项目自己的目录里，其他项目不受影响。

这是第三方插件，不在 `@deepseek-ai` scope 下，与官方包没有从属关系。命名沿用官方家族的习惯：`dsh-session-persistence-*` 里 `-jsonl` 是**格式**变体，`-in-project` 是**落点**变体 —— 前缀说明接缝，后缀说明变体。

**当前状态：可用。** 五个服务方法都已实现，并且用真实的 DSH 跑通了端到端验收（开开关的项目落在项目里、没开开关的落在默认根、冷启动后能接着上次的会话写）。测试 45 个全过。

## 兼容性

| 项 | 值 |
|---|---|
| 目标 harness | Desktop 内置 DSH `0.2.0-rc.2`（对着 `app.asar` 里的源码核对过） |
| peer 依赖 | `@deepseek-ai/cordis ~4.0.4`、`@deepseek-ai/schemastery ~3.18.4`、`@deepseek-ai/dsh-session 0.2.0-rc.2`、`@deepseek-ai/dsh-session-format 0.2.0-rc.2`、`@deepseek-ai/dsh-session-persistence 0.2.0-rc.2`、`@deepseek-ai/dsh-session-persistence-jsonl 0.2.0-rc.2` |
| 升级风险 | 后几个包是**精确 pin**。DSH 还在 rc 阶段，服务接口、落点编码、日志格式都可能变；升级 DSH 时要重新核对接口，不能只改版本号 |

`dsh-session` 与 `dsh-session-format` 是给 `src/jsonl-layout.js` 用的。**它们必须真的写进 `peerDependencies`**：插件解析只认声明过的 peer，没声明的名字会退回普通查找然后失败（实测报 `failed to import`）。

## 当前状态

| 部分 | 状态 |
|---|---|
| 落点决策 `src/policy.js` | ✅ 完整实现，9 个测试 |
| 落点登记表 `src/roots.js` | ✅ 完整实现，10 个测试 |
| 布局镜像 `src/jsonl-layout.js` | ✅ 与官方 `locate()` 逐条对齐（差分测试） |
| 插件入口与 Config `src/index.js` / `src/router.js` | ✅ 完整实现 |
| `create` / `flush` / `locate` 按项目路由 | ✅ 真实后端验证 |
| `open` / `stat` / `list` | ✅ 真实后端验证，含冷启动 |
| 跑通一次真实会话 | ✅ `tools/e2e-headless.sh`（隔离 `DSH_HOME`，不碰 `~/.dsh`） |

**路由是怎么挂起来的。** 这里踩过三个坑，每一个都只有真跑起来才会暴露（结论见[未决问题 / spike-1](#spike-1子实例能否取回已结案且有第三个坑)）：

```js
async backendFor(root) {
  let entry = this.children.get(root)
  if (entry === undefined) {
    entry = {}; this.children.set(root, entry)
    entry.promise = (async () => {
      const scope = this.spawnContext.isolate('sessionPersistence')   // ① 隔离作用域
      const fork = scope.plugin(JsonlSessionPersistence, { root })
      await fork                                                       // ② 等子插件激活
      entry.backend = fork.ctx.sessionPersistence
      return entry.backend
    })()
    entry.promise.catch(() => {})
    try { await entry.promise } catch (error) { this.children.delete(root); throw error }
  }
  return entry.promise
}
```

1. **必须隔离。** 同一个服务作用域里注册第二个 `sessionPersistence`，cordis 直接抛 `service "sessionPersistence" has been registered at <Router>`。每个落点一个 `ctx.isolate('sessionPersistence')`，各拿一份注册位。
2. **必须 `await`。** `ctx.plugin()` 返回的是 thenable，插件体在微任务里才跑；同步读 `fork.ctx.sessionPersistence` 会抛 `cannot get property "sessionPersistence" without inject`。
3. **必须用构造时那个 ctx，不能用 `this.ctx`。** 服务被 `ctx.sessionPersistence` 取出来用时，cordis 会把方法绑到一个**影子对象**上，从影子出发解析服务会走到调用侧那一侧的 fiber。用 `this.ctx` 挂子实例，`fork.ctx.sessionPersistence` 读回来的是**路由器自己** —— `create()` 无限自递归，实测直接 OOM。而且影子挂在根 fiber 下，从它挂出去的子实例不归本插件所有，插件卸载时句柄不会被排空。

顺带一个纯 JavaScript 的坑：那个影子对象是 `Object.create(服务实例)` 出来的，**私有字段（`#spawnContext`）读不到**，会抛 `TypeError: Cannot read private member`。所以 `spawnContext` 是普通字段。

**装配时插件加载失败会怎样。** 装配方式是"禁用官方后端 + 插入本插件"。插件加载失败时进程里就**没有** `sessionPersistence` 提供方，会话不会落盘。所以装之前先按[安装](#安装)里的顺序做完前置检查。

## 快速验证

```bash
cd <仓库根目录>
npm test                      # 45 passed
./tools/e2e-headless.sh       # 端到端：真跑一次 DSH，隔离 DSH_HOME
```

`npm test` 分两档：

- **不需要 harness** 的部分（策略层、登记表、编解码语义）零依赖直接跑，`src/policy.js` 不 import 任何官方包。
- **需要 harness** 的部分（布局差分测试、路由器集成测试）要先有官方包：

  ```bash
  node tools/harness-sandbox.mjs   # 从本机 DSH 的 app.asar 里还原 peer 依赖到 ./node_modules
  ```

  这些包只随 DSH 分发、不在公共 registry 上，所以没法 `npm install`。`node_modules/` 已在 `.gitignore` 里。还原不出来的环境下，这组测试会**跳过**而不是失败。

`tools/e2e-headless.sh` 全程用隔离的 `DSH_HOME`（默认 `/tmp/dsh-in-project-e2e/home`），**不碰 `~/.dsh`**；没有 API key 也能验收持久化 —— 会话在调用模型之前就已落盘，占位 key 会停在 AUTH 那一步（退出码 1），属于预期。

提醒：

- `test/fixtures/*/.dsh/` 里的开关文件**必须进版本库**，否则新 clone 上会有 3 个测试拿不到夹具而失败。所以 `.gitignore` 里写的是 `/.dsh/`（只忽略仓库根），不要写成 `.dsh/`。

## 开关文件

首选 `<项目>/.dsh/project.yml`，也支持等价的 `<项目>/.dsh/project.json`（纯 JSON，不需要 YAML 解析）。**两者同时存在时 `project.yml` 优先。**

```yaml
# 文件存在即视为开启
sessions: project            # 可省略；写 default 表示显式否决
sessionsRoot: .dsh/sessions  # 可选：自定义落点，按项目根解析
```

判定规则（自上而下，先匹配者生效）：

| 情况 | 落点 | `reason` |
|---|---|---|
| `DSH_SESSION_LOCATION=project` 或 `=default` | 由环境变量决定 | `env-override` |
| 没有开关文件 | 默认根 | `no-switch-file` |
| 文件在，但没写 `sessions` | 项目内 | `switch-present` |
| `sessions: project`（或 `true`） | 项目内 | `switch-says-project` |
| `sessions: default`（或 `false`） | 默认根 | `switch-says-default` |
| `sessions` 取值非法 | 默认根 | `invalid-switch-value` |
| 文件解析失败 | 默认根 | `unparsable-switch-file` |

取值非法或解析失败一律退回默认根：持久化插件宁可不动用户数据，也不能因为一个拼写错误把会话换个地方存。环境变量遵循同一原则 —— `DSH_SESSION_LOCATION` 只有正好等于 `project` 或 `default` 才生效，其他取值一律忽略，继续按开关文件判定（注意：是忽略，不是退回默认根）。

**YAML 只解析扁平的 `键: 值` 子集**：整行注释（`#` 开头）、空行、`键: 值`、单双引号、`true` / `false`。不支持嵌套、数组、多行字符串，也**不支持行尾注释** —— `sessions: project # 开启` 解析出来的值是 `project # 开启`，属于非法取值，结果是静默退回默认根。需要更强的 YAML 时再引 `yaml` 依赖，现在保持零运行时依赖。

`sessionsRoot` 的几种写法（都实测过）：

| 写法 | 解析结果 |
|---|---|
| `.dsh/sessions`（默认） | `<项目>/.dsh/sessions` |
| `/abs/path` | 原样使用 |
| `../outside` | 项目外的路径（**能写出项目**） |
| `~/logs` | `<项目>/~/logs`（**不展开 `~`**） |

## 落点与磁盘布局

默认根是 `$DSH_HOME/sessions`，官方布局长这样：

```
$DSH_HOME/sessions/
  --Users-alice-Desktop-dsh-test--/          # 项目目录，按会话 header 里的 cwd 生成
    session-0b2a5232-…/                      # 会话目录，按 id 生成
      session.v4.jsonl.zstd                  # 当前格式版本 + 默认压缩 zstd
      session.lock                           # 写句柄的租赁锁（flock），文件会留在磁盘上
```

开启开关之后，`root` 换成项目内目录，但**项目目录那一层仍然由官方后端追加**（`projectDir(root, cwd)`，去不掉）：

```
<项目>/.dsh/sessions/
  --Users-alice-Desktop-github-foo--/
    session-<id>/
      session.v4.jsonl.zstd
```

几个会影响"要不要进 git"的细节：

- 项目目录名是把 cwd 折叠出来的可读名字：路径分隔符折成 `-`，其他不安全字符转义成 `~XXXX`，超过 251 字符截断 —— **有损**，不是可逆编码。
- 会话目录名是 id 的转义结果，常见形态是 `session-<uuid>`，也有裸 `<uuid>`。
- 当前产物是 `session.v4.jsonl.zstd`：`v4` 来自运行时的 `SESSION_FORMAT_VERSION`（`@deepseek-ai/dsh-session` 导出，本机实测就是 4），配了 `compression: none` 时后缀是 `session.v4.jsonl`。本插件不写死这个版本号，`src/jsonl-layout.js` 用的是同一个常量。
- `create()` 是惰性的：创建之后既不 append 也不 `flush` 的话，磁盘上不会留下任何东西。
- header 里没有 cwd 的会话，落在 `<root>/_no-cwd/`。

本插件自己只多写一个文件 —— 落点登记表，放在 harness home 下、不在会话数据里：

```
$DSH_HOME/session-persistence-in-project/roots.json
{ "version": 1, "roots": ["/abs/project/.dsh/sessions", …] }   # 最近使用在前
```

它只记「哪些项目落点值得去找」，不记 id、不记内容。文件缺失或损坏都退化成空表：默认根里的会话照常可见，项目里的会话要等那个项目下次被用到才会重新登记。写盘失败也只记一笔日志，绝不让会话操作失败。

## 安装

### 前置检查（先做完这两步，再谈安装）

1. **插件必须先成为 profile 的依赖。** 直接拿工作区源码路径去 insert 是不行的：`src/router.js` 要 `import '@deepseek-ai/schemastery'`，而工作区一路向上都没有 `node_modules`，实测报 `ERR_MODULE_NOT_FOUND`。正确做法是登记成 **profile link**：

   ```bash
   dsh plugin --profile <profile> add <插件仓库绝对路径>
   ```

   之后插件声明的 peer 由 boot 期的运行时解析表直接供给 —— 也就是**解析到 harness 自己那份**（asar 里），不需要往插件目录塞 `node_modules`。实测：仓库里没有 `node_modules` 时也能正常加载并落盘。条件只有一个，而且是硬的：**用到的包必须写进 `peerDependencies`**，没声明的名字会退回普通查找然后失败。

2. **`defaultRoot` 不要硬编码家目录。** 用官方 patch 同款的 `!!js dshHomePath('sessions')`：`!!js` 表达式在 patch 层可用的作用域里由 `dsh-app-boot` 注入了 `dshHomePath`。写死 `/Users/you/.dsh/sessions` 之后，一旦 `DSH_HOME` 变化，会话就劈成两半 —— 这正是本插件最不该犯的错。

### 装配方式：禁用官方后端 + 插入本插件

一个进程只能有一个 `ctx.sessionPersistence` 提供方（cordis 在同一作用域内重复注册同名服务会直接抛错），所以装配方式必然是"禁用官方 JSONL 后端 + 插入本插件"：

```yaml
- id: session-persistence-jsonl
  name: "@deepseek-ai/dsh-session-persistence-jsonl"
  disabled: true

- insert:
    - id: session-persistence-in-project
      name: dsh-session-persistence-in-project
      config:
        defaultRoot: !!js dshHomePath('sessions')
```

`disabled` 是 loader 的合法条目键（`options.disabled`，支持 `!!js`）。id 按"包名去掉 `@deepseek-ai/dsh-` 前缀"的惯例推出；真实 id 可以在 `dsh-base/cordis.patch.yml` 里核对，或用 `dsh --profile "$DSH_PROFILE" --dump-config` 打印当前组合。装完**先用 `--dump-config` 核对**：要能看到官方那行带 `disabled: true`，以及本插件那行。

### 这段配置贴在哪里

patch 层的叠加顺序是：各 bundle 层 → `$DSH_PROFILE_DIR/cordis.patch.yml`（profile 用户层）→ `$DSH_HOME/cordis.patch.yml`（home 层，优先级更高，对所有 profile 生效）→ `--patch` 覆盖层。上面这段写在 profile 用户层或 home 层都可以。

注意 patch 的 `config` 是**整块替换，不做深合并** —— 覆盖既有行时要把字段写全。

更推荐的做法是把插件做成 **bundle**（`package.json` 里声明 `dsh.bundle.patch` 指向一个含 `insert:` 的 `cordis.patch.yml`），再用 `plugin_manager` 的 `install_bundle` 安装。官方插件开发文档明确不建议手写 profile 的 `package.json` / `cordis.patch.yml`：包安装、依赖链接、patch 行都由 `install_bundle` 负责。

### 安装顺序

**`disabled` 和 `insert` 必须落在同一层补丁里。** 不能"先只 insert、确认没问题再禁用" —— 官方后端还在时插入本插件，实测直接抛 `service "sessionPersistence" has been registered at <JsonlSessionPersistence>`，插件起不来，进程里就没有提供方了。

所以顺序是：

1. 先按前置检查把插件登记成 profile 依赖。
2. 一次性写好上面那段补丁（禁用 + 插入）。
3. `--dump-config` 核对组合结果，再启动。
4. 留一份回滚补丁：去掉 `disabled`、删掉 insert 行，就回到官方后端。

### 回滚之后

新会话回到默认根，但**已经写进项目里的会话不会自动搬回来**。回滚之后它们还能不能打开，取决于落点登记表还在不在（`$DSH_HOME/session-persistence-in-project/roots.json`）：官方后端只认自己的 `root`，看不见项目里那批。正式启用之前，先想清楚这批文件后续怎么处理。

## 安全与隐私

- **开关文件是不可信输入。** 它来自被 clone 的仓库，而 `sessionsRoot` 接受绝对路径和 `../` —— 一个恶意仓库可以决定 DSH 把日志写到哪里。正式使用建议只允许项目内的相对路径，或加一层白名单校验。
- **会话日志会泄密。** 日志里有完整对话、工具输出和代码片段，可能包含密钥、内网地址等信息。决定"会话随仓库提交"之前，先确认这些内容可以共享。
- **环境变量是全局开关。** `DSH_SESSION_LOCATION` 同时作用于所有项目，适合临时排障，不适合当常规配置。

## 已知限制

- **项目落点的可见性依赖登记表。** `open(id)` / `stat(id)` / `list()` 只拿到 id，候选落点来自「默认根 + 登记过的项目落点」（`$DSH_HOME/session-persistence-in-project/roots.json`）。登记表丢了，项目里的历史会话仍然在盘上，但在 `list()` 里看不见、也 `open()` 不了 —— 直到那个项目再次被使用、重新登记。
- **落点判定按 cwd 缓存在进程内**，改完开关文件要重启才生效。
- **一个 id 只允许落在一个地方。** 建会话前会做一次跨落点查重，已在别处存在就抛 `SessionAlreadyExistsError`。官方后端只在**单个 root 内**查重，跨 root 的静默重复会让两个子后端同时持有同一个 id 的活写句柄，把同一段事件写进两份日志 —— 所以这道检查是必须的。
- header 没有 cwd 的会话按默认根处理（reason 为 `no-cwd`），由官方后端放进 `<root>/_no-cwd/`。这里**不猜 `process.cwd()`**：对 DSH 主进程来说那个值与会话无关。
- YAML 子集不支持行尾注释；`sessionsRoot` 不展开 `~`。
- 接口没有删除会话的能力，日志只增不减。
- `flush()` 会遍历所有子后端；某个项目落点读失败时 `list()` 只记一笔并跳过，但**默认根失败会直接抛** —— 那时"合并结果完整"这个前提已经不成立。

## 开发

```
src/policy.js          落点决策（零依赖）
src/roots.js           落点登记表：默认根 + 见过的项目落点，落盘到 $DSH_HOME
src/jsonl-layout.js    官方磁盘布局的镜像，只为同步的 locate() 兜底
src/router.js          按项目路由的后端：每落点一个隔离的官方子实例
src/index.js           插件入口
test/policy.test.mjs       9 个测试（零依赖）
test/roots.test.mjs        10 个测试（零依赖）
test/jsonl-layout.test.mjs 8 个测试（差分：与官方 locate() 逐条对齐）
test/router.test.mjs       18 个测试（真实官方后端，落在临时目录）
test/fixtures/             enabled / explicit-off / json-switch / plain 四种假项目
tools/harness-sandbox.mjs  从 app.asar 还原 peer 依赖到 ./node_modules
tools/e2e-headless.sh      端到端验收（隔离 DSH_HOME）
```

`jsonl-layout.js` 那份镜像是 `locate(meta)` 逼出来的：官方 `locate` 是**同步**的纯路径计算，而子实例要 `await` 才存在，所以冷路径只能自己算。为了不让它悄悄漂移，差分测试会实例化真正的官方后端，对同一批 (cwd, id) 比较两边算出来的路径 —— 官方改了转义规则，测试就红。

四种假项目故意放在插件仓库内，而插件仓库自己**不开**开关。理由有两个：一是夹具的行为必须只由夹具目录里的开关文件决定；二是调试期插件随时可能崩，而插件崩了就没有持久化提供方，正在进行的这次调试会话也不会落盘 —— 把开发仓库排除在外，能少丢一次现场。

### 端到端验收做了什么

`tools/e2e-headless.sh` 在隔离的 `DSH_HOME` 下起一个 `headless` profile，把本插件登记成 profile link，写入装配补丁，然后用 `--dump-config` 核对组合，最后在两个项目里各跑一次真实会话：

| 场景 | 期望 |
|---|---|
| 项目里有 `.dsh/project.yml` | 会话落在 `<项目>/.dsh/sessions/…`，默认根里没有 |
| 项目里没有开关文件 | 会话落在 `$DSH_HOME/sessions/…`，项目里什么都没写 |
| 冷启动后用 `--session-id` 续写 | 新进程能找到项目里的会话并追加 |

用占位 API key 跑：会话在调用模型**之前**就已经落盘，所以运行会停在 AUTH 那一步（退出码 1），这属于预期 —— 恰好说明持久化路径已经走完了。

## 设计笔记：为什么不是"一行配置"能解决的

读完 `app.asar` 里的官方源码和文档，可以确认四条硬事实：

1. **接缝只有一个。** `ctx.sessionPersistence` 是 `@deepseek-ai/dsh-session-persistence` 里的 `SessionPersistence` Service，官方 JSONL 后端实现它；而 `root` 在构造时就被解析成普通字符串（`this.root = resolve(config.root)`）—— 一个进程一个 root，之后不再变。
2. **项目分层靠的不是 root，是每个会话 header 里的 `cwd`。** 路径由 `logPath(root, meta.cwd, meta.id)` 算出，所以"按项目换落点"必须落在**每次会话操作**上，而不是启动时一次。
3. **一个进程会服务多个工作区。** `cwd` 是**每个 agent 的启动配置项**（`dsh-agent-loop` 的 `agents[].cwd`），不是进程属性；`~/.dsh/sessions` 下并列的多个项目目录就是它的结果。进程环境里也没有工作区路径（`DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_WEB_URL` 都与工作区无关），所以"每进程一个 root"这条捷径走不通。
4. **没有现成的按工作区作用域。** `dsh-scope` 是为按 agent / 分组隔离注册而设的库，不是按工作区开 cordis scope，因此挂不了"每项目一个后端实例"。

官方文档自己留了口子：JSONL 后端「把会话保存在部署控制的根下：**项目本地**、共享、临时或集中式」。项目本地 root 是官方认可用法 —— 缺的只是"按项目切换"的那层路由，也就是这个插件要做的事。

## 未决问题

### spike-1：子实例能否取回（已结案，且有第三个坑）

用真实的 `@deepseek-ai/cordis@4.0.4` 跑最小复现，结论明确：

- 不 isolate，直接 `ctx.plugin(JsonlSessionPersistence, { root })` → 抛 `service "sessionPersistence" has been registered at <Router>`；
- 不等激活就同步读 `fork.ctx.sessionPersistence` → 抛 `cannot get property "sessionPersistence" without inject`（早期版本读到的是父级，缓存后 `create` 无限自递归，实测 OOM）；
- `ctx.isolate('sessionPersistence')` + `await fork` 之后再取 → 正常，不同 root 各自拿到独立实例；
- **但挂子实例的 ctx 必须是构造时那个，不能是 `this.ctx`。** 服务被 `ctx.sessionPersistence` 取用时方法会绑到影子对象上，从影子解析服务会落到调用侧的 fiber —— `fork.ctx.sessionPersistence` 读回来的是路由器自己，`create()` 递归到 OOM；而且影子挂在根 fiber 下，子实例不归本插件所有，插件卸载时不跟着走。这一条是端到端跑起来才暴露的，只看单个 `ctx.plugin` 的最小复现看不出来。

结论：路线可行，已按此实现（见[当前状态](#当前状态)），不需要退路方案（"本插件只做决策、把 `resolveLocation` 交给宿主装配"，或自己实现存储）。

### spike-2：id → 落点（已结案）

`open(id, access)` / `stat(id)` 只给 id，不给 cwd。关键在于：**官方后端已经把"在 root 内按 id 找会话"解决了** —— `findLog(id)` 会遍历 root 下所有项目目录按 id 查找，`list()` 同理全扫。所以不需要 cwd→id 索引，真正要解决的是"**候选 root 集合**从哪来"：

- **候选 = 默认根 + 登记过的项目落点**（`src/roots.js`），落盘到 `$DSH_HOME/session-persistence-in-project/roots.json`，否则冷启动看不见项目里的历史会话；
- **用 `stat(id)` 当探针**逐落点询问：它命中给快照、未命中返回 `undefined`（不抛错），正好比 `open` 干净；
- 全都没命中 → `open` 抛 `SessionPersistenceNotFoundError`，`stat` 返回 `undefined`（与官方后端一致），**不静默新建**；
- 跨 root 重名 id：`create` 之前做一次查重，已在别处存在就抛 `SessionAlreadyExistsError`。官方只在单个 root 内查重，跨 root 的重复会让两个子后端同时写同一个 id；
- 命中结果缓存在内存里（`idRoots`），缓存落空时自动回退到逐落点探测。

### spike-3：`.gitignore` 策略（仍未决）

会话进项目之后，要不要默认忽略？判断依据是[安全与隐私](#安全与隐私)里的那条：日志会泄密。如果目的是让日志随仓库提交、便于交接，就要接受内容可被共享；如果只是想留在本地，就该忽略。决定之前，仓库的 `.gitignore` 里留了一条**只针对仓库根**的 `/.dsh/` 作防御。

## License

MIT（见 `package.json`；仓库里目前还没有 `LICENSE` 文件）。

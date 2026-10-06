#!/usr/bin/env node
/**
 * 从官方 `@deepseek-ai/dsh-session-persistence-jsonl` 生成「扁平布局」分叉。
 *
 * ## 为什么需要分叉
 *
 * 官方后端的磁盘布局是 `root / projectKey(cwd) / id / session.v<版本>.jsonl[.zstd]`，
 * 项目层由模块私有的 `projectDir()` 硬编码，没有开关、也没有 hook。默认根是多项目
 * 容器，这层必须有；**项目内落点只有一个项目，这层纯属重复**。要去掉它，只能改
 * 存储引擎本身 —— 也就是这里做的事。
 *
 * ## 这份分叉改了什么
 *
 * 三件事，其余全部保持官方原样（含 fsync/目录 sync、zstd 帧校验、格式迁移、
 * 进程内 + 跨进程写锁、崩溃尾部修复）：
 *
 * 1. **写路径扁平化**：`projectDir()` 直接返回 root，新会话落在 `<root>/<id>/`。
 * 2. **旧分层数据仍然可读可写**：升级前写在 `<root>/<旧项目目录>/<id>/` 的会话
 *    原地不动 —— 读得到、`list()` 看得见、续写仍然写回原目录（`legacyDirs` 记住
 *    每个 id 实际所在的目录，所有路径推导都走 `pathFor()`）。不自动搬迁用户数据。
 * 3. **同一个 id 不会因为两种布局同时存在而炸**：`listArtifacts()` 见到重复 id 会
 *    抛错，所以扁平那份优先，旧目录里同名 id 直接跳过。
 *
 * ## 上游漂移怎么办
 *
 * 每个改动都以**精确文本锚点**表达，锚点缺失或不再唯一时本脚本直接失败。所以
 * DSH 升级后先跑 `node tools/vendor-jsonl-flat.mjs`：能重放说明上游没动这几处；
 * 报错说明动了，人来重新核对补丁。`--check` 用于 CI/测试，只校验不写盘。
 *
 * ```
 * node tools/vendor-jsonl-flat.mjs            # 重新生成 vendor/ 下的分叉
 * node tools/vendor-jsonl-flat.mjs --check    # 只校验：锚点仍可重放、产物未漂移
 * node tools/vendor-jsonl-flat.mjs --source <官方包目录> --dest <输出目录>
 * ```
 *
 * @module dsh-session-persistence-in-project/tools/vendor-jsonl-flat
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 官方包名。 */
export const UPSTREAM_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'

/** 分叉产物的目录名。 */
export const VENDOR_DIR = 'vendor/dsh-session-persistence-jsonl-flat'

/**
 * 补丁表：按顺序应用，每条的 `find` 必须**恰好出现一次**。
 *
 * 写法刻意保持「最小文本替换」：不重排上游代码，方便在 DSH 升级后逐条核对。
 */
export const PATCHES = [
  {
    id: 'project-dir-flat',
    description: 'projectDir() 不再追加 --<cwd>-- 层：root 自己就是会话容器',
    find: `function projectDir(root, cwd) {
	if (cwd === void 0) return join(root, "_no-cwd");
	return join(root, projectKey(cwd));
}`,
    replace: `function projectDir(root, cwd) {
	/* fork(flat): 项目内落点不再追加 \`--<cwd>--\` 层 —— root 自己就是会话容器。 */
	return root;
}`,
  },
  {
    id: 'legacy-dirs-field',
    description: '记录「已定位过的旧分层会话目录」，让读写留在原地',
    find: `	name = "session-persistence-jsonl";
	root;
	compression;
	rootEncodingCheck;`,
    replace: `	name = "session-persistence-jsonl";
	root;
	compression;
	/** fork(flat): 已定位过的旧分层会话目录（id → 目录）；新建的会话不进这张表。 */
	legacyDirs = /* @__PURE__ */ new Map();
	rootEncodingCheck;`,
  },
  {
    id: 'flat-project-dirs-and-legacy-scan',
    description: 'root 是唯一的「项目目录」，并新增旧分层目录扫描 + 路径推导',
    find: `	/** The human-readable project directories under the configured root. */
	async listProjectDirs(signal) {
		try {
			signal?.throwIfAborted();
			const entries = await readdir(this.root, { withFileTypes: true });
			signal?.throwIfAborted();
			return entries.filter((e) => e.isDirectory()).map((e) => join(this.root, e.name));
		} catch (error) {
			if (isENOENT(error)) return [];
			throw error;
		}
	}`,
    replace: `	/** fork(flat): root 自己就是唯一的「项目目录」。 */
	async listProjectDirs(signal) {
		try {
			signal?.throwIfAborted();
			await readdir(this.root);
			signal?.throwIfAborted();
			return [this.root];
		} catch (error) {
			if (isENOENT(error)) return [];
			throw error;
		}
	}
	/**
	* fork(flat): 升级前落在 \`<root>/<旧项目目录>/<id>/\` 的会话目录。
	*
	* 扁平会话目录直接位于 root 下（里面就放着当前代产物），旧的项目目录则装着若干
	* 会话子目录 —— 用「目录里有没有产物文件」区分这两种形状。
	*/
	async legacySessionDirs(signal) {
		const dirs = [];
		let entries;
		try {
			entries = await readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if (isENOENT(error)) return dirs;
			throw error;
		}
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (!entry.isDirectory()) continue;
			const project = join(this.root, entry.name);
			let children;
			try {
				children = await readdir(project, { withFileTypes: true });
			} catch (error) {
				if (isENOENT(error)) continue;
				throw error;
			}
			const flat = children.some((child) => child.isFile() && parseGenerationLogFilename(child.name, this.compression) !== void 0);
			if (flat) continue;
			for (const child of children) if (child.isDirectory()) dirs.push(join(project, child.name));
		}
		return dirs;
	}
	/** fork(flat): 该会话真正所在的目录 —— 旧分层会话留在原地，不搬。 */
	dirFor(meta) {
		return this.legacyDirs.get(meta.id) ?? sessionDir(this.root, meta.cwd, meta.id);
	}
	/** fork(flat): 该会话真正所在的当前代产物路径。 */
	pathFor(meta) {
		return join(this.dirFor(meta), basename(logPath(this.root, meta.cwd, meta.id, this.compression)));
	}`,
  },
  {
    id: 'find-log-legacy-fallback',
    description: 'findLog()：扁平优先，找不到再回退到旧分层目录（并记住它）',
    find: `		if (matches.length > 1) throw new Error(\`duplicate JSONL session id "\${id}" appears in multiple project directories\`);
		signal?.throwIfAborted();
		return matches[0];
	}`,
    replace: `		if (matches.length > 1) throw new Error(\`duplicate JSONL session id "\${id}" appears in multiple project directories\`);
		signal?.throwIfAborted();
		if (matches.length === 1) return matches[0];
		/* fork(flat): 回退到升级前的分层布局 \`<root>/<旧项目目录>/<id>/\`，并记住它的位置。 */
		const encoded = encodeSegment(id);
		for (const dir of await this.legacySessionDirs(signal)) {
			signal?.throwIfAborted();
			if (basename(dir) !== encoded) continue;
			const selected = await this.resolveGenerationInDirectory(dir, signal);
			if (selected === void 0) continue;
			this.legacyDirs.set(id, dir);
			matches.push(selected);
		}
		if (matches.length > 1) throw new Error(\`duplicate JSONL session id "\${id}" appears in multiple project directories\`);
		return matches[0];
	}`,
  },
  {
    id: 'list-generations-legacy-merge',
    description: 'listGenerations()：扁平 + 旧分层都列出来，同一个 id 以扁平那份为准',
    find: `	async listGenerations(signal) {
		const sources = [];
		for (const project of await this.listProjectDirs(signal)) for (const dir of await this.listSessionDirs(project, signal)) {
			signal?.throwIfAborted();
			const selected = await this.resolveGenerationInDirectory(dir, signal);
			if (selected !== void 0) sources.push(selected);
		}
		return sources;
	}`,
    replace: `	async listGenerations(signal) {
		const sources = [];
		const flatNames = /* @__PURE__ */ new Set();
		for (const project of await this.listProjectDirs(signal)) for (const dir of await this.listSessionDirs(project, signal)) {
			signal?.throwIfAborted();
			const selected = await this.resolveGenerationInDirectory(dir, signal);
			if (selected === void 0) continue;
			flatNames.add(basename(dir));
			sources.push(selected);
		}
		/* fork(flat): 旧的分层落点仍然可见；同一个 id 扁平优先（listArtifacts 见重复 id 会抛错）。 */
		for (const dir of await this.legacySessionDirs(signal)) {
			signal?.throwIfAborted();
			if (flatNames.has(basename(dir))) continue;
			const selected = await this.resolveGenerationInDirectory(dir, signal);
			if (selected !== void 0) sources.push(selected);
		}
		return sources;
	}`,
  },
  {
    id: 'stored-identity-accepts-legacy',
    description: '身份校验接受旧分层路径（结构判断，不重算 projectKey）',
    find: `		if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal)) throw new Error(\`corrupt session log "\${path}": header id "\${meta.id}" and cwd identify "\${expectedPath}"\`);`,
    replace: `		if (path !== expectedPath && !await this.sameFile(path, expectedPath, signal) && !this.isLegacyLayoutPath(path, meta)) throw new Error(\`corrupt session log "\${path}": header id "\${meta.id}" and cwd identify "\${expectedPath}"\`);`,
  },
  {
    id: 'legacy-layout-path-helper',
    description: '新增旧分层路径的结构判定',
    find: `	/** Validate a supported historical header against the selected source path. */`,
    replace: `	/**
	* fork(flat): \`<root>/<旧项目目录>/<id>/<产物>\` 也是合法来源。
	*
	* 用结构判断而不是重算 projectKey —— 不依赖上游的名称编码规则，也不会因为项目
	* 改过路径而失灵。
	*/
	isLegacyLayoutPath(path, meta) {
		try {
			if (basename(dirname(path)) !== encodeSegment(meta.id)) return false;
			return dirname(dirname(dirname(path))) === resolve(this.root);
		} catch {
			return false;
		}
	}
	/** Validate a supported historical header against the selected source path. */`,
  },
  {
    id: 'path-for-write-paths',
    description: 'appendLines/repair/locate 走 pathFor()，旧分层会话续写回原目录',
    find: `		const content = await this.encodeEventBatch(events);
		const path = logPath(this.root, meta.cwd, meta.id, this.compression);
		const handle = await open(path, "a");`,
    replace: `		const content = await this.encodeEventBatch(events);
		const path = this.pathFor(meta);
		const handle = await open(path, "a");`,
  },
  {
    id: 'path-for-repair',
    description: 'repair() 走 pathFor()',
    find: `	async repair(meta, offset) {
		const path = logPath(this.root, meta.cwd, meta.id, this.compression);`,
    replace: `	async repair(meta, offset) {
		const path = this.pathFor(meta);`,
  },
  {
    id: 'path-for-locate',
    description: 'locate() 走 pathFor()，报告的就是磁盘上那个文件',
    find: `	locate(meta) {
		return {
			kind: "jsonl",
			path: logPath(this.root, meta.cwd, meta.id, this.compression)
		};
	}`,
    replace: `	locate(meta) {
		return {
			kind: "jsonl",
			path: this.pathFor(meta)
		};
	}`,
  },
  {
    id: 'reject-opposite-covers-legacy',
    description: '反向编码检查同时覆盖旧分层目录',
    find: `	async rejectOppositeArtifact(cwd, id) {
		const path = await this.findOppositeGenerationInDirectory(sessionDir(this.root, cwd, id));
		if (path !== void 0) throw this.encodingMismatch(path);
	}`,
    replace: `	async rejectOppositeArtifact(cwd, id) {
		const dirs = [sessionDir(this.root, cwd, id)];
		const legacy = this.legacyDirs.get(id);
		if (legacy !== void 0 && !dirs.includes(legacy)) dirs.push(legacy);
		for (const dir of dirs) {
			const path = await this.findOppositeGenerationInDirectory(dir);
			if (path !== void 0) throw this.encodingMismatch(path);
		}
	}`,
  },
]

/**
 * 计算内容的 sha256。
 *
 * @param input - 字符串或 Buffer。
 * @returns 十六进制摘要。
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * 解析仓库根目录。
 *
 * @returns 绝对路径。
 */
function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * 应用补丁表。
 *
 * @param source - 官方 `lib/index.js` 全文。
 * @returns `{ output, applied }`，锚点缺失或重复时抛错。
 */
export function applyPatches(source) {
  let output = source
  const applied = []
  for (const patch of PATCHES) {
    const occurrences = output.split(patch.find).length - 1
    if (occurrences !== 1) {
      throw new Error(
        `补丁 ${patch.id} 的锚点出现 ${occurrences} 次（要求恰好 1 次）—— 上游很可能改过这段代码：\n` +
          `${patch.find.split('\n').slice(0, 3).join('\n')}\n…`,
      )
    }
    output = output.replace(patch.find, patch.replace)
    applied.push(patch.id)
  }
  return { output, applied }
}

/**
 * 生成分叉的全部产物（不落盘）。
 *
 * @param options - `sourceDir`（官方包目录）。
 * @returns 文件清单 `[{ relative, content, note }]` 与清单对象。
 */
export function build(options = {}) {
  const root = repoRoot()
  const sourceDir = options.sourceDir ?? path.join(root, 'node_modules', UPSTREAM_PACKAGE)
  const manifestPath = path.join(sourceDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到官方包：${sourceDir}\n先跑 \`node tools/harness-sandbox.mjs\` 还原 peer 依赖。`)
  }
  const upstream = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const sourceFile = path.join(sourceDir, 'lib', 'index.js')
  const source = fs.readFileSync(sourceFile, 'utf8')
  const { output, applied } = applyPatches(source)

  const files = [
    {
      relative: 'index.js',
      content: output,
      note: `由 ${UPSTREAM_PACKAGE}@${upstream.version} 的 lib/index.js 打补丁生成，勿手改`,
    },
    {
      relative: 'worker.cjs',
      content: fs.readFileSync(path.join(sourceDir, 'lib', 'worker.cjs'), 'utf8'),
      note: '官方 zstd 压缩 worker，原样搬运（index.js 用 `new URL("./worker.cjs", import.meta.url)` 引用它）',
    },
    {
      relative: 'LICENSE',
      content: fs.readFileSync(path.join(sourceDir, 'LICENSE'), 'utf8'),
      note: '上游 MIT 许可证，必须随分叉一起分发',
    },
  ]

  const manifest = {
    note: '这是派生产物：由 tools/vendor-jsonl-flat.mjs 生成。改动请改补丁表，不要改这里的文件。',
    upstream: { name: UPSTREAM_PACKAGE, version: upstream.version },
    sourceSha256: sha256(source),
    patches: applied,
    outputs: Object.fromEntries(files.map((file) => [file.relative, sha256(file.content)])),
  }
  return { files, manifest }
}

/**
 * 生成 `README.md` 的内容。
 *
 * @param manifest - {@link build} 返回的清单。
 * @returns Markdown 文本。
 */
function readme(manifest) {
  const lines = PATCHES.map((patch) => `- \`${patch.id}\` —— ${patch.description}`)
  return `# 扁平布局分叉（生成物，勿手改）

源头：\`${manifest.upstream.name}@${manifest.upstream.version}\` 的 \`lib/index.js\`。
重新生成：\`node tools/vendor-jsonl-flat.mjs\`；校验：\`node tools/vendor-jsonl-flat.mjs --check\`。

改动共 ${PATCHES.length} 处：

${lines.join('\n')}

上游一改这几段代码，脚本会以「锚点缺失/不唯一」失败 —— 那时人来重新核对补丁，
不要直接编辑 \`index.js\`。
`
}

/**
 * 命令行入口。
 *
 * @param argv - `process.argv.slice(2)`。
 * @returns 退出码。
 */
export function main(argv) {
  const root = repoRoot()
  const options = { check: false, sourceDir: undefined, dest: path.join(root, VENDOR_DIR) }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') options.check = true
    else if (arg === '--source') options.sourceDir = argv[++i]
    else if (arg === '--dest') options.dest = argv[++i]
    else {
      console.error(`unknown argument: ${arg}`)
      return 2
    }
  }

  let built
  try {
    built = build({ sourceDir: options.sourceDir })
  } catch (error) {
    console.error(String(error.message ?? error))
    return 1
  }
  const { files, manifest } = built

  if (options.check) {
    const stale = []
    for (const file of files) {
      const target = path.join(options.dest, file.relative)
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== file.content) stale.push(file.relative)
    }
    const manifestTarget = path.join(options.dest, 'manifest.json')
    const expectedManifest = `${JSON.stringify(manifest, null, 2)}\n`
    if (!fs.existsSync(manifestTarget) || fs.readFileSync(manifestTarget, 'utf8') !== expectedManifest) stale.push('manifest.json')
    if (stale.length > 0) {
      console.error(`分叉产物与补丁表不一致：${stale.join(', ')}\n跑 \`node tools/vendor-jsonl-flat.mjs\` 重新生成。`)
      return 1
    }
    console.log(`分叉产物可重放：${PATCHES.length} 处补丁，源头 ${manifest.upstream.name}@${manifest.upstream.version}`)
    return 0
  }

  fs.mkdirSync(options.dest, { recursive: true })
  for (const file of files) {
    fs.writeFileSync(path.join(options.dest, file.relative), file.content)
  }
  fs.writeFileSync(path.join(options.dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(options.dest, 'README.md'), readme(manifest))
  console.log(`已生成 ${options.dest}：${files.length} 个文件，${PATCHES.length} 处补丁，源头 ${manifest.upstream.name}@${manifest.upstream.version}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exit(main(process.argv.slice(2)))
}

# 扁平布局分叉（生成物，勿手改）

源头：`@deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2` 的 `lib/index.js`。
重新生成：`node tools/vendor-jsonl-flat.mjs`；校验：`node tools/vendor-jsonl-flat.mjs --check`。

改动共 11 处：

- `project-dir-flat` —— projectDir() 不再追加 --<cwd>-- 层：root 自己就是会话容器
- `legacy-dirs-field` —— 记录「已定位过的旧分层会话目录」，让读写留在原地
- `flat-project-dirs-and-legacy-scan` —— root 是唯一的「项目目录」，并新增旧分层目录扫描 + 路径推导
- `find-log-legacy-fallback` —— findLog()：扁平优先，找不到再回退到旧分层目录（并记住它）
- `list-generations-legacy-merge` —— listGenerations()：扁平 + 旧分层都列出来，同一个 id 以扁平那份为准
- `stored-identity-accepts-legacy` —— 身份校验接受旧分层路径（结构判断，不重算 projectKey）
- `legacy-layout-path-helper` —— 新增旧分层路径的结构判定
- `path-for-write-paths` —— appendLines/repair/locate 走 pathFor()，旧分层会话续写回原目录
- `path-for-repair` —— repair() 走 pathFor()
- `path-for-locate` —— locate() 走 pathFor()，报告的就是磁盘上那个文件
- `reject-opposite-covers-legacy` —— 反向编码检查同时覆盖旧分层目录

上游一改这几段代码，脚本会以「锚点缺失/不唯一」失败 —— 那时人来重新核对补丁，
不要直接编辑 `index.js`。

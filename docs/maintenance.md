# SDK 补丁维护

在 Git 中保留维护分支和已经创建的版本分支。SDK 源码编辑、依赖安装和测试都在单独的 SDK checkout 执行。以下命令从维护 checkout 根目录运行，路径可按工作区调整。

## 应用和验证

按 [README](../README.md) 创建干净的基线 worktree。`check` 和 `apply` 校验完整 SHA、工作树和索引。`--only` 自动加入传递依赖并沿用 manifest 顺序。若某组冲突，工具报告组名和 Git 错误，预检期间写入临时索引。修复补丁后用同一干净 checkout 重试。成功 `apply` 后再切换选择时，使用另一个从基线创建的 worktree。

```sh
python3 -m unittest discover -s tools -p 'test_*.py' -v
python3 tools/patchset.py check --target "$sdk" --only artifact-guidance
python3 tools/patchset.py test --target "$sdk" --plan
python3 tools/patchset.py test --target "$sdk"
npm --prefix "$sdk" run typecheck
(cd "$sdk" && npm exec -- eslint src/)
npm --prefix "$sdk" run build
npm --prefix "$sdk" run test:light-entries
```

`test` 使用已有的 SDK Jest 配置，检查列出的每个套件至少有一个通过的测试。共享测试文件可以覆盖几个组。`sdk-validation` 包含 SDK 类型、依赖环等检查。类型、lint 和构建以重放后的项目规则和脚本为准。验证发布护栏的 workflow 语法测试在完整重放 checkout 运行。

涉及摘要时，可额外跑 `npm test -- --runInBand --runTestsByPath src/specs/summarization.test.ts -t 'no API keys'`。涉及图、工具、流或供应商追踪时，按重放后的 `AGENTS.md` 运行 `npm test -- --runInBand langfuse deterministic-trace-id`。使用真实 LLM 或 Langfuse 的测试需要对应服务身份，按实际运行情况记录结果。

## 新增或更新单组

1. 选定责任组和位置。在新建的干净基线 worktree 中，使用 `apply --only <前序组列表>` 应用 manifest 中排在该组之前的 active 组。如果该组排第一，直接使用基线。如果在末尾新增，应用全部旧组。
2. 用 `git -C "$edit" write-tree` 记录前序树 `before`。更新现有组时，在这个 worktree 对该组运行 `git -C "$edit" apply --index "$patches/patches/$id/changes.patch"`。`patches` 指维护 checkout 的绝对路径，`edit` 指 SDK 编辑 checkout。
3. 修改 SDK 源码、相关测试和文档。阶段性文件只加入本组路径。保存前检查 `git -C "$edit" diff --cached`，再用 `git -C "$edit" write-tree` 得到 `after`。
4. 从 `before` 到 `after` 生成标准 Git diff。检查净差异及共享文件的上下文，再替换维护分支的 `patches/<id>/changes.patch`。

```sh
git -C "$edit" diff --check "$before" "$after"
git -C "$edit" diff --binary --full-index --no-renames --no-ext-diff --no-textconv \
  --no-color --src-prefix=a/ --dst-prefix=b/ "$before" "$after" > "$edit.patch"
```

5. 新增时在 manifest 对应位置加 `id`、`status`、`summary`、`depends_on` 及适用的 `jest` 测试路径或 `commands` 参数数组。已存在的组只更新实际变化的依赖与检查。把来源和责任写入 [来源说明](sources.md)。在新基线 checkout 预检定向选择和整套补丁，重放整套并执行受影响的测试。后续组如果有冲突，按顺序用新的前序树更新它们。

包版本的唯一维护入口是 `package-metadata`。按上面的单组流程应用现有组，在 SDK 编辑 checkout 运行 `npm version <X.Y.Z-ricky.N> --no-git-tag-version --ignore-scripts`，一起暂存 `package.json` 和 `package-lock.json` 并重新生成这一组。发版命令的 `--version` 只核对包与锁的版本。升级锁文件时使用 npm 生成锁并检查差异。`X.Y.Z` 取自固定上游包版本，同一官方版本上的下一次 fork 发版递增 `N`。

## 更新基线与处理冲突

1. 用 `git fetch --no-tags upstream "refs/tags/$tag"` 从 `upstream` 取回目标官方标签，用 `git ls-remote upstream "refs/tags/$tag" "refs/tags/$tag^{}"` 核对。用 `git rev-parse 'FETCH_HEAD^{commit}'` 得到刚取回的完整提交。核对标签对应的 `package.json` 版本，再更新 manifest 的 `upstream.ref` 和 `upstream.commit`。
2. 保留旧维护提交用于对照。从新 SHA 新建编辑 worktree，按 manifest 顺序为各组记下 `before` 树，用 `git apply --index` 试应用。出现冲突时，先查看新上游实现和调用方。可在这个临时 checkout 用 `git apply --3way` 辅助合并，再逐文件解决、暂存。若 Git 缺少共享 hunk 的旧 blob，在同一 Git 仓的另一个 worktree 重放旧版前序和该组以恢复旧 blob。锁文件与新上游有交叉时，从新锁用 npm 重新生成。
3. 每完成一组，就按单组流程生成新净差异，或按下节登记替代。验证改动和依赖后，在另一个干净的新基线 worktree 执行完整 `check`、`apply` 和测试。出现一半合并结果时，可保留该编辑 checkout，另建干净 worktree 重来。

## 部分替代、完全替代和主动淘汰

先在目标基线定位覆盖行为的提交。对照旧组的调用方、边界行为、持久数据和公共类型。用相同的可运行用例分别检查旧组与目标实现。比较 diff、构建和测试结果，并检查其他组对该行为和共享上下文的依赖。

- **部分上游替代**。保留该组的 active 状态，只移除已覆盖的 hunks。在来源说明记录目标基线、上游完整提交、覆盖的行为、剩余职责与测试结果。保留仍能检查合同的测试。
- **完全上游替代**。状态改为 `upstream`，删除载荷和旧测试入口。设置 `replacement.commit` 为已包含在目标基线中的上游完整 SHA。`replacement.evidence` 记录等价范围和实际测试命令与结果。`check` 和 `apply` 会验证上游提交的祖先关系。
- **由另一补丁组替代**。状态改为 `replaced`，以 `replacement.patch` 指向 active 后继组。记录等价证据，并让后继组接管相应测试。
- **主动淘汰**。确认消费方已经移除调用或接受行为变化后，状态改为 `retired`。在 `replacement.evidence` 记录原因、消费方影响和新基线测试结果。

后三种状态保留 manifest 条目，清空 `depends_on`，移除载荷。依赖旧组的 active 组要显式改依赖，并在目标基线上重放和测试。上游或主动淘汰也可以把仍有价值的用例转交现有组。历史发版继续通过其原有分支和记录追溯。

## 生成和交付版本

1. 在完整重放 checkout 通过受影响的 SDK 检查。提交维护补丁，确认 `origin` 指向 fork，并在干净的维护 checkout 运行 [发版命令](../README.md)。`--patch-ref` 可以给本地维护 ref 或完整 SHA。工具从该提交读 manifest、补丁和 tarball smoke。
2. 工具在输出目录下新建 `source` worktree。它核对上游包版本、fork 的包名、版本及锁文件两处版本，并把完整重放保存为发版提交的父提交。它随后在发版 tip 移除 `.github/workflows/`。在这个干净提交上执行 `npm ci --ignore-scripts --no-audit --no-fund`、`npm run build` 和 `npm pack --ignore-scripts --json`。
3. 工具用实际 tarball 在两个消费 workspace 安装 `file:` 依赖，核实只安装一份，锁的版本、路径和 SHA-512 匹配，并加载全部 CJS 与 ESM 入口。类型检查沿用 SDK 打包测试的解析模式，ESM 用 `bundler` 检查各入口，CJS 用 `node` 检查根入口。通过后工具以创建方式写入本地 `release/v<version>`。本地或 `origin` 已有同名分支时拒绝。冲突、构建或验证失败时，查看留下的 checkout 和报错，修复后用新输出目录重试。同一版本已经建分支后，后续发行用下一版本。
4. 随 tarball 保存 `release.json` 和 `agents-<version>.patch`。记录包含补丁提交、上游 SHA、完整重放和实际发版的 commit/tree，以及包和 diff 摘要。`git show -s --format=%B release/v<version>` 也可读取版本及重放来源。

当前纯重放保留 `ci.yml`、`publish.yml`、`validate.yml` 和 `workflow-syntax.yml`。历史 `publish.yml` 有 `main` push 和手动触发，拥有 `id-token: write`，验证使用 `secrets: inherit`。它的发布 jobs 已限定 `LibreChat-AI/agents`。发版 tip 移除整个 `.github/workflows/`，覆盖现有和后续上游 workflow。维护分支也没有 workflow。该断点适用于维护及 `release/v*` 分支，旧 `main` 仍按其自身 workflow 处理事件。首次采用时，把后续维护 PR 指向 `patches`。发版入口仅构建本地文件和 Git ref，npm 网络访问用于读取依赖。

## 交给 LibreChat

在 LibreChat 自己的 `sdk` 补丁编辑 checkout 里按其 `vendor/README.md` 操作。复制 tarball 到 `vendor/`，复制同版源码 patch 并更新 `vendor/agents.json`。以 `release.json` 的 `source` 核对实际构建提交、tree、base、干净构建状态及源码 patch SHA-256，将 `tarball.sha256` 填入应用元数据。给 patch 路径加 `vendor/` 前缀，并按应用的元数据结构填写其余字段。将 `api/package.json` 的依赖指向 `file:../vendor/<tarball>`，`packages/api/package.json` 指向 `file:../../vendor/<tarball>`。用 npm 更新根锁，确认根安装项 `resolved` 为 `file:vendor/<tarball>`，`integrity` 对应 tarball，并运行 `node vendor/verify-agents.mjs` 与应用 SDK 验证。[LibreChat SDK 补丁](https://github.com/Ricky-Hao/LibreChat/tree/f02d9b1d81a5e61661d69bea05e9278c162a3fd7/patches/sdk)

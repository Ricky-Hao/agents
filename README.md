# Ricky-Hao/agents SDK 补丁

本分支维护 `@librechat/agents` 的有序补丁。`manifest.json` 固定上游完整 SHA，并记录各组依赖和定向检查。维护分支用于审阅补丁，`release/v<version>` 用于保存生成的 SDK 源码。

当前基线是 LibreChat-AI/agents `v4.2.11`（`690865f925800990bc8941e15fe93741b3cbd626`）。本分支生成 `4.2.11-ricky.2` 本地候选。生产前序 `4.2.11-ricky.1` 的完整重放 tree 为 `996688a08ea9bca1030271f79e23a14df8ad537d`。[来源与分组](docs/sources.md)

在维护 checkout 根目录运行。重放需要 Git 和 Python 3.9+。SDK 验证和打包使用目标 `package.json` 要求的 Node 与 npm，当前需要 Node 24+。

```sh
base=$(python3 -c 'import json; print(json.load(open("manifest.json"))["upstream"]["commit"])')
sdk=../agents-sdk-replay
git -c submodule.recurse=false worktree add --detach "$sdk" "$base"
python3 tools/patchset.py list
python3 tools/patchset.py check --target "$sdk"
python3 tools/patchset.py apply --target "$sdk"
git -C "$sdk" write-tree
npm --prefix "$sdk" ci --ignore-scripts --no-audit --no-fund
python3 tools/patchset.py test --target "$sdk"
```

`check` 在临时 Git 索引中重放。`apply` 成功后在 SDK checkout 暂存整套差异。两者都从干净的固定基线开始。用 `--only summary-stream` 可验证一个组及其依赖，用 `test --plan` 可查看命令。

每次发版在已提交的维护 checkout 中，用完整版本创建新分支。`origin` 指向 Ricky-Hao/agents，输出目录须是新路径。

```sh
python3 tools/release.py --patch-ref HEAD --version 4.2.11-ricky.2 \
  --output ../agents-release-4.2.11-ricky.2
```

命令保留完整重放提交，在发版分支的 tip 移除 GitHub Actions workflows，并构建和验证 SDK tarball。保留输出目录中的 tarball、源码 diff 和 `release.json`。版本更新、冲突处理、替代、淘汰及 LibreChat 接入见[维护手册](docs/maintenance.md)。

# SDK 补丁维护

- 在本分支维护 `manifest.json`、`patches/`、工具和文档。SDK 源码改动在固定上游的独立 worktree 完成，并按责任组保存净差异。
- 先读 [维护手册](docs/maintenance.md) 和 [来源与分组](docs/sources.md)。应用顺序、依赖、状态和定向测试入口以 `manifest.json` 为准。
- 修改已有组时保留共享文件中其他组负责的行为。升级基线或替代补丁时，在新基线重放并运行相关检查。SDK 的开发规范和 Langfuse 契约在重放后的 `AGENTS.md` 中。
- 使用 `tools/release.py` 从已提交的维护版本生成新发版分支。本分支与发版分支都使用本地验证。按授权执行任何远端操作，历史 `release/v*` 分支保持原有指向。

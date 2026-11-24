# 首次迁移来源

- 上游基线为 `690865f925800990bc8941e15fe93741b3cbd626`，对应官方 `v4.2.11` 标签和 fork 合并 `f2336b95` 的第二父提交。基线 Git tree 为 `f4e07c1d4a8d085e941592120fb35c654124549a`。[上游标签](https://github.com/LibreChat-AI/agents/tree/v4.2.11)
- fork 快照为 `06ac16c17bcd7a75e79c01d57248f350b157676b`，包含 PR #5 的 HTTP 超时测试修正。11 组保存它相对基线的全部 128 个差异路径，完整重放 Git tree 为 `996688a08ea9bca1030271f79e23a14df8ad537d`。[fork 快照](https://github.com/Ricky-Hao/agents/commit/06ac16c17bcd7a75e79c01d57248f350b157676b) · [PR #5](https://github.com/Ricky-Hao/agents/pull/5)
- 重放和发版源码保留基线的两个 gitlink。`.worktrees/adaptive-smoother` 指向 `34be23de75f040d74addf1a03d31409f85c46162`，`.worktrees/preempt-restart` 指向 `80d43fabf67ec6bbc679bb3eb08f1d595ec6643c`。这些路径无 `.gitmodules` 映射，构建使用普通 checkout。
- 维护工具的 manifest 选择和临时索引预检参考 LibreChat `patches` 的 `f02d9b1d81a5e61661d69bea05e9278c162a3fd7`。包 smoke 参考 agents 的 `config/runtime-package.test.mjs` 和 LibreChat 的 `vendor/verify-agents.mjs`。[LibreChat 补丁树](https://github.com/Ricky-Hao/LibreChat/tree/f02d9b1d81a5e61661d69bea05e9278c162a3fd7)

## 补丁组

路径范围可用 `git apply --stat patches/<id>/changes.patch` 查看。[manifest](../manifest.json) 记录唯一的重放顺序、状态、依赖和自动检查。

| 补丁组 | 维护职责 |
| --- | --- |
| `package-metadata` | `package.json` 和二进制 diff 形式的 `package-lock.json`。保留 fork 版本、axios 版本和 npm 打包文件清单。 |
| `message-provenance` | Skill 载体与版本、来源与最近消息、助手文本阶段和供应商消息投影。 |
| `summary-stream` | 摘要压缩和摘要占位、推理内容抽取与摘要失败事件。继承 `message-provenance` 的消息结构和共享 hunks。 |
| `programmatic-tools` | 程序化调用标识、intent、续接、富结果和错误归一化、本地工具选择与导出。 |
| `artifact-guidance` | Python、Bash 与代码执行器的产物和跨技能文件提示。继承 `programmatic-tools` 的调用入口和测试。 |
| `checkpoint-replay` | 审批中断、工具批次、子代理和 checkpoint 重放。含原 fork 对同组实现和测试的格式调整。 |
| `provider-compatibility` | 提示缓存、供应商流适配、token 用量和代理兼容性。 |
| `local-tool-result-caps` | 本地工具输出上限、截断提示和 workspace 执行相关检查。 |
| `sdk-validation` | SDK 开发规范、lint、Langfuse 测试及 decisions HTTP 超时测试修正。 |
| `sdk-consumer-docs` | SDK README 与迁移文档。依赖它所述的包元数据、摘要和工具行为。 |
| `upstream-publish-guard` | 历史 fork 对上游 npm publish 和 GitHub Release jobs 的仓库限定。发版流程另行移除 workflows。 |
| `tool-image-read` | `read_image` 的同轮根图引用、直接工具执行和 Responses 预算投影。`4.2.11-ricky.2` 首次交付，`4.2.11-ricky.3` 支持宿主已确认的前台提问 saver。 [补丁说明](../patches/tool-image-read/README.md) |

`src/messages/format.ts` 和 `src/stream.ts` 由消息组及摘要组分段维护。`src/types/tools.ts` 中 Skill 来源字段与输出上限分属消息组和本地上限组。`ProgrammaticToolCalling.ts` 和对应测试分属程序化工具组与产物提示组。更新一个组时，从该组的前序树生成差异。

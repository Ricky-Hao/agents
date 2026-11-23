# 工具原图按需读回

本组基于官方 `v4.2.11`（`690865f925800990bc8941e15fe93741b3cbd626`），继承 fork `06ac16c17bcd7a75e79c01d57248f350b157676b` 的根图工具执行和 provider 投影。它随本地 `4.2.11-ricky.2` 候选首次交付。LibreChat 的 `patches/mcp-images` 负责识别真实 MCP 调用和限定宿主入口。

宿主显式传入 `RunConfig.isTrustedToolImage` 后，符合条件的根图注册 `read_image({ref})`。工具只查找本次执行原图状态中的已授权结果。请求预算先容纳当前批的常规材料，再按 tool call 顺序加入读回图。源结果和读回结果各自保留 call ID。读回字节只进入当前 Responses 请求的结构化图片块。

本组依赖 `checkpoint-replay` 的工具批生命周期和共享文件上下文。替换前应在同一固定基线核实图状态身份、作用域、预算和调用配对，再用消费方的真实入口合同检查请求。定向合同为 `python3 tools/patchset.py test --target "$sdk" --only tool-image-read`，会执行本组及依赖的 Jest 用例。

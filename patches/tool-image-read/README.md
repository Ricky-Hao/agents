# 工具原图按需读回

本组基于官方 `v4.2.11`（`690865f925800990bc8941e15fe93741b3cbd626`），继承 fork `06ac16c17bcd7a75e79c01d57248f350b157676b` 的根图工具执行和 provider 投影。它随本地 `4.2.11-ricky.2` 候选首次交付。LibreChat 的 `patches/mcp-images` 负责识别真实 MCP 调用和限定宿主入口。

宿主显式传入 `RunConfig.isTrustedToolImage` 后，符合条件的根图注册 `read_image({ref})`。工具只查找本次执行原图状态中的已授权结果。请求预算先容纳当前批的常规材料，再按 tool call 顺序加入读回图。源结果和读回结果各自保留 call ID。读回字节只进入当前 Responses 请求的结构化图片块。

`4.2.11-ricky.3` 增加受信宿主的 `RunConfig.allowToolImageReadWithCheckpointer` 准入，供 LibreChat 普通前台提问使用。一般工具审批仍停用读回。新鲜执行只接受当前图中有来源证明的原消息。正常 saver 写入期间，当前图保留原消息身份。序列化后重建的消息无法发放或兑换旧引用。

提问与读回同批时沿用直接工具的中断优先顺序。实际暂停立即清空读回作用域，`Command` 恢复或带 checkpoint 游标的执行也不启动新作用域。模型的选图参数只关联到当次响应对象，交给 saver 的调用与流式工具事件保留名称、调用 ID 和空参数。持久状态中的读回结果只有文本，原始 MCP artifact 继续由既有 saver 管理。

本组依赖 `checkpoint-replay` 的工具批生命周期和共享文件上下文。替换前应在同一固定基线核实图状态身份、作用域、预算和调用配对，再用消费方的真实入口合同检查请求。定向合同为 `python3 tools/patchset.py test --target "$sdk" --only tool-image-read`，会执行本组及依赖的 Jest 用例。

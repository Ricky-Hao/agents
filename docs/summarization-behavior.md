# Summarization & Context Management Behavior

## Overview

LibreChat's agent context management uses a staged pipeline inspired by Claude Code's compaction approach. The behavior differs based on whether summarization is enabled or disabled for the agent.

Both paths share **observation masking** as the first line of defense. When masking is insufficient, summarization-enabled agents summarize older context and retain a recent tail. Summarization-disabled agents apply progressively aggressive mechanical truncation.

---

## Shared Behavior (Both Paths)

### Observation Masking (80%+ context pressure)

When the total message tokens exceed 80% of the pruning budget, consumed ToolMessages are replaced with tight head+tail truncations (~300 chars) that serve as informative placeholders.

**Consumed** means: a subsequent AI message exists with substantive text content (not purely tool calls). The model has already read and acted on the result.

- AI messages are **never masked** — they contain the model's own reasoning and conclusions, which prevents the model from repeating work after tool results are masked.
- **Unconsumed** tool results (the latest outputs the model hasn't responded to yet) are left intact.
- This runs every agent node turn when pressure is at or above 80%.

### Token Budget Anatomy

```
maxContextTokens (e.g. 8000)
  - reserveTokens (5% default)
  = pruningBudget
  - instructionTokens (system message + tool schemas)
  = effectiveMaxTokens (available for conversation messages)
```

`contextPressure = calibratedTotalTokens / pruningBudget`

### Calibration

Token counts from the local tokenizer (tiktoken) diverge from what providers actually count. The pruner maintains a **cumulative calibration ratio**:

```
calibrationRatio = cumulativeProviderReported / cumulativeRawSent
```

Updated each turn from `usageMetadata.input_tokens` returned by the provider. The ratio is persisted across runs via `contextMeta.calibrationRatio` so subsequent conversations start calibrated.

All budget comparisons multiply raw counts by `calibrationRatio` to approximate provider space, while the `indexTokenCountMap` stays in raw-token space for stability.

### Fading Tier

Every character cap applied to historical tool results (masking, pre-flight truncation, fit-to-budget) derives from one latched **fading tier** (`src/messages/fading.ts`): `{ v, budgetTokens, masked }`. The budget sits on a ladder that halves the context window per rung; the tier only ever shrinks and masking only ever activates. Because truncation is a pure function of (content, cap), a historical tool result maps to identical bytes on every call within a tier — which is what keeps prefix-based provider prompt caches (Anthropic's single tail breakpoint) valid from turn to turn. Only escalation and compaction rewrite the prefix.

- **Fit rung**: the shallowest rung at which the widest observed parallel tool exchange (call inputs plus fresh results) fits within the effective budget, so a complete exchange can never leave the context empty or lose its results to orphan repair.
- **Pressure-band rungs** (summarization disabled only): +1 rung at 85 %, +2 at 90 %, +4 at 99 %.
- **Masking** latches at 80 % pressure; consumed results then keep 10 % of the fresh cap (floor 300 chars).

Graph history stays canonical. The pruner keeps the original bytes of every capped tool result and input-capped AI message and builds a provider-facing projection per Run from them, so a deeper tier or masking re-derives from the original content and matches what a fresh Run seeded with the same tier derives from the host's stored messages. Restored tiers are validated at every boundary (`Run`, `StandardGraph`, `AgentSession`); an invalid or fresh seed starts fresh.

The tier is returned from every prune call. Single-agent hosts can use `Run.getFadingTier()` and `RunConfig.fadingTier`; multi-agent hosts should persist `Run.getFadingTiers()` and restore `RunConfig.fadingTiers` so each agent keeps its independent tier. The budget is absolute, so a mid-run budget correction or a return to the normal window keeps the tier; only compaction resets it, and `Run.didResetFadingTier()` / `Run.getFadingTierResetAgentIds()` report that reset to hosts that merge tiers.

**Instruction overhead calibration**: The pruner also tracks `bestInstructionOverhead` — the best observed instruction token count from provider feedback. When the variance between the estimated and calibrated `toolSchemaTokens` exceeds 15% (`CALIBRATION_VARIANCE_THRESHOLD`), the calibrated value is applied to `AgentContext.toolSchemaTokens`. This corrects the local tool-schema estimate (which uses a static multiplier) against real provider behavior. After intra-run summarization, the calibrated overhead is preserved and seeded into the recreated pruner.

---

## When Summarization is Enabled

### Pipeline (every agent node turn)

1. **Fit-to-budget truncation** (every turn): the fading tier's fit rung caps every tool result and tool-call input so the widest observed parallel exchange fits within the effective budget. The cap is latched, so a historical result keeps the same bytes on later turns.

2. **80%+ pressure — Observation masking**: Masking latches on the tier; consumed ToolMessages shrink to 10 % of the fresh cap (floor ~300 chars). Pre-masking snapshot saved so the summarizer can access un-masked originals later.

3. **Apply pass**: `applyFadingCaps` walks only the messages that arrived since the last call (or everything after an escalation) and rewrites the ones above their cap.

4. **Pruning split**: `getMessagesWithinTokenLimit` determines which messages fit (`context`) and which overflow (`messagesToRefine`). Messages are kept newest-first.

5. **Summarization trigger**: If `messagesToRefine` is non-empty, `shouldTriggerSummarization` evaluates the configured trigger (or defaults to "any pruned messages"). The unchanged-message guard and consecutive-failure limit bound repeated attempts. If triggered, compaction selects an older head and a retained recent tail.

### Compaction and Retained History

When summarization fires:

- The default policy retains up to two recent user-led turns, within a token budget of `min(16000, 16% of maxContextTokens)`.
- Under pressure, older closed tool exchanges within one long turn can form the compactable head. Tool-call/result pairs stay balanced, and a lone user payload stays intact.
- The summarizer sees bounded provider history and an instruction identifying the first retained message. Input bounding compresses tool output before omitting retained-tail context; it preserves the required head.
- On success, graph state becomes `createRemoveAllMessage()` followed by the canonical retained messages. The summary carrier precedes that tail on subsequent model calls.
- Setting `retainRecent: { turns: 0 }` restores full-history compaction with no retained tail. If there is no compactable head, automatic compaction skips; manual compaction reports `nothing_to_summarize`.

### Summary Injection After Compaction

After compaction, `AgentContext` injects a generated-context `HumanMessage` before the retained tail. The carrier states that the summary may be incomplete or mistaken. It does not claim that the current model wrote it.

With no retained tail, the next call starts with `[SystemMessage(instructions), HumanMessage(summary)]`. With a retained tail, the summary stays before those messages. The carrier is counted against the receiving model's budget.

### Summarization Invocation

The selected provider history is sent through `attemptInvoke` with the summarization instruction appended as the final HumanMessage. Tools remain schema-only, so a summarizer cannot execute them. Compatible self-summarization requests reuse prompt-cache shaping; other providers use their own preparation and budget. Context-budget rejection can retry with a smaller input, and configured fallback providers are attempted when the primary fails.

If all providers fail, existing summary state, version, and history remain intact for automatic, overflow, and manual triggers. Empty output and interrupted attempts also cannot advance the compaction boundary. Failed steps close and emit `on_summarize_complete` with an error and classified `errorCode`; available attempt usage remains attached. Run-wide stream-limit failures propagate to the caller. Prompts preserve uncertainty about tool results and truncation.

### 摘要流内容契约

`on_summarize_delta` 的 `summary.content` 始终是内容块数组。字符串转成 text 块，合法内容块保持原顺序。结构化 reasoning 只提取 `summary` 中的文本，不输出对象或其他元数据。空 reasoning 不发送空 delta，也不能遮蔽同一 chunk 或后续 chunk 的正文。

流中的 reasoning 只用于临时显示。完成事件用最终摘要替换临时内容；保存的摘要只取正文。只有 reasoning、空输出或失败的尝试不能推进摘要边界。

### Summarization Prompt

The prompt is written in the tone of a user directing the assistant — assertive, first-person, active voice:

> "Hold on, before you continue I need you to write me a checkpoint of everything so far..."

This prevents the model from continuing to roleplay or respond to the conversation instead of producing a structured checkpoint.

### Emergency Truncation

If masking + fit-to-budget still produce an **empty context** (no messages fit at all), a deeper, temporary tier at which one complete tool exchange (result plus call input) fits within a per-message share of the effective budget is applied to a clone of the messages before pruning is retried. The latched tier is left alone: that share depends on the message count, and latching it would pin every future result to one transient event.

### Cross-Run Behavior

- `initialSummary` from the prior run is included in the **system prompt** via `buildInstructionsString`.
- `formatAgentMessages` drops messages before the summary boundary in the message chain.
- The model sees the system prompt (with summary) + the user's new message.
- Mid-run summaries use the HumanMessage carrier before retained history.

---

## When Summarization is Disabled

### Pipeline (every agent node turn)

1. **< 80% pressure**: No modifications.

2. **80%+ pressure — Observation masking**: Same consumed-only masking as the summarization-enabled path. Consumed ToolMessages masked, unconsumed left intact, AI messages untouched.

3. **80%+ pressure — Context pressure fading**: The fading tier deepens by extra rungs on top of the fit rung, halving the cap budget per rung:

   | Pressure | Extra rungs | Budget factor |
   | -------- | ----------- | ------------- |
   | 80%      | 0           | 1.0           |
   | 85%      | 1           | 0.5           |
   | 90%      | 2           | 0.25          |
   | 99%      | 4           | 0.0625        |

   Every tool result shares one cap at a given tier; the consumed/fresh distinction from masking is the only per-message difference. The tier never relaxes, so a conversation hovering around a threshold does not flip between bands.

4. **Position-based context pruning** (if `contextPruningConfig.enabled`): Additional position-based degradation of old tool results.

5. **Pruning**: `getMessagesWithinTokenLimit` drops oldest messages to fit budget. Orphan repair strips unpaired tool_use/tool_result blocks.

6. **Emergency truncation** (if pruning produces empty context): A temporary tier at which one complete tool exchange fits within the per-message share of the effective budget is applied to a clone, then pruning is retried. The latched tier is not changed.

### Key Difference from Enabled Path

Messages that get pruned are **gone** — no summary captures them. The model loses context of what it did in earlier turns. This is acceptable for simpler conversations but problematic for long agentic runs with many tool calls.

---

## Summary Injection Locations

| Scenario                     | Where                                       | Why                                                        |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Mid-run post-compaction      | `HumanMessage` before retained history      | Preserve checkpoint and tail ordering                      |
| Mid-run subsequent turns     | Carrier stays before the retained tail      | Keep the checkpoint available with recent context          |
| Cross-run (`initialSummary`) | System prompt via `buildInstructionsString` | One-time cost; model needs it alongside user's new message |
| No summary                   | N/A                                         | Normal `[SystemMessage, ...messages]`                      |

---

## Observation Masking Details

A ToolMessage is **consumed** when a subsequent AI message exists with substantive text content — meaning the model has read and acted on the result. Detection walks backwards from the end of the messages array:

1. Find the first AI message with non-empty text content (not just tool calls).
2. All ToolMessages before that point are consumed.
3. ToolMessages after that point are unconsumed.

Masking uses `truncateToolResultContent` with a ~300 char limit, producing head+tail truncations that preserve the beginning and end of the result. This is more informative than a synthetic placeholder — the model can still see what the tool returned at a glance.

---

## Key Design Decisions

1. **Summarization IS the pruning** — when enabled, no messages are hard-pruned without being captured in a summary first. The summary replaces dropped messages.

2. **Retain recent context** — summarize the older head while preserving a bounded tail of canonical messages and complete tool exchanges.

3. **Generated-context carrier** — mid-run summaries use a HumanMessage that preserves uncertainty and precedes retained history.

4. **Observation masking for both paths** — consumed tool results are masked regardless of whether summarization is enabled. The model's own AI message text preserves what it concluded from those results.

5. **No events XML** — with full compaction the LLM sees the entire conversation each time, making structured event extraction redundant with the checkpoint's markdown content.

6. **Computed `instructionTokens`** — `instructionTokens` is a getter (`systemMessageTokens + toolSchemaTokens`), not a manually tracked value. This eliminates the category of bugs where instruction overhead gets out of sync from increments/decrements in multiple places.

---

## Configuration Reference

### `librechat.yaml` — `summarization` block

| Field              | Type           | Default                    | Description                                                                                                      |
| ------------------ | -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `boolean`      | `true`                     | Top-level kill switch. Set `false` to disable summarization globally.                                            |
| `provider`         | `string`       | Agent's own provider       | LLM provider for the summarizer (e.g. `anthropic`, `bedrock`).                                                   |
| `model`            | `string`       | Agent's own model          | Model for summarization calls.                                                                                   |
| `parameters`       | `object`       | `{}`                       | Extra LLM constructor params (temperature, etc.). Also accepts `maxSummaryTokens`.                               |
| `prompt`           | `string`       | Built-in checkpoint prompt | Custom prompt for initial summarization.                                                                         |
| `updatePrompt`     | `string`       | Built-in update prompt     | Custom prompt for re-compaction when a prior summary exists. Falls back to `prompt`.                             |
| `trigger`          | `object`       | Always on overflow         | When to fire summarization. See trigger types below.                                                             |
| `reserveRatio`     | `number (0-1)` | `0.05`                     | Fraction of token budget reserved as headroom. Pruning triggers at `budget * (1 - r)`.                           |
| `maxSummaryTokens` | `number`       | Provider/client default    | Optional max output tokens for the summarization model.                                                          |
| `retainRecent`     | `object`       | Two turns, bounded tokens  | `turns` selects recent user-led turns; `tokens` sets the retained budget. `{ turns: 0 }` summarizes all history. |
| `contextPruning`   | `object`       | disabled                   | Position-based context pruning (only applies when summarization is disabled).                                    |

### SDK-only budget setting

`SummarizationConfig.contextBudgetMode` defaults to `input`; set it to `window` when the configured context ceiling covers the full model window, including output. Hosts must explicitly map this SDK field before exposing it through their own configuration. The consumer YAML adapter does not currently forward it.

### Trigger types (`trigger` field)

| Type                 | Value     | Behavior                                                                    |
| -------------------- | --------- | --------------------------------------------------------------------------- |
| `token_ratio`        | `0.0-1.0` | Fire when `1 - effectiveRemainingContextTokens / maxContextTokens >= value` |
| `remaining_tokens`   | `number`  | Fire when `effectiveRemainingContextTokens <= value`                        |
| `messages_to_refine` | `number`  | Fire when `messagesToRefine.length >= value`                                |
| _(not set)_          | —         | Fire whenever pruning drops any messages (default)                          |

### `contextPruning` sub-config (summarization-disabled path only)

| Field                  | Type            | Default | Description                                                 |
| ---------------------- | --------------- | ------- | ----------------------------------------------------------- |
| `enabled`              | `boolean`       | `false` | Enable position-based tool result degradation.              |
| `keepLastAssistants`   | `number (0-10)` | —       | Number of recent assistant turns to protect from pruning.   |
| `softTrimRatio`        | `number (0-1)`  | —       | Position threshold for head+tail soft-trim.                 |
| `hardClearRatio`       | `number (0-1)`  | —       | Position threshold for full content replacement.            |
| `minPrunableToolChars` | `number`        | —       | Minimum chars before a tool result is eligible for pruning. |

### `parameters` sub-fields (extracted before passing to LLM)

| Field              | Type     | Default                 | Description                                     |
| ------------------ | -------- | ----------------------- | ----------------------------------------------- |
| `maxSummaryTokens` | `number` | Provider/client default | Can also be set here (same as top-level field). |

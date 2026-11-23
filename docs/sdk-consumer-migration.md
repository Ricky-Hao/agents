# Fork SDK Consumer Migration

`4.2.11-ricky.1` merges LibreChat-AI/agents `v4.2.11` (`690865f925800990bc8941e15fe93741b3cbd626`) and carries forward the SDK contracts consolidated in `4.2.2-ricky.1`. The SDK supplies the programmatic call identity and Zod 4 schema inspection that originally came from the LibreChat consumer patch.

## Contract Mapping

| Consumer behavior                        | SDK owner                                                                 | Migration                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill provenance and source wrappers     | `messages/skillCarrier.ts`, `messages/format.ts`, Skill tools             | Preserve application-loaded source metadata and the full skill body.                                                                                                          |
| Assistant phase and provider projection  | `messages/assistantPhase.ts`, `stream.ts`, provider converters            | Keep phase on assistant content and project only supported fields to providers.                                                                                               |
| Reasoning normalization and array deltas | `messages/reasoningTypes.ts`, `stream.ts`, `summarization/node.ts`        | Preserve text order; summary deltas use content-block arrays and never expose reasoning metadata as text.                                                                     |
| Summary failure safety                   | `summarization/node.ts`, `shared.ts`, upstream retry/input/window helpers | Preserve old summary and history on failure; retain uncertainty guidance and use the upstream budget, cancellation, and recent-tail policies.                                 |
| Programmatic call identity               | `tools/intentArg.ts`, `ProgrammaticToolCalling.ts`                        | Read `config[PROGRAMMATIC_TOOL_CALL_ID]` inside the SDK-provided invoke config. The symbol property is non-enumerable and non-writable; sandbox arguments are not its source. |
| Schema-aware intent removal              | `tools/intentArg.ts`, `utils/schema.ts`                                   | Prefer Zod 4 `_zod.def`, fall back to Zod 3 `_def`, and preserve business fields named `intent` unless they match the SDK label schema.                                       |
| Protocol errors, rich content, artifacts | `tools/response.ts`, execution tools, `utils/toolContent.ts`              | Preserve error status and structured content instead of flattening all results to text.                                                                                       |
| File delivery guidance                   | `tools/codeGuidance.ts`, execution tools, `agents/AgentContext.ts`        | Keep SDK file-delivery guidance available to code tools and agent instructions.                                                                                               |
| Langfuse and cache usage                 | Existing tracing modules and v4.2.2 provider accounting                   | Keep run-scoped identity, redaction, deterministic traces, and cache-write TTL usage fields.                                                                                  |

The obsolete metadata-summary generator is removed. Existing persisted diagnostic stubs remain recognizable so they are not reintroduced as valid summaries.

## Host Responsibilities

The SDK handles execution, content normalization, protocol results, and internal invocation markers. The host owns HTTP authentication, authorization, database writes, session binding, private context, and trust decisions. A symbol marker supplies invocation context within the process; it does not authorize a request.

The frontend summary reducer in `packages/chat` accepts content-block arrays and replaces temporary content on successful completion. An error completion must leave the previous checkpoint and history in place. `summary.coverage` identifies the retained-history boundary when available.

By default the SDK sends buffered deltas after a successful attempt, including normalized display reasoning. This supports the existing append-only LibreChat fork reducer. A consumer that handles `SummarizeDeltaEvent.reset` can set `summarizationConfig.streamDeltas: true` to receive live text deltas. On `reset`, replace the step's temporary content with the new blocks. An empty replacement clears it. The fixed LibreChat upstream commit `d4e85d2205c78413ee27d631d7e3b7313556f21d` already handles `reset` in that reducer.

The SDK defaults to retaining two recent user-led turns within `min(16000, 16% of maxContextTokens)` tokens. The host already forwards `retainRecent`; `{ turns: 0 }` selects full-history compaction. The SDK also accepts `contextBudgetMode`, but the current consumer configuration adapter does not forward it. Add that mapping only when exposing the setting in the host.

## Switching the Consumer

After source review, CI, and the normal merge, update the consumer's package reference, lockfile, artifact metadata, and verifier together. Remove patch application for behavior now provided by the SDK, and retain host-only adapters and frontend reducers.

Both LibreChat manifests at that commit declare `@librechat/agents` as `^4.2.7`. npm excludes `4.2.11-ricky.1` from that range by default. Reference the vendored archive explicitly, as in PR #4. The package also exposes the upstream `@librechat/agents/runtime` entry for hosts that use the standalone runtime.

Build the consumer archive from the exact clean SDK merge commit and record its SHA, package version, archive hash, and build commands. A local candidate pack is for verification. Update any verifier that pins an old version, archive name, or dirty-source contract. Keep the old `4.2.1-ricky.2` archive and patch with their original `dirty: true` and `buildState: uncommitted-source` provenance.

Use the Node engine and dependency versions declared by this package. Run the consumer's type checks and focused contracts for Skill provenance, phase/reasoning, summary success/failure, programmatic replay identity, schema intent handling, and rich tool results before rollout.

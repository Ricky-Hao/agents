# Fork SDK Consumer Migration

`4.2.2-ricky.1` combines upstream v4.2.2 with the SDK behavior consumed by LibreChat's `4.2.1-ricky.2` package. The source repository now owns the programmatic call identity and Zod 4 schema inspection that were previously present only in the consumer patch.

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

The frontend summary reducer remains in `packages/chat`. It must accept content-block arrays, use deltas for temporary display, and replace temporary content with the completed summary. An error completion must not commit a checkpoint. `summary.coverage` can identify the retained-history boundary; consumers must not assume that every successful compaction removes all messages.

The SDK defaults to retaining two recent user-led turns within `min(16000, 16% of maxContextTokens)` tokens. The host already forwards `retainRecent`; `{ turns: 0 }` selects full-history compaction. The SDK also accepts `contextBudgetMode`, but the current consumer configuration adapter does not forward it. Add that mapping only when exposing the setting in the host.

## Switching the Consumer

After source review, CI, and the normal merge, update the consumer's package reference, lockfile, artifact metadata, and verifier together. Remove patch application for behavior now provided by the SDK, and retain host-only adapters and frontend reducers.

Build a new archive from the exact clean source commit and record that commit, package version, archive hash, and build commands. Keep the old `4.2.1-ricky.2` archive and patch as historical inputs. Its `dirty: true` / `buildState: uncommitted-source` provenance remains unchanged. Update any verifier that requires that old version, archive name, or dirty-source contract.

Use the Node engine and dependency versions declared by this package. Run the consumer's type checks and focused contracts for Skill provenance, phase/reasoning, summary success/failure, programmatic replay identity, schema intent handling, and rich tool results before rollout.

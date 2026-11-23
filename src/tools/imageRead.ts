import { randomBytes } from 'node:crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  isHumanMessage,
} from '@langchain/core/messages';
import type {
  BaseMessage,
  MessageContentImageUrl,
} from '@langchain/core/messages';
import type { ToolRuntime } from '@langchain/core/tools';
import type { ToolCallChunk } from '@langchain/core/messages/tool';
import type { BaseGraphState } from '@/types';
import type { ArtifactProjection } from '@/messages/core';
import {
  cloneToolMessageWithContent,
  getToolContentCharLength,
} from '@/utils/toolContent';
import { setProviderMessageProvenance } from '@/messages/provenance';
import { latestArtifactToolBatch } from '@/messages/core';

export const READ_IMAGE_TOOL = 'read_image';
const REF_PATTERN = '^img_[A-Za-z0-9_-]{16}$';
const refPattern = new RegExp(REF_PATTERN);
const MAX_IMAGE_REFS = 32;
const MAX_READS_PER_REQUEST = 4;

/** Supplied by a trusted host after its tool and output policy accepted a result. */
export type IsTrustedToolImage = (block: object, callId: string) => boolean;

type InlineImage = MessageContentImageUrl & { image_url: { url: string } };

type Source = {
  ref: string;
  callId: string;
  parentId: string;
  message: WeakRef<ToolMessage>;
  index: number;
  ordinal: number;
  exposed: boolean;
};

function isInlineImage(block: unknown): block is InlineImage {
  const image = block as Partial<InlineImage> | null | undefined;
  return (
    image?.type === 'image_url' &&
    typeof image.image_url?.url === 'string' &&
    /^data:image\/(png|jpeg|webp);base64,/.test(image.image_url.url)
  );
}

function artifactBlocks(message: ToolMessage): Array<{ type?: string } | null> {
  return Array.isArray(message.artifact?.content)
    ? message.artifact.content
    : [];
}

function readRef(input: unknown): string | undefined {
  const ref = (input as { ref?: unknown } | null | undefined)?.ref;
  if (
    typeof ref === 'string' &&
    ref.length === 20 &&
    refPattern.test(ref) &&
    Object.keys(input as object).length === 1
  ) {
    return ref;
  }
}

/** Owned by the root graph. Only the canonical ToolMessage owns the image bytes. */
export class ToolImageRead {
  private active = false;
  private accepted = new WeakSet<ToolMessage>();
  private selections = new WeakMap<ToolMessage, Source>();
  private refs = new Map<string, Source>();
  private readCalls = new WeakMap<AIMessage, Map<string, string | undefined>>();
  private streamedStepKey?: string;
  private streamedReadIndices = new Set<number>();

  readonly tool = new DynamicStructuredTool<unknown>({
    name: READ_IMAGE_TOOL,
    description:
      'Read one image by its reference from a tool result in this turn. Use this only when you need its pixels again or the image was omitted.',
    schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          pattern: REF_PATTERN,
          minLength: 20,
          maxLength: 20,
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    func: async (input, _manager, config): Promise<ToolMessage> => {
      const runtime = config as ToolRuntime<Partial<BaseGraphState>>;
      runtime.signal?.throwIfAborted();
      return this.read(
        readRef(input),
        runtime.state.messages ?? [],
        runtime.toolCallId
      );
    },
  });

  constructor(
    private readonly isTrustedImage: IsTrustedToolImage,
    readonly checkpointed = false
  ) {}

  start(): void {
    this.end();
    this.active = true;
  }

  end(): void {
    this.active = false;
    this.refs.clear();
    this.accepted = new WeakSet();
    this.selections = new WeakMap();
    this.readCalls = new WeakMap();
    this.streamedStepKey = undefined;
    this.streamedReadIndices.clear();
  }

  /** Responses sends unnamed argument fragments after announcing a call by index. */
  redactStreamedReadArgs(
    stepKey: string,
    chunks: ToolCallChunk[]
  ): ToolCallChunk[] {
    if (this.streamedStepKey !== stepKey) {
      this.streamedStepKey = stepKey;
      this.streamedReadIndices.clear();
    }
    return chunks.map((chunk) => {
      const { index, name } = chunk;
      if (index != null && name) {
        if (name === READ_IMAGE_TOOL) this.streamedReadIndices.add(index);
        else this.streamedReadIndices.delete(index);
      }
      return name === READ_IMAGE_TOOL ||
        (index != null && this.streamedReadIndices.has(index))
        ? { ...chunk, args: '' }
        : chunk;
    });
  }

  /** Keep selectors on the live model turn. The saver sees paired calls with empty args. */
  captureReadCalls(message: AIMessage): void {
    const calls = new Map<string, string | undefined>();
    if (message.tool_calls?.some((call) => call.name === READ_IMAGE_TOOL)) {
      message.tool_calls = message.tool_calls.map((call) => {
        if (call.name !== READ_IMAGE_TOOL) return call;
        if (call.id != null) calls.set(call.id, readRef(call.args));
        return { ...call, args: {} };
      });
      message.lc_kwargs.tool_calls = message.tool_calls;
      if (this.active) this.readCalls.set(message, calls);
    }
    if (
      message instanceof AIMessageChunk &&
      message.tool_call_chunks?.some(
        (chunk) => chunk.name === READ_IMAGE_TOOL || calls.has(chunk.id ?? '')
      )
    ) {
      message.tool_call_chunks = message.tool_call_chunks.map((chunk) =>
        chunk.name === READ_IMAGE_TOOL || calls.has(chunk.id ?? '')
          ? { ...chunk, args: '{}' }
          : chunk
      );
      message.lc_kwargs.tool_call_chunks = message.tool_call_chunks;
    }
    if (
      message.invalid_tool_calls?.some((call) => call.name === READ_IMAGE_TOOL)
    ) {
      message.invalid_tool_calls = message.invalid_tool_calls.map((call) =>
        call.name === READ_IMAGE_TOOL
          ? { ...call, args: '{}', error: 'invalid_ref' }
          : call
      );
      message.lc_kwargs.invalid_tool_calls = message.invalid_tool_calls;
    }
    // The Responses adapter keeps the provider's completed function calls in metadata too.
    const output = message.response_metadata.output;
    if (
      Array.isArray(output) &&
      output.some(
        (item) =>
          item?.type === 'function_call' && item.name === READ_IMAGE_TOOL
      )
    ) {
      message.response_metadata = {
        ...message.response_metadata,
        output: output.map((item) =>
          item?.type === 'function_call' && item.name === READ_IMAGE_TOOL
            ? { ...item, arguments: '{}' }
            : item
        ),
      };
      message.lc_kwargs.response_metadata = message.response_metadata;
    }
  }

  accept(message: ToolMessage): void {
    if (this.active && artifactBlocks(message).length > 0) {
      this.accepted.add(message);
    }
  }

  private sourceImage(
    messages: BaseMessage[],
    source: Source
  ): InlineImage | undefined {
    // A foreground stream may seed its prompt outside the graph message
    // channel. The execution boundary still applies, as does any newer human turn.
    const boundary = messages.findLastIndex(
      (message) =>
        isHumanMessage(message) ||
        (message.id === source.parentId &&
          message instanceof AIMessage &&
          message.tool_calls?.some((call) => call.id === source.callId) ===
            true)
    );
    if (!(messages[boundary] instanceof AIMessage)) return;
    for (let index = boundary + 1; index < messages.length; index++) {
      const message = messages[index];
      if (!(message instanceof ToolMessage)) break;
      if (message !== source.message.deref()) continue;
      const block = artifactBlocks(message)[source.index];
      if (isInlineImage(block) && this.isTrustedImage(block, source.callId))
        return block;
    }
  }

  readCheckpointed(messages: BaseMessage[], callId: string): ToolMessage {
    const parent = messages.findLast((message) => message instanceof AIMessage);
    const ref =
      parent == null ? undefined : this.readCalls.get(parent)?.get(callId);
    return this.read(ref, messages, callId);
  }

  private read(
    ref: string | undefined,
    messages: BaseMessage[],
    callId: string
  ): ToolMessage {
    const source = ref != null && this.active ? this.refs.get(ref) : undefined;
    const available =
      source?.exposed === true && this.sourceImage(messages, source) != null;
    let content =
      (this.checkpointed && !this.active) || ref != null
        ? 'image_unavailable'
        : 'invalid_ref';
    if (available) content = 'image_omitted';
    const result = new ToolMessage({
      name: READ_IMAGE_TOOL,
      tool_call_id: callId,
      status: available ? 'success' : 'error',
      content,
    });
    if (available) this.selections.set(result, source);
    return result;
  }

  private register(
    messages: BaseMessage[],
    batch: NonNullable<ReturnType<typeof latestArtifactToolBatch>>
  ): void {
    const parentId = batch.parent.id;
    if (parentId == null || this.refs.size >= MAX_IMAGE_REFS) return;
    for (const position of batch.toolIndices) {
      const message = messages[position] as ToolMessage;
      if (!this.accepted.has(message)) continue;
      const callId = message.tool_call_id;
      const blocks = artifactBlocks(message);
      let ordinal = 0;
      for (
        let index = 0;
        index < blocks.length && this.refs.size < MAX_IMAGE_REFS;
        index++
      ) {
        const block = blocks[index];
        if (block?.type === 'image_url') ordinal++;
        if (!isInlineImage(block) || !this.isTrustedImage(block, callId))
          continue;
        if (
          [...this.refs.values()].some(
            (ref) => ref.message.deref() === message && ref.index === index
          )
        )
          continue;
        const ref = `img_${randomBytes(12).toString('base64url')}`;
        this.refs.set(ref, {
          ref,
          callId,
          parentId,
          message: new WeakRef(message),
          index,
          ordinal,
          exposed: false,
        });
      }
    }
  }

  project(
    canonical: BaseMessage[],
    serving: BaseMessage[],
    projection: ArtifactProjection,
    fits: (messages: BaseMessage[]) => boolean
  ): { messages: BaseMessage[]; exposed: Source[] } {
    if (!this.active) return { messages: serving, exposed: [] };
    const batch = latestArtifactToolBatch(canonical);
    if (batch != null) this.register(canonical, batch);
    if (this.refs.size === 0) return { messages: serving, exposed: [] };

    const outputs = new Map<string, number>();
    for (let index = 0; index < serving.length; index++) {
      const message = serving[index];
      if (message instanceof ToolMessage)
        outputs.set(message.tool_call_id, index);
    }

    let messages = serving;
    const exposed: Source[] = [];
    const labels = new Map<number, { lines: string[]; sources: Source[] }>();
    for (const source of this.refs.values()) {
      const index = outputs.get(source.callId);
      if (index == null) continue;
      const block = this.sourceImage(canonical, source);
      if (block == null) continue;
      const imagePosition = projection.imagePositions.get(block);
      const position =
        imagePosition == null
          ? ' (use read_image to view)'
          : ` (tool image ${imagePosition})`;
      const entry = labels.get(index) ?? { lines: [], sources: [] };
      entry.lines.push(`Image ${source.ordinal} [${source.ref}]${position}`);
      entry.sources.push(source);
      labels.set(index, entry);
    }
    if (labels.size > 0) {
      const labeled = [...serving];
      for (const [index, { lines }] of labels) {
        const message = serving[index] as ToolMessage;
        const content =
          typeof message.content === 'string'
            ? `${message.content}\n${lines.join('\n')}`
            : [
                ...message.content,
                { type: 'text' as const, text: lines.join('\n') },
              ];
        labeled[index] = cloneToolMessageWithContent(message, content);
      }
      if (fits(labeled)) {
        messages = labeled;
        for (const { sources } of labels.values()) exposed.push(...sources);
      }
    }

    let remainingChars = projection.remainingChars;
    const images: InlineImage[] = [];
    for (const index of batch?.toolIndices ?? []) {
      const result = canonical[index] as ToolMessage;
      const source = this.selections.get(result);
      const outputIndex = outputs.get(result.tool_call_id);
      if (source == null || outputIndex == null) continue;
      const image = this.sourceImage(canonical, source);
      if (image == null) {
        messages = [...messages];
        messages[outputIndex] = cloneToolMessageWithContent(
          result,
          'image_unavailable'
        );
        continue;
      }
      if (images.length === MAX_READS_PER_REQUEST) continue;
      const cost = getToolContentCharLength([image]) + 1;
      if (cost > remainingChars) continue;
      const nextImages = [...images, image];
      const payload = new HumanMessage({ content: nextImages });
      setProviderMessageProvenance(payload, [{ attribution: 'synthetic' }]);
      const candidate = messages.slice(0, images.length > 0 ? -1 : undefined);
      candidate[outputIndex] = cloneToolMessageWithContent(
        result,
        `image_included (read image ${nextImages.length})`
      );
      candidate.push(payload);
      if (!fits(candidate)) continue;
      messages = candidate;
      images.push(image);
      remainingChars -= cost;
    }
    return { messages, exposed };
  }

  confirm(exposed: Source[]): void {
    for (const source of exposed) source.exposed = true;
  }
}

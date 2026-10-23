import { RunnableLambda } from '@langchain/core/runnables';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type * as t from '@/types';
import {
  createSummarizationChunkHandler,
  createSummarizeNode,
} from '@/summarization/node';
import { ContentTypes, GraphEvents, Providers, StepTypes } from '@/common';
import { registerProvider } from '@/llm/providerRegistry';
import { AgentContext } from '@/agents/AgentContext';
import { createContentAggregator } from '@/stream';
import { FakeChatModel } from '@/llm/fake';

const stepId = 'summary-reasoning-step';
const summaryStep: t.RunStep = {
  id: stepId,
  index: 0,
  stepIndex: 0,
  type: StepTypes.MESSAGE_CREATION,
  stepDetails: {
    type: StepTypes.MESSAGE_CREATION,
    message_creation: { message_id: stepId },
  },
  summary: { type: ContentTypes.SUMMARY, content: [] },
  usage: null,
};

async function collectDeltas(
  chunks: AIMessageChunk[]
): Promise<t.SummarizeDeltaEvent[]> {
  const deltas: t.SummarizeDeltaEvent[] = [];
  await RunnableLambda.from(async (_input: string, config: RunnableConfig) => {
    const onChunk = createSummarizationChunkHandler({
      stepId,
      config,
      provider: Providers.OPENAI,
      reasoningKey: 'reasoning',
    });
    expect(onChunk).toBeDefined();
    for (const chunk of chunks) {
      await onChunk!(chunk);
    }
  }).invoke('fixture', {
    callbacks: [
      {
        handleCustomEvent(event: string, data: t.SummarizeDeltaEvent): void {
          if (event === GraphEvents.ON_SUMMARIZE_DELTA) deltas.push(data);
        },
      },
    ],
  });
  await awaitAllCallbacks();
  return deltas;
}

describe('摘要 reasoning 流', () => {
  it.each([
    {
      name: '空 reasoning summary 后继续正文',
      chunks: [
        new AIMessageChunk({
          content: '',
          additional_kwargs: { reasoning: { type: 'reasoning', summary: [] } },
        }),
        new AIMessageChunk({ content: 'Body' }),
      ],
      expected: [{ type: 'text', text: 'Body' }],
      expectedDeltaCount: 1,
    },
    {
      name: '普通文本顺序',
      chunks: [
        new AIMessageChunk({ content: 'First ' }),
        new AIMessageChunk({ content: 'second' }),
      ],
      expected: [
        { type: 'text', text: 'First ' },
        { type: 'text', text: 'second' },
      ],
      expectedDeltaCount: 2,
    },
    {
      name: '内容块数组及其顺序',
      chunks: [
        new AIMessageChunk({
          content: [
            { type: 'thinking', thinking: 'Thinking' },
            { type: 'text', text: 'First ' },
            { type: 'text', text: 'second' },
          ],
          additional_kwargs: { reasoning: { type: 'reasoning', summary: [] } },
        }),
      ],
      expected: [
        { type: 'thinking', thinking: 'Thinking' },
        { type: 'text', text: 'First ' },
        { type: 'text', text: 'second' },
      ],
      expectedDeltaCount: 1,
    },
    {
      name: '结构化 reasoning 只提取 summary 文本',
      chunks: [
        new AIMessageChunk({
          content: '',
          additional_kwargs: {
            reasoning: {
              type: 'reasoning',
              encrypted_content: 'not-visible',
              summary: [
                { type: 'summary_text', text: 'First ' },
                { type: 'summary_text', text: 'second' },
              ],
            },
          },
        }),
      ],
      expected: [{ type: 'text', text: 'First second' }],
      expectedDeltaCount: 1,
    },
    {
      name: '空内容不产生 delta',
      chunks: [
        new AIMessageChunk({
          content: [],
          additional_kwargs: { reasoning: { type: 'reasoning', summary: [] } },
        }),
      ],
      expected: [],
      expectedDeltaCount: 0,
    },
  ])('$name', async ({ chunks, expected, expectedDeltaCount }) => {
    const deltas = await collectDeltas(chunks);
    const { aggregateContent, contentParts } = createContentAggregator();
    aggregateContent({ event: GraphEvents.ON_RUN_STEP, data: summaryStep });
    for (const data of deltas) {
      aggregateContent({ event: GraphEvents.ON_SUMMARIZE_DELTA, data });
      expect(Array.isArray(data.delta.summary.content)).toBe(true);
      expect(data.delta.summary.content?.length).toBeGreaterThan(0);
    }
    expect(contentParts[0]).toMatchObject({
      type: ContentTypes.SUMMARY,
      content: expected,
    });
    expect(deltas).toHaveLength(expectedDeltaCount);
  });

  it('complete 替换临时 reasoning，保存调用和最终状态只含摘要正文', async () => {
    class SummaryModel extends FakeChatModel {
      constructor() {
        super({ responses: ['unused'] });
      }

      async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
        for (const chunk of [
          new AIMessageChunk({
            content: '',
            additional_kwargs: {
              reasoning: { type: 'reasoning', summary: [] },
            },
          }),
          new AIMessageChunk({
            content: '',
            additional_kwargs: {
              reasoning: {
                summary: [
                  { type: 'summary_text', text: 'Temporary reasoning' },
                ],
              },
            },
          }),
          new AIMessageChunk({ content: 'Final ' }),
          new AIMessageChunk({
            content: [{ type: 'text', text: 'checkpoint' }],
          }),
        ]) {
          yield new ChatGenerationChunk({ text: '', message: chunk });
        }
      }
    }
    const provider = 'summary-reasoning-fixture' as t.RuntimeProviderName;
    const unregister = registerProvider({ provider, model: SummaryModel });
    const agentContext = AgentContext.fromConfig(
      {
        agentId: 'summary-fixture',
        provider,
        clientOptions: {},
        reasoningKey: 'reasoning',
        summarizationEnabled: true,
        summarizationConfig: { retainRecent: { turns: 0 } },
      },
      () => 10
    );
    const saved = jest.spyOn(agentContext, 'setSummary');
    const { aggregateContent, contentParts } = createContentAggregator();
    const deltas: t.SummarizeDeltaEvent[] = [];
    const completions: t.SummarizeCompleteEvent[] = [];
    const eventOrder: string[] = [];
    const node = createSummarizeNode({
      agentContext,
      generateStepId: () => [stepId, 0],
      graph: {
        contentData: [],
        contentIndexMap: new Map(),
        isMultiAgent: false,
        async dispatchRunStep(data): Promise<void> {
          aggregateContent({ event: GraphEvents.ON_RUN_STEP, data });
        },
        async dispatchRunStepCompleted(): Promise<void> {},
      },
    });

    try {
      const result = await RunnableLambda.from(
        async (_input: string, config: RunnableConfig) =>
          node(
            {
              messages: [new HumanMessage('History')],
              summarizationRequest: {
                agentId: agentContext.agentId,
                remainingContextTokens: 1000,
              },
            },
            config
          )
      ).invoke('fixture', {
        callbacks: [
          {
            handleCustomEvent(
              event: string,
              data: t.SummarizeDeltaEvent | t.SummarizeCompleteEvent
            ): void {
              if (event === GraphEvents.ON_SUMMARIZE_DELTA) {
                eventOrder.push(event);
                deltas.push(data as t.SummarizeDeltaEvent);
              }
              if (event === GraphEvents.ON_SUMMARIZE_COMPLETE) {
                eventOrder.push(event);
                completions.push(data as t.SummarizeCompleteEvent);
              }
            },
          },
        ],
      });
      await awaitAllCallbacks();
      expect(eventOrder).toEqual([
        GraphEvents.ON_SUMMARIZE_DELTA,
        GraphEvents.ON_SUMMARIZE_DELTA,
        GraphEvents.ON_SUMMARIZE_DELTA,
        GraphEvents.ON_SUMMARIZE_COMPLETE,
      ]);
      for (const data of deltas) {
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_DELTA, data });
      }
      expect(contentParts[0]).toMatchObject({
        content: [
          { type: 'text', text: 'Temporary reasoning' },
          { type: 'text', text: 'Final ' },
          { type: 'text', text: 'checkpoint' },
        ],
      });
      expect(completions).toHaveLength(1);
      aggregateContent({
        event: GraphEvents.ON_SUMMARIZE_COMPLETE,
        data: completions[0],
      });
      expect(contentParts[0]).toMatchObject({
        type: ContentTypes.SUMMARY,
        content: [{ type: 'text', text: 'Final checkpoint' }],
        summaryVersion: 1,
      });
      expect(saved).toHaveBeenCalledTimes(1);
      expect(saved).toHaveBeenCalledWith('Final checkpoint', 10);
      expect(agentContext.getSummaryText()).toBe('Final checkpoint');
      expect(agentContext.summaryVersion).toBe(1);
      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0]._getType()).toBe('remove');
      expect(result.summarizationRequest).toBeUndefined();
    } finally {
      saved.mockRestore();
      unregister();
    }
  });
});

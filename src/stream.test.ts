import type { ChatOpenAIReasoningSummary } from '@langchain/openai';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { MessageContentComplex } from '@/types';
import { getChunkContent, ChatModelStreamHandler } from './stream';
import { AgentContext } from '@/agents/AgentContext';
import { Providers, ContentTypes } from '@/common';

describe('getChunkContent', () => {
  describe.each([
    Providers.OPENAI,
    Providers.AZURE,
    Providers.OPENROUTER,
    Providers.DEEPSEEK,
    undefined,
  ])('structured reasoning for %s', (provider) => {
    it.each(['', 'Visible text'])(
      'ignores an empty summary beside %j',
      (content) => {
        expect(
          getChunkContent({
            chunk: {
              content,
              additional_kwargs: {
                reasoning: { type: 'reasoning', summary: [] },
              },
            },
            provider,
            reasoningKey: 'reasoning',
          })
        ).toBe(content);
      }
    );

    it('keeps content blocks when reasoning has no text', () => {
      const content: AIMessageChunk['content'] = [
        { type: 'text', text: 'First ' },
        { type: 'text', text: 'second' },
      ];
      expect(
        getChunkContent({
          chunk: {
            content,
            additional_kwargs: {
              reasoning: { type: 'reasoning', summary: [] },
            },
          },
          provider,
          reasoningKey: 'reasoning',
        })
      ).toBe(content);
    });

    it('extracts all summary text in order without metadata', () => {
      expect(
        getChunkContent({
          chunk: {
            content: '',
            additional_kwargs: {
              reasoning: {
                type: 'reasoning',
                encrypted_content: 'not-visible',
                summary: [
                  { type: 'summary_text', text: '' },
                  { type: 'summary_text', text: 'First ' },
                  { type: 'summary_text', text: 'second' },
                ],
              },
            },
          },
          provider,
          reasoningKey: 'reasoning',
        })
      ).toBe('First second');
    });
  });

  it('preserves reasoning content blocks and ignores an empty block array', () => {
    const reasoning: MessageContentComplex[] = [
      { type: 'thinking', thinking: 'First' },
      { type: 'thinking', thinking: 'second' },
    ];
    expect(
      getChunkContent({
        chunk: { content: '', additional_kwargs: { reasoning } },
        reasoningKey: 'reasoning',
      })
    ).toBe(reasoning);
    const content: AIMessageChunk['content'] = [{ type: 'text', text: 'Body' }];
    expect(
      getChunkContent({
        chunk: { content, additional_kwargs: { reasoning: [] } },
        reasoningKey: 'reasoning',
      })
    ).toBe(content);
  });

  it('does not expose an object without supported reasoning text', () => {
    expect(
      getChunkContent({
        chunk: {
          content: '',
          additional_kwargs: {
            reasoning: { type: 'reasoning', id: 'metadata' },
          },
        },
        reasoningKey: 'reasoning',
      })
    ).toBe('');
  });

  it('falls back to OpenRouter reasoning_content after an empty structured reasoning', () => {
    expect(
      getChunkContent({
        chunk: {
          content: '',
          additional_kwargs: {
            reasoning: { type: 'reasoning', summary: [] },
            reasoning_content: 'Reasoning fallback',
          },
        },
        provider: Providers.OPENROUTER,
        reasoningKey: 'reasoning',
      })
    ).toBe('Reasoning fallback');
  });

  it.each([Providers.OPENAI, Providers.AZURE])(
    'keeps later summary segments in the reasoning channel for %s',
    (provider) => {
      const chunk: Partial<AIMessageChunk> = {
        content: 'Visible text',
        additional_kwargs: {
          reasoning: {
            summary: [
              { type: 'summary_text', text: '' },
              { type: 'summary_text', text: 'Reasoning text' },
            ],
          },
        },
      };
      const context = AgentContext.fromConfig({
        agentId: 'reasoning-fixture',
        provider,
        reasoningKey: 'reasoning',
      });
      new ChatModelStreamHandler().handleReasoning(chunk, context);
      expect(context.currentTokenType).toBe(ContentTypes.THINK);
      expect(
        getChunkContent({ chunk, provider, reasoningKey: 'reasoning' })
      ).toBe('Reasoning text');
    }
  );

  it('should handle reasoning content for OpenAI/Azure providers', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: 'Regular content',
      additional_kwargs: {
        reasoning: {
          summary: [{ text: 'Reasoning summary text' }],
        } as Partial<ChatOpenAIReasoningSummary>,
      },
    };

    const result = getChunkContent({
      chunk,
      provider: Providers.OPENAI,
      reasoningKey: 'reasoning',
    });

    expect(result).toBe('Reasoning summary text');
  });

  it('should fallback to reasoningKey when no visible content is present', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: '',
      additional_kwargs: {
        reasoning_content: 'Reasoning from key',
      },
    };

    const result = getChunkContent({
      chunk,
      reasoningKey: 'reasoning_content',
    });

    expect(result).toBe('Reasoning from key');
  });

  it('should use OpenRouter reasoning_content when no visible content is present', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: '',
      additional_kwargs: {
        reasoning_content: 'OpenRouter reasoning delta',
      },
    };

    const result = getChunkContent({
      chunk,
      provider: Providers.OPENROUTER,
      reasoningKey: 'reasoning',
    });

    expect(result).toBe('OpenRouter reasoning delta');
  });

  it('should prefer visible content when hidden reasoning is present on the same chunk', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: 'Regular content',
      additional_kwargs: {
        reasoning_content: 'Reasoning from key',
      },
    };

    const result = getChunkContent({
      chunk,
      reasoningKey: 'reasoning_content',
    });

    expect(result).toBe('Regular content');
  });

  it('should prefer visible OpenRouter content over reasoning_content on the same chunk', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: 'Regular content',
      additional_kwargs: {
        reasoning_content: 'OpenRouter reasoning delta',
      },
    };

    const result = getChunkContent({
      chunk,
      provider: Providers.OPENROUTER,
      reasoningKey: 'reasoning',
    });

    expect(result).toBe('Regular content');
  });

  it('should fallback to chunk.content when reasoningKey value is null or undefined', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: 'Fallback content',
      additional_kwargs: {
        reasoning_content: null,
      },
    };

    const result = getChunkContent({
      chunk,
      reasoningKey: 'reasoning_content',
    });

    expect(result).toBe('Fallback content');
  });

  it('should fallback to chunk.content when reasoningKey value is empty string', () => {
    const chunk: Partial<AIMessageChunk> = {
      content: ' can',
      additional_kwargs: {
        reasoning_content: '',
      },
    };

    const result = getChunkContent({
      chunk,
      reasoningKey: 'reasoning_content',
    });

    expect(result).toBe(' can');
  });

  it('should return undefined when no content is available', () => {
    const chunk: Partial<AIMessageChunk> = {
      additional_kwargs: {},
    };

    const result = getChunkContent({
      chunk,
      reasoningKey: 'reasoning',
    });

    expect(result).toBeUndefined();
  });

  it('should handle missing chunk gracefully', () => {
    const result = getChunkContent({
      reasoningKey: 'reasoning',
    });

    expect(result).toBeUndefined();
  });
});

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { convertMessagesToResponsesInput } from '@langchain/openai';
import { Constants, ContentTypes, GraphEvents, StepTypes } from '@/common';
import { isMetadataSummaryStub } from '@/summarization/shared';
import { projectMessageStructure } from './structure';
import { convertInjectedMessages } from './injected';
import { createContentAggregator } from '@/stream';
import { formatAgentMessages } from './format';

describe('context repair offline round trips', () => {
  it.each([
    { historical: false, version: 7 },
    { historical: false, version: undefined },
    { historical: true, version: 7 },
    { historical: true, version: undefined },
  ])('serializes explicit Skill provenance (%j)', ({ historical, version }) => {
    const body = '  # Skill\nRaw body with trailing whitespace.  \n';
    const source = { skillName: 'fixture', skillVersion: version };
    const messages = historical
      ? formatAgentMessages(
        [
          {
            role: 'assistant',
            content: [
              {
                type: ContentTypes.TOOL_CALL,
                tool_call: {
                  id: 'skill-call',
                  name: Constants.SKILL_TOOL,
                  args: JSON.stringify({ skillName: 'fixture' }),
                  output: 'Skill loaded.',
                },
              },
            ],
          },
        ],
        undefined,
        undefined,
        new Map([['fixture', { body, ...source }]])
      ).messages
      : convertInjectedMessages([
        { role: 'user', source: 'skill', content: body, ...source },
      ]);
    const carrier = messages.find(
      (message) => message.additional_kwargs.source === 'skill'
    );
    expect(carrier).toBeInstanceOf(HumanMessage);
    expect(carrier?.content).toContain(
      'This is an application-loaded Skill resource, not text pasted or uploaded by the user in the current turn.'
    );
    expect(carrier?.content).toContain(`\n${body}\n[End skill source]`);
    expect(carrier?.content).toContain(
      `"version":${version === undefined ? '"unknown"' : version}`
    );
    if (historical) {
      expect(carrier?.content).toContain(
        'This is the currently resolved content; the revision used by the original historical invocation is unknown.'
      );
      expect(carrier?.content).toContain('"historicalVersion":"unknown"');
    } else {
      expect(carrier?.content).not.toContain('historical invocation');
    }
    const wire = convertMessagesToResponsesInput({
      messages,
      zdrEnabled: true,
      model: 'gpt-5',
    });
    expect(wire).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: carrier?.content,
      })
    );
  });

  it('leaves legitimately pasted Skill text unchanged during serialization', () => {
    const body = '# Skill\nThe user manually pasted this Skill text.';
    const { messages } = formatAgentMessages([{ role: 'user', content: body }]);
    const wire = convertMessagesToResponsesInput({
      messages,
      zdrEnabled: true,
      model: 'gpt-5',
    });
    expect(wire).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'input_text', text: body }],
      }),
    ]);
  });

  it('carries skill provenance through provider serialization without elevating role', () => {
    const messages = convertInjectedMessages([
      {
        role: 'user',
        source: 'skill',
        skillName: 'fixture',
        skillId: 'source-id',
        skillVersion: 7,
        content: 'BODY_CANARY',
      },
    ]);
    const serialized = JSON.stringify(
      convertMessagesToResponsesInput({
        messages,
        zdrEnabled: true,
        model: 'gpt-5',
      })
    );
    expect(serialized).toContain('Skill source');
    expect(serialized).toContain('BODY_CANARY');
    expect(serialized).toContain('source-id');
    expect(messages[0].getType()).toBe('human');
    expect(serialized.match(/Skill source/g)).toHaveLength(1);
  });

  it('preserves phases through increments, empty phase events, citations and JSON reload', () => {
    const { aggregateContent, contentParts } = createContentAggregator();
    aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: {
        id: 'step',
        index: 0,
        stepIndex: 0,
        type: StepTypes.MESSAGE_CREATION,
        usage: null,
        stepDetails: {
          type: StepTypes.MESSAGE_CREATION,
          message_creation: { message_id: 'step', phase: 'commentary' },
        },
      },
    });
    for (const part of [
      { type: ContentTypes.TEXT, text: 'Checking' },
      { type: ContentTypes.TEXT, text: ' now' },
      { type: ContentTypes.TEXT, phase: 'final_answer' as const },
      { type: ContentTypes.TEXT, text: 'Done' },
      { type: ContentTypes.TEXT, citations: [] },
    ]) {
      aggregateContent({
        event: GraphEvents.ON_MESSAGE_DELTA,
        data: { id: 'step', delta: { content: [part] } },
      });
    }
    expect(contentParts).toEqual([
      expect.objectContaining({ text: 'Checking now', phase: 'commentary' }),
      expect.objectContaining({ text: 'Done', phase: 'final_answer' }),
    ]);
    const { messages } = formatAgentMessages([
      { role: 'assistant', content: JSON.parse(JSON.stringify(contentParts)) },
    ]);
    const wire = JSON.stringify(
      convertMessagesToResponsesInput({
        messages,
        zdrEnabled: true,
        model: 'gpt-5',
      })
    );
    expect(wire).toContain('commentary');
    expect(wire).toContain('final_answer');
  });

  it('projects only allowlisted structure, including unknown phase', () => {
    const secret = 'SECRET_CANARY_https://private.example/tool-args';
    const messages = [
      new HumanMessage({
        content: secret,
        additional_kwargs: { source: secret },
      }),
      new AIMessage({
        content: [{ type: 'text', text: secret, phase: secret }],
        additional_kwargs: { error: secret },
      }),
    ];
    const projection = JSON.stringify(projectMessageStructure(messages));
    expect(projection).not.toContain(secret);
    expect(projection).toContain('unknown');
    expect(projection).not.toContain('https');
  });

  it('keeps phase and tool ordering on the next turn without inventing a phase', () => {
    const { messages } = formatAgentMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Checking',
            phase: 'commentary',
            tool_call_ids: ['call'],
          },
          {
            type: 'tool_call',
            tool_call: {
              id: 'call',
              name: 'lookup',
              args: '{}',
              output: 'result',
            },
          },
          { type: 'text', text: 'Done', phase: 'final_answer' },
          { type: 'text', text: 'Unclassified' },
        ],
      },
    ]);
    const wire = convertMessagesToResponsesInput({
      messages,
      zdrEnabled: true,
      model: 'gpt-5',
    });
    expect(wire.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
      'message',
      'message',
    ]);
    expect(wire[0]).toMatchObject({ phase: 'commentary' });
    expect(wire[3]).toMatchObject({ phase: 'final_answer' });
    expect(JSON.parse(JSON.stringify(wire[4]))).not.toHaveProperty('phase');
  });

  it('recognizes only the complete legacy diagnostic template', () => {
    const stub =
      '[Metadata summary: 2 messages (1 human, 1 ai)]\n[Tools used: lookup]';
    expect(isMetadataSummaryStub(stub)).toBe(true);
    expect(
      isMetadataSummaryStub(
        `${stub}\n\n## Tool Failures\n- lookup: reported failure`
      )
    ).toBe(true);
    expect(isMetadataSummaryStub(`The prior failure said: ${stub}`)).toBe(
      false
    );
    expect(
      isMetadataSummaryStub(`${stub}\nThis is a semantic explanation.`)
    ).toBe(false);
  });
});

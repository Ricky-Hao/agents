import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ArtifactProjection } from '@/messages/core';
import { projectArtifactPayload } from '@/messages/core';
import { getToolContentCharLength } from '@/utils/toolContent';
import { ToolImageRead } from '@/tools/imageRead';
import { Providers } from '@/common';
import { Run } from '@/run';

function inline(value: string) {
  return {
    type: 'image_url' as const,
    image_url: { url: `data:image/png;base64,${value}` },
  };
}

const first = inline('c3ludGhldGljLTE=');
const second = inline('c3ludGhldGljLTI=');
const third = inline('c3ludGhldGljLTM=');
const original = [first, second, third];
const prompt = new HumanMessage({
  id: 'turn',
  content: 'Read the test images.',
});

function request(id: string, ...callIds: string[]) {
  return new AIMessage({
    id,
    content: '',
    tool_calls: callIds.map((callId) => ({ id: callId, name: id, args: {} })),
  });
}

function result(id: string, ...images: ReturnType<typeof inline>[]) {
  return new ToolMessage({
    id,
    tool_call_id: id,
    content: 'Source result',
    artifact: { content: images },
  });
}

function project(
  scope: ToolImageRead,
  state: BaseMessage[],
  chars = 10_000,
  fits: (messages: BaseMessage[]) => boolean = () => true
) {
  const budget: ArtifactProjection = {
    remainingChars: chars,
    imagePositions: new Map(),
  };
  const serving = projectArtifactPayload(state, chars, budget);
  const projected = scope.project(state, serving, budget, fits);
  scope.confirm(projected.exposed);
  return projected.messages;
}

function output(messages: BaseMessage[], id: string): string {
  return String(
    messages.find(
      (message) => message instanceof ToolMessage && message.tool_call_id === id
    )?.content
  );
}

function images(messages: BaseMessage[]) {
  return messages.flatMap((message) =>
    message instanceof HumanMessage && Array.isArray(message.content)
      ? message.content.filter(({ type }) => type === 'image_url')
      : []
  );
}

async function read(
  scope: ToolImageRead,
  messages: BaseMessage[],
  args: Record<string, unknown>,
  id = 'read'
) {
  const runtime = { state: { messages }, toolCallId: id } as RunnableConfig;
  return (await scope.tool.invoke(
    { name: 'read_image', type: 'tool_call', id, args },
    runtime
  )) as ToolMessage;
}

function setup(checkpointed = false) {
  const a = result('a', first, second);
  const b = result('b', third);
  const source = request('mcp', 'a', 'b');
  const scope = new ToolImageRead(
    (block, callId) =>
      callId === 'a' ? block === first || block === second : block === third,
    checkpointed
  );
  scope.start();
  scope.accept(b);
  scope.accept(a);
  const state = [prompt, source, b, a];
  const serving = project(scope, state);
  const refs = Array.from(
    output(serving, 'a').matchAll(/\[(img_[\w-]{16})\]/g),
    (match) => match[1]
  );
  return { a, b, source, scope, state, serving, refs };
}

test('binds refs and image order to model calls and per-result order, and counts duplicates against the budget', async () => {
  const { scope, state, serving, refs } = setup();
  expect(refs.length).toBe(2);
  expect(
    images(serving).every((block, index) => block === original[index])
  ).toBe(true);
  expect(images(serving)).toHaveLength(3);
  expect(output(serving, 'a')).toMatch(
    /Image 1 .*\(tool image 1\)\nImage 2 .*\(tool image 2\)/
  );
  expect(output(serving, 'b')).toMatch(/Image 1 .*\(tool image 3\)/);
  const calls = request(
    'read_image',
    'read1',
    'read2',
    'read3',
    'read4',
    'read5'
  );
  const reads = await Promise.all(
    calls.tool_calls!.map(({ id }, index) =>
      read(scope, [...state, calls], { ref: refs[index === 0 ? 1 : 0] }, id)
    )
  );
  expect(
    reads.every(
      (message) =>
        message.artifact == null && message.content === 'image_omitted'
    )
  ).toBe(true);
  const projected = project(scope, [...state, calls, ...reads.reverse()]);
  const selected = images(projected);
  expect(selected).toHaveLength(4);
  expect(
    selected.every((image, index) => image === (index === 0 ? second : first))
  ).toBe(true);
  expect(output(projected, 'read1')).toBe('image_included (read image 1)');
  expect(output(projected, 'read4')).toBe('image_included (read image 4)');
  expect(output(projected, 'read5')).toBe('image_omitted');
  expect(
    images(
      project(scope, [
        ...state,
        calls,
        ...reads,
        request('status', 'status'),
        result('status'),
      ])
    )
  ).toHaveLength(0);
});

test('reserves room for current images and reports omission at character and model budget boundaries', async () => {
  const { scope, state, refs } = setup();
  const calls = request('read_image', 'read', 'current');
  const selected = await read(scope, [...state, calls], { ref: refs[1] });
  const current = new ToolMessage({
    id: 'current',
    tool_call_id: 'current',
    content: '',
    artifact: { content: [third] },
  });
  const batch = [...state, calls, selected, current];
  const charBudget =
    getToolContentCharLength([third]) + getToolContentCharLength([second]) + 1;
  const constrained = project(scope, batch, charBudget - 1);
  expect(images(constrained).length).toBe(1);
  expect(images(constrained)[0] === third).toBe(true);
  expect(output(constrained, 'read')).toBe('image_omitted');
  expect(output(project(scope, batch, charBudget), 'read')).toBe(
    'image_included (read image 1)'
  );
  expect(
    output(
      project(
        scope,
        batch,
        charBudget,
        (messages) => images(messages).length <= 1
      ),
      'read'
    )
  ).toBe('image_omitted');
});

test('checkpointed reads take their selector from the live model message only', () => {
  const { a, scope, state, refs } = setup(true);
  const readCall = { id: 'read', name: 'read_image', args: { ref: refs[1] } };
  const askCall = {
    id: 'ask',
    name: 'ask_user_question',
    args: { question: 'Which one?' },
  };
  const calls = new AIMessage({
    id: 'read-batch',
    content: '',
    tool_calls: [readCall, askCall],
    response_metadata: {
      output: [
        {
          type: 'function_call',
          name: readCall.name,
          arguments: JSON.stringify(readCall.args),
        },
      ],
    },
  });
  scope.captureReadCalls(calls);
  expect(JSON.stringify(calls).includes(refs[1])).toBe(false);
  expect(calls.tool_calls).toEqual([{ ...readCall, args: {} }, askCall]);

  const pending = [...state, calls];
  const selected = scope.readCheckpointed(pending, readCall.id);
  expect(selected.artifact == null).toBe(true);
  expect(images(project(scope, [...pending, selected]))[0] === second).toBe(
    true
  );
  const clonedParent = new AIMessage({
    id: calls.id,
    content: '',
    tool_calls: [readCall, askCall],
  });
  expect(
    scope.readCheckpointed([...state, clonedParent], readCall.id).content
  ).toBe('invalid_ref');
  const clonedSource = result('a', first, second);
  expect(
    scope.readCheckpointed(
      pending.map((message) => (message === a ? clonedSource : message)),
      readCall.id
    ).content
  ).toBe('image_unavailable');
  scope.end();
  expect(scope.readCheckpointed(pending, readCall.id).content).toBe(
    'image_unavailable'
  );
});

test('rejects forged, removed, replaced and cross-scope sources', async () => {
  const { a, source, scope, state, refs } = setup();
  const otherScope = new ToolImageRead(() => true);
  otherScope.start();
  const readPrompt = request('read_image', 'read');
  const pending = [...state, readPrompt];
  expect((await read(otherScope, pending, { ref: refs[0] })).content).toBe(
    'image_unavailable'
  );
  expect(
    (await read(scope, pending, { ref: 'img_zzzzzzzzzzzzzzzz' })).content
  ).toBe('image_unavailable');
  await expect(read(scope, pending, { ref: 1 })).rejects.toThrow();
  await expect(
    read(scope, pending, { ref: refs[0], extra: true })
  ).rejects.toThrow();
  await expect(
    read(scope, pending, { ref: 'https://localhost/image.png' })
  ).rejects.toThrow();
  const removed = messagesStateReducer(pending, new RemoveMessage({ id: 'a' }));
  expect((await read(scope, removed, { ref: refs[0] })).content).toBe(
    'image_unavailable'
  );
  const replacement = result('a', second, first);
  scope.accept(replacement);
  const substituted = pending.map((message) =>
    message === a ? replacement : message
  );
  expect((await read(scope, substituted, { ref: refs[0] })).content).toBe(
    'image_unavailable'
  );

  const forged = result('a', inline('Zm9yZ2Vk'));
  scope.accept(forged);
  const forgedProjection = project(scope, [prompt, source, forged]);
  expect(output(forgedProjection, 'a').includes('img_')).toBe(false);
  const laterRead = await read(scope, pending, { ref: refs[0] });
  expect(output(project(scope, [...removed, laterRead]), 'read')).toBe(
    'image_unavailable'
  );
  expect(
    (
      await read(
        scope,
        [...pending, new HumanMessage({ id: 'new-turn', content: 'New turn' })],
        { ref: refs[0] }
      )
    ).content
  ).toBe('image_unavailable');
  scope.end();
  expect((await read(scope, pending, { ref: refs[0] })).content).toBe(
    'image_unavailable'
  );
});

test('registers at most 32 refs and allows reading an image omitted on initial projection', async () => {
  const blocks = Array.from({ length: 33 }, (_, index) =>
    inline(`image${index}`)
  );
  const scope = new ToolImageRead((block) =>
    blocks.some((image) => image === block)
  );
  const source = result('source', ...blocks);
  scope.start();
  scope.accept(source);
  const state = [request('mcp', 'source'), source];
  const initial = project(scope, state, 1);
  expect(images(initial)).toHaveLength(0);
  const refs = [...output(initial, 'source').matchAll(/\[(img_[\w-]{16})\]/g)];
  expect(refs.length).toBe(32);
  const calls = request('read_image', 'read');
  const selected = await read(scope, [...state, calls], { ref: refs[31][1] });
  const projected = project(scope, [...state, calls, selected]);
  expect(images(projected)[0] === blocks[31]).toBe(true);
});

test.each([
  'eligible',
  'fallback',
  'checkpoint',
  'allowed-checkpoint',
  'tool-approval',
  'tracing',
  'continuation',
  'chat-completions',
])('binds read_image only when eligible (%s)', async (mode) => {
  if (mode === 'tracing') {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      LANGSMITH_TRACING: 'true',
    });
  }
  try {
    const run = await Run.create({
      runId: 'synthetic-image-read-gates',
      isTrustedToolImage: () => true,
      allowToolImageReadWithCheckpointer:
        mode === 'allowed-checkpoint' || mode === 'tool-approval',
      ...(mode === 'tool-approval' && { humanInTheLoop: { enabled: true } }),
      graphConfig: {
        type: 'standard',
        agents: [
          {
            agentId: 'synthetic-root',
            provider: Providers.OPENAI,
            clientOptions: {
              apiKey: 'synthetic',
              model: 'gpt-6.2-sol',
              useResponsesApi: mode !== 'chat-completions',
              ...(mode === 'fallback' && {
                fallbacks: [
                  {
                    provider: Providers.OPENAI,
                    clientOptions: { model: 'fallback' },
                  },
                ],
              }),
              ...(mode === 'continuation' && {
                modelKwargs: { previous_response_id: 'synthetic' },
              }),
            },
          },
        ],
        ...(['checkpoint', 'allowed-checkpoint', 'tool-approval'].includes(
          mode
        ) && {
          compileOptions: { checkpointer: new MemorySaver() },
        }),
      },
    });
    expect(run.Graph?.imageRead?.tool.name).toBe(
      mode === 'eligible' || mode === 'allowed-checkpoint'
        ? 'read_image'
        : undefined
    );
  } finally {
    jest.restoreAllMocks();
  }
});

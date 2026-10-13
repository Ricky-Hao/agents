import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { executeTools, unwrapToolResponse } from '../ProgrammaticToolCalling';
import { Constants } from '@/common';

const message = (status?: 'success' | 'error') =>
  new ToolMessage({
    content: 'Missing public fixture file',
    status,
    tool_call_id: '',
    name: 'fixture',
  });
const serialized = (status?: 'success' | 'error'): object =>
  JSON.parse(JSON.stringify(message(status)));
const mcpError = Object.freeze({
  isError: true,
  content: [{ type: 'text', text: 'Missing fixture' }],
  structuredContent: { reason: 'missing' },
});

async function execute(
  value: unknown,
  mcp = true,
  caller = Constants.PROGRAMMATIC_TOOL_CALLING
) {
  const fixture = Object.assign(
    tool(async () => value, {
      name: 'fixture',
      description: 'local fixture',
      schema: z.object({ id: z.string() }).strict(),
    }),
    { mcp }
  );
  const input = Object.freeze({ id: 'fixture', intent: 'Inspect fixture' });
  const [result] = await executeTools(
    [{ id: 'inner', name: fixture.name, input }],
    new Map([[fixture.name, fixture]]),
    caller
  );
  expect(input).toEqual({ id: 'fixture', intent: 'Inspect fixture' });
  return result;
}

describe('PTC protocol result boundary', () => {
  it.each([
    ['real ToolMessage', () => message('error')],
    ['serialized ToolMessage', () => serialized('error')],
    ['MCP CallToolResult', () => mcpError],
    ['MCP tuple ToolMessage', () => [message('error'), {}]],
    ['MCP tuple serialized ToolMessage', () => [serialized('error'), {}]],
    ['MCP tuple CallToolResult', () => [mcpError, {}]],
    [
      'typed-artifact ToolMessage pair',
      () => [message('error'), { type: 'file', uri: 'fixture.txt' }],
    ],
    [
      'typed-artifact serialized ToolMessage pair',
      () => [serialized('error'), { type: 'file', uri: 'fixture.txt' }],
    ],
    [
      'typed-artifact MCP error pair',
      () => [mcpError, { type: 'file', uri: 'fixture.txt' }],
    ],
    [
      'JSON-RPC error',
      () => ({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32603,
          message: 'Fixture failure',
          data: { detail: 'private fixture' },
        },
      }),
    ],
  ] as const)(
    'marks %s as failure for both callers without dropping its payload',
    async (_name, create) => {
      for (const caller of [
        Constants.PROGRAMMATIC_TOOL_CALLING,
        Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
      ]) {
        const value = create();
        const before = JSON.stringify(value);
        const result = await execute(value, true, caller);
        expect(result).toMatchObject({
          is_error: true,
          error_message: 'Tool reported an error.',
        });
        expect(result.result).toBe(value);
        expect(JSON.stringify(value)).toBe(before);
      }
    }
  );

  it.each([false, true])(
    'recognizes ToolMessage outside MCP (mcp=%s)',
    async (mcp) => {
      expect((await execute(message('error'), mcp)).is_error).toBe(true);
    }
  );

  it.each([
    ['success', () => message('success'), 'Missing public fixture file'],
    [
      'serialized success',
      () => serialized('success'),
      'Missing public fixture file',
    ],
    ['absent status', () => message(), 'Missing public fixture file'],
    [
      'empty',
      () =>
        new ToolMessage({ content: [], status: 'success', tool_call_id: '' }),
      [],
    ],
  ] as const)('unwraps %s message content', async (_name, create, expected) => {
    expect(await execute(create())).toMatchObject({
      is_error: false,
      result: expected,
    });
  });

  it('preserves the original non-MCP successful ToolMessage contract', async () => {
    for (const value of [
      message('success'),
      message(),
      serialized('success'),
      new ToolMessage({ content: [], status: 'success', tool_call_id: '' }),
    ]) {
      expect((await execute(value, false)).result).toBe(value);
    }
  });

  it.each([false, true])(
    'preserves Date artifacts on successful ToolMessages (mcp=%s)',
    async (mcp) => {
      const artifact = new Date('2026-10-13T00:00:00.000Z');
      const value = new ToolMessage({
        content: 'success',
        artifact,
        status: 'success',
        tool_call_id: '',
      });
      const result = await execute(value, mcp);
      expect(result.is_error).toBe(false);
      expect(result.result).toBe(value);
      expect(value.artifact).toBe(artifact);
      expect(unwrapToolResponse(['success', artifact], true)).toEqual([
        'success',
        artifact,
      ]);
    }
  );

  it('preserves nonplain artifacts without evaluating inherited serialization getters', async () => {
    const getter = jest.fn(() => {
      throw new Error('PRIVATE_ARTIFACT_FIXTURE');
    });
    const artifact: object = Object.create(
      Object.defineProperty({}, 'toJSON', { get: getter })
    );
    const value = new ToolMessage({
      content: 'success',
      artifact,
      status: 'success',
      tool_call_id: '',
    });
    for (const mcp of [false, true]) {
      const result = await execute(value, mcp);
      expect(result.is_error).toBe(false);
      expect(result.result).toBe(value);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('still unwraps only safe empty plain artifact carriers', async () => {
    for (const artifact of [{}, Object.create(null), { artifacts: [] }]) {
      const value = new ToolMessage({
        content: 'success',
        artifact,
        status: 'success',
        tool_call_id: '',
      });
      expect(await execute(value, true)).toMatchObject({
        is_error: false,
        result: 'success',
      });
      expect((await execute(value, false)).result).toBe(value);
    }
  });

  it.each([
    { status: 'error', error: 'business field', data: { valid: true } },
    { status: 404, data: { valid: true } },
    { isError: true, data: { valid: true } },
    { type: 'tool', status: 'error', content: 'ordinary record' },
    { jsonrpc: '2.0', error: { message: 'missing code and id' } },
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -1, message: 'ambiguous' },
      result: {},
    },
    { content: [], isError: 'true' },
    { content: [], isError: false, structuredContent: { status: 'error' } },
    'Plain prose, not JSON',
    '{broken JSON',
    '{"status":"error","data":{"valid":true}}',
    JSON.stringify(serialized('error')),
  ])('keeps business or unrecognized values successful: %#', async (value) => {
    const result = await execute(value);
    expect(result.is_error).toBe(false);
    expect(result.result).toBe(value);
  });

  it('does not infer MCP or JSON-RPC failures for unrelated non-MCP output', async () => {
    for (const value of [
      mcpError,
      { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'business' } },
    ]) {
      expect(await execute(value, false)).toMatchObject({
        is_error: false,
        result: value,
      });
    }
  });

  it('retains a malformed ToolMessage status without inventing a failure', async () => {
    const value = {
      ...serialized('success'),
      kwargs: { content: 'data', tool_call_id: '', status: 'ERROR' },
    };
    const result = await execute(value);
    expect(result.is_error).toBe(false);
    expect(result.result).toBe(value);
  });

  it('keeps artifacts, structured content and mixed rich blocks intact', async () => {
    const rich = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'fixture', mimeType: 'image/png' },
    ];
    const values = [
      rich,
      [rich, {}],
      ['caption', { files: ['fixture.png'] }],
      { content: rich, structuredContent: { id: 'fixture' }, isError: false },
      new ToolMessage({
        content: rich,
        artifact: { files: ['fixture.png'] },
        status: 'success',
        tool_call_id: '',
      }),
    ];
    for (const value of values) {
      const result = await execute(value);
      expect(result.is_error).toBe(false);
      expect(result.result).toBe(value);
    }
    const value = new ToolMessage({
      content: rich,
      status: 'success',
      tool_call_id: '',
    });
    expect((await execute(value)).result).toBe(rich);
  });

  it('does not reinterpret JSON text content as protocol status', async () => {
    const value = [{ type: 'text', text: '{"status":"error","id":"valid"}' }];
    expect(await execute(value)).toMatchObject({
      is_error: false,
      result: { status: 'error', id: 'valid' },
    });
  });

  it.each(['status', 'content', 'kwargs', 'isError'])(
    'never evaluates a hostile %s getter',
    async (key) => {
      const getter = jest.fn(() => {
        throw new Error('PRIVATE_RESULT_FIXTURE');
      });
      const bases: Record<string, object> = {
        kwargs: serialized('error'),
        isError: { ...mcpError },
      };
      const base = bases[key] ?? message('error');
      const value = Object.defineProperty(base, key, {
        get: getter,
        enumerable: true,
      });
      const result = await execute(value);
      expect(result.is_error).toBe(true);
      expect(result.error_message).not.toContain('PRIVATE_RESULT_FIXTURE');
      expect(getter).not.toHaveBeenCalled();
    }
  );

  it('contains Proxy inspection traps without evaluating them', async () => {
    const trap = jest.fn(() => {
      throw new Error('PRIVATE_RESULT_FIXTURE');
    });
    // Invocation/Promise resolution can read properties before the host boundary.
    const result = await execute(
      new Proxy({}, { getOwnPropertyDescriptor: trap })
    );
    expect(result).toMatchObject({
      is_error: true,
      error_message: 'Tool response could not be inspected safely.',
    });
    expect(() =>
      unwrapToolResponse(
        new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }),
        true
      )
    ).not.toThrow();
    expect(trap).not.toHaveBeenCalled();
  });

  it('does not recursively search business content, nested arrays or cycles', async () => {
    const nested = [[serialized('error'), {}], {}];
    const cyclic: unknown[] = [];
    cyclic.push(cyclic, {});
    for (const value of [
      nested,
      cyclic,
      { data: serialized('error') },
      { content: [], structuredContent: serialized('error') },
    ]) {
      const result = await execute(value);
      expect(result.is_error).toBe(false);
      expect(result.result).toBe(value);
    }
  });

  it('preserves content beyond the flattening inspection budget', async () => {
    const value = Array.from({ length: 4097 }, () => ({
      type: 'text',
      text: 'fixture',
    }));
    expect((await execute(value)).result).toBe(value);
  });
});

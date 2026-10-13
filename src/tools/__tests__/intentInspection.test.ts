import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { GenericTool } from '@/types';
import { executeTools } from '../ProgrammaticToolCalling';
import { stripIntentForInvoke } from '../intentArg';
import { Constants } from '@/common';

const secret = 'PRIVATE_SCHEMA_DIAGNOSTIC';
const input = Object.freeze({ id: 'agent', intent: 'business operation' });

describe('executor schema inspection safety', () => {
  const probes = [
    'constructor',
    'name',
    'schema',
    'type',
    'properties',
    'shape',
    '_def',
    'options',
    'iterator',
    'proxy',
  ] as const;

  it.each(probes)(
    'contains a hostile %s probe before invoking a real tool',
    async (probe) => {
      for (const caller of [
        Constants.PROGRAMMATIC_TOOL_CALLING,
        Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
      ]) {
        for (const args of [input, { id: 'agent' }, JSON.stringify(input)]) {
          const body = jest.fn(async () => 'must not execute');
          const tool = new DynamicStructuredTool({
            name: 'fixture',
            description: 'fixture',
            schema: z.object({ id: z.string() }).strict(),
            func: body,
          });
          const invoke = jest.spyOn(tool, 'invoke');
          const getter = jest.fn(() => {
            throw new Error(secret);
          });
          const schema = {
            type: 'object',
            properties: { id: { type: 'string' } },
          };
          Object.defineProperty(tool, 'schema', {
            value: schema,
            configurable: true,
          });
          if (probe === 'constructor' || probe === 'schema') {
            Object.defineProperty(tool, probe, { get: getter });
          } else if (probe === 'name') {
            const constructor = Object.defineProperty({}, 'name', {
              get: getter,
            });
            Object.defineProperty(tool, 'constructor', { value: constructor });
          } else if (probe === 'options') {
            Object.defineProperty(schema, '_def', {
              value: Object.defineProperty({}, 'options', { get: getter }),
            });
          } else if (probe === 'iterator') {
            const options = Object.defineProperty([], Symbol.iterator, {
              get: getter,
            });
            Object.defineProperty(schema, 'allOf', { value: options });
          } else if (probe === 'proxy') {
            Object.defineProperty(tool, 'schema', {
              value: new Proxy(schema, {
                get: getter,
                getOwnPropertyDescriptor: getter,
              }),
            });
          } else {
            if (probe === 'shape')
              Object.defineProperty(schema, 'properties', { value: undefined });
            Object.defineProperty(schema, probe, { get: getter });
          }
          const [result] = await executeTools(
            [{ id: 'call', name: 'fixture', input: args }],
            new Map([['fixture', tool]]),
            caller
          );
          expect(result.is_error).toBe(true);
          expect(result.error_message).not.toContain(secret);
          expect(invoke).not.toHaveBeenCalled();
          expect(body).not.toHaveBeenCalled();
          expect(getter).not.toHaveBeenCalled();
        }
      }
    }
  );

  it('keeps ordinary invocation failures distinct from inspection failures', async () => {
    const tool = new DynamicStructuredTool({
      name: 'fixture',
      description: 'fixture',
      schema: z.object({ id: z.string() }).strict(),
      func: async () => 'ok',
    });
    const [result] = await executeTools(
      [{ id: 'call', name: tool.name, input: { extra: true } }],
      new Map([[tool.name, tool]])
    );
    expect(result.is_error).toBe(true);
    expect(result.error_message).toContain(
      'Received tool input did not match expected schema'
    );
  });

  it('supports transparent tool instrumentation and contains outer Proxy descriptor traps', async () => {
    const body = jest.fn(async () => 'ok');
    const target = new DynamicStructuredTool({
      name: 'fixture',
      description: 'fixture',
      schema: z.object({ id: z.string() }).strict(),
      func: body,
    });
    const transparent = new Proxy(target, {
      get: (tool, key) =>
        key === 'invoke'
          ? tool.invoke.bind(tool)
          : Reflect.get(tool, key, tool),
    });
    const [success] = await executeTools(
      [{ id: 'call', name: target.name, input }],
      new Map([[target.name, transparent]])
    );
    expect(success.is_error).toBe(false);
    body.mockClear();
    const trap = jest.fn(() => {
      throw new Error(secret);
    });
    const hostile = new Proxy(target, { getOwnPropertyDescriptor: trap });
    const [failure] = await executeTools(
      [{ id: 'call', name: target.name, input }],
      new Map([[target.name, hostile]])
    );
    expect(failure).toMatchObject({
      is_error: true,
      error_message: 'Tool input schema could not be inspected safely.',
    });
    expect(trap).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
  });

  it('contains failures from the necessary lazy Zod shape evaluation', async () => {
    const schema = z.object({ id: z.string() });
    Object.defineProperty(schema._def, 'shape', {
      value: () => {
        throw new Error(secret);
      },
    });
    const body = jest.fn(async () => 'must not execute');
    const tool = new DynamicStructuredTool({
      name: 'fixture',
      description: 'fixture',
      schema,
      func: body,
    });
    const [result] = await executeTools(
      [{ id: 'call', name: tool.name, input }],
      new Map([[tool.name, tool]])
    );
    expect(result).toMatchObject({
      is_error: true,
      error_message: 'Tool input schema could not be inspected safely.',
    });
    expect(body).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves Zod 4 wrapped validation (business intent=%s)',
    async (business) => {
      const schema = (
        business
          ? z4.object({ id: z4.string(), intent: z4.string() })
          : z4.object({ id: z4.string() })
      )
        .strict()
        .optional();
      const tool = new DynamicStructuredTool({
        name: 'fixture',
        description: 'fixture',
        schema,
        func: async (args) => JSON.stringify(args),
      });
      const [result] = await executeTools(
        [{ id: 'call', name: tool.name, input: JSON.stringify(input) }],
        new Map([[tool.name, tool]])
      );
      expect(result).toMatchObject({
        is_error: false,
        result: JSON.stringify(business ? input : { id: 'agent' }),
      });
    }
  );

  it('bounds cyclic, deep and wide schema graphs before invocation', async () => {
    const cyclic: { type: string; _def?: { innerType: object } } = {
      type: 'object',
    };
    cyclic._def = { innerType: cyclic };
    let deep: object = {
      type: 'object',
      properties: { intent: { type: 'string' } },
    };
    for (let i = 0; i < 1000; i++)
      deep = { type: 'object', _def: { innerType: deep } };
    for (const schema of [cyclic, deep]) {
      expect(stripIntentForInvoke(input, { schema })).toBe(input);
    }
    const tool = new DynamicStructuredTool({
      name: 'fixture',
      description: 'fixture',
      schema: z.object({ id: z.string() }),
      func: async () => 'must not execute',
    });
    Object.defineProperty(tool, 'schema', {
      value: { type: 'object', allOf: Array.from({ length: 129 }, () => ({})) },
    });
    const invoke = jest.spyOn(tool, 'invoke');
    const [result] = await executeTools(
      [{ id: 'call', name: tool.name, input }],
      new Map([[tool.name, tool]])
    );
    expect(result).toMatchObject({
      is_error: true,
      error_message: 'Tool input schema could not be inspected safely.',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not confuse a shared schema node with a cycle', () => {
    const shared = { type: 'object', properties: { id: { type: 'string' } } };
    expect(
      stripIntentForInvoke(input, {
        schema: { type: 'object', allOf: [shared, shared] },
      })
    ).toEqual({ id: 'agent' });
  });
});

describe('real DynamicStructuredTool reference validation', () => {
  it.each([
    ['root', false],
    ['root', true],
    ['allOf', false],
    ['allOf', true],
  ] as const)(
    'retains %s referenced business intent (required=%s)',
    async (placement, required) => {
      const business = {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          intent: { type: 'string' as const },
        },
        required: required ? ['id', 'intent'] : ['id'],
        additionalProperties: false,
      };
      const schema = {
        type: 'object' as const,
        $defs: { business },
        ...(placement === 'root'
          ? { $ref: '#/$defs/business' }
          : { allOf: [{ $ref: '#/$defs/business' }] }),
      };
      const body = jest.fn(async (args: unknown) => JSON.stringify(args));
      const tool: GenericTool = new DynamicStructuredTool({
        name: 'referenced',
        description: 'fixture',
        schema,
        func: body,
      });
      // First prove this validator supports the fixture, independently of normalization.
      expect(await tool.invoke(input)).toBe(JSON.stringify(input));
      for (const args of [input, JSON.stringify(input)]) {
        const [result] = await executeTools(
          [{ id: 'call', name: tool.name, input: args }],
          new Map([[tool.name, tool]])
        );
        expect(result).toMatchObject({
          is_error: false,
          result: JSON.stringify(input),
        });
        expect(body.mock.calls.at(-1)?.[0]).toEqual(input);
      }
      const [missing] = await executeTools(
        [{ id: 'call', name: tool.name, input: { id: 'agent' } }],
        new Map([[tool.name, tool]])
      );
      expect(missing.is_error).toBe(required);
      for (const args of [
        { ...input, extra: true },
        { ...input, intent: 42 },
      ]) {
        const [invalid] = await executeTools(
          [{ id: 'call', name: tool.name, input: args }],
          new Map([[tool.name, tool]])
        );
        expect(invalid.is_error).toBe(true);
      }
      expect(input.intent).toBe('business operation');
    }
  );
});

describe('helper-only uncertain reference shapes (not sent to the validator)', () => {
  it.each([
    { type: 'object', $ref: '#/missing' },
    { type: 'object', allOf: [{ $ref: '#/missing' }] },
    { type: 'object', $ref: 'https://invalid.example/schema' },
    { type: 'object', $ref: '#' },
    {
      type: 'object',
      $defs: { loop: { $ref: '#/$defs/loop' } },
      allOf: [{ $ref: '#/$defs/loop' }],
    },
  ])('preserves input when intent cannot be resolved: %j', (schema) => {
    expect(stripIntentForInvoke(input, { schema })).toBe(input);
    const encoded = JSON.stringify(input);
    expect(stripIntentForInvoke(encoded, { schema })).toBe(encoded);
  });
});

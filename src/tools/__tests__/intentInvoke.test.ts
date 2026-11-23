import { z } from 'zod';
import { DynamicStructuredTool, DynamicTool } from '@langchain/core/tools';
import type { GenericTool } from '@/types';
import { PROGRAMMATIC_TOOL_INPUT, stripIntentForInvoke } from '../intentArg';
import { executeTools } from '../ProgrammaticToolCalling';
import { Constants } from '@/common';

describe('execution-schema intent normalization', () => {
  const schema = z.object({ id: z.string(), expanded: z.boolean() }).strict();
  const args = Object.freeze({
    id: 'agent',
    expanded: false,
    intent: 'Inspecting agent',
  });

  it.each([
    Constants.PROGRAMMATIC_TOOL_CALLING,
    Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
  ])(
    'validates real tools through %s and the shared direct helper',
    async (caller) => {
      const tool = new DynamicStructuredTool({
        name: 'agents_get',
        description: 'fixture',
        schema,
        func: async (input) => JSON.stringify(input),
      });
      const invoke = jest.spyOn(tool, 'invoke');
      for (const input of [
        args,
        JSON.stringify(args),
        { id: 'agent', expanded: false },
      ]) {
        const [result] = await executeTools(
          [{ id: 'call', name: tool.name, input }],
          new Map([[tool.name, tool]]),
          caller
        );
        expect(result).toMatchObject({
          is_error: false,
          result: JSON.stringify({ id: 'agent', expanded: false }),
        });
        const direct: GenericTool = tool;
        expect(await direct.invoke(stripIntentForInvoke(input, tool))).toBe(
          JSON.stringify({ id: 'agent', expanded: false })
        );
      }
      expect(invoke.mock.calls[0][1]).toMatchObject({
        [PROGRAMMATIC_TOOL_INPUT]: args,
      });
      expect(args.intent).toBe('Inspecting agent');
      for (const input of [
        { intent: 'Missing required' },
        { ...args, extra: true },
        '{malformed',
        JSON.stringify({ ...args, extra: true }),
      ]) {
        const [result] = await executeTools(
          [{ id: 'bad', name: tool.name, input }],
          new Map([[tool.name, tool]]),
          caller
        );
        expect(result.is_error).toBe(true);
      }
    }
  );

  it('retains business intent and its validation, including wrapped Zod schemas', async () => {
    const business = schema.extend({ intent: z.string() }).strict();
    for (const wrapped of [
      business,
      business.optional(),
      business.nullable(),
      business.default(args),
      business.refine(() => true),
    ]) {
      expect(stripIntentForInvoke(args, { schema: wrapped })).toBe(args);
      expect(
        stripIntentForInvoke(JSON.stringify(args), { schema: wrapped })
      ).toBe(JSON.stringify(args));
      const wrappedTool = new DynamicStructuredTool({
        name: 'wrapped',
        description: 'fixture',
        schema: wrapped,
        func: async (input) => JSON.stringify(input),
      });
      const [result] = await executeTools(
        [
          {
            id: 'wrapped',
            name: wrappedTool.name,
            input: JSON.stringify(args),
          },
        ],
        new Map([[wrappedTool.name, wrappedTool]])
      );
      expect(result).toMatchObject({
        is_error: false,
        result: JSON.stringify(args),
      });
    }
    const tool = new DynamicStructuredTool({
      name: 'business',
      description: 'fixture',
      schema: business,
      func: async (input) => JSON.stringify(input),
    });
    for (const input of [args, JSON.stringify(args)]) {
      const [result] = await executeTools(
        [{ id: 'call', name: tool.name, input }],
        new Map([[tool.name, tool]])
      );
      expect(result).toMatchObject({
        is_error: false,
        result: JSON.stringify(args),
      });
    }
    const [missing] = await executeTools(
      [
        {
          id: 'call',
          name: tool.name,
          input: { id: 'agent', expanded: false },
        },
      ],
      new Map([[tool.name, tool]])
    );
    expect(missing.is_error).toBe(true);
    for (const wrapped of [
      schema.optional(),
      schema.nullable(),
      schema.refine(() => true),
    ]) {
      expect(stripIntentForInvoke(args, { schema: wrapped })).toEqual({
        id: 'agent',
        expanded: false,
      });
      const wrappedTool = new DynamicStructuredTool({
        name: 'wrapped',
        description: 'fixture',
        schema: wrapped,
        func: async (input) => JSON.stringify(input),
      });
      const [result] = await executeTools(
        [
          {
            id: 'wrapped',
            name: wrappedTool.name,
            input: JSON.stringify(args),
          },
        ],
        new Map([[wrappedTool.name, wrappedTool]])
      );
      expect(result).toMatchObject({
        is_error: false,
        result: JSON.stringify({ id: 'agent', expanded: false }),
      });
    }
  });

  it('keeps JSON-looking prose intact for string tools and mixed schemas', async () => {
    const input = JSON.stringify(args);
    const tool = new DynamicTool({
      name: 'text',
      description: 'fixture',
      func: async (text) => text,
    });
    const invoke = jest.spyOn(tool, 'invoke');
    await executeTools(
      [{ id: 'call', name: tool.name, input }],
      new Map([[tool.name, tool]])
    );
    expect(invoke.mock.calls[0][0]).toBe(input);
    expect(
      stripIntentForInvoke(input, { schema: z.union([schema, z.string()]) })
    ).toBe(input);
  });

  it('honors raw JSON schema business declarations without mutating input', async () => {
    const tool = new DynamicStructuredTool({
      name: 'json',
      description: 'fixture',
      schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const },
          expanded: { type: 'boolean' as const },
        },
        required: ['id', 'expanded'],
        additionalProperties: false,
      },
      func: async (input) => JSON.stringify(input),
    });
    const [result] = await executeTools(
      [{ id: 'call', name: tool.name, input: JSON.stringify(args) }],
      new Map([[tool.name, tool]])
    );
    expect(result.is_error).toBe(false);
    expect(
      stripIntentForInvoke(args, {
        schema: { type: 'object', properties: { intent: { type: 'string' } } },
      })
    ).toBe(args);
  });
});

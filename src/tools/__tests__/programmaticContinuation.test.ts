import fetch from 'node-fetch';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import type { RequestInit } from 'node-fetch';
import type { PTCToolResult } from '@/types';
import { createProgrammaticToolCallingTool } from '../ProgrammaticToolCalling';
import { createBashProgrammaticToolCallingTool } from '../BashProgrammaticToolCalling';

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
const fetchMock = jest.mocked(fetch);

describe('real host runners with fixture CodeAPI continuation responses', () => {
  it.each([
    [
      'Python',
      createProgrammaticToolCallingTool,
      'await missing(); print(await valid())',
    ],
    ['Bash', createBashProgrammaticToolCallingTool, 'missing "{}"; valid "{}"'],
  ] as const)(
    '%s submits error status, then preserves a later successful result',
    async (_language, create, code) => {
      const bodies: Array<{ tool_results?: PTCToolResult[] }> = [];
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (_url, init) => {
        bodies.push(JSON.parse((init as RequestInit).body as string));
        const response = [
          {
            status: 'tool_call_required',
            continuation_token: 'first',
            tool_calls: [{ id: 'bad', name: 'missing', input: {} }],
          },
          {
            status: 'tool_call_required',
            continuation_token: 'second',
            tool_calls: [{ id: 'good', name: 'valid', input: {} }],
          },
          {
            status: 'completed',
            session_id: 'fixture',
            stdout: 'handled; valid',
            files: [],
          },
        ][bodies.length - 1];
        return { ok: true, json: async () => response } as Awaited<
          ReturnType<typeof fetch>
        >;
      });
      const failed = new ToolMessage({
        content: 'Missing fixture file',
        status: 'error',
        tool_call_id: '',
      });
      const missing = tool(async () => failed, {
        name: 'missing',
        description: 'fixture',
        schema: z.object({}),
      });
      const valid = tool(async () => ({ sha: 'fixture-sha' }), {
        name: 'valid',
        description: 'fixture',
        schema: z.object({}),
      });
      const tools = [missing, valid];
      const runner = create({
        baseUrl: 'https://code.fixture.invalid',
        authHeaders: {},
      });
      const output = await runner.invoke(
        { code, tool_manifest: ['missing', 'valid'] },
        {
          toolCall: {
            name: runner.name,
            args: {},
            toolMap: new Map(tools.map((value) => [value.name, value])),
            toolDefs: tools.map((value) => ({
              name: value.name,
              description: 'fixture',
              parameters: { type: 'object' },
            })),
          },
        }
      );
      expect(bodies).toHaveLength(3);
      expect(bodies[1].tool_results).toMatchObject([
        {
          call_id: 'bad',
          is_error: true,
          error_message: 'Tool reported an error.',
        },
      ]);
      expect(bodies[2].tool_results).toEqual([
        { call_id: 'good', is_error: false, result: { sha: 'fixture-sha' } },
      ]);
      expect(JSON.stringify(output)).toContain('handled; valid');
    }
  );
});

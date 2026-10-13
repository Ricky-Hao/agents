import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import {
  createLocalProgrammaticToolCallingTool,
  createLocalBashProgrammaticToolCallingTool,
} from '../local/LocalProgrammaticToolCalling';

describe('actual local wrappers (not the remote CodeAPI backend)', () => {
  it.each([
    [
      'py',
      createLocalProgrammaticToolCallingTool,
      'try:\n  await missing()\nexcept RuntimeError:\n  print("caught")\nprint((await valid())["sha"])',
    ],
    [
      'bash',
      createLocalBashProgrammaticToolCallingTool,
      'if missing "{}"; then echo unexpected; else echo caught; fi\nvalid "{}"',
    ],
  ] as const)(
    '%s exposes an actionable failure and permits later success',
    async (lang, create, code) => {
      const cwd = await mkdtemp(join(tmpdir(), 'ptc-result-'));
      try {
        const missing = tool(
          async () =>
            new ToolMessage({
              content: 'Missing fixture file',
              status: 'error',
              tool_call_id: '',
            }),
          { name: 'missing', description: 'fixture', schema: z.object({}) }
        );
        const valid = tool(async () => ({ sha: 'fixture-sha' }), {
          name: 'valid',
          description: 'fixture',
          schema: z.object({}),
        });
        const tools = [missing, valid];
        const runner = create({ cwd, timeoutMs: 10000 });
        const config = {
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
        };
        const output = await runner.invoke(
          { code, lang, tool_manifest: ['missing', 'valid'] },
          config
        );
        expect(JSON.stringify(output)).toContain('caught');
        expect(JSON.stringify(output)).toContain('fixture-sha');
        expect(JSON.stringify(output)).not.toContain('unexpected');
        await expect(
          runner.invoke(
            {
              code: lang === 'py' ? 'await missing()' : 'missing "{}"',
              lang,
              tool_manifest: ['missing'],
            },
            config
          )
        ).rejects.toThrow('Tool reported an error.');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    30000
  );
});

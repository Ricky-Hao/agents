import { describe, it, expect } from '@jest/globals';
import type { GenericTool } from '@/types';
import { executeTools } from '../ProgrammaticToolCalling';
import { PROGRAMMATIC_TOOL_CALL_ID } from '../intentArg';
import { Constants } from '@/common';

describe('programmatic bridge identity', () => {
  it.each([
    Constants.PROGRAMMATIC_TOOL_CALLING,
    Constants.BASH_PROGRAMMATIC_TOOL_CALLING,
  ])(
    'preserves replay identity outside sandbox arguments for %s',
    async (caller) => {
      const ids: unknown[] = [];
      const tool = {
        name: 'fixture',
        invoke: async (_input: unknown, config: object) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            config,
            PROGRAMMATIC_TOOL_CALL_ID
          );
          expect(descriptor?.enumerable).toBe(false);
          expect(descriptor?.writable).toBe(false);
          ids.push(descriptor?.value);
          return 'ok';
        },
      } as GenericTool;
      const toolMap = new Map([[tool.name, tool]]);
      const input = {
        programmaticToolCallId: 'forged',
        toolCall: { id: 'forged' },
      };
      for (const id of ['first', 'first', 'second']) {
        await executeTools([{ id, name: tool.name, input }], toolMap, caller);
      }
      expect(ids).toEqual(['first', 'first', 'second']);
    }
  );
});

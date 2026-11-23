import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { RunnableConfig } from '@langchain/core/runnables';

/* CodeExecutor imports the default export of node-fetch; capture POST bodies. */
const fetchCalls: Array<Record<string, unknown>> = [];
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: async (_url: string, init?: { body?: string }) => {
    fetchCalls.push(JSON.parse(init?.body ?? '{}'));
    return {
      ok: true,
      json: async () => ({
        session_id: 's1',
        stdout: 'ok',
        stderr: '',
        files: [],
      }),
    };
  },
}));

import {
  CODE_ARTIFACT_PATH_GUIDANCE,
  CodeExecutionToolDescription,
  StatefulCodeExecutionToolDescription,
  buildCodeExecutionToolDescription,
  buildCodeExecutionToolSchema,
  createCodeExecutionTool,
} from '../CodeExecutor';

describe('CodeExecutor stateful description', () => {
  it('selects the stateful description only when statefulSessions is on', () => {
    expect(buildCodeExecutionToolDescription()).toBe(
      CodeExecutionToolDescription
    );
    expect(buildCodeExecutionToolDescription({ statefulSessions: false })).toBe(
      CodeExecutionToolDescription
    );
    expect(buildCodeExecutionToolDescription({ statefulSessions: true })).toBe(
      StatefulCodeExecutionToolDescription
    );
  });

  /* Statefulness is filesystem-tier only: the machine is warm across calls,
   * but every execution is a new interpreter process, so in-memory state never
   * carries over. The description must not imply a notebook-style kernel. */
  it('promises filesystem persistence WITHOUT promising a shared runtime', () => {
    const d = StatefulCodeExecutionToolDescription;
    expect(d).toContain('same warm machine');
    expect(d).toContain('/mnt/data');
    expect(d).toContain('NEW process');
    expect(d).toContain('NEVER carry over');
    expect(d).toContain(CODE_ARTIFACT_PATH_GUIDANCE);
  });

  it('never claims variables/imports survive between executions', () => {
    const d = StatefulCodeExecutionToolDescription;
    expect(d).not.toContain('share one runtime');
    expect(d).not.toContain('typically still available');
  });

  it('adjusts the code-param note per mode', () => {
    const stateless =
      buildCodeExecutionToolSchema().properties.code.description;
    const stateful = buildCodeExecutionToolSchema({ statefulSessions: true })
      .properties.code.description;
    expect(stateless).toMatch(/variables and imports don't persist/);
    expect(stateful).toContain('do NOT carry over');
    expect(stateful).toContain('/mnt/data');
    expect(stateful).not.toContain('typically still defined');
    expect(stateful).not.toContain('reload from /mnt/data every call');
  });

  it.each([false, true])(
    'limits internal files and delivery in managed mode (stateful=%s)',
    (statefulSessions) => {
      const description = buildCodeExecutionToolDescription({
        statefulSessions,
      });
      const parameter = buildCodeExecutionToolSchema({ statefulSessions })
        .properties.code.description;

      for (const text of [description, parameter]) {
        expect(text).toContain(
          'automatically collected/displayed, not private scratch'
        );
        expect(text).toContain(
          'requested files, necessary deliverables, or unavoidable cross-call storage'
        );
        expect(text).toContain(
          'Prefer memory or unique same-call /tmp scratch (mktemp), with cleanup'
        );
        expect(text).toContain(
          '`/tmp` and other sandbox directories are not durable'
        );
        expect(text).not.toContain('Anything a later call needs');
        expect(text).not.toContain('write anything that must survive there');
      }
      expect(parameter).toContain(
        'prompts, receipts, bridge scripts or report copies'
      );
      expect(parameter).toContain(
        'A callback completion notice is not a request for attachments'
      );
      expect(parameter).toContain('authorized original workspace');
      expect(parameter).toContain(
        'rather than defaulting to base64 round-trips'
      );
      expect(parameter).toContain(
        'Never hide files or change extensions to evade collection'
      );
    }
  );
});

describe('CodeExecutor runtime_session_hint wire field', () => {
  afterEach(() => {
    fetchCalls.length = 0;
  });

  async function run(
    toolCall: Record<string, unknown>,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>[]> {
    const codeTool = createCodeExecutionTool(params);
    await codeTool.invoke({ lang: 'py', code: 'print(1)' }, {
      toolCall,
    } as unknown as RunnableConfig);
    return fetchCalls;
  }

  it('sends runtime_session_hint when a stateful tool receives it', async () => {
    const calls = await run(
      { _runtime_session_hint: 'conv-42' },
      { statefulSessions: true }
    );
    expect(calls[0].runtime_session_hint).toBe('conv-42');
  });

  it('ignores an injected hint when the tool is stateless', async () => {
    const calls = await run({ _runtime_session_hint: 'conv-42' });
    expect('runtime_session_hint' in calls[0]).toBe(false);
  });

  it('omits runtime_session_hint when not injected', async () => {
    const calls = await run({});
    expect('runtime_session_hint' in calls[0]).toBe(false);
  });

  it('does not leak the statefulSessions factory flag onto the wire', async () => {
    const calls = await run({}, { statefulSessions: true });
    expect('statefulSessions' in calls[0]).toBe(false);
  });

  it('strips a model-supplied runtime_session_hint from the raw args', async () => {
    const codeTool = createCodeExecutionTool({ statefulSessions: true });
    await codeTool.invoke(
      { lang: 'py', code: 'print(1)', runtime_session_hint: 'model-picked' },
      { toolCall: {} } as unknown as RunnableConfig
    );
    expect('runtime_session_hint' in fetchCalls[0]).toBe(false);
  });

  it('lets only the ToolNode-injected hint reach the wire, ignoring model args', async () => {
    const codeTool = createCodeExecutionTool({ statefulSessions: true });
    await codeTool.invoke(
      { lang: 'py', code: 'print(1)', runtime_session_hint: 'model-picked' },
      {
        toolCall: { _runtime_session_hint: 'host-conv' },
      } as unknown as RunnableConfig
    );
    expect(fetchCalls[0].runtime_session_hint).toBe('host-conv');
  });
});

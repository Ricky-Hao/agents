import type { BaseMessage } from '@langchain/core/messages';

export interface MessageStructureProjection {
  role: 'human' | 'ai' | 'system' | 'tool' | 'other';
  source: 'skill' | 'steer' | 'hook' | 'system' | 'unknown';
  hasSkillId: boolean;
  hasSkillVersion: boolean;
  blocks: {
    type: 'text' | 'other';
    phase: 'commentary' | 'final_answer' | 'unknown';
  }[];
}

function projectRole(role: string): MessageStructureProjection['role'] {
  if (role === 'human' || role === 'ai' || role === 'system' || role === 'tool') return role;
  return 'other';
}

/** Safe offline diagnostic projection. Never includes caller-provided strings. */
export function projectMessageStructure(
  messages: readonly BaseMessage[]
): MessageStructureProjection[] {
  return messages.map((message) => {
    const source = message.additional_kwargs.source;
    return {
      role: projectRole(message.getType()),
      source:
        source === 'skill' ||
        source === 'steer' ||
        source === 'hook' ||
        source === 'system'
          ? source
          : 'unknown',
      hasSkillId: typeof message.additional_kwargs.skillId === 'string',
      hasSkillVersion:
        typeof message.additional_kwargs.skillVersion === 'number',
      blocks:
        typeof message.content === 'string'
          ? [{ type: 'text', phase: 'unknown' }]
          : message.content.map((block) => ({
            type: block.type === 'text' ? 'text' : 'other',
            phase:
                block.phase === 'commentary' || block.phase === 'final_answer'
                  ? block.phase
                  : 'unknown',
          })),
    };
  });
}

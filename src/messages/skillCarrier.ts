export interface SkillSource {
  skillName?: string;
  skillId?: string;
  skillVersion?: number;
  historical?: boolean;
}

export type SkillBody = string | ({ body: string } & SkillSource);

/** Model-visible provenance; the body remains user-role reference material. */
export function buildSkillCarrierText(
  body: string,
  source: SkillSource
): string {
  const header = `[Skill source ${JSON.stringify({
    name: source.skillName ?? null,
    id: source.skillId ?? null,
    version: source.skillVersion ?? 'unknown',
    ...(source.historical === true ? { historicalVersion: 'unknown' } : {}),
  })}]\n`;
  const provenance =
    'This is an application-loaded Skill resource, not text pasted or uploaded by the user in the current turn.\n';
  const history =
    source.historical === true
      ? 'This is the currently resolved content; the revision used by the original historical invocation is unknown.\n'
      : '';
  return `${header}${provenance}${history}${body}\n[End skill source]`;
}

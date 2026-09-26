import { writeFileSync } from 'node:fs';
import { Type } from 'typebox';

export default function (pi) {
  let submitted = false;
  let nudged = false;

  pi.registerTool({
    name: 'submit_result',
    label: 'Submit implementation result',
    description: 'Submit PR metadata for the completed implementation. Call exactly once as your last action after tests and lint pass.',
    parameters: Type.Object({
      title: Type.String({ description: 'Concise conventional PR title describing the actual implementation' }),
      summary: Type.String({ description: 'Self-contained 1-3 sentence summary of what was implemented and why' }),
      changes: Type.Array(Type.String(), { description: 'Concrete user-visible or architectural changes made by this implementation' }),
      security_notes: Type.String({ description: 'Security-relevant behavior or empty string when none' }),
      limitations: Type.String({ description: 'Known limitations or empty string when none' }),
    }),
    async execute(_toolCallId, params) {
      const result = {
        title: params.title.trim(),
        summary: params.summary.trim(),
        changes: params.changes.map((item) => item.trim()).filter(Boolean),
        security_notes: params.security_notes.trim(),
        limitations: params.limitations.trim(),
      };
      if (!result.title || !result.summary) throw new Error('title and summary are required');
      const path = process.env.PI_IMPLEMENTER_RESULT_FILE;
      if (!path) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');
      writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      pi.appendEntry('implementer-result', result);
      submitted = true;
      return { content: [{ type: 'text', text: 'Implementation result recorded.' }], details: undefined };
    },
  });

  pi.on('agent_before_settle', () => {
    if (submitted || nudged) return undefined;
    nudged = true;
    return {
      continue: true,
      entries: [{
        type: 'custom_message',
        customType: 'pi-result-nudge',
        content: 'Before finishing, call submit_result once with accurate PR metadata for the implementation you completed.',
        display: true,
      }],
    };
  });
}

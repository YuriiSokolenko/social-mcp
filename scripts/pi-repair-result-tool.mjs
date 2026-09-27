import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { registerSubmitNudge, terminalResult } from './pi-common/terminal-result.mjs';

export default function (pi) {
  let submitted = false;

  pi.registerTool({
    name: 'submit_repair',
    label: 'Sync, validate, and submit PR repair',
    description: 'Integrate current dev and validate the repaired PR. If conflicts or checks fail, fix them in this same session and retry.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      integrateLatestDev({
        conflictMessage: (files) => `PR conflicts with current dev. Resolve these files in this same repair session, run relevant tests, then call submit_repair again: ${files.join(', ')}`,
      });
      validateFinalProductTree();
      submitted = true;
      return terminalResult('Current dev is integrated and git diff --check, pytest, and Ruff all pass. Repair is complete; stop now.', undefined);
    },
  });

  registerSubmitNudge(pi, {
    isSubmitted: () => submitted,
    customType: 'pi-repair-result-nudge',
    content: 'Before finishing, call submit_repair. If it reports merge conflicts or failing checks, fix them in this same session and retry until it succeeds.',
  });
}

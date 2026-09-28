import { integrateLatestDev, validateFinalProductTree } from './pi-common/finalize-product-tree.mjs';
import { registerTerminalTool } from './pi-common/terminal-tool.mjs';

export default function (pi) {
  registerTerminalTool(pi, {
    name: 'submit_repair',
    label: 'Sync, validate, and submit PR repair',
    description: 'Integrate current dev and validate the repaired PR. Fix any reported conflict/check failure and retry.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    nudgeType: 'pi-repair-result-nudge',
    nudgeText: 'Before finishing, call submit_repair. If it reports a conflict/check failure, fix it and retry.',
    successText: 'Current dev is integrated and final checks pass. Repair is complete; stop now.',
    execute: async () => {
      integrateLatestDev({
        conflictMessage: files => `PR conflicts with current dev. Resolve these files and retry submit_repair: ${files.join(', ')}`,
      });
      validateFinalProductTree();
      return {};
    },
  });
}

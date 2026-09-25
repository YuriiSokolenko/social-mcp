import { createBashTool } from '@earendil-works/pi-coding-agent';
import { bashTimeout, registerTimedBash } from './pi-bash-timeout-policy.mjs';

// Loaded explicitly from the trusted dev checkout by each Pi workflow.
// The built-in bash executor already kills its entire process tree on timeout.
export default function (pi) {
  const limit = Number(process.env.PI_BASH_TIMEOUT_SECONDS ?? 600);
  bashTimeout(undefined, limit); // Fail before running the model if misconfigured.
  registerTimedBash(pi, createBashTool, limit);
}

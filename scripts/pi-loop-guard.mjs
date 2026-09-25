import { LoopGuard } from './pi-loop-guard-policy.mjs';

// Loaded explicitly from the trusted dev checkout by Pi workflows that want a
// hard stop on runaway exploration. Distinct from pi-bash-timeout.mjs, which
// only bounds a single command's wall-clock time, not how many times the
// model calls tools in one run.
export default function (pi) {
  const guard = new LoopGuard({
    turnLimit: Number(process.env.PI_MAX_TURNS ?? 40),
    repeatThreshold: Number(process.env.PI_MAX_REPEAT_CALLS ?? 3),
  });
  pi.on('turn_start', (event) => {
    guard.onTurnStart(event.turnIndex);
  });
  pi.on('tool_call', (event) => guard.checkToolCall(event.toolName, event.input));
}

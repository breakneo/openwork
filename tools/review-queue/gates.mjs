import { validateFeed } from './core.mjs';

function observedTime(value) {
  if (typeof value !== 'string') throw new Error('Observed time is required');
  return validateFeed({ items: [], generated_at: value }).generated_at;
}
function line(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\r\n\u0000-\u001f\u007f]/.test(value)) throw new Error('A bounded nonempty single-line value is required');
  return value;
}
export function evaluateArchiveGates(observation) {
  const observed_at = observedTime(observation.observed_at);
  const human = observation.authority === 'live-human';
  const outcome = (allowed, gate, who, unblock, worktree = 'not evaluated') => ({ allowed, status: allowed ? 'verified' : 'blocked', gate, observed_at, who, unblock, worktree,
    text: `gate=${gate}; observed_at=${observed_at}; who=${who}; unblock=${unblock}; worktree=${worktree}` });
  const gates = [
    ['authorization', human ? observation.approved_item_id === observation.item_id && observation.approved_action === 'archive' : observation.authority === 'agent-initiated' && observation.agent_grant === true, 'operator', 'Confirm current exact-item archive instruction or standing agent grant'],
    ['identity', /^ses_[A-Za-z0-9]+$/.test(observation.item_id ?? '') && observation.identity_verified === true, 'executor', 'Re-read and match exact session/workspace identity'],
    ['pinned', observation.pinned === false, 'operator', 'Confirm the session is unpinned; never bypass a pin'],
    ['active-user-root', observation.active_user_root === false, 'operator', 'Compare the exact active user root identity; parentId alone is insufficient'],
    ['external-mission', observation.external_mission === false && !/^SUPAUD-/i.test(observation.title ?? ''), 'coordinator', 'Confirm ownership and external mission prefixes; excluded owners remain untouched'],
    ['busy', observation.busy === false, 'owner', 'Finish or explicitly stop in-flight session work and recheck'],
    ['working', observation.working === false, 'owner', 'Finish working state and recheck live activity'],
    ['descendants', observation.descendants === 'idle', 'executor', 'Read descendant activity; unknown is unresolved, not idle'],
    ['safety', observation.safety_resolved === true, 'executor', 'Resolve all remaining applicable safety observations'],
  ];
  if (!human) gates.push(
    ['scope', observation.scope === 'in-scope', 'operator', 'Authorize agent-initiated archive scope or give an explicit per-item human instruction'],
    ['purpose', observation.purpose_complete === true, 'owner', 'Deliver the requested work to the user'],
    ['learnings', observation.learnings_captured === true, 'owner', 'Capture required learnings before agent-initiated archive'],
    ['pending-decision', observation.pending_decision === false, 'operator', 'Resolve the pending decision'],
    ['remaining-work', observation.remaining_work === false, 'owner', 'Complete or explicitly conclude remaining task work'],
  );
  for (const [gate, passed, who, unblock] of gates) if (!passed) return outcome(false, gate, who, unblock);
  if (human) return outcome(true, 'passed', 'executor', 'Recheck immediately before the authorized action; approval is not proof of effect', 'not applicable to explicit human instruction');
  const tree = observation.task_worktree;
  if (tree?.ownership === 'none' && ['reporting', 'watchdog'].includes(observation.task_kind)) return outcome(true, 'passed', 'executor', 'Recheck immediately before action', 'not applicable — no owned task worktree');
  if (tree?.ownership !== 'owned') return outcome(false, 'owned-task-worktree', 'owner', 'Identify the actual owned task worktree; never substitute the coordinator worktree');
  if (tree.clean !== true) return outcome(false, 'owned-task-worktree-clean', 'owner', 'Reconcile the owned task worktree; unknown or dirty is not clean');
  return outcome(true, 'passed', 'executor', 'Recheck immediately before action', 'owned task worktree verified clean');
}
export function waitingReceipt({ owner, outstanding, observed_at, next_check_at }) {
  const observed = observedTime(observed_at);
  const next = observedTime(next_check_at);
  if (Date.parse(next) <= Date.parse(observed)) throw new Error('Next check must follow the observation');
  return { status: 'waiting', owner: line(owner), outstanding: line(outstanding), observed_at: observed, next_check_at: next,
    text: `owner=${line(owner)}; outstanding=${line(outstanding)}; observed_at=${observed}; next_check_at=${next}; waiting is not done` };
}

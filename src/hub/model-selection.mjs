// Worker model selection on dsh 0.2.2.
//
// The 0.1.x hub selected a worker's route by listening on `agent/request` and
// rewriting `provider`/`model` in the resolved request. dsh 0.2.2 forbids that:
// the agent loop throws "…proposed … after step preparation fixed …; use
// agent.model.select()" when a listener changes the route, and `agent/request`
// is marked deprecated for exactly this kind of override.
//
// The supported route is the agent's own accessor: call `model.select()` once,
// after creation and before the first step, and the loop prepares every step
// with that selection. Doing it here (a plain module, no @deepseek-ai import)
// keeps the hub free of duplicate module realms and makes the rule testable
// without a live host.

/**
 * Apply a worker's dispatch route to its live agent.
 *
 * @param agent - the live agent handle's `agent` (needs `model.select`)
 * @param selection - `{ provider, model, reasoningEffort? }` resolved for the job
 * @throws a fixed sentence when the host does not expose `model.select`
 */
export function applyModelSelection(agent, selection) {
  const model = agent?.model;
  if (typeof model?.select !== 'function') {
    throw new Error('dsh-crew: agent.model.select is not available on this dsh');
  }
  model.select({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  });
}

const tasks = new Map<string, Set<AbortController>>();
export function registerAnswer(session: string, controller: AbortController) {
  const active = tasks.get(session) ?? new Set<AbortController>(); active.add(controller); tasks.set(session, active);
  return () => { active.delete(controller); if (!active.size) tasks.delete(session); };
}
export function cancelAnswers(session: string) { for (const controller of tasks.get(session) ?? []) controller.abort(); }

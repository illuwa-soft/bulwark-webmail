import type { EmbeddedViewCommand, EmbeddedViewOwner, FramePolicy, LeaveReason } from './contracts';
import type { EmbeddedViewController } from './controller';

type Host = { pluginId: string; controller: EmbeddedViewController; root: Element };
const hosts = new Set<Host>();
export const embeddedViewsActive = () => [...hosts].some(host => !!host.controller.store.getState().view);

/** A visible plugin page owns the display; a specific sandbox instance owns its handle. */
export function registerEmbeddedViewHost(host: Host) {
  hosts.add(host);
  return () => { hosts.delete(host); host.controller.dispose(); };
}
export function requestEmbeddedView(pluginId: string, scope: EmbeddedViewOwner, command: EmbeddedViewCommand, policy: FramePolicy) {
  const host = [...hosts].find(candidate => candidate.pluginId === pluginId && candidate.root.contains(scope.container));
  if (!host) throw new Error('Open this plugin app page first');
  if (command.action === 'open') return host.controller.open(scope, command, policy);
  return host.controller.handle(scope, command);
}
export async function leaveEmbeddedViews(reason: LeaveReason) {
  for (const host of hosts) if (!(await host.controller.leave(reason))) return false;
  return true;
}
/** Revoked authentication and removed pages dispose without consulting plugin code. */
export function disposeEmbeddedViews() { for (const host of hosts) host.controller.dispose(); }

import type { WorkerDeps } from '../../deps';
import { userPrefix } from '../../lib/storage';

/** Hard-deletes a user whose account deletion was requested. Rows go via ON DELETE CASCADE; images go via the prefix. */
export function createAccountProcessor(deps: WorkerDeps) {
  return async function deleteAccount(userId: string): Promise<void> {
    const user = await deps.prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
    if (!user) return; // already gone: the job is idempotent
    // Safety: never hard-delete an account that did not ask to be deleted.
    if (!user.deletedAt) {
      deps.logger.warn({ userId }, 'account deletion skipped: user is not marked deleted');
      return;
    }
    await deps.storage.deletePrefix(userPrefix(userId));
    await deps.prisma.user.delete({ where: { id: userId } });
    deps.logger.info({ userId }, 'account hard-deleted');
  };
}

const { v4: uuid } = require('uuid');
const blocksRepository = require('../repositories/blocksRepository');
const friendsRepository = require('../repositories/friendsRepository');
const logger = require('../utils/logger').child({ module: 'blockHelper' });

/**
 * True if either user has blocked the other (block is one-directional in
 * storage but always enforced both ways).
 */
async function areUsersBlocked(userIdA: string, userIdB: string) {
  if (!userIdA || !userIdB) return false;
  const { data, error } = await blocksRepository.existsBetween(userIdA, userIdB);
  if (error) { logger.error({ err: error, userIdA, userIdB }, 'areUsersBlocked query failed'); return false; }
  return !!(data && data.length);
}

/**
 * Blocks `blockedId` on behalf of `blockerId`, and — since you shouldn't
 * stay "friends" with someone you've just blocked — tears down any
 * friendship / pending friend request between the pair in the same call.
 */
async function blockUser(blockerId: string, blockedId: string) {
  if (!blockerId || !blockedId) throw new Error('Both user ids are required');
  if (blockerId === blockedId) throw new Error('Cannot block yourself');

  const { error: blockErr } = await blocksRepository.insertBlock({
    id: uuid(),
    blockerId,
    blockedId,
    createdAt: new Date().toISOString(),
  });
  if (blockErr) throw blockErr;

  await friendsRepository.deleteBetween(blockerId, blockedId);

  return { ok: true };
}

async function unblockUser(blockerId: string, blockedId: string) {
  const { error } = await blocksRepository.deleteBlock(blockerId, blockedId);
  if (error) throw error;
  return { ok: true };
}

export { areUsersBlocked, blockUser, unblockUser };

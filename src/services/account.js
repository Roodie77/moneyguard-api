import path from 'path';
import { query, withTransaction } from '../utils/db.js';
import logger from '../utils/logger.js';
import { deleteAsset } from './storage.js';

export const DELETION_GRACE_HOURS = 24;
const MAX_CLEANUP_ATTEMPTS = 10;

// The user as the API shows them: never the password hash or other internal columns, plus whether the account is
// active or waiting to be deleted.
export function publicUser({ passwordHash, passwordChangedAt, avatarPublicId, ...user }) {
  return { ...user, accountStatus: user.deletesAt ? 'pending_deletion' : 'active' };
}

// null for an active account. For one waiting to be deleted: when it was requested, when it will be deleted, and a
// sentence a screen can show as it is.
export function deletionInfo(user) {
  if (!user.deletesAt) return null;
  return {
    requestedAt: user.deletionRequestedAt,
    deletesAt: user.deletesAt,
    message: `This account is scheduled for permanent deletion at ${user.deletesAt.toISOString()} (UTC). Until then you can cancel and nothing is lost. After that, your profile and all your data are removed and cannot be recovered.`,
  };
}

// True when the deadline has passed. The database makes the final decision (purgeAccount checks again).
export const isDue = (user) => Boolean(user.deletesAt) && user.deletesAt <= new Date();

// Starts the grace period. Asking again changes nothing: the deadline is not pushed back.
export async function requestDeletion(userId) {
  const [user] = await query(
    `UPDATE users
        SET deletion_requested_at = COALESCE(deletion_requested_at, now()),
            deletes_at = COALESCE(deletes_at, now() + make_interval(hours => $2))
      WHERE id = $1 RETURNING *`,
    [userId, DELETION_GRACE_HOURS],
  );
  return user;
}

// Ends the grace period: the account carries on as if nothing happened. Safe to repeat.
export async function cancelDeletion(userId) {
  const [user] = await query(
    'UPDATE users SET deletion_requested_at = NULL, deletes_at = NULL WHERE id = $1 RETURNING *',
    [userId],
  );
  return user;
}

// Permanently deletes one account whose deadline has passed: every row of theirs (the database removes them with the user)
// and, queued in the same transaction, every file they uploaded. Returns false if the account is gone already or the user
// cancelled just before (the row is locked and checked again, so a cancel and a delete can never both win).
export async function purgeAccount(userId) {
  return withTransaction(async (tx) => {
    const [user] = await tx.query(
      'SELECT id, avatar_url, avatar_public_id FROM users WHERE id = $1 AND deletes_at <= now() FOR UPDATE',
      [userId],
    );
    if (!user) return false;

    await tx.query(
      `INSERT INTO storage_cleanup (public_id, resource_type, local_name)
       SELECT public_id, COALESCE(resource_type, 'image'), CASE WHEN public_id IS NULL THEN filename END
         FROM files WHERE user_id = $1`,
      [userId],
    );
    if (user.avatarPublicId) {
      await tx.query("INSERT INTO storage_cleanup (public_id, resource_type) VALUES ($1, 'image')", [user.avatarPublicId]);
    } else if (typeof user.avatarUrl === 'string' && user.avatarUrl.startsWith('/uploads/')) {
      await tx.query('INSERT INTO storage_cleanup (local_name) VALUES ($1)', [path.basename(user.avatarUrl)]);
    }

    await tx.query('DELETE FROM users WHERE id = $1', [userId]); // bills, expenses, files, alerts, tokens, ... go with it
    return true;
  });
}

// Removes the files queued by purgeAccount. A file that cannot be removed now (the storage is unreachable) stays queued and
// is tried again on the next sweep, up to MAX_CLEANUP_ATTEMPTS times; after that it is reported once and left alone.
export async function processStorageCleanup() {
  const rows = await query('SELECT * FROM storage_cleanup WHERE attempts < $1 ORDER BY created_at LIMIT 50', [MAX_CLEANUP_ATTEMPTS]);
  for (const row of rows) {
    try {
      await deleteAsset({ publicId: row.publicId, resourceType: row.resourceType ?? 'image', localName: row.localName });
      await query('DELETE FROM storage_cleanup WHERE id = $1', [row.id]);
    } catch (err) {
      const [{ attempts }] = await query('UPDATE storage_cleanup SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [row.id]);
      const what = row.publicId ?? row.localName;
      if (attempts >= MAX_CLEANUP_ATTEMPTS) logger.error(`Giving up deleting an uploaded file of a deleted account after ${attempts} tries: ${what} (${err.message})`);
      else logger.warn(`Could not delete an uploaded file of a deleted account yet (try ${attempts}): ${what} (${err.message})`);
    }
  }
}

// Deletes every account whose grace period is over, then their files. Runs when the server starts and every minute.
// Safe to run at any time and from several servers at once.
export async function sweepDeletedAccounts() {
  const due = await query('SELECT id FROM users WHERE deletes_at <= now() ORDER BY deletes_at LIMIT 100');
  let purged = 0;
  for (const { id } of due) {
    try {
      if (await purgeAccount(id)) purged += 1;
    } catch (err) {
      logger.error(`Could not delete account ${id}: ${err.message}`);
    }
  }
  if (purged) logger.info(`Permanently deleted ${purged} account(s) after their grace period`);
  await processStorageCleanup();
  return purged;
}

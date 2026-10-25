-- Account deletion with a grace period. deletion_requested_at is when the user asked; deletes_at is when the account and
-- all its data are removed for good (24 hours later). Both are empty for an active account. While they are set the
-- account still works, so the user can see the notice and cancel.
ALTER TABLE users
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletes_at            timestamptz,
  ADD CONSTRAINT users_deletion_both_or_neither CHECK ((deletion_requested_at IS NULL) = (deletes_at IS NULL));

-- The sweep that does the deleting only looks at accounts that have a deadline.
CREATE INDEX users_deletes_at_idx ON users (deletes_at) WHERE deletes_at IS NOT NULL;

-- Uploaded files live outside the database (Cloudinary, or this server's disk), so deleting the account rows does not
-- remove them. When an account is deleted its files are queued here in the same transaction, then removed one by one,
-- retried if the storage is briefly unreachable. A row is removed from the queue once its file is gone.
CREATE TABLE storage_cleanup (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     text,
  resource_type text,
  local_name    text,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (public_id IS NOT NULL OR local_name IS NOT NULL)
);

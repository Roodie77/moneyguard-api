-- A profile picture. avatar_url is what a client opens (a Cloudinary link, or /uploads/<name> for a file kept on this
-- server's disk). avatar_public_id is the Cloudinary id, kept so the old picture can be deleted when it is replaced;
-- it stays empty for pictures kept on disk.
ALTER TABLE users
  ADD COLUMN avatar_url       text,
  ADD COLUMN avatar_public_id text;

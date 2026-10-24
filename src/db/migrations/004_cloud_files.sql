-- Files kept in the cloud (Cloudinary) are opened by link. These columns stay empty for files kept on this
-- server's disk, whose link is /uploads/<filename>.
ALTER TABLE files
  ADD COLUMN url           text,
  ADD COLUMN public_id     text,
  ADD COLUMN resource_type text;

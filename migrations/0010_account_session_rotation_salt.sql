-- The random salt of the session's last rotation. The new handle is derived from the handle it
-- replaced and this salt (HMAC under SESSION_SECRET), so every request that still carries the previous
-- handle inside its 30-second window gets the same successor back instead of a new one: two tabs, a
-- refresh beside a mutation, or a lost Set-Cookie all converge on one cookie (iletişim-servisi 07
-- review, account-center #115). Additive: an older image neither reads nor writes it; a salt it leaves
-- stale only makes the next re-rotation fall back to a fresh one.
SET LOCAL lock_timeout = '5s';
ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS rotation_salt bytea;

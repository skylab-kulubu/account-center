-- When the session's current handle first carried a request (null: not yet). A re-rotation from the
-- previous handle while the current one was never used (its Set-Cookie response was lost) keeps the
-- previous handle, so two requests carrying it at once both recover (iletişim-servisi 07 review).
-- Additive: an older image neither reads nor writes it; a value it leaves behind only makes the next
-- re-rotation behave as before.
ALTER TABLE account_sessions ADD COLUMN IF NOT EXISTS handle_used_at timestamptz;

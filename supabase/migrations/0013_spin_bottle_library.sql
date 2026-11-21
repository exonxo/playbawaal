-- Spin the Bottle prompts in the content library. Run in the Supabase SQL editor AFTER 0012. Safe to run
-- more than once. Nothing is deleted or rewritten: it only allows one more kind of library item
-- ('bottle-prompts', one row per truth or dare, category = the mood: kids, family, college, office).
-- library_pick, library_add, the counts and the grants from 0010-0012 work for it unchanged.
-- If 0012 is ever run again, run 0013 again after it (0012 resets this check to its own list).

alter table public.content_library drop constraint if exists content_library_kind_check;
alter table public.content_library add constraint content_library_kind_check
  check (kind in ('chor-kaun-topic', 'emoji-puzzle', 'dare', 'kbc-question', 'bottle-prompts'));

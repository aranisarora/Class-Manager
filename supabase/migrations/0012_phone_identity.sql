-- =============================================================================
-- 0012 · One number, one row
--
-- §9.1: "Identity is the phone number. There are no join codes. Step 1
-- registered the number, so a recognized sender resolves on sight."
--
-- That whole design rests on a string comparison, and nothing was making the
-- string comparable. `contact` has `unique(academy_id, phone_e164)`, which is
-- exactly the right constraint and could not fire, because the same human
-- arrives written four ways:
--
--     9880077889   919880077889   +91 98800 77889   +919880077889
--
-- Watched happening: an admin added two families, then tapped a follow-up
-- button, and the model added the same two families again — once under
-- `9880077889` and once under `919880077889`. Four accounts, four players, four
-- enrollments, for two children. The unique key sat there the whole time and
-- never had two equal strings to compare.
--
-- What that costs downstream is worse than the duplicate rows. The parent
-- messages in from the number their phone actually sends from and resolves to
-- whichever row happens to match; reminders address a number that is not on
-- WhatsApp; the roster is wrong and nothing anywhere says so.
--
-- So normalisation belongs at layer 0 — "the database refuses what it can" — and
-- not in each writer. Every path that has ever written a contact (the seed, the
-- emulator, `add_coach`, `add_family`, `book_trial`, model-authored SQL, and
-- whatever is written next) gets it without knowing it exists, which is the
-- only version of this that stays true.
-- =============================================================================

-- The default dial code is per academy, read from settings, because "assume
-- India" is right for this product and wrong as a law of nature.
create or replace function app.dial_code(p_academy_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(nullif(a.settings->>'dial_code', ''), '+91')
    from academy a
   where a.id = p_academy_id
$$;

/**
 * A phone number, as E.164, or unchanged if it cannot be made into one.
 *
 * Deliberately does NOT reject what it cannot parse. A refusal here would turn a
 * mistyped number into a failed write in the middle of somebody's onboarding,
 * and the product's answer to an unreachable number is already "the message is
 * recorded as undelivered with a reason" — which is visible, whereas a rejected
 * insert is an error message about a column.
 */
create or replace function app.normalize_phone(p_raw text, p_dial_code text default '+91')
returns text
language plpgsql
immutable
as $$
declare
  digits text;
  cc     text := regexp_replace(coalesce(nullif(p_dial_code, ''), '+91'), '\D', '', 'g');
begin
  if p_raw is null then
    return null;
  end if;

  digits := regexp_replace(p_raw, '\D', '', 'g');
  if digits = '' then
    return p_raw;
  end if;

  -- 00 is the other way of writing +.
  if left(digits, 2) = '00' then
    return '+' || substr(digits, 3);
  end if;

  -- Already carries a +: trust the caller, minus the punctuation.
  if left(btrim(p_raw), 1) = '+' then
    return '+' || digits;
  end if;

  -- A bare national number gets this academy's dial code.
  if length(digits) between 6 and 11 and left(digits, length(cc)) <> cc then
    return '+' || cc || digits;
  end if;

  return '+' || digits;
end;
$$;

create or replace function app.contact_normalize_phone()
returns trigger
language plpgsql
as $$
begin
  new.phone_e164 := app.normalize_phone(new.phone_e164, app.dial_code(new.academy_id));
  -- `wa_id` is the same number without punctuation, and it was being written by
  -- hand at every call site too.
  new.wa_id := regexp_replace(coalesce(new.wa_id, new.phone_e164), '\D', '', 'g');
  return new;
end;
$$;

drop trigger if exists contact_normalize_phone on contact;
create trigger contact_normalize_phone
  before insert or update of phone_e164, wa_id on contact
  for each row execute function app.contact_normalize_phone();

-- Existing rows, so the constraint means the same thing for history as for new
-- writes. Duplicates that only differ by formatting are collapsed onto the row
-- that has been talked to most recently; anything that would still collide is
-- left alone rather than silently merged, because merging two people's history
-- is not something a migration should decide.
do $$
declare
  r record;
begin
  for r in
    select c.id, c.academy_id, c.phone_e164,
           app.normalize_phone(c.phone_e164, app.dial_code(c.academy_id)) as normalized
      from contact c
  loop
    continue when r.normalized = r.phone_e164;
    if exists (
      select 1 from contact d
       where d.academy_id = r.academy_id and d.phone_e164 = r.normalized and d.id <> r.id
    ) then
      raise notice 'contact % would collide with an existing row on %; left as-is', r.id, r.normalized;
    else
      update contact set phone_e164 = r.normalized where id = r.id;
    end if;
  end loop;
end;
$$;

grant execute on function app.dial_code(uuid) to cm_service, cm_user, cm_readonly;
grant execute on function app.normalize_phone(text, text) to cm_service, cm_user, cm_readonly;

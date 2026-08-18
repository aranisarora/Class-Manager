-- =============================================================================
-- 0036 — the business answers in one question
--
-- A manager's world is four things: the books, the register, the people and the
-- day. This repo had a view for the register (`app.session_roster`), a view for
-- one property of the day (`session_coverage`), and a view for one question about
-- the books (`unmarked_billable_session`). The books themselves, the people, and
-- the day as a person hears it had nothing, and the model rebuilt each of them
-- from raw tables on every turn that touched them.
--
-- The counts, over every recorded run in `.probe/runs`, of what the model wrote
-- `from` or `join`ed by hand:
--
--   class 1233 · person 780 · session 729 · player 515 · coach 491 · account 426
--   venue 400 · enrollment 399 · session_coach 270 · tally_line 225 · payment 198
--
-- against `app.session_roster` at 100. The register view is the most-used object
-- in the schema because it is the only one that answers a question in the words
-- somebody asks it. That is the whole design rule here, and it is narrower than
-- "build views for common questions":
--
--   **Build one where the same join is written every time AND one of its
--   predicates is where it goes wrong. When you add one, delete the competing
--   derivation from the prefix — otherwise you have added surface and kept the
--   failure.**
--
-- The second clause is the one that matters. `app.account_balance()` has existed
-- since the first commit, handles the period question, and was used by the model
-- **zero times in every run ever recorded** — because SCHEMA_DOC hands over the
-- arithmetic ("Balance for a period = sum(tally_line.amount) - sum(confirmed
-- payment.amount)"), and a formula in the prompt beats a helper in the database
-- every time. Two authors of one truth, and the prose author won. So every view
-- below lands with a deletion upstream, in the same commit.
--
-- -----------------------------------------------------------------------------
-- THE HAZARD THAT IS SPECIFIC TO VIEWS, and every join below is written around it
--
-- A view that INNER JOINs a table the reader may not see turns "withheld by
-- policy" into "does not exist" — and hides it inside an aggregate, where it
-- looks like a complete answer. The product warns about this shape everywhere
-- above the database and it is at its most dangerous here, because a missing row
-- in a view has nothing to point at.
--
-- Driven, by hand, in the run records: `from person p join account a on
-- a.holder_person_id = p.id join player pl on pl.account_id = a.id where
-- lower(p.full_name) like '%sunita%'` — which returns zero rows for a Sunita who
-- is a coach, and reads as "no such person".
--
-- So: a role or a name the reader might not hold is LEFT JOINed, and comes back
-- null rather than deleting the row. `class_roster` left-joins the account holder
-- for exactly this reason — a coach may see the players on their own sessions and
-- may not see the accounts those players belong to, and an inner join there would
-- have shown a coach an empty register for a class they teach.
--
-- SECURITY: every view is `security_invoker = true`, so each runs with the
-- permissions of whoever asks. A coach's roster is their own sessions, a family's
-- money is their own money, and none of this is a hole in 0003. The one exception
-- is `coach_public`, which was already the documented exception and is joined here
-- precisely because it is the only path to a co-coach's name.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Two time helpers, and the rule they make structural.
--
-- SCHEMA_DOC says "Timestamps are timestamptz; render in the academy's timezone,
-- never raw." That is an instruction the writer must remember on every read, and
-- the graveyard's own general lesson is that **a rule the writer must remember is
-- a default the database should hold**.
--
-- The incident is the most expensive one in the product: given `06:00:00` and no
-- rendering, replies came back saying "6pm", defended it when pushed, and sent a
-- parent to a locked hall. `census()` in context.ts fixed it for the rows the
-- census carries, by calling `inZone().label`. Every other read still returns raw
-- UTC to a model that has to remember to convert it.
--
-- These are the SQL half of that formatter and they deliberately produce the same
-- string: `inZone().label` in lib/clock.ts is `formatDate` + `formatTime` from
-- lib/format.ts — "Mon 18 Aug, 6:30 pm", weekday abbreviated, no zero padding on
-- the day, minutes dropped on the hour, lowercase meridiem. If that formatter
-- changes, these change with it. (Drift here is cosmetic rather than dangerous —
-- the failure being prevented is a UTC timestamp read as a local one, which any
-- correct rendering prevents. Two spellings of the right time is a much smaller
-- problem than one spelling of the wrong one.)
--
-- A helper rather than a column, because a helper generalises: it renders ANY
-- timestamp in ANY query, where a column only renders the one the view carries.
-- -----------------------------------------------------------------------------
create or replace function app.local_clock(p_at timestamptz, p_tz text) returns text
  language sql stable
  as $$
    select case
      when p_at is null then null
      else to_char(x.l, 'FMHH12')
           || case when extract(minute from x.l) = 0 then '' else to_char(x.l, ':MI') end
           || case when extract(hour from x.l) < 12 then ' am' else ' pm' end
    end
    from (select p_at at time zone coalesce(nullif(p_tz, ''), 'Asia/Kolkata') as l) x
  $$;

comment on function app.local_clock(timestamptz, text) is
  'The clock alone, in the academy timezone: "6:30 pm", "7 am". Matches formatTime '
  'in lib/format.ts, which is what the rest of the product writes times with.';

create or replace function app.local_label(p_at timestamptz, p_tz text) returns text
  language sql stable
  as $$
    select case
      when p_at is null then null
      else to_char(p_at at time zone coalesce(nullif(p_tz, ''), 'Asia/Kolkata'), 'Dy FMDD Mon')
           || ', ' || app.local_clock(p_at, p_tz)
    end
  $$;

comment on function app.local_label(timestamptz, text) is
  'A timestamp as a person says it, in the academy timezone: "Mon 18 Aug, 6:30 pm". '
  'Matches inZone().label in lib/clock.ts. A raw timestamptz read as a local time is '
  'the most expensive error this product has made.';

-- The one-argument forms, which are the ones worth documenting: the timezone a
-- query wants is almost always this academy's own, and a helper that has to be
-- told the zone is a helper that can be told the wrong zone.
create or replace function app.local_clock(p_at timestamptz) returns text
  language sql stable
  as $$ select app.local_clock(p_at, (select a.timezone from academy a where a.id = app.academy_id())) $$;

create or replace function app.local_label(p_at timestamptz) returns text
  language sql stable
  as $$ select app.local_label(p_at, (select a.timezone from academy a where a.id = app.academy_id())) $$;

comment on function app.local_clock(timestamptz) is 'app.local_clock in this academy''s timezone.';
comment on function app.local_label(timestamptz) is 'app.local_label in this academy''s timezone.';


-- -----------------------------------------------------------------------------
-- THE BOOKS — account_standing
--
-- `account` 426 + `tally_line` 225 + `payment` 198 hand-joins across the runs,
-- and `app.account_balance()` used zero times.
--
-- The derivation is not merely tedious, it is a TRAP, and the trap has a name in
-- the run records. This shape recurs across turns:
--
--     (select coalesce(sum(t.amount),0) from tally_line t
--       where t.account_id = a.id and t.period = date '2026-08-01') as aug_charges,
--     (select coalesce(sum(pay.amount),0) from payment pay
--       where pay.account_id = a.id and pay.status = 'confirmed')   as paid
--
-- One month of charges, every payment ever made. The difference is neither a
-- period balance nor a running one, and it is the arithmetic behind the week's
-- worst pair of turns: an owner told "she's in credit Rs2,400, September covered"
-- while the client was told "Rs2,400 of charges on the 1st", ninety seconds apart.
--
-- **The deeper fact, and it is why no column here offers a period balance:
-- `tally_line` carries `period` and `payment` does not, so a payment cannot be
-- attributed to a month at all.** lib/jobs/handlers/money.ts reached this
-- conclusion in a comment and refuses to compute it: *"it has no period filter and
-- cannot have one — payment carries no period, so a payment cannot be attributed
-- to a month and 'what is owed for August' is not a computable quantity here."*
--
-- SCHEMA_DOC promised the quantity anyway, and `app.account_balance(id, period)`
-- manufactured it by confirmation date. Three authors and three answers, on the
-- one channel where being wrong about money is the expensive failure. Attributing
-- a payment to the month it landed in is an ALLOCATION POLICY nobody stated, and
-- inventing one is how an invention acquires the authority of policy.
--
-- So the view carries only quantities that exist:
--   charged/paid/balance are lifetime and running, which is the only honest
--   balance; awaiting_confirmation is money somebody says they sent that nobody
--   has attested; last_payment_at answers "when did anything last come in", which
--   is the actionable question a period balance was being used to ask.
-- -----------------------------------------------------------------------------
drop view if exists public.account_standing;

create view public.account_standing with (security_invoker = true) as
  select a.academy_id,
         a.id                                   as account_id,
         a.display_name,
         a.holder_person_id,
         hp.full_name                           as holder_name,
         hc.id                                  as holder_contact_id,
         t.charged::numeric(10,2)               as charged,
         p.paid::numeric(10,2)                  as paid,
         (t.charged - p.paid)::numeric(10,2)    as balance,
         p.awaiting_confirmation::numeric(10,2) as awaiting_confirmation,
         p.last_payment_at,
         t.last_charge_period,
         pl.players
    from account a
    -- LEFT, not inner: see the hazard note at the top. A holder whose person row
    -- is not visible to this reader leaves a null name on a real account, rather
    -- than deleting an account that exists.
    left join person hp on hp.id = a.holder_person_id
    left join lateral (
      select coalesce(sum(tl.amount), 0) as charged,
             max(tl.period)              as last_charge_period
        from tally_line tl
       where tl.account_id = a.id
    ) t on true
    left join lateral (
      select coalesce(sum(pm.amount) filter (where pm.status = 'confirmed'), 0) as paid,
             coalesce(sum(pm.amount) filter (where pm.status = 'requested'), 0) as awaiting_confirmation,
             max(pm.confirmed_at) filter (where pm.status = 'confirmed')        as last_payment_at
        from payment pm
       where pm.account_id = a.id
    ) p on true
    left join lateral (
      select coalesce(array_agg(pe.full_name order by pe.full_name), '{}'::text[]) as players
        from player py
        join person pe on pe.id = py.person_id
       where py.account_id = a.id and py.active
    ) pl on true
    left join lateral (
      select c.id
        from contact c
       where c.person_id = a.holder_person_id
       order by c.is_primary desc nulls last, c.created_at
       limit 1
    ) hc on true;

comment on view public.account_standing is
  'Where an account stands: lifetime charges, confirmed payments, the running balance, '
  'money claimed but not attested, and when anything last came in. There is deliberately '
  'no period balance — tally_line carries a period and payment does not, so a payment '
  'cannot be attributed to a month without an allocation policy nobody has stated. '
  'Positive balance = they owe; negative = they are in credit. Inherits the reader.';

grant select on public.account_standing to cm_service, cm_user, cm_readonly;


-- -----------------------------------------------------------------------------
-- THE REGISTER, one level up — class_roster
--
-- `app.session_roster` answers "who is due at this session". Nothing answered
-- "who is in this class", which is the grain an owner actually asks at, and the
-- model rebuilt it 399 times from enrollment + class + player + person.
--
-- Two things go wrong in the hand-written version, and both are in the records:
--
--  1. `player.active` is left out. Every hand-rolled roster in the runs joins
--     enrollment to player to person and filters on `e.ended_on is null` alone —
--     so a child who has LEFT THE ACADEMY ENTIRELY is still on the register. The
--     enrolment ends the billing; `player.active = false` is the person leaving,
--     and only one of the two was ever checked.
--  2. `e.ended_on is null` is the right predicate for today and the wrong one for
--     any other day. The date-range form below is `enrolledPlayers` in
--     lib/jobs/util.ts and `app.session_roster`'s own predicate, because two
--     definitions of "on the register" is how the register and the bill come to
--     disagree.
--
-- It also carries the EFFECTIVE RATE — coalesce(enrollment, class) for amount,
-- unit and count — which is the other derived value SCHEMA_DOC states as a
-- formula and which the model therefore inlines. Drop-ins inside a monthly batch,
-- sibling discounts, scholarship players and legacy rates all live in that
-- coalesce, and none of them survive somebody quoting `class.rate_amount`.
-- -----------------------------------------------------------------------------
drop view if exists public.class_roster;

create view public.class_roster with (security_invoker = true) as
  select cl.academy_id,
         cl.id                                    as class_id,
         cl.name                                  as class_name,
         e.id                                     as enrollment_id,
         e.is_trial,
         e.started_on,
         pl.id                                    as player_id,
         pe.full_name                             as player_name,
         pl.account_id,
         ah.full_name                             as account_holder,
         coalesce(e.rate_amount, cl.rate_amount)  as rate_amount,
         coalesce(e.rate_unit,   cl.rate_unit)    as rate_unit,
         coalesce(e.rate_count,  cl.rate_count)   as rate_count
    from class cl
    join academy ac on ac.id = cl.academy_id
    join enrollment e on e.class_id = cl.id and e.academy_id = cl.academy_id
    join player pl on pl.id = e.player_id and pl.active
    join person pe on pe.id = pl.person_id
    -- LEFT: a coach may read the players on their own sessions and may NOT read
    -- the accounts those players belong to. An inner join here would have shown a
    -- coach an empty register for a class they teach.
    left join account acc on acc.id = pl.account_id
    left join person ah on ah.id = acc.holder_person_id
   where e.started_on <= (app.now() at time zone ac.timezone)::date
     and (e.ended_on is null or e.ended_on >= (app.now() at time zone ac.timezone)::date);

comment on view public.class_roster is
  'Who is on a class''s register today, one row per live enrolment, with the effective '
  'rate (enrolment''s, defaulting to the class''s). Excludes players who have left '
  '(player.active) and enrolments not live today — for history, read enrollment itself. '
  'Inherits the reader.';

grant select on public.class_roster to cm_service, cm_user, cm_readonly;


-- -----------------------------------------------------------------------------
-- THE PEOPLE — person_directory
--
-- `person` 780 hand-joins, and the highest-value read in the product is the one
-- the model has no cheap way to make: the row behind somebody who is NOT in the
-- conversation.
--
-- The runtime already builds a dossier before the first round — roles, opt-out,
-- mutes, open questions, live watches — and builds it for the person in the SEAT
-- and nobody else. So every conversation teaches the same lesson: the background
-- you need arrives on its own. That is true 100% of the time for the person in
-- front of you and 0% of the time for anybody else, and the owner — the one
-- person whose whole job is talking ABOUT other people — scored lowest of all
-- four seats on "did it check the facts about people not in this conversation".
--
-- Telling the model to go and look does not fix it, because there was nothing
-- single to look at: roles are four tables, standing is three more, and the one
-- sentence that would send it to `pending_request` is written INSIDE the
-- description of `pending_request`, which you only read if you had already decided
-- to look there.
--
-- WHAT IS DELIBERATELY ABSENT: an `is_admin` column. `academy_admin` shows a
-- non-admin session only its own row, by design — so an invoker view would report
-- `false` for the actual owner to everybody except the owner, which is a label
-- licensing a false sentence. Reaching the admin never needs the table: reply with
-- to_contact_id 'admin', or handoff.
--
-- `window_open` is here because it is the fact the prefix said could not be known.
-- PLATFORM told the model "you cannot tell from here whether a given person's
-- window is open" while `lib/messaging/window.ts` decides it with one comparison
-- against `contact.last_inbound_at` — a column sitting in SCHEMA_DOC the whole
-- time, maintained on every inbound by lib/identity.ts. The 24 hours below and
-- WINDOW_MS there are one fact; they move together.
--
-- Null, not false, when the contact row is not visible to this reader: "their
-- window is shut" and "I cannot see their window" are opposite sentences.
-- -----------------------------------------------------------------------------
drop view if exists public.person_directory;

create view public.person_directory with (security_invoker = true) as
  select pe.academy_id,
         pe.id            as person_id,
         pe.full_name,
         c.contact_id,
         c.phone_e164,
         c.contact_state,
         c.opted_out_at,
         c.last_inbound_at,
         c.window_open,
         co.id            as coach_id,
         co.status        as coach_status,
         acc.id           as account_id,
         pl.id            as player_id,
         q.open_questions,
         m.mutes
    from person pe
    left join lateral (
      select c2.id                as contact_id,
             c2.phone_e164        as phone_e164,
             c2.state             as contact_state,
             c2.opted_out_at      as opted_out_at,
             c2.last_inbound_at   as last_inbound_at,
             (c2.last_inbound_at is not null
              and c2.last_inbound_at > app.now() - interval '24 hours') as window_open
        from contact c2
       where c2.person_id = pe.id
       order by c2.is_primary desc nulls last, c2.last_inbound_at desc nulls last, c2.created_at
       limit 1
    ) c on true
    -- coach_public, not coach: the coach table is own-row-only for non-admins, so
    -- an invoker join to it would answer "is this person a coach" with "no" for
    -- every coach but the reader.
    left join coach_public co on co.person_id = pe.id
    left join account acc on acc.holder_person_id = pe.id
    left join lateral (
      select p2.id from player p2
       where p2.person_id = pe.id and p2.active
       order by p2.created_at
       limit 1
    ) pl on true
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind',       pr.kind,
               'subject',    pr.subject,
               'question',   pr.question,
               'asked_at',   pr.created_at,
               'expires_at', pr.expires_at)
             order by pr.created_at desc), '[]'::jsonb) as open_questions
        from pending_request pr
       where pr.person_id = pe.id and pr.resolved_at is null
    ) q on true
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
               'scope',  cp.scope,
               'until',  cp.until,
               'stated', cp.stated)
             order by cp.created_at desc), '[]'::jsonb) as mutes
        from comm_preference cp
       where cp.person_id = pe.id and cp.released_at is null
    ) m on true;

comment on view public.person_directory is
  'Everyone this reader may see, and what they are to the business: their contact and '
  'whether its 24h window is open, whether they coach, hold an account or play, what '
  'they have been asked and not answered, and what they have muted. The sideways read, '
  'as one query. No is_admin column: academy_admin is own-row-only, so any such column '
  'would report false for the owner to everybody but the owner. Inherits the reader.';

grant select on public.person_directory to cm_service, cm_user, cm_readonly;


-- -----------------------------------------------------------------------------
-- THE DAY — session_detail
--
-- `session` 729 + `class` 1233 + `venue` 400 hand-joins. "What is on tomorrow"
-- and "tell me about Saturday" are the same four joins every time, plus coverage,
-- plus a headcount, plus the timezone conversion nobody can be relied on to
-- remember.
--
-- Built ON `session_coverage` and `app.session_roster` rather than beside them.
-- Coverage is the most important derived value in the product and it keeps one
-- author; so does "who is due at this session", whose date predicate is exactly
-- the part a second copy would get subtly wrong.
--
-- THE COACH STATES ARE NAMED, and the naming is the load-bearing part.
-- `session_coach` stores the state as three nullable timestamps, and a row with
-- all three empty means "assigned, and nothing has come back". Nothing named that,
-- so the model had to look at three empty fields and decide what they meant on
-- every turn — and it decided both ways. Driven: a coach asked whether he could
-- take a session two other coaches were still assigned to, and was told "that's
-- yours. Nothing to take; it's already you." Two other coaches were assigned, he
-- had never confirmed, and the owner's uncovered-session alarm was still running.
--
-- `assigned_no_answer` licenses "they are down for it and nothing has come back",
-- which is true. It cannot be paraphrased into "they said yes". It deliberately
-- does NOT claim they were asked — whether a question was put on their screen is
-- `pending_request`, and until every ask files itself under the session it is
-- about, that is a separate fact.
--
-- The case order is declined → arrived → confirmed, which is the order in
-- app.session_is_covered, so this view can never disagree with session_coverage.
-- Do not reorder it.
-- -----------------------------------------------------------------------------
drop view if exists public.session_detail;

create view public.session_detail with (security_invoker = true) as
  select s.academy_id,
         s.id                                            as session_id,
         s.class_id,
         cl.name                                         as class_name,
         s.starts_at,
         s.ends_at,
         s.status,
         s.cancel_reason,
         (s.starts_at at time zone ac.timezone)::date    as local_date,
         app.local_label(s.starts_at, ac.timezone)       as local_start,
         app.local_clock(s.ends_at, ac.timezone)         as local_end,
         v.id                                            as venue_id,
         v.name                                          as venue_name,
         v.address                                       as venue_address,
         cov.covered,
         cov.pending_count,
         cov.confirmed_count,
         cov.declined_count,
         co.coaches,
         r.due_players,
         r.marked_players,
         r.attended_players
    from session s
    join class cl on cl.id = s.class_id
    join academy ac on ac.id = s.academy_id
    left join venue v on v.id = coalesce(s.venue_id, cl.venue_id)
    left join session_coverage cov on cov.session_id = s.id
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
               'coach_id', sc.coach_id,
               'name',     pe.full_name,
               'state',    case
                             when sc.declined_at  is not null then 'declined'
                             when sc.arrived_at   is not null then 'arrived'
                             when sc.confirmed_at is not null then 'confirmed'
                             else                                  'assigned_no_answer'
                           end)
             order by pe.full_name nulls last), '[]'::jsonb) as coaches
        from session_coach sc
        left join coach_public cp on cp.id = sc.coach_id
        left join person pe on pe.id = cp.person_id
       where sc.session_id = s.id
    ) co on true
    left join lateral (
      select count(*)::int                                                             as due_players,
             count(*) filter (where sr.attendance_status is not null)::int             as marked_players,
             count(*) filter (where sr.attendance_status in ('present','late'))::int   as attended_players
        from app.session_roster sr
       where sr.session_id = s.id
    ) r on true;

comment on view public.session_detail is
  'A session as a person hears it: class, venue, the start already rendered in the '
  'academy timezone, coverage from session_coverage, the coach set with each coach''s '
  'state named, and the headcount from app.session_roster. assigned_no_answer means '
  'down for it with nothing back — NOT that they were asked and stayed silent. '
  'Inherits the reader.';

grant select on public.session_detail to cm_service, cm_user, cm_readonly;


-- -----------------------------------------------------------------------------
-- app.account_balance — made honest, and made to read the view.
--
-- Two defects, neither of which anybody could have hit, because the model never
-- called it once in any recorded run.
--
-- 1. SECURITY DEFINER on a function that takes an account id and returns that
--    account's money. SCHEMA_DOC promises "tally_line and payment are invisible to
--    anybody who holds no account of their own" — and a coach may read
--    `player.account_id` for the players on their own sessions, so the promise was
--    one function call away from being false. It is invoker now: the same
--    permissions the caller has by hand, which is what every other read here does.
--
-- 2. The period argument computed a quantity that does not exist. It attributed a
--    payment to the month its confirmation fell in — an allocation policy nobody
--    stated — while lib/jobs/handlers/money.ts refuses the same computation in as
--    many words. A number that looks authoritative and is a guess is worse than a
--    refusal, and this repo's own record is that every honest refusal was repaired
--    in-turn while every dishonest result became a false sentence to a person. So
--    it raises, and the message says what to ask instead.
--
-- The running branch delegates to account_standing so there is one author for the
-- arithmetic rather than two that will drift.
-- -----------------------------------------------------------------------------
create or replace function app.account_balance(p_account_id uuid, p_period date)
  returns numeric
  language plpgsql stable security invoker set search_path = public, pg_temp
  as $$
  begin
    if p_period is not null then
      raise exception
        'account_balance takes no period: tally_line carries a period and payment does not, '
        'so a payment cannot be attributed to a month. Ask for the running balance '
        '(period null, or account_standing.balance), or for that month''s charges '
        '(sum(amount) from tally_line where period = ...).'
        using errcode = 'invalid_parameter_value';
    end if;
    -- No coalesce to 0. An account this caller cannot see returns NULL, because
    -- "they owe nothing" and "I cannot see their money" are opposite sentences and
    -- the old definer version could only ever say the first one.
    return (select balance from account_standing where account_id = p_account_id);
  end
  $$;

comment on function app.account_balance(uuid, date) is
  'The running balance for an account, from account_standing. NULL means no such '
  'account is visible to the caller, never zero. A non-null period is refused: payment '
  'carries no period, so a period balance is not a computable quantity.';

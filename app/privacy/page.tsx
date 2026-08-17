import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { DELETION_URL, OPERATOR, PRIVACY_URL } from '@/lib/legal'

/**
 * The privacy policy, and the one page on this deployment that is written for
 * somebody outside the building.
 *
 * WHY IT IS A ROUTE AND NOT A LINK TO A DOC. Meta requires a privacy policy URL
 * that a reviewer can open, unauthenticated, from a machine that has never seen
 * this project, and it re-checks that URL after approval. A Google Doc or a
 * Notion page can be moved, un-shared or rate-limited by somebody who is not
 * thinking about App Review; a route in this repo is deployed by the same push
 * that deploys the webhook, so the two cannot drift apart.
 *
 * WHY IT IS NOT IN `middleware.ts`'s MATCHER. That matcher is an allowlist of
 * gated paths, so a new route is public by default — which is exactly what this
 * one needs. Do not add `/privacy` to it. A privacy policy behind a login is the
 * single most common reason a WhatsApp Business submission is rejected, and the
 * failure is silent from this side: the reviewer sees a redirect to `/ops/login`
 * and files it as "policy not accessible".
 *
 * WHY IT IS STATIC. No database read, no `force-dynamic`, no env. It has to
 * render 200 when Postgres is down, when the model key is unset, and during a
 * migration — because the one time a reviewer opens it is not a time anybody
 * chooses. `app/page.tsx` is the opposite of this by design; that is why that
 * one is gated and this one is not.
 *
 * WHAT TO EDIT BEFORE SUBMITTING: `lib/legal.ts`, and nothing else. Everything
 * else in this document describes what `supabase/migrations`, `lib/messaging`
 * and `lib/agent` actually do, so it should be edited when they change and not
 * before.
 */

const CANONICAL = PRIVACY_URL

export const metadata: Metadata = {
  title: `Privacy Policy · ${OPERATOR.service}`,
  description: `How ${OPERATOR.service} collects, uses, stores and deletes personal data when a coaching academy runs its classes over WhatsApp. We do not sell personal data.`,
  alternates: { canonical: CANONICAL },
  // Explicit rather than inherited: a reviewer sometimes arrives via search, and
  // a `noindex` picked up from a future root-level default would be invisible here.
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#08090b' },
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
  ],
}

// ---------------------------------------------------------------------------

function Section({ id, n, title, children }: { id: string; n: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="flex items-baseline gap-3 text-lg font-medium tracking-tight text-ink">
        <span className="font-mono text-xs text-faint tabular-nums">{n}</span>
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-dim">
        {children}
      </div>
    </section>
  )
}

function Row({ what, why }: { what: string; why: string }) {
  return (
    <div className="grid gap-1 border-t border-line-soft py-3 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-6">
      <div className="text-ink">{what}</div>
      <div className="text-dim">{why}</div>
    </div>
  )
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-panel border border-accent/40 bg-accent-soft px-4 py-3 text-[0.9375rem] leading-relaxed text-ink">
      {children}
    </div>
  )
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-medium text-ink">{children}</strong>

const Mail = () => (
  <a className="text-accent underline underline-offset-2" href={`mailto:${OPERATOR.email}`}>
    {OPERATOR.email}
  </a>
)

export default function PrivacyPolicy() {
  return (
    <main className="min-h-dvh">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-16 sm:py-20">
        <header>
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-dim">
            {OPERATOR.service}
          </span>
          <h1 className="mt-5 text-3xl font-medium tracking-tight text-ink">Privacy Policy</h1>
          <p className="mt-3 font-mono text-[0.6875rem] text-faint">
            Effective {OPERATOR.effective} · Last updated {OPERATOR.updated}
          </p>
          <p className="mt-6 text-[0.9375rem] leading-relaxed text-dim">
            {OPERATOR.service} is a WhatsApp-based assistant that coaching academies, sports
            academies and tuition centres in {OPERATOR.jurisdiction} use to run their classes:
            booking and cancelling sessions, marking attendance, sending reminders, and keeping
            track of fees. There is no app to install and no account to create. Everything happens
            inside a WhatsApp conversation between an academy and the people it already teaches.
          </p>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
            This policy explains, in plain terms, what personal data passes through the service,
            why, who else can see it, how long it is kept, and how to get it deleted.
          </p>
        </header>

        <Callout>
          <B>The short version.</B> We do not sell, rent or trade personal data — to anyone, ever.
          We do not use it for advertising, we do not build advertising or marketing profiles, and
          we do not share it with data brokers. Phone numbers and messages are used for one thing:
          running the academy that you are already a client, parent or coach of. You can ask us to
          stop messaging you, or to delete your data, at any time — in the chat itself.
        </Callout>

        <Section id="who" n="1" title="Who is responsible for your data">
          <p>
            Two parties are involved, and the difference matters if you want something changed or
            deleted.
          </p>
          <p>
            <B>The academy</B> — the coaching business you or your child attends — decides what is
            collected and why. Under India&rsquo;s Digital Personal Data Protection Act, 2023, it is
            the <B>Data Fiduciary</B>. It owns the relationship with you.
          </p>
          <p>
            <B>{OPERATOR.entity}</B> operates the software the academy uses, and processes data on
            that academy&rsquo;s instructions and on its behalf — a <B>Data Processor</B>. We do not
            decide what an academy collects, and we do not use any academy&rsquo;s data for our own
            purposes.
          </p>
          <p>
            Requests can go to either of us. If you write to us about data belonging to an academy,
            we will act on it and tell the academy; if you write to the academy, it can act through
            the product directly.
          </p>
        </Section>

        <Section id="collect" n="2" title="What we collect">
          <p>
            All of it arrives one of two ways: WhatsApp passes it to us when you message the
            academy&rsquo;s number, or the academy enters it while running its business. We do not
            buy data, scrape it, or obtain it from third-party lists.
          </p>
          <div className="mt-2">
            <Row
              what="Your WhatsApp phone number"
              why="In international (E.164) format, plus the WhatsApp ID Meta assigns it. This is how a message reaches you, and it is the one identifier the service cannot work without."
            />
            <Row
              what="Your WhatsApp profile name"
              why="Supplied by WhatsApp with an incoming message. Used so the academy sees a name rather than a number."
            />
            <Row
              what="Messages in the conversation"
              why="What you send to the academy's number and what it sends back, including button taps and form (WhatsApp Flow) responses, with timestamps and delivery status."
            />
            <Row
              what="Name and role"
              why="Who you are to the academy — student, parent or guardian, coach, administrator — and which people are related to which."
            />
            <Row
              what="Class and attendance records"
              why="Enrolments, bookings, cancellations, and whether a student was present. This is the academy's own register."
            />
            <Row
              what="Fee and payment records"
              why="Amounts due and paid, the date, the method, a reference such as a UPI transaction ID (UTR), and — where somebody forwarded one — a payment screenshot."
            />
            <Row
              what="Notes the academy writes"
              why="Free-text notes and remembered facts about a student or family, such as a coach's observation or a standing preference. Written by the academy, visible to the academy."
            />
            <Row
              what="An activity log"
              why="A record of actions taken in the system and by whom, so a mistake can be traced and undone."
            />
          </div>
          <p className="mt-2">
            <B>We do not collect</B> your device location, your contact list, your photos or files
            beyond what you deliberately send into the chat, anything from other apps on your phone,
            or anything about your activity outside this conversation. There is no tracking pixel,
            no advertising SDK, and no third-party analytics or cookies on this website.
          </p>
          <p>
            <B>We never see or store payment credentials.</B> No card numbers, no CVV, no bank login,
            no UPI PIN. Payments happen in your own banking or UPI app; what reaches us is a record
            that one occurred.
          </p>

          {/*
            Meta's reviewers check one thing above all others: that the policy covers the data
            reached by each permission the app requests, by name. A policy that describes its data
            in the abstract is the commonest content rejection, so the mapping is stated outright
            rather than left to be inferred from the table above.
          */}
          <div className="mt-4 rounded-panel border border-line bg-surface p-5">
            <h3 className="text-base font-medium text-ink">
              The Meta permissions we use, and what each one touches
            </h3>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
              This service is built on the WhatsApp Business Platform (Cloud API). It requests two
              permissions and no others, and it reaches no Facebook or Instagram data of any kind.
            </p>
            <div className="mt-3">
              <Row
                what="whatsapp_business_messaging"
                why="Sends and receives messages on the academy's WhatsApp number. Through it we handle your phone number, your WhatsApp ID and profile name, the content of messages in both directions, button and form responses, and delivery/read status. This is the permission that carries every item in the table above marked as coming from WhatsApp."
              />
              <Row
                what="whatsapp_business_management"
                why="Manages the academy's own WhatsApp Business Account — registering the webhook and submitting and reading the pre-approved message templates. It touches business configuration, not personal data: no message content and no personal data of any recipient is accessed through it."
              />
            </div>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
              We do not use Facebook Login, and we hold no Facebook or Instagram profile, friend,
              page or advertising data. We do not request permissions for data we do not need.
            </p>
          </div>
        </Section>

        <Section id="why" n="3" title="Why we use it, and on what basis">
          <p>
            Every use below is necessary to provide the service the academy asked for and that you
            engaged with by messaging it. We do not use personal data for any purpose that is not on
            this list.
          </p>
          <div className="mt-2">
            <Row what="Delivering messages" why="Sending you the schedule, reminders, confirmations and answers you are there for, and receiving your replies." />
            <Row what="Running the register" why="Recording bookings, cancellations and attendance so the academy's records are correct." />
            <Row what="Fees" why="Telling you what is owed, recording what was paid, and issuing receipts." />
            <Row what="Answering questions" why="Understanding what you asked and replying to it — see §4, which explains the AI involved." />
            <Row what="Keeping the service working" why="Diagnosing failures, preventing abuse, and meeting Meta's WhatsApp Business rules." />
            <Row what="Legal obligations" why="Retaining financial records where the law requires it." />
          </div>
          <p className="mt-2">
            Under the DPDP Act, the lawful basis is your consent — given when you message the
            academy&rsquo;s number or agree to be added to its roster — together with the
            &ldquo;legitimate uses&rdquo; the Act allows for a service you have voluntarily
            approached. <B>Nothing is sent to anyone during setup.</B> An academy building its roster
            messages nobody until it explicitly chooses to begin.
          </p>
        </Section>

        <Section id="ai" n="4" title="The AI, stated plainly">
          <p>
            Replies are generated by a large language model rather than picked from a fixed script.
            That means the text of your conversation, and the academy records relevant to answering
            it, are sent to our model provider — <B>DeepSeek</B> (api.deepseek.com) — to produce a
            reply. This is the only place your message content goes other than WhatsApp itself and
            our own database.
          </p>
          <p>
            We send the minimum needed to answer the question in front of it. We do not use your
            conversations to train any model of our own, and we do not sell or license conversation
            data to anyone for training or any other purpose. Because this provider operates
            outside {OPERATOR.jurisdiction}, this involves a transfer of data abroad; the DPDP Act
            permits such transfers except to countries the Government restricts, and we will stop
            using any provider that becomes restricted.
          </p>
          <p>
            Two safeguards are worth stating because they limit what the AI can do to your data.
            Anything the model reads out of what you typed is <B>read back to you before it is acted
            on</B>, so a misunderstanding is corrected rather than committed. And access is enforced
            by the database, not by the model: each academy&rsquo;s data is isolated at the storage
            layer, so a conversation with one academy cannot reach another academy&rsquo;s records
            even if the model is asked to.
          </p>
        </Section>

        <Section id="sharing" n="5" title="Who else sees it">
          <p>
            <B>We do not sell your personal data. We have never sold it and the service has no
            business model that involves selling it.</B> We do not share it for advertising,
            marketing, profiling, credit scoring or resale. It is disclosed only to the following,
            each of which is necessary to run the product and bound to use the data only to provide
            its service to us.
          </p>
          <div className="mt-2">
            <Row what="Your academy" why="The coaching business you attend. Its administrators and the coaches assigned to your classes see the records concerning you. This is the point of the product." />
            <Row what="Meta Platforms" why="WhatsApp Business Cloud API — the messaging carrier. Every message is delivered through it, under WhatsApp's own privacy terms." />
            <Row what="Supabase" why="Managed PostgreSQL. Stores the database described in §2." />
            <Row what="Vercel" why="Application hosting. Runs the service in Mumbai (region bom1)." />
            <Row what="DeepSeek" why="The language model that generates replies. See §4." />
          </div>
          <p className="mt-2">
            We will also disclose data where a valid legal order requires it, or where it is
            necessary to establish or defend a legal claim — and no further than the request
            compels. If we are ever acquired or merged, personal data would transfer as part of that
            business, and this policy would continue to apply to it until you are told otherwise.
          </p>
        </Section>

        <Section id="messaging" n="6" title="How we message you, and how to make it stop">
          <p>
            You will only ever hear from an academy you have a real relationship with — as a client,
            a parent or guardian, or a member of its staff. We do not send marketing broadcasts to
            purchased lists, and the service is built to refuse a message the recipient would not
            have asked for.
          </p>
          <p>
            <B>To stop, just say so in the chat.</B> Plain words work — &ldquo;stop messaging
            me&rdquo; — and so does a narrower request such as &ldquo;stop messaging me about
            fees&rdquo;, which is honoured as written rather than treated as a full opt-out. An
            opt-out takes effect immediately and is enforced at the point of sending, so nothing
            further goes out. Blocking the number in WhatsApp also works and is stronger. If you opt
            out of everything, note the practical consequence: the academy will have to reach you
            about fees some other way.
          </p>
          <p>
            We follow Meta&rsquo;s WhatsApp Business Messaging Policy, including its rules on
            pre-approved templates and on the 24-hour window for freeform replies.
          </p>
        </Section>

        <Section id="children" n="7" title="Children">
          <p>
            Many students at a coaching academy are under 18. The service is not offered to children
            directly: a child does not sign up for it, and the account and the WhatsApp number
            belong to a <B>parent or guardian</B>, who is the person the academy communicates with
            and who provides consent on the child&rsquo;s behalf.
          </p>
          <p>
            Data held about a child is limited to what running their classes requires — name,
            enrolment, attendance, fees, and coaching notes. We do not track children, we do not
            advertise to them, and we do not profile them. A parent or guardian may see, correct or
            delete their child&rsquo;s data at any time by asking the academy or by writing to us.
          </p>
        </Section>

        <Section id="security" n="8" title="How it is protected">
          <p>
            Data is encrypted in transit (HTTPS/TLS) and encrypted at rest by our database host.
            Each academy&rsquo;s data is separated at the database level by row-level security
            policies, so one academy&rsquo;s records are unreachable from another&rsquo;s session by
            construction rather than by the application remembering to check. Every incoming
            WhatsApp request is cryptographically verified before it is processed, and the operator
            console is behind authentication. Access to production data is limited to people who
            need it to keep the service running.
          </p>
          <p>
            No system is perfectly secure. If a breach occurs that affects your personal data, we
            will notify the Data Protection Board of India and affected users as the DPDP Act
            requires.
          </p>
        </Section>

        <Section id="retention" n="9" title="How long it is kept">
          <div className="mt-1">
            <Row what="Messages and conversations" why="For as long as the academy uses the service, then deleted within 90 days of its account closing." />
            <Row what="Attendance and class records" why="Kept while you are enrolled, and for up to 3 years afterwards, so historical registers stay intact." />
            <Row what="Fee and payment records" why="Up to 8 years, which is what Indian financial record-keeping requires." />
            <Row what="Activity logs" why="Up to 12 months." />
            <Row what="Data of a person who opted out" why="Only the record that you opted out, so we can keep honouring it. Nothing further is added." />
          </div>
          <p className="mt-2">
            A deletion request under §10 overrides these periods, except where a law requires us to
            keep a specific record for longer.
          </p>
        </Section>

        <Section id="rights" n="10" title="Your rights, and how to delete your data">
          <p>Under the DPDP Act, 2023, you may:</p>
          <div className="mt-1">
            <Row what="Access" why="Ask what personal data we hold about you and who it has been shared with." />
            <Row what="Correction" why="Have anything inaccurate, incomplete or out of date corrected or completed." />
            <Row what="Erasure" why="Have your personal data deleted, unless a law requires us to keep it." />
            <Row what="Withdraw consent" why="Stop the processing at any time — with the same ease it was given." />
            <Row what="Nominate" why="Name someone to exercise these rights for you if you die or become incapacitated." />
            <Row what="Grievance redressal" why="Raise a complaint and get an answer, before escalating." />
          </div>
          <div id="data-deletion" className="mt-6 scroll-mt-8 rounded-panel border border-line bg-surface p-5">
            <h3 className="text-base font-medium text-ink">How to delete your data</h3>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
              Either of these works, and neither requires an account or a form:
            </p>
            <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-[0.9375rem] leading-relaxed text-dim marker:text-faint">
              <li>
                <B>In WhatsApp</B> — message the academy&rsquo;s number with{' '}
                <span className="font-mono text-[0.875rem] text-ink">DELETE MY DATA</span>, or ask
                for your data to be deleted in your own words. The request is recorded and raised
                with the academy, which holds the records.
              </li>
              <li>
                <B>By email</B> — write to <Mail /> from any address, telling us the WhatsApp number
                concerned and the name of the academy.
              </li>
            </ol>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
              We will verify that the request comes from you or your guardian, act on it within{' '}
              <B>30 days</B>, and confirm when it is done. Records that a law obliges us to retain —
              fee receipts, principally — are kept for the period in §9 and then deleted; we will
              tell you which ones those are. Deleting your data ends the service for you: the
              academy will no longer be able to message you through it.
            </p>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-dim">
              These instructions also stand on their own page:{' '}
              <a className="text-accent underline underline-offset-2" href={DELETION_URL}>
                {DELETION_URL}
              </a>
            </p>
          </div>
        </Section>

        <Section id="contact" n="11" title="Contact and grievances">
          <p>
            Write to <Mail /> for anything in this policy — a question, a request under §10, or a
            complaint. Complaints are handled by our Grievance Officer,{' '}
            <B>{OPERATOR.grievanceOfficer}</B>, at the same address. We aim to acknowledge within 72
            hours and resolve within 30 days.
          </p>
          <p>
            If you are not satisfied with our response, you may complain to the{' '}
            <B>Data Protection Board of India</B>. For matters that concern how your academy uses
            the service rather than how the software works, the academy is the first place to ask —
            see §1.
          </p>
        </Section>

        <Section id="changes" n="12" title="Changes to this policy">
          <p>
            If this policy changes, the date at the top changes with it, and the revised version is
            published at this same address. Where a change materially affects how your data is used,
            we will say so in the chat before it takes effect. Continuing to use the service after
            that means the updated policy applies.
          </p>
        </Section>

        <footer className="border-t border-line-soft pt-6">
          <p className="text-[0.8125rem] leading-relaxed text-faint">
            {OPERATOR.entity} · {OPERATOR.jurisdiction} · <Mail />
          </p>
          <p className="mt-2 font-mono text-[0.6875rem] text-faint">{CANONICAL}</p>
        </footer>
      </div>
    </main>
  )
}

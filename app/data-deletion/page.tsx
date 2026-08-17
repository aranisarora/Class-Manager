import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { DELETION_URL, OPERATOR, PRIVACY_URL } from '@/lib/legal'

/**
 * Data deletion instructions, as a page of their own.
 *
 * WHY THIS EXISTS WHEN `/privacy#data-deletion` ALREADY SAYS ALL OF IT. Meta's
 * App Dashboard takes a *Data Deletion Instructions URL* as a separate field from
 * the privacy policy URL, and requires one of it or a callback endpoint for any
 * app that reaches user data. A fragment URL is a poor answer to that field: the
 * reviewer's fetch drops the fragment, so what gets checked is the top of a long
 * policy rather than the instructions, and "instructions not found" is a
 * rejection nobody can see the cause of from this side.
 *
 * WHY NOT A CALLBACK ENDPOINT INSTEAD. The callback is for apps where Facebook
 * Login gives Meta a user id to hand back on deletion. There is no Facebook
 * Login here and no such id — the subject is a WhatsApp number belonging to a
 * parent — so an endpoint would have nothing to key on. Instructions are the
 * correct half of that either/or, not the lazy one.
 *
 * Public, static and outside `middleware.ts`'s matcher for the same reasons as
 * `app/privacy/page.tsx`; that file's header explains them.
 */

export const metadata: Metadata = {
  title: `Delete your data · ${OPERATOR.service}`,
  description: `How to have your personal data deleted from ${OPERATOR.service}, by WhatsApp message or by email. Acted on within 30 days.`,
  alternates: { canonical: DELETION_URL },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#08090b' },
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
  ],
}

const B = ({ children }: { children: ReactNode }) => (
  <strong className="font-medium text-ink">{children}</strong>
)

const Mail = () => (
  <a className="text-accent underline underline-offset-2" href={`mailto:${OPERATOR.email}`}>
    {OPERATOR.email}
  </a>
)

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs text-faint tabular-nums">{n}</span>
        <h2 className="text-base font-medium text-ink">{title}</h2>
      </div>
      <div className="mt-3 flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-dim">
        {children}
      </div>
    </div>
  )
}

export default function DataDeletion() {
  return (
    <main className="min-h-dvh">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-16 sm:py-20">
        <header>
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-dim">
            {OPERATOR.service}
          </span>
          <h1 className="mt-5 text-3xl font-medium tracking-tight text-ink">Delete your data</h1>
          <p className="mt-3 font-mono text-[0.6875rem] text-faint">
            Last updated {OPERATOR.updated}
          </p>
          <p className="mt-6 text-[0.9375rem] leading-relaxed text-dim">
            {OPERATOR.service} is a WhatsApp assistant that coaching academies in{' '}
            {OPERATOR.jurisdiction} use to run their classes. The personal data it holds about you
            is your WhatsApp number and profile name, your messages with the academy, and your
            class, attendance and fee records. You can have all of it deleted. There is no account
            to log into and no form to fill in — either route below is enough.
          </p>
        </header>

        <Step n="1" title="Ask in WhatsApp">
          <p>
            Message the academy&rsquo;s WhatsApp number — the same conversation you already use —
            with <span className="font-mono text-[0.875rem] text-ink">DELETE MY DATA</span>, or ask
            for your data to be deleted in your own words. The request is recorded and raised with
            the academy, which holds the records.
          </p>
        </Step>

        <Step n="2" title="Or email us">
          <p>
            Write to <Mail /> from any address. Tell us the <B>WhatsApp number</B> concerned and the{' '}
            <B>name of the academy</B>, so we can find the right records and confirm the request is
            yours.
          </p>
        </Step>

        <Step n="3" title="What happens next">
          <p>
            We verify the request comes from you or, for a student under 18, from a parent or
            guardian. We then delete your personal data — number, profile name, conversation
            history, notes, attendance and enrolment records — and confirm to you when it is done.
          </p>
          <p>
            This happens within <B>30 days</B> of a verified request, and usually much sooner.
          </p>
          <p>
            <B>One exception, stated plainly:</B> records that Indian law obliges us to keep — fee
            and payment receipts, principally — are retained for the statutory period and deleted at
            the end of it. We will tell you exactly which records those are. Nothing else is kept,
            and nothing retained is used to contact you.
          </p>
        </Step>

        <Step n="4" title="If you only want the messages to stop">
          <p>
            Deletion ends the service for you: the academy will no longer be able to reach you
            through it. If you would rather stay enrolled and simply not be messaged, say so in the
            chat — &ldquo;stop messaging me&rdquo; works, and so does a narrower request such as
            &ldquo;stop messaging me about fees&rdquo;, which is honoured as written. That takes
            effect immediately and does not delete your class records.
          </p>
        </Step>

        <footer className="border-t border-line-soft pt-6">
          <p className="text-[0.9375rem] leading-relaxed text-dim">
            The full detail — what is collected, who it is shared with, and how long each kind of
            record is kept — is in our{' '}
            <a className="text-accent underline underline-offset-2" href={PRIVACY_URL}>
              Privacy Policy
            </a>
            .
          </p>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-faint">
            {OPERATOR.entity} · {OPERATOR.jurisdiction} · <Mail />
          </p>
          <p className="mt-2 font-mono text-[0.6875rem] text-faint">{DELETION_URL}</p>
        </footer>
      </div>
    </main>
  )
}

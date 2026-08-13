'use client'

/**
 * **The way back.**
 *
 * §15 says "the chat is the navigation", and there was no navigation to it. The setup
 * form's submit button read *"Save and go back to the chat"* and its success state read
 * *"Back to the chat — the next thing is your timetable"*; neither was a link, and the
 * page had opened in a new tab (`target="_blank"` on the message's `cta_url` button).
 * So the product promised to take somebody somewhere and then physically could not,
 * which is the same class of failure as a button that cannot be tapped — a claim the
 * runtime cannot back (§2.4), made in the one place with no model in the loop.
 *
 * Every tap out of the chat was a one-way door, and a one-way door is a gate however
 * politely the footer denies it.
 *
 * `window.close()` works when the page was opened by the chat client — a new tab or an
 * in-app browser, which is every real path here — and silently does nothing otherwise,
 * so `history.back()` is the fallback and the sentence stays true either way.
 *
 * Its own module because `chrome.tsx` is a server component and this needs a handler.
 */
export function BackToChat({ label = 'Back to the chat' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        window.close()
        // Still here: the tab was not script-opened. Go back if there is anywhere to
        // go, and otherwise leave them be rather than navigating somewhere strange.
        if (window.history.length > 1) window.history.back()
      }}
      className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <span aria-hidden>←</span> {label}
    </button>
  )
}

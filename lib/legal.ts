/**
 * The facts the public legal pages state that no other file knows.
 *
 * WHY IT IS SHARED AND NOT DECLARED TWICE. `/privacy` and `/data-deletion` are
 * submitted to Meta as two separate URLs in App Dashboard → Settings → Basic, and
 * a reviewer opens both. If the contact address on one is stale the pages
 * contradict each other, which reads worse than either page being wrong on its
 * own. One constant, imported by both, makes that impossible.
 *
 * THIS IS THE ONLY FILE TO EDIT BEFORE SUBMITTING.
 */
export const OPERATOR = {
  /** The product name a parent sees. Keep it identical to the WhatsApp display name. */
  service: 'Class Manager',
  /** The legal entity or individual answerable for the data. */
  entity: 'Class Manager',
  /** Reachable, monitored, and the same address given to Meta. */
  email: 'aa5925@ic.ac.uk',
  /** Named contact for grievances — the DPDP Act expects a person, not a queue. */
  grievanceOfficer: 'Aranis Arora',
  jurisdiction: 'India',
  effective: '18 August 2026',
  updated: '18 August 2026',
} as const

/**
 * The origin these pages are served from. Hard-coded rather than read from
 * `APP_BASE_URL`: these are static pages by design (see `app/privacy/page.tsx`),
 * and a canonical tag that changes with an environment variable is one bad
 * preview deploy away from pointing Meta at a URL that will not exist tomorrow.
 */
export const SITE = 'https://class-manager-gilt.vercel.app'

export const PRIVACY_URL = `${SITE}/privacy`
export const DELETION_URL = `${SITE}/data-deletion`

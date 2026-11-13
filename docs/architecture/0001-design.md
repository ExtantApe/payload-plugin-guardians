# 0001: Guardians design record

Status: **built** (2026-11-10), 0.1.0. The security read's fixes are in docs/decisions.md; `suggestionsBy` became the requests collection's own read access.

**Gate:** nothing here goes live on a production site until a legal review of minors, guardian consent and the age gate.

## Context

The owner decided how minors and guardians work on the first site on 2026-11-10. Guardians is its own plugin, agnostic, so it works on any Payload site. Settled decisions this plugin must keep:

- **The kid always decides.** A guardian's suggestion never applies itself, not even for a vet visit, medication or a death. It's still saved with its real time, so nothing is lost while it waits.
- **Declined suggestions** are kept forever. The kid can reopen one at any time, and it goes back on the to-approve list. There's no expiry, and a pending count keeps them from being forgotten.
- **Approving** applies the change with its original time. It warns the kid when they've changed the same thing since.
- **Two guardians per minor, five kids per guardian.** A manager can raise the five for one guardian.
- **Settings stay the guardian's to change directly.** Only the kid's records (animals, care logs, weights) become suggestions.
- **The kid's bigger actions** (purchases, joining a project, anything public): the kid is told first, then the request goes to a guardian to approve.
- **Adulthood** ends the link on its own, the kid is told, access stops at once, and the history stays.
- **A guardian can do anything the kid can,** and every action is recorded as the guardian's, with `via` set to guardian.

Name approved 2026-11-10: **Guardians**, `@extantape/payload-plugin-guardians`. MIT. Agnostic: no imports of our other plugins. Age Gate, Hats, Notifications and Audit Trail plug in through adapters.

## Decision

Guardians owns:
- **the link** between a guardian's account and a minor's;
- **the check** of who may act for whom;
- **turning a guardian's writes** to the minor's records into suggestions;
- **requests in both directions,** and their decisions.

The site owns its pages and decides which collections hold the minor's records. The age gate decides who is a minor.

## 1. Who is a minor (adapter)

`isMinor(user, { now })` is required. On the first site it reads Age Gate's `minorUntil`. It fails closed: if it throws, the account counts as a minor for refusals (it can't be a guardian), and as not linkable for new links.

## 2. Guardianships

Collection `guardianships`:
- guardian, minor;
- status: `active` or `ended`;
- started;
- ended, with the reason: `came-of-age`, `removed-by-guardian`, `removed-by-minor`, `removed-by-staff` or `account-deleted`;
- who did each step.

Ended links are kept, never deleted.

- **Making a link, without looking anyone up.**
  - One side creates a link code in their own account. It's single-use, lasts 7 days, and only its hash is stored. They hand it over in person.
  - The other side enters it while signed in.
  - The link is active as soon as both have acted.
  - There's no search by email or name, so nobody can find out whether an address belongs to a minor.
  - Codes are rate-limited per account.
- **Rules, checked inside the transaction that makes the link:**
  - the guardian isn't a minor;
  - the minor is a minor;
  - they aren't the same account;
  - they aren't already linked;
  - the minor has fewer than 2 active guardians;
  - the guardian has fewer than their limit (5, or what a manager set).
  - The counts are kept race-safe by recording first and then counting, as MFA's limiter does: under a race, one is refused rather than both let in.
- **Ending:** either side can end it, and so can a manager. `endComeOfAge(payload)` runs daily and ends every link whose minor is no longer a minor, and `canActAs` also checks at each use, so access stops at once even before the daily run.

## 3. `canActAs(payload, { actor, target, req })`

- Returns `{ allowed: true, via: 'self' | 'guardian' }` or `{ allowed: false }`.
- `self` when actor is target.
- `guardian` when an active guardianship links them and the target is still a minor.
- Anything else, or any error: not allowed.
- Hats links (one person's own accounts) are the site's own check. The site combines both in its access rules.

## 4. Suggestions: guardian writes to the minor's records

The site lists the collections that hold a minor's records:

```ts
guardiansPlugin({
  records: [
    { collection: 'animals', ownerField: 'keeper' },
    { collection: 'weights', ownerField: 'keeper', timeField: 'weighedAt' },
    { collection: 'care-logs', ownerField: 'keeper', timeField: 'at' },
  ],
  actingFor: (req) => ({ actor, target }) | null,   // how the site knows a guardian is acting for this kid (Hats or its own switcher)
})
```

- **A direct write is refused.** On those collections, a create, update or delete by a guardian on a record owned by a linked minor is refused with the code `suggestionRequired`. That covers acting through the switcher, and the guardian's own account writing to the kid's records. Nothing is applied, so the kid always decides, whatever path the write takes. A test proves it for each operation.
- **`suggest(payload, { actor, minor, collection, operation, id?, data, req })`** stores a suggestion:
  - direction `to-minor`;
  - the data as given;
  - the record's `updatedAt` at the time, for the conflict warning;
  - the real time it was suggested, which also fills `timeField` on approval;
  - status `pending`.
- **The kid decides:**
  - `approve` applies the change as the kid, through the Local API with the kid's own access, so it can't do more than the kid could. Hooks and validation run. The original time goes into `timeField`.
    - If the record changed since the suggestion was made, approving needs `{ replace: true }`. The site shows "This replaces what you entered".
    - If the record was deleted since, approving fails with `gone`, and the suggestion stays pending until the kid declines it.
  - `decline` moves it to `declined`, kept forever.
  - `reopen` puts a declined suggestion back to `pending`.
  - Only the minor can approve, decline or reopen. A guardian can withdraw their own pending suggestion. Every step is recorded.
- **Counts:** `pendingCount(payload, minor)` for the kid's badge; `suggestionsBy(payload, guardian)` for the guardian's status list.

## 5. Requests from the minor to a guardian

For actions outside the kid's records, the site registers kinds:

```ts
approvals: {
  'join-project': {
    label: 'Join a project',
    apply: async ({ request, minor, req }) => { /* do it, as the minor, inside the transaction */ },
    expiresDays: 30,          // optional; animal suggestions never expire
  },
}
```

- **`requestApproval(payload, { minor, kind, summary, ref, req })`** records a `to-guardian` request. The kid is shown first that it will go to their guardian, before the site calls this. Every active guardian is notified, and the first decision wins (a conditional write on `pending`).
- **On approval** the kind's `apply` runs in the same transaction, so a failed `apply` leaves the request pending. **On decline** nothing happens, and the kid is told.
- **Purchases** are a kind, with the guardian paying. Paying is the site's own code, not this plugin.

## 6. Notices and audit (adapters)

- **Notifications:** when `config.custom.notifications.notify` exists, the plugin registers its kinds (`guardian-suggestion`, `suggestion-decided`, `approval-requested`, `approval-decided`, `link-made`, `link-ended`, `came-of-age`) and sends through it. Without Notifications it calls the site's optional `onNotice`. Params carry first names or display names only, never ages or dates of birth.
- **Audit:** `onEvent({ type, actor, target, via, ref })` for every link, suggestion and decision. The site passes it to Audit Trail. Events never carry the suggested data, only references.

## 7. Access

- `guardianships` and `guardian-requests` can be read only by the two sides and by managers (`access.manage`, required).
- Nobody writes them through the API: every change goes through the plugin's functions, which check the person.
- Suggested data (`data`) is readable only by the minor, the guardian who made it, and managers.

## Collections

- `guardianships`: as in section 2.
- `guardian-codes`: hash, creator, intended role (`guardian` or `minor`), expires and used. Hidden. Deleted when used, or 7 days after expiry.
- `guardian-requests`:
  - direction, kind, minor, guardian (for to-minor), status (`pending`, `approved`, `declined`, `withdrawn`, `expired`);
  - collection, operation, record id, data, base updatedAt;
  - suggestedAt, decidedAt, decidedBy, summary.

The first site that uses it has none of these collections today.

## Tests (planned)

- **Links:**
  - a code made and used;
  - expired, reused and wrong codes, with the same answer for each;
  - every rule refuses: minor as guardian, adult as minor, self, duplicate, a third guardian, a sixth kid, and a raised limit;
  - a race for the last slot gives one link, not two;
  - ending by each side and by staff;
  - came of age, both in the daily run and at use.
- **canActAs:** every case, including an error giving not allowed, and an ended link.
- **Suggestions (the kid always decides):**
  - every operation on every listed collection is refused when written directly by a guardian, whether through the switcher or the guardian's own account, with nothing changed;
  - suggest, approve (the original time is applied, the kid's own access is used), the conflict needs `replace`, a deleted record gives `gone`, decline, reopen, approve again, withdraw;
  - only the minor decides.
- **Requests:**
  - the first decision wins under a race;
  - `apply` runs once, and a failing `apply` leaves the request pending;
  - expiry;
  - notices are sent to every guardian.
- **Access:** each collection for the minor, the guardian, another guardian, another member and a manager; API writes refused.
- **Logs and events** carry references, never the suggested data or ages.

## The site switch (the first site)

- One change in the site's own repo, reviewed by this plugin's lead:
  - Age Gate's `minorUntil` as `isMinor`;
  - Hats' acting context as `actingFor`;
  - the records list;
  - the approval kinds (join project, public backer, purchases);
  - the pages (My kids, the kid's Pending and Declined, the guardian's status list).
- The site's own minor rules (member only, no projects, no public backing, the name rules) stay in the site.

## Open

- **Second-account signals for staff** (the same email domain or device as a linked minor, birth years that don't agree): the site's own data, so a site task, not the plugin's. If the site wants it, the plugin's `onEvent` gives the link events to hang it on.
- **A toggle for a guardian who also keeps animals themselves** is a site preference.

## Rough time

These are guesses of session days, not promises: links and codes with the limits, 1.5; canActAs and the write refusal on listed collections, 1; suggestions with approve, conflicts and reopen, 1.5; requests with kinds and the first decision wins, 1; adapters for notices and events, 0.5; tests, a security read and docs, 1.5. About 7 in all, close to the first estimate of 8 for guardians as a whole.

# payload-plugin-guardians

Guardians for Payload: link a minor's account to up to two guardians, turn a guardian's changes to the minor's records into suggestions the minor decides, and route the minor's bigger requests to a guardian.

**Status:** 0.1.0 is on npm (2026-11-14). 46 tests pass against Payload 3.92 with an in-memory MongoDB replica set. They cover links and every refusal, a race for the last place, canActAs, guardian writes refused on every path, suggestions from start to finish, requests with the first decision winning, coming of age, deleted accounts, races between two decisions, access and events. Not tested: GraphQL, a real role switcher (the tests stand in for one with a header), and uploads on a listed collection. No site uses it yet, and none will turn it on before a legal review of minors and guardian consent.

## What it does

- **Links, by a code handed over in person.**
  - Either side makes a code in their own account (`createLinkCode`): 12 characters, single use, 7 days. The other side enters it, signed in (`useLinkCode`), and the link is active.
  - Nobody searches for an account by email or name, so nobody can learn whether an address belongs to a minor. A wrong, used or expired code gets the same answer.
  - Rules: a guardian is an adult and a minor is a minor, both known for certain (if `isMinor` can't tell, there's no link). You can't link to yourself, or link twice, even with two codes at once. A minor has at most 2 active guardians. A guardian has at most 5 kids, unless a manager raises it with `setKidLimit` (never below the default).
  - The limits hold under a race: the link is written, then counted in a fixed order, and one past the limit is removed at once.
  - **Who becomes a guardian:** any adult a minor gives their code to, or any adult whose code a minor enters. Handing it over "in person" is your site's advice, not something the plugin can check. So every new link is announced to both sides and to the minor's existing guardians, who can end a link they don't recognise.
  - Either side ends a link, and so can a manager (`endLink` with `asStaff`, checked against `access.manage`). Ended links are kept, with who ended them and why. Deleting an account ends its links (`account-deleted`), so a deleted guardian stops holding one of the minor's places. The ex-guardian's pending suggestions are withdrawn, and they stop reading the kid's requests to a guardian, including ones they decided. They can still read their own past suggestions to the kid.
- **Coming of age.** `isMinor` (yours, for example from Age Gate's `minorUntil`) is checked at every use, so access stops the moment someone is an adult. `endComeOfAge(payload)`, daily, ends the links and tells both sides. History stays.
- **`canActAs(payload, { actor, target })`:** `self`, `guardian` (an active link, the actor known to be an adult, and the target known to be a minor), or no. Any error, or an age that can't be told, is no. Use it in your access rules. Hats links, one person's own accounts, are your own check.
- **The kid always decides.** List the collections that hold a minor's records, with their owner field:
  - **A linked guardian's direct write is refused** (`suggestionRequired`), whether they switched into the kid's account or wrote from their own. That covers creates, updates and deletes, bulk ones included.
    - It's checked first and last in `beforeChange`, so a site hook that fills in the owner can't slip past. It's checked once more after the write, inside its transaction, which also catches a hook on another field.
    - **Bulk updates** (by `where`) on these collections are refused for anyone who is an active guardian, and for anyone the plugin can't check. Payload doesn't roll back one document of a bulk update, so they can't be checked safely. Guardians change records one at a time.
    - An owner field with its own `beforeChange` hook stops the site at start-up, because field hooks run after the last check.
    - Site code that writes with `disableTransaction: true` gets past the after-write check, though not the `beforeChange` ones.
    - If the plugin can't tell who is writing, or can't read the owner, it refuses.
    - Your own jobs, with nobody signed in, aren't stopped.
  - **`actingFor` is required.** If your site lets one account act as another (a switcher, or anything that changes `req.user` to the kid), it must say who is really acting, or a guardian acting as the kid would look like the kid. Return null when nobody is acting for anyone.
  - **Owner fields** must be a single relationship to your users collection, or a text id. Anything else stops the site at start-up.
  - **`suggest`** stores the change instead, with the real time. Nothing changes until the minor acts. The change can be up to 64 KB as JSON; a bigger one is refused (`tooLarge`).
  - **`approveSuggestion`** applies it as the minor, with the minor's own access, in one transaction. For a new record, the time it was suggested goes into your `timeField`, for example when the animal was fed. An edit keeps the record's own time.
    - If the minor changed the record since, approving needs `replace: true`. Show "This replaces what you entered".
    - If the record was deleted since, it says `gone`.
  - **`declineSuggestion`** keeps it for good, and `reopenSuggestion` puts it back on the list. Suggestions never expire.
  - The guardian who made a suggestion can withdraw it while it's pending. `pendingCount` gives the kid's badge.
- **Requests from the minor to a guardian.** You define the kinds (joining a project, a purchase), each with an `apply` and an optional expiry.
  - `requestApproval` tells every active guardian, and each of them can read it. Tell the kid it goes to their guardian before calling it.
  - `decideApproval`: the first decision wins, and the other gets `notPending` (409), even when both arrive at once. If a decision fails on a write conflict about something else, and the request is still pending, the answer is `busy` (409): That didn’t go through. Please try again. Approving runs `apply` as the minor, in the same transaction, so a failed `apply` leaves the request pending. An expired request is marked expired and can't be approved.
- **Notices** go through the Notifications plugin when it's installed (the plugin registers its kinds itself, with no import), else your `onNotice`. They carry no names or ages.
- **Events** (`onEvent`) for every link, suggestion and decision, with references only: never the suggested data or ages. For your audit trail's `via`, `viaGuardian(req)` gives `{ kind: 'guardian', id }` when a guardian acts for a minor.
- **Access:**
  - Links and requests are read by their two sides and by managers (`access.manage`, required; only an answer of exactly `true` counts). For a request to a guardian, the guardian side is whoever is linked now. Who decided a request (`decidedBy`) is read by managers only.
  - If `access.manage` throws, the read is refused.
  - Codes are read by nobody.
  - Nobody writes any of them through the API.

## On its own, and with others

**On its own:** it needs a users collection, MongoDB with transactions, and three things from you: `isMinor`, `access.manage` and `actingFor`. Without Notifications, notices go to your `onNotice`. It doesn't depend on any other plugin.

**Works with:**
- **Age Gate:** `isMinor` can read Age Gate's `minorUntil`, as the Install example does.
- **Hats:** Hats, or your own switcher, answers `actingFor`, so a guardian who switched into a kid's account is still seen as the guardian.
- **Notifications:** when it's installed, Guardians registers its kinds through `config.custom.notificationKinds` and sends through `config.custom.notifications.notify`.
- **Audit Trail:** pass `onEvent` through Audit Trail's `fromPluginEvent`, and use `viaGuardian(req)` in its `via`.

**Family:** It's part of the **Identity** family (a working draft): plugins designed to sit together for accounts and access.

## Install

```sh
npm install @extantape/payload-plugin-guardians
```

```ts
import { guardiansPlugin, viaGuardian } from '@extantape/payload-plugin-guardians'

guardiansPlugin({
  isMinor: (user) => typeof user.minorUntil === 'string' && user.minorUntil > new Date().toISOString().slice(0, 7), // required
  access: { manage: ({ req }) => req.user?.role === 'admin' }, // required
  actingFor: (req) => mySwitcher(req), // { actor, target } while someone acts for another account
  records: [
    { collection: 'animals', ownerField: 'keeper' },
    { collection: 'weights', ownerField: 'keeper', timeField: 'weighedAt' },
  ],
  approvals: {
    'join-project': { label: 'Join a project', expiresDays: 30, apply: async ({ request, minor, req, payload }) => { /* join, as the minor */ } },
  },
  onEvent: (e) => recordInMyAuditTrail(e),
})
```

Build the collections' indexes before first use. Run `endComeOfAge` and `pruneLinkCodes` daily.

## Limits

- A code is used up even if the link is then refused, for example because the limit was reached. Make a new one.
- Your pages decide what a guardian sees of the kid's account. The plugin stops their writes to the listed records and answers `canActAs`. It doesn't hide anything else.
- Second-account signals (the same email domain or device as a linked minor) are your own site's job.
- MongoDB with transactions (a replica set). Without transactions, approving and deciding refuse rather than half-apply.
- If your `onEvent` throws during an approval, the approval rolls back: the audit record and the change go together.
- A failing `onEvent` also stops a user deleting their own account. The delete rolls back, the links stay as they were, and REST answers 500.

## Commands

```sh
npm test          # integration tests, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).

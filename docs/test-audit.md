# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-10: 0.1.0

| Promise | Test |
| --- | --- |
| A link by code from either side; used once; the same answer for wrong, used and expired codes; one's own code refused | `links` (2) |
| A minor can't be a guardian, an adult can't be the minor, no duplicates, 2 guardians, 5 kids, a manager's raised limit | `links` (2) |
| One person per code, and one link per last place, even at the same moment | `links` (2) |
| Ending by either side or staff, kept; coming of age stops access at once and in the daily run | `links > ends…` |
| canActAs: self, guardian, no, and no on any error | `canActAs` |
| viaGuardian for an audit trail | `canActAs > tells an audit trail…` |
| The kid always decides: every direct write by a linked guardian refused (create, update, delete; switched in or not); refused when the writer or the link can't be checked | `the kid always decides` (3) |
| Suggestions: approve (the minor's own access, the suggested time), create and delete, conflict needs replace, gone, decline, reopen, withdraw, no expiry, only the minor decides, only a guardian suggests | `the kid always decides` (5) |
| Requests: every guardian told, the first decision wins, a failed apply leaves it pending, strangers refused, expiry, no guardian, unknown kind | `requests` (2) |
| Access: two sides and staff only, no API writes, codes unreadable | `access` |
| Events carry references only | `access > records events…` |

Mutation check: 16 guards, all caught, three of them only after the tests above were added: a link lookup that fails, one code used at once, and the minor's own access on approval. Dropping the `usedAt` check in the code lookup alone isn't caught, because the conditional claim catches the same reuse. It's kept as a second layer.

Gaps skipped: Hats' real switcher (the site's), and the notices' delivery (Notifications' own tests).

## 2026-11-10: after the security read of b602123

Ten tests added in `what the security read found`:
- a later hook filling in the owner;
- the owner-field type and `actingFor` refused at start-up;
- an age that can't be told;
- the other guardians notified;
- the same pair twice at once;
- staff checks and `setKidLimit`;
- withdrawn suggestions;
- guardians reading requests sent to them, and `apply` running as the minor;
- the time field on edits, and expiry kept;
- the six mutations the read found surviving (another sign-in collection, a moved record, a self-suggestion).

The mutation check catches all 16 fix-related guards.

## 2026-11-10: after the second read (8934e56)

- A bulk update whose owner a later hook sets is refused with nothing saved; the guard now also runs last in `beforeChange`. Removing that last guard fails the new test.
- An owner field with its own `beforeChange` hook is refused at start-up (tested, and mutation-checked).
- An ex-guardian no longer reads the kid's requests (tested).

## 2026-11-10: after the third read (3ba8a9d)

- A bulk update by an active guardian on a listed collection is refused before anything runs, closing the last path (a hook on another field moving the owner). A single update with that hook is caught after the write and rolled back. A non-guardian's bulk update still works. If the check can't tell, it refuses. All three tested; removing the guard or its fallback fails a test.

## 2026-11-13: after the final security read (cddb859)

44 tests. Added in `the final security read`:
- a throwing `access.manage`: REST GET of guardianships gives 403, `endLink` with `asStaff` and `setKidLimit` refuse;
- `decideApproval` refused after the kid comes of age, while the guardian's age is unknown, and for the kid themself;
- an ex-guardian can't read a request they decided, still reads their own suggestions, and `decidedBy` is for managers only;
- two decisions at once: the loser gets `notPending` with a 409 (decideApproval and approveSuggestion, four rounds each), and `lostRace` knows the code and the label;
- the six guards the last mutation check left uncaught: an owner value the guard can't read, a known adult actor in `canActAs`, an `isMinor` answer that isn't a boolean, the `kidLimit` read needing exactly true, the conditional move with a stale read, the expiry check inside the transaction;
- a deleted account's links end with `account-deleted`, freeing the minor's place;
- suggested data over 64 KB, or not JSON, is refused.

Mutation check, in a throwaway copy: 24 mutants of the new guards, all caught. Five survived the first run (the `via` check in `decideApproval`, each half of `lostRace`, the 409 after a lost move) and one didn't apply; the tests above were then added and all six are caught.

Gaps skipped: GraphQL (same access functions as REST), a real role switcher, uploads on a listed collection, a real localized owner field (the hook is called directly), and deletes through REST or the admin panel.


## 2026-11-13: follow-ups from the approval of 03ec633

46 tests. Added:
- a write conflict inside `apply` that has nothing to do with another decision answers `busy` (409), the request stays pending, and a retry approves it; the race test still gives `notPending` to the loser;
- when `onEvent` throws during a user delete, the account is kept, the link stays active, the suggestion stays pending and the request's audience is unchanged.

Mutation check, in a throwaway copy: 6 of 6 caught (busy never given, busy always given, and each of the four places the delete's `req` is passed on).

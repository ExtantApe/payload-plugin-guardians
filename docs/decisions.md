# Decisions

Dated decisions for this repo, newest last.

- 2026-11-10: created from the standard repo starter kit.

- 2026-11-10: name approved by the owner on 2026-11-10. MIT, public from its first push after the audit. Design in [architecture/0001-design.md](architecture/0001-design.md), taken from the owner's decisions on minors and guardians, including the rule that the kid always decides. Nothing goes live on a production site before a legal review of minors and guardian consent.
- 2026-11-10: links are made with a single-use code handed over in person, never by searching for an account by email or name, so nobody can learn whether an address belongs to a minor.
- 2026-11-10: a guardian's direct write to a minor's listed records is refused (`suggestionRequired`), whatever path it takes; changes go through `suggest`. That enforces the kid always decides in code as well as in the site's pages.

- 2026-11-10 (security read of b602123, an automated review against the plugin security checklist): three blockers fixed. The guard runs again after the write against the record as saved; owner fields must be a single users relationship or text; and an age `isMinor` can't tell is never treated as a known minor or adult. Also: `actingFor` is required, new links are announced to the minor's other guardians, staff ending is checked against `access.manage`, ex-guardians' suggestions are withdrawn, the time field fills new records only, `apply` runs as the minor, decisions need transactions, guardians can read requests sent to them, and `setKidLimit` replaces editing `kidLimit` directly.

- 2026-11-10 (third security read): an active guardian can't bulk-update a minor's listed collections at all. Hooks the plugin can't see could move a record to the kid after the last check, and Payload doesn't roll back one document of a bulk update. Changing records one at a time keeps every change checkable.

- 2026-11-13 (final security read of cddb859): no code blocker. Fixed: a throwing `access.manage` refuses instead of failing with a 500; `decideApproval` checks `canActAs`, so a guardian can't decide after the kid comes of age or while the guardian's age is unknown; deciding a request no longer makes the decider one of its readers, and `decidedBy` is for managers only; two decisions at once give the loser `notPending` (409), never a database error; deleting an account ends its links with `account-deleted`; suggested data is capped at 64 KB. Tracked text names the rules in plain words, with no ops IDs, private paths or private product names.

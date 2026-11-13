# Changelog

## 0.1.0 (unreleased)

First version, from the owner's decisions on minors and guardians, where the kid always decides:
- links by a code handed over in person, with the limits held under a race;
- `canActAs`;
- a guardian's direct writes to a minor's listed records refused, and changes made as suggestions the minor approves, declines or reopens, applied with the minor's own access and the time they were suggested;
- requests from the minor to a guardian, with the first decision winning;
- coming of age;
- notices through Notifications, and events, with no names or ages;
- `viaGuardian` for an audit trail;
- links end when either account is deleted, inside the delete's transaction, and suggested data is capped at 64 KB;
- a decision that fails on an unrelated write conflict answers `busy`, so it can be tried again.

Tested: 46 integration tests on a real MongoDB in memory, with a mutation check on the guards after each security read. Not tested: a real site, GraphQL, a real role switcher such as Hats', uploads on a listed collection, and a legal review (needed before any site turns it on).

export { guardiansPlugin } from './plugin.js'
export { activeLink, canActAs, APPLYING } from './act.js'
export { createLinkCode, endComeOfAge, endLink, pruneLinkCodes, setKidLimit, useLinkCode } from './links.js'
export { approveSuggestion, decideApproval, declineSuggestion, pendingCount, reopenSuggestion, requestApproval, suggest, withdrawSuggestion } from './requests.js'
export { GuardianError } from './util.js'
export type { ApprovalKind, GuardianEvent, GuardiansOptions, RecordCollection, User } from './types.js'

/** For an audit trail's `via`: how this change was made, when a guardian is acting for a minor. */
export { viaGuardian } from './via.js'

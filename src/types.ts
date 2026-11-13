import type { Access, Payload, PayloadRequest } from 'payload'

export type ID = string | number
export type Req = Partial<PayloadRequest>
export type User = { id: ID; collection?: string } & Record<string, unknown>

/** A collection that holds a minor's own records: a guardian's writes to them become suggestions the minor decides. */
export type RecordCollection = {
  collection: string
  /** The field naming the record's owner (a relationship to users, or the user's id as text). */
  ownerField: string
  /** A date field to fill with the time the suggestion was made, when it's approved (a weighing's time, say). */
  timeField?: string
}

export type ApprovalKind = {
  label: string
  /** Runs on approval, inside the same transaction, as the minor. Throwing leaves the request pending. */
  apply: (args: { request: Record<string, unknown>; minor: User; guardian: User; req: PayloadRequest; payload: Payload }) => void | Promise<void>
  /** Days before a pending request expires. Default: never. */
  expiresDays?: number
}

export type GuardianEvent = {
  type:
    | 'link-made'
    | 'link-ended'
    | 'came-of-age'
    | 'suggested'
    | 'suggestion-approved'
    | 'suggestion-declined'
    | 'suggestion-reopened'
    | 'suggestion-withdrawn'
    | 'approval-requested'
    | 'approval-approved'
    | 'approval-declined'
  actor: string | null
  target: string
  via: 'self' | 'guardian' | 'staff' | 'system'
  /** References only: a guardianship or request id, a collection and record id. Never the suggested data or ages. */
  ref?: Record<string, string>
  req?: Req
}

export type GuardiansOptions = {
  /** Who is a minor now. Required. Throwing counts as a minor for refusals and as not linkable. */
  isMinor: (user: User, ctx: { now: Date }) => boolean | Promise<boolean>
  /** Who sees every link and request, and ends links as staff. Required; only an answer of exactly true counts. */
  access: { manage: Access }
  /** Who is acting for whom on this request: the site's switcher (Hats, or its own). Null when acting as themselves. */
  actingFor: (req: Req) => { actor: ID; target: ID } | null | Promise<{ actor: ID; target: ID } | null>
  /** Collections holding a minor's own records. */
  records?: RecordCollection[]
  /** Kinds of request a minor sends to a guardian. */
  approvals?: Record<string, ApprovalKind>
  users?: string
  /** Most active guardians per minor. Default 2. */
  maxGuardians?: number
  /** Most kids per guardian, unless a manager raised it for one guardian. Default 5. */
  maxKids?: number
  /** Hours a link code works. Default 168 (7 days). */
  codeHours?: number
  /** Link codes a person may make per day. Default 10. */
  codesPerDay?: number
  onEvent?: (event: GuardianEvent) => void | Promise<void>
  /** A notice for a person, when the Notifications plugin isn't installed. */
  onNotice?: (args: { to: ID; kind: string; params: Record<string, string>; link?: string; req?: Req }) => void | Promise<void>
  slugs?: { guardianships?: string; codes?: string; requests?: string }
  adminGroup?: string
}

export type Resolved = {
  users: string
  guardianships: string
  codes: string
  requests: string
  isMinor: GuardiansOptions['isMinor']
  manage: Access
  actingFor: GuardiansOptions['actingFor']
  records: RecordCollection[]
  approvals: Record<string, ApprovalKind>
  maxGuardians: number
  maxKids: number
  codeHours: number
  codesPerDay: number
  onEvent?: GuardiansOptions['onEvent']
  onNotice?: GuardiansOptions['onNotice']
  adminGroup: string
}

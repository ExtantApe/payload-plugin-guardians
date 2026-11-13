import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { activeLink, APPLYING, canActAs } from './act.js'
import type { ID, Req, User } from './types.js'
import { asReq, configOf, DAY, emit, GuardianError, idOf, loadUser, minorNow, notice, same, sys, transaction } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
/** The most a suggestion's data may be, as JSON: 64 KB. */
export const MAX_DATA_BYTES = 64 * 1024
const NOT_FOUND = () => new GuardianError('notFound', 'That request wasn’t found.', 404)

async function load(payload: Payload, id: ID, req?: Req): Promise<Doc | null> {
  const o = configOf(payload)
  return (await payload.findByID({ collection: o.requests as CollectionSlug, id, ...sys, disableErrors: true, ...(req?.transactionID ? { req: req as never } : {}) })) as Doc | null
}

/**
 * Is the request still pending, read after a rolled-back transaction? A decision that won the race may not have
 * committed yet, so it looks a few times, about 200 ms in all, before saying it's still pending.
 */
const stillPending = (payload: Payload, id: ID) => async () => {
  for (let i = 0; i < 4; i++) {
    if ((await load(payload, id))?.status !== 'pending') return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

/** Moves a request from one status to another only if it's still in the first: the first decision wins. */
async function move(payload: Payload, id: ID, from: string, data: Doc, req?: Req): Promise<boolean> {
  const o = configOf(payload)
  const done = await payload.db.updateOne({ collection: o.requests, where: { and: [{ id: { equals: id } }, { status: { equals: from } }] } as Where, data, ...(req?.transactionID ? { req } : {}) } as never)
  return Boolean(done)
}

// ---------------------------------------------------------------------------------------------
// Suggestions: guardian to minor (the kid always decides)

/**
 * A guardian suggests a change to their linked minor's record. Nothing changes until the minor approves. The data
 * and the real time are kept, so approving later applies it as it was meant.
 */
export async function suggest(payload: Payload, args: { guardian: User; minor: ID; collection: string; operation: 'create' | 'update' | 'delete'; id?: ID; data?: Record<string, unknown>; summary?: string; req?: Req }): Promise<{ request: ID }> {
  const o = configOf(payload)
  const list = o.records.find((r) => r.collection === args.collection)
  if (!list) throw new GuardianError('notARecord', 'That isn’t something a guardian can suggest changes to.')
  if (!['create', 'update', 'delete'].includes(args.operation)) throw new GuardianError('badOperation', 'Suggest a create, an update or a delete.')
  const act = await canActAs(payload, { actor: args.guardian.id, target: args.minor, req: args.req })
  if (!act.allowed || act.via !== 'guardian') throw new GuardianError('notGuardian', 'You aren’t this account’s guardian.', 403)
  const data = args.data ?? {}
  if (typeof data !== 'object' || Array.isArray(data)) throw new GuardianError('badData', 'The change must be an object of fields.')
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(data), 'utf8')
  } catch {
    throw new GuardianError('badData', 'The change must be plain fields that can be saved.')
  }
  if (size > MAX_DATA_BYTES) throw new GuardianError('tooLarge', 'That change is too big to suggest. Keep it under 64 KB, or split it into smaller changes.', 413)
  let base: string | null = null
  if (args.operation !== 'create') {
    if (args.id === undefined) throw new GuardianError('notFound', 'That record wasn’t found.', 404)
    const doc = (await payload.findByID({ collection: args.collection as CollectionSlug, id: args.id, ...sys, disableErrors: true })) as Doc | null
    if (!doc || !same(doc[list.ownerField], args.minor)) throw new GuardianError('notFound', 'That record wasn’t found.', 404)
    base = doc.updatedAt ?? null
  }
  if (list.ownerField in data && !same(data[list.ownerField], args.minor)) throw new GuardianError('badData', 'A suggestion can’t move a record to someone else.')
  const now = new Date().toISOString()
  const doc = (await payload.create({
    collection: o.requests as CollectionSlug,
    data: {
      direction: 'to-minor',
      kind: `${args.operation}:${args.collection}`,
      minor: args.minor,
      guardian: args.guardian.id,
      status: 'pending',
      summary: args.summary?.slice(0, 200),
      collectionSlug: args.collection,
      operation: args.operation,
      recordId: args.id === undefined ? undefined : String(args.id),
      data,
      baseUpdatedAt: base,
      suggestedAt: now,
    } as never,
    ...sys,
  })) as Doc
  await emit(payload, { type: 'suggested', actor: String(args.guardian.id), target: String(args.minor), via: 'guardian', ref: { request: String(doc.id), collection: args.collection, ...(args.id !== undefined ? { record: String(args.id) } : {}) }, req: args.req })
  await notice(payload, { to: args.minor, kind: 'guardians:suggestion', params: {}, actor: args.guardian.id, req: args.req })
  return { request: doc.id }
}

/**
 * The minor approves a suggestion: it's applied as the minor, with the minor's own access, in one transaction, with
 * the time it was suggested in the record's time field. If the record changed since, approving needs `replace`
 * ("This replaces what you entered"). A record deleted since can't be approved (`gone`).
 */
export async function approveSuggestion(payload: Payload, args: { minor: User; request: ID; replace?: boolean; req?: Req }): Promise<{ applied: ID | null }> {
  const o = configOf(payload)
  return transaction(payload, args.req, async (tx) => {
    const r = await load(payload, args.request, tx)
    if (!r || r.direction !== 'to-minor' || !same(r.minor, args.minor.id)) throw NOT_FOUND()
    if (r.status !== 'pending') throw new GuardianError('notPending', 'This suggestion has already been decided.', 409)
    const list = o.records.find((x) => x.collection === r.collectionSlug)
    if (!list) throw new GuardianError('notARecord', 'This kind of record can’t take suggestions any more.')
    const asMinor = { ...asReq(payload, tx), user: { ...args.minor, collection: o.users }, context: { ...(tx.context ?? {}), [APPLYING]: true } } as unknown as PayloadRequest
    const data = { ...(r.data ?? {}) } as Doc
    // The suggested time fills the time field of a new record only: an edit to an existing one keeps its date.
    if (r.operation === 'create' && list.timeField && data[list.timeField] === undefined) data[list.timeField] = r.suggestedAt
    let applied: ID | null = null
    if (r.operation === 'create') {
      data[list.ownerField] = args.minor.id
      applied = ((await payload.create({ collection: r.collectionSlug as CollectionSlug, data: data as never, overrideAccess: false, user: asMinor.user, req: asMinor })) as Doc).id
    } else {
      const current = (await payload.findByID({ collection: r.collectionSlug as CollectionSlug, id: r.recordId, depth: 0, overrideAccess: true, disableErrors: true, req: tx })) as Doc | null
      if (!current || !same(current[list.ownerField], args.minor.id)) throw new GuardianError('gone', 'That record isn’t there any more. You can decline this suggestion.')
      if (r.baseUpdatedAt && current.updatedAt && new Date(current.updatedAt).getTime() !== new Date(r.baseUpdatedAt).getTime() && !args.replace)
        throw new GuardianError('conflict', 'You’ve changed this since it was suggested. Approving replaces what you entered.', 409)
      if (r.operation === 'update') {
        delete data[list.ownerField]
        await payload.update({ collection: r.collectionSlug as CollectionSlug, id: r.recordId, data: data as never, overrideAccess: false, user: asMinor.user, req: asMinor })
      } else await payload.delete({ collection: r.collectionSlug as CollectionSlug, id: r.recordId, overrideAccess: false, user: asMinor.user, req: asMinor })
      applied = r.recordId
    }
    if (!(await move(payload, r.id, 'pending', { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: args.minor.id, ...(applied && r.operation === 'create' ? { appliedId: String(applied) } : {}) }, tx)))
      throw new GuardianError('notPending', 'This suggestion has already been decided.', 409)
    await emit(payload, { type: 'suggestion-approved', actor: String(args.minor.id), target: String(args.minor.id), via: 'self', ref: { request: String(r.id) }, req: tx })
    await notice(payload, { to: idOf(r.guardian)!, kind: 'guardians:suggestion-decided', params: { decision: 'approved' }, req: tx })
    return { applied }
  }, stillPending(payload, args.request))
}

/** The minor declines: kept, never deleted, and can be reopened. */
export async function declineSuggestion(payload: Payload, args: { minor: User; request: ID; req?: Req }) {
  const r = await load(payload, args.request)
  if (!r || r.direction !== 'to-minor' || !same(r.minor, args.minor.id)) throw NOT_FOUND()
  if (!(await move(payload, r.id, 'pending', { status: 'declined', decidedAt: new Date().toISOString(), decidedBy: args.minor.id }))) throw new GuardianError('notPending', 'This suggestion has already been decided.', 409)
  await emit(payload, { type: 'suggestion-declined', actor: String(args.minor.id), target: String(args.minor.id), via: 'self', ref: { request: String(r.id) }, req: args.req })
  await notice(payload, { to: idOf(r.guardian)!, kind: 'guardians:suggestion-decided', params: { decision: 'declined' }, req: args.req })
}

/** The minor reopens a declined suggestion: it's back on their list to decide again. */
export async function reopenSuggestion(payload: Payload, args: { minor: User; request: ID; req?: Req }) {
  const r = await load(payload, args.request)
  if (!r || r.direction !== 'to-minor' || !same(r.minor, args.minor.id)) throw NOT_FOUND()
  if (!(await move(payload, r.id, 'declined', { status: 'pending', decidedAt: null, decidedBy: null }))) throw new GuardianError('notDeclined', 'Only a declined suggestion can be reopened.')
  await emit(payload, { type: 'suggestion-reopened', actor: String(args.minor.id), target: String(args.minor.id), via: 'self', ref: { request: String(r.id) }, req: args.req })
}

/** The guardian who suggested it withdraws it while it's pending. */
export async function withdrawSuggestion(payload: Payload, args: { guardian: User; request: ID; req?: Req }) {
  const r = await load(payload, args.request)
  if (!r || r.direction !== 'to-minor' || !same(r.guardian, args.guardian.id)) throw NOT_FOUND()
  if (!(await move(payload, r.id, 'pending', { status: 'withdrawn', decidedAt: new Date().toISOString(), decidedBy: args.guardian.id }))) throw new GuardianError('notPending', 'This suggestion has already been decided.', 409)
  await emit(payload, { type: 'suggestion-withdrawn', actor: String(args.guardian.id), target: String(idOf(r.minor)), via: 'guardian', ref: { request: String(r.id) }, req: args.req })
}

/** The minor's to-decide count, for a badge. */
export async function pendingCount(payload: Payload, minor: ID): Promise<number> {
  const o = configOf(payload)
  return (await payload.count({ collection: o.requests as CollectionSlug, where: { and: [{ minor: { equals: minor } }, { direction: { equals: 'to-minor' } }, { status: { equals: 'pending' } }] }, overrideAccess: true })).totalDocs
}

// ---------------------------------------------------------------------------------------------
// Approvals: minor to guardian

/**
 * A minor asks a guardian to approve something outside their records (joining a project, a purchase). Show the kid
 * that it goes to their guardian before calling this. Every active guardian is told; the first decision wins.
 */
export async function requestApproval(payload: Payload, args: { minor: User; kind: string; summary?: string; ref?: string; req?: Req }): Promise<{ request: ID }> {
  const o = configOf(payload)
  const kind = o.approvals[args.kind]
  if (!kind) throw new GuardianError('unknownKind', 'That isn’t something to ask a guardian about.')
  if (!(await minorNow(payload, args.minor))) throw new GuardianError('notMinor', 'Only an account with a guardian can ask one.')
  const guardians = (await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ minor: { equals: args.minor.id } }, { status: { equals: 'active' } }] }, pagination: false, ...sys })).docs as Doc[]
  if (!guardians.length) throw new GuardianError('noGuardian', 'You need a guardian linked to your account to ask for this.')
  const now = new Date()
  const doc = (await payload.create({
    collection: o.requests as CollectionSlug,
    data: {
      audience: guardians.map((g) => idOf(g.guardian)),
      direction: 'to-guardian',
      kind: args.kind,
      minor: args.minor.id,
      status: 'pending',
      summary: args.summary?.slice(0, 200),
      ref: args.ref?.slice(0, 200),
      suggestedAt: now.toISOString(),
      ...(kind.expiresDays ? { expiresAt: new Date(now.getTime() + kind.expiresDays * DAY).toISOString() } : {}),
    } as never,
    ...sys,
  })) as Doc
  await emit(payload, { type: 'approval-requested', actor: String(args.minor.id), target: String(args.minor.id), via: 'self', ref: { request: String(doc.id), kind: args.kind }, req: args.req })
  for (const g of guardians) await notice(payload, { to: idOf(g.guardian)!, kind: 'guardians:approval-requested', params: { what: kind.label }, actor: args.minor.id, req: args.req })
  return { request: doc.id }
}

/**
 * A guardian decides. Approving runs the kind's `apply` as the minor, in the same transaction as the decision, so
 * a failed `apply` leaves the request pending. The first decision wins; an expired request can't be approved.
 */
export async function decideApproval(payload: Payload, args: { guardian: User; request: ID; approve: boolean; req?: Req }): Promise<void> {
  const o = configOf(payload)
  // An expired request is marked so before the decision's transaction, so the mark isn't rolled back with it.
  const before = await load(payload, args.request)
  if (before?.direction === 'to-guardian' && before.status === 'pending' && before.expiresAt && new Date(before.expiresAt).getTime() < Date.now()) {
    if (await activeLink(payload, args.guardian.id, idOf(before.minor)!)) {
      await move(payload, before.id, 'pending', { status: 'expired' })
      throw new GuardianError('expired', 'This request has expired. They can ask again.')
    }
  }
  await transaction(payload, args.req, async (tx) => {
    const r = await load(payload, args.request, tx)
    if (!r || r.direction !== 'to-guardian') throw NOT_FOUND()
    // A guardian decides only while they may act for the kid now: an active link, the kid still a minor and the
    // guardian known to be an adult. Coming of age stops it at once, before the daily run ends the link.
    const act = await canActAs(payload, { actor: args.guardian.id, target: idOf(r.minor), req: tx })
    if (!act.allowed || act.via !== 'guardian') throw NOT_FOUND()
    if (r.status !== 'pending') throw new GuardianError('notPending', 'This request has already been decided.', 409)
    if (r.expiresAt && new Date(r.expiresAt).getTime() < Date.now()) {
      await move(payload, r.id, 'pending', { status: 'expired' }, tx)
      throw new GuardianError('expired', 'This request has expired. They can ask again.')
    }
    // Who decided goes in decidedBy (managers only), not in guardian: reading follows the audience, so an
    // ex-guardian stops reading the kid's requests once the link ends, including ones they decided.
    const decided = { status: args.approve ? 'approved' : 'declined', decidedAt: new Date().toISOString(), decidedBy: args.guardian.id }
    if (!(await move(payload, r.id, 'pending', decided, tx))) throw new GuardianError('notPending', 'This request has already been decided.', 409)
    if (args.approve) {
      const kind = o.approvals[r.kind]
      if (!kind) throw new GuardianError('unknownKind', 'This kind of request can’t be approved any more.')
      const minor = await loadUser(payload, idOf(r.minor), tx)
      if (!minor) throw NOT_FOUND()
      // As the minor: the request's user is the minor, inside the decision's transaction.
      const asMinor = { ...tx, user: { ...minor, collection: o.users } } as unknown as PayloadRequest
      await kind.apply({ request: r, minor, guardian: args.guardian, req: asMinor, payload })
    }
    await emit(payload, { type: args.approve ? 'approval-approved' : 'approval-declined', actor: String(args.guardian.id), target: String(idOf(r.minor)), via: 'guardian', ref: { request: String(r.id), kind: String(r.kind) }, req: tx })
    await notice(payload, { to: idOf(r.minor)!, kind: 'guardians:approval-decided', params: { decision: args.approve ? 'approved' : 'declined' }, req: tx })
  }, stillPending(payload, args.request))
}

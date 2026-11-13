import type { CollectionAfterDeleteHook, CollectionSlug, Payload, Where } from 'payload'

import type { ID, Req, User } from './types.js'
import { asReq, configOf, DAY, managerSays, emit, GuardianError, hashCode, HOUR, idOf, loadUser, minorNow, minorState, newCode, normalCode, notice, same, sys } from './util.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A code the signed-in person hands over in person, so the other side can link to them. Nobody looks anyone up by
 * email or name. The creator's side comes from who they are: a minor makes a code for a guardian, an adult for a
 * minor. Returned once; only its hash is kept.
 */
export async function createLinkCode(payload: Payload, args: { user: User; req?: Req }): Promise<{ code: string; expiresAt: string; role: 'guardian' | 'minor' }> {
  const o = configOf(payload)
  const since = new Date(Date.now() - DAY).toISOString()
  const made = await payload.count({ collection: o.codes as CollectionSlug, where: { and: [{ creator: { equals: args.user.id } }, { createdAt: { greater_than: since } }] }, overrideAccess: true })
  if (made.totalDocs >= o.codesPerDay) throw new GuardianError('tooMany', 'That’s a lot of codes today. Please try again tomorrow.', 429)
  const role = (await minorNow(payload, args.user)) ? 'minor' : 'guardian'
  const code = newCode()
  const expiresAt = new Date(Date.now() + o.codeHours * HOUR).toISOString()
  await payload.create({ collection: o.codes as CollectionSlug, data: { hash: hashCode(payload.secret, code), creator: args.user.id, role, expiresAt } as never, ...sys })
  return { code, expiresAt, role }
}

const BAD_CODE = () => new GuardianError('badCode', 'That code didn’t work. It may have expired or been used. Ask for a new one.')

/** Every rule for a new link, read inside the transaction. Throws the first that fails. */
async function checkRules(payload: Payload, guardian: User, minor: User, req: Req) {
  const o = configOf(payload)
  if (same(guardian.id, minor.id)) throw new GuardianError('self', 'You can’t link to your own account.')
  // Both must be known for certain: an adult guardian and a minor. If either can't be told, no link.
  const g = await minorState(payload, guardian)
  const m = await minorState(payload, minor)
  if (g === 'unknown' || m === 'unknown') throw new GuardianError('unknownAge', 'This link can’t be checked right now. Please try again later.')
  if (g === 'yes') throw new GuardianError('guardianIsMinor', 'A guardian has to be an adult.')
  if (m === 'no') throw new GuardianError('notMinor', 'Only an account under the age of majority can have a guardian.')
  const r = asReq(payload, req)
  const pair = await payload.count({ collection: o.guardianships as CollectionSlug, where: { and: [{ guardian: { equals: guardian.id } }, { minor: { equals: minor.id } }, { status: { equals: 'active' } }] }, overrideAccess: true, req: r })
  if (pair.totalDocs) throw new GuardianError('alreadyLinked', 'You’re already linked.')
}

/** The guardian's limit: the default, or a manager's raised limit on any of their links. */
async function kidLimit(payload: Payload, guardian: ID): Promise<number> {
  const o = configOf(payload)
  const raised = (await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ guardian: { equals: guardian } }, { kidLimit: { exists: true } }] }, sort: '-kidLimit', limit: 1, ...sys })).docs as Doc[]
  return Math.max(o.maxKids, Number(raised[0]?.kidLimit ?? 0))
}

/**
 * The other side enters the code, signed in. The code is claimed with a conditional write, so only one person can
 * use it. The link is made, then the limits are counted including it, ordered by time: under a race, a link past a
 * limit is ended at once with nothing else changed, so two people can't both take the last place. An expired,
 * used or unknown code gets the same answer.
 */
export async function useLinkCode(payload: Payload, args: { user: User; code: unknown; req?: Req }): Promise<{ guardianship: ID }> {
  const o = configOf(payload)
  const code = normalCode(args.code)
  if (code.length !== 12) throw BAD_CODE()
  const hash = hashCode(payload.secret, code)
  const found = ((await payload.find({ collection: o.codes as CollectionSlug, where: { hash: { equals: hash } }, limit: 1, pagination: false, ...sys })).docs as Doc[])[0]
  if (!found || found.usedAt || new Date(found.expiresAt).getTime() < Date.now() || same(found.creator, args.user.id)) {
    if (found && same(found.creator, args.user.id)) throw new GuardianError('self', 'That’s your own code: give it to the other person to enter.')
    throw BAD_CODE()
  }
  const claimed = await payload.db.updateOne({ collection: o.codes, where: { and: [{ id: { equals: found.id } }, { usedAt: { exists: false } }] } as Where, data: { usedAt: new Date().toISOString() } } as never)
  if (!claimed) throw BAD_CODE()
  const creator = await loadUser(payload, idOf(found.creator))
  if (!creator) throw BAD_CODE()
  const guardian = found.role === 'guardian' ? creator : args.user
  const minor = found.role === 'guardian' ? args.user : creator
  await checkRules(payload, guardian, minor, args.req ?? {})

  const now = new Date().toISOString()
  const link = (await payload.create({ collection: o.guardianships as CollectionSlug, data: { guardian: guardian.id, minor: minor.id, status: 'active', startedAt: now, madeBy: args.user.id } as never, ...sys })) as Doc
  // Count including this link, in a fixed order, so racing links agree on who's past the limit.
  const firstN = async (field: 'guardian' | 'minor', id: ID, n: number) =>
    ((await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ [field]: { equals: id } }, { status: { equals: 'active' } }] }, sort: ['createdAt', 'id'], limit: n, pagination: false, ...sys })).docs as Doc[]).some((d) => same(d.id, link.id))
  // The same pair twice at once (two of a kid's codes entered together): only the first stays.
  const firstPair = ((await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ guardian: { equals: guardian.id } }, { minor: { equals: minor.id } }, { status: { equals: 'active' } }] }, sort: ['createdAt', 'id'], limit: 1, pagination: false, ...sys })).docs as Doc[])[0]
  if (!same(firstPair?.id, link.id)) {
    await payload.delete({ collection: o.guardianships as CollectionSlug, id: link.id, ...sys })
    throw new GuardianError('alreadyLinked', 'You’re already linked.')
  }
  const fitsMinor = await firstN('minor', minor.id, o.maxGuardians)
  const fitsGuardian = fitsMinor && (await firstN('guardian', guardian.id, await kidLimit(payload, guardian.id)))
  if (!fitsMinor || !fitsGuardian) {
    await payload.delete({ collection: o.guardianships as CollectionSlug, id: link.id, ...sys })
    throw fitsMinor
      ? new GuardianError('tooManyKids', 'This guardian already has the most kids an account can have. Staff can raise it.')
      : new GuardianError('tooManyGuardians', `An account can have at most ${o.maxGuardians} guardians.`)
  }
  await emit(payload, { type: 'link-made', actor: String(args.user.id), target: String(minor.id), via: 'self', ref: { guardianship: String(link.id) }, req: args.req })
  // Both sides are told, and so is every other guardian the minor already has.
  const others = ((await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ minor: { equals: minor.id } }, { status: { equals: 'active' } }, { id: { not_equals: link.id } }] }, pagination: false, ...sys })).docs as Doc[]).map((d) => idOf(d.guardian)!)
  for (const to of [guardian.id, minor.id, ...others]) await notice(payload, { to, kind: 'guardians:link-made', params: {}, actor: args.user.id, req: args.req })
  return { guardianship: link.id }
}

/** Ends a link: either side, or a manager (`asStaff`). Kept, with who ended it and why. */
export async function endLink(payload: Payload, args: { user: User; guardianship: ID; asStaff?: boolean; req?: Req }): Promise<void> {
  const o = configOf(payload)
  // Staff means the manage rule says so for this request, not just the flag.
  if (args.asStaff && !(await managerSays(payload, o.manage, { req: { ...asReq(payload, args.req), user: args.user } } as never))) throw new GuardianError('notFound', 'That link wasn’t found.', 404)
  const link = (await payload.findByID({ collection: o.guardianships as CollectionSlug, id: args.guardianship, ...sys, disableErrors: true })) as Doc | null
  const mine = link && (same(link.guardian, args.user.id) || same(link.minor, args.user.id))
  if (!link || link.status !== 'active' || (!mine && !args.asStaff)) throw new GuardianError('notFound', 'That link wasn’t found.', 404)
  const reason = args.asStaff && !mine ? 'removed-by-staff' : same(link.guardian, args.user.id) ? 'removed-by-guardian' : 'removed-by-minor'
  const done = await payload.db.updateOne({ collection: o.guardianships, where: { and: [{ id: { equals: link.id } }, { status: { equals: 'active' } }] } as Where, data: { status: 'ended', endedAt: new Date().toISOString(), endReason: reason, endedBy: args.user.id } } as never)
  if (!done) return
  await withdrawPending(payload, idOf(link.guardian)!, idOf(link.minor)!)
  await emit(payload, { type: 'link-ended', actor: String(args.user.id), target: String(idOf(link.minor)), via: reason === 'removed-by-staff' ? 'staff' : 'self', ref: { guardianship: String(link.id), reason }, req: args.req })
  for (const to of [link.guardian, link.minor]) if (!same(to, args.user.id)) await notice(payload, { to: idOf(to)!, kind: 'guardians:link-ended', params: {}, req: args.req })
}

/** Ends every link whose minor has come of age. Run daily; access stops at once anyway, at each check. */
export async function endComeOfAge(payload: Payload): Promise<number> {
  const o = configOf(payload)
  const active = (await payload.find({ collection: o.guardianships as CollectionSlug, where: { status: { equals: 'active' } }, pagination: false, ...sys })).docs as Doc[]
  const seen = new Map<string, boolean>()
  let ended = 0
  for (const link of active) {
    const id = String(idOf(link.minor))
    if (!seen.has(id)) seen.set(id, await minorNow(payload, await loadUser(payload, idOf(link.minor))))
    if (seen.get(id)) continue
    const done = await payload.db.updateOne({ collection: o.guardianships, where: { and: [{ id: { equals: link.id } }, { status: { equals: 'active' } }] } as Where, data: { status: 'ended', endedAt: new Date().toISOString(), endReason: 'came-of-age' } } as never)
    if (!done) continue
    await withdrawPending(payload, idOf(link.guardian)!, idOf(link.minor)!)
    ended++
    await emit(payload, { type: 'came-of-age', actor: null, target: id, via: 'system', ref: { guardianship: String(link.id) } })
    await notice(payload, { to: idOf(link.minor)!, kind: 'guardians:came-of-age', params: {} })
    await notice(payload, { to: idOf(link.guardian)!, kind: 'guardians:link-ended', params: {} })
  }
  return ended
}

/**
 * When an account is deleted, every active link it's on ends with `account-deleted`, inside the delete's
 * transaction. A deleted guardian stops holding one of the minor's places, and their pending suggestions are
 * withdrawn. The other side is told.
 */
export const endLinksOfDeleted: CollectionAfterDeleteHook = async ({ id, req }) => {
  const payload = req.payload
  const o = configOf(payload)
  const tx = req.transactionID ? { req } : {}
  const active = (await payload.find({ collection: o.guardianships as CollectionSlug, where: { and: [{ or: [{ guardian: { equals: id } }, { minor: { equals: id } }] }, { status: { equals: 'active' } }] }, pagination: false, ...sys, ...tx })).docs as Doc[]
  for (const link of active) {
    const done = await payload.db.updateOne({ collection: o.guardianships, where: { and: [{ id: { equals: link.id } }, { status: { equals: 'active' } }] } as Where, data: { status: 'ended', endedAt: new Date().toISOString(), endReason: 'account-deleted' }, ...tx } as never)
    if (!done) continue
    await withdrawPending(payload, idOf(link.guardian)!, idOf(link.minor)!, req)
    await emit(payload, { type: 'link-ended', actor: null, target: String(idOf(link.minor)), via: 'system', ref: { guardianship: String(link.id), reason: 'account-deleted' }, req })
    const other = same(link.guardian, id) ? link.minor : link.guardian
    await notice(payload, { to: idOf(other)!, kind: 'guardians:link-ended', params: {}, req })
  }
}

/** Deletes used and expired codes a week after they stopped working. */
export async function pruneLinkCodes(payload: Payload): Promise<void> {
  const o = configOf(payload)
  const cut = new Date(Date.now() - 7 * DAY).toISOString()
  await payload.delete({ collection: o.codes as CollectionSlug, where: { or: [{ usedAt: { less_than: cut } }, { expiresAt: { less_than: cut } }] }, ...sys })
}

/**
 * When a link ends: the ex-guardian's pending suggestions are withdrawn, and they're taken off the audience of the
 * kid's requests, so they no longer read them.
 */
async function withdrawPending(payload: Payload, guardian: ID, minor: ID, req?: Req) {
  const o = configOf(payload)
  const tx = req?.transactionID ? { req: req as never } : {}
  const shared = (await payload.find({ collection: o.requests as CollectionSlug, where: { and: [{ minor: { equals: minor } }, { audience: { contains: guardian } }] }, pagination: false, ...sys, ...tx })).docs as Doc[]
  for (const r of shared) await payload.db.updateOne({ collection: o.requests, where: { id: { equals: r.id } }, data: { audience: ((r.audience ?? []) as unknown[]).map(idOf).filter((a) => !same(a, guardian)) }, ...tx } as never)
  await payload.db.updateMany({
    collection: o.requests,
    where: { and: [{ direction: { equals: 'to-minor' } }, { guardian: { equals: guardian } }, { minor: { equals: minor } }, { status: { equals: 'pending' } }] } as Where,
    data: { status: 'withdrawn', decidedAt: new Date().toISOString() },
    ...tx,
  } as never)
  await emit(payload, { type: 'suggestion-withdrawn', actor: null, target: String(minor), via: 'system', ref: { guardian: String(guardian), reason: 'link-ended' } })
}

/** A manager raises one guardian's kid limit (it never goes below the default). Checked with the manage rule. */
export async function setKidLimit(payload: Payload, args: { user: User; guardian: ID; limit: number; req?: Req }): Promise<void> {
  const o = configOf(payload)
  if (!(await managerSays(payload, o.manage, { req: { ...asReq(payload, args.req), user: args.user } } as never))) throw new GuardianError('notAllowed', 'Only staff can change a guardian’s limit.', 403)
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50) throw new GuardianError('badLimit', 'A limit is a whole number from 1 to 50.')
  const links = (await payload.find({ collection: o.guardianships as CollectionSlug, where: { guardian: { equals: args.guardian } }, pagination: false, ...sys })).docs as Doc[]
  if (!links.length) throw new GuardianError('notFound', 'That guardian has no links.', 404)
  await payload.db.updateMany({ collection: o.guardianships, where: { guardian: { equals: args.guardian } } as Where, data: { kidLimit: args.limit } } as never)
}

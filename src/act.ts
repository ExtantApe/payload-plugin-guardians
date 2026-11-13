import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionBeforeOperationHook, CollectionSlug, Payload } from 'payload'

import type { ID, Req, User } from './types.js'
import { configOf, GuardianError, idOf, loadUser, minorState, same } from './util.js'

/** Set by the plugin while applying an approved suggestion as the minor. */
export const APPLYING = Symbol.for('guardians.applying')

/** An active link with `guardian` guarding `minor`, read inside the caller's transaction when there is one. */
export async function activeLink(payload: Payload, guardian: ID, minor: ID, req?: Req): Promise<boolean> {
  const o = configOf(payload)
  const { totalDocs } = await payload.count({
    collection: o.guardianships as CollectionSlug,
    where: { and: [{ guardian: { equals: guardian } }, { minor: { equals: minor } }, { status: { equals: 'active' } }] },
    overrideAccess: true,
    ...(req?.transactionID ? { req: req as never } : {}),
  })
  return totalDocs > 0
}

/**
 * May `actor` act for `target`? `self` for one's own account; `guardian` for an active link while the target is
 * still a minor and the actor isn't. Anything else, or any error, is no. Hats links (one person's own accounts) are
 * the site's own check.
 */
export async function canActAs(payload: Payload, args: { actor: ID | null | undefined; target: ID | null | undefined; req?: Req }): Promise<{ allowed: boolean; via?: 'self' | 'guardian' }> {
  try {
    const actor = idOf(args.actor)
    const target = idOf(args.target)
    if (actor === null || target === null) return { allowed: false }
    if (same(actor, target)) return { allowed: true, via: 'self' }
    if (!(await activeLink(payload, actor, target, args.req))) return { allowed: false }
    const [a, t] = await Promise.all([loadUser(payload, actor), loadUser(payload, target)])
    // Both must be known: the actor an adult, the target a minor. Unknown on either side is no.
    if (!a || !t || (await minorState(payload, a)) !== 'no' || (await minorState(payload, t)) !== 'yes') return { allowed: false }
    return { allowed: true, via: 'guardian' }
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'guardians: canActAs failed, so it said no' })
    return { allowed: false }
  }
}

/** Who is writing: the person a site's switcher says is acting, else the signed-in account. */
async function writer(req: Req): Promise<ID | null> {
  const o = configOf(req.payload!)
  const acting = await o.actingFor?.(req)
  if (acting) return idOf(acting.actor)
  const u = req.user as User | null | undefined
  return u && u.collection === o.users ? u.id : null
}

/**
 * The kid always decides, in code: a guardian's direct write to a linked minor's records is refused, whether they switched into the
 * kid's account or wrote from their own. Changes go through `suggest`, and the kid decides. A write the plugin
 * makes while applying an approved suggestion runs as the kid, so it isn't stopped. Code with no signed-in person
 * (the site's own jobs) isn't a guardian and isn't stopped. If the check can't decide, the write is refused.
 */
async function refuseGuardianWrite(req: Req, owners: unknown[]) {
  if ((req.context as Record<symbol, unknown> | undefined)?.[APPLYING]) return
  const payload = req.payload!
  let who: ID | null
  try {
    who = await writer(req)
  } catch {
    throw new GuardianError('suggestionRequired', 'This change can’t be checked right now, so it wasn’t saved.', 403)
  }
  if (who === null) return
  for (const owner of owners) {
    if (owner === null || owner === undefined || owner === '') continue
    const id = typeof owner === 'string' || typeof owner === 'number' || (typeof owner === 'object' && !Array.isArray(owner) && 'id' in (owner as object)) ? idOf(owner) : null
    // An owner we can't read (an array, an odd shape) is refused, not skipped.
    if (id === null) throw new GuardianError('suggestionRequired', 'This change can’t be checked, so it wasn’t saved.', 403)
    if (same(id, who)) continue
    let linked = true
    try {
      linked = await activeLink(payload, who, id, req)
    } catch {
      linked = true // can't tell: refuse
    }
    if (linked) throw new GuardianError('suggestionRequired', 'Changes to your kid’s records go to them as suggestions. They decide.', 403)
  }
}

export const guardBeforeChange =
  (ownerField: string): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, req }) => {
    await refuseGuardianWrite(req, [originalDoc?.[ownerField], data?.[ownerField]])
    return data
  }

/**
 * Checked again after the write, inside its transaction, against the record as saved: a later hook (the site's,
 * or a field's) that fills in the owner can't slip a guardian's write past the check. Throwing rolls it back.
 */
export const guardAfterChange =
  (ownerField: string): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, req }) => {
    await refuseGuardianWrite(req, [previousDoc?.[ownerField], doc?.[ownerField]])
    return doc
  }

export const guardBeforeDelete =
  (collection: string, ownerField: string): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const doc = (await req.payload.findByID({ collection: collection as CollectionSlug, id, depth: 0, overrideAccess: true, disableErrors: true, req })) as Record<string, unknown> | null
    await refuseGuardianWrite(req, [doc?.[ownerField]])
  }

/**
 * A bulk update (by `where`) on a minor's records, from anyone who is an active guardian, is refused outright.
 * Payload doesn't roll back one document of a bulk update when a later check fails, and hooks the plugin can't see
 * (a hook on another field, or another plugin's) could move a record to the kid after the last check. Single
 * updates are checked before and after, inside their transaction; deletes are checked before anything goes.
 */
export const guardBulkUpdate: CollectionBeforeOperationHook = async ({ operation, args, req }) => {
  if (operation !== 'update' || (args as { id?: unknown })?.id !== undefined) return args
  if ((req.context as Record<symbol, unknown> | undefined)?.[APPLYING]) return args
  const o = configOf(req.payload)
  let who: ID | null
  let guarding = true
  try {
    who = await writer(req)
    if (who === null) return args
    const { totalDocs } = await req.payload.count({ collection: o.guardianships as CollectionSlug, where: { and: [{ guardian: { equals: who } }, { status: { equals: 'active' } }] }, overrideAccess: true })
    guarding = totalDocs > 0
  } catch {
    guarding = true // can't tell: refuse
  }
  if (guarding) throw new GuardianError('suggestionRequired', 'Guardians change records one at a time, so each change can be checked. Bulk updates aren’t allowed here.', 403)
  return args
}

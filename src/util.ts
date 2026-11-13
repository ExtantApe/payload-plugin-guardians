import { createHash, randomBytes } from 'node:crypto'

import { APIError, type Payload, type PayloadRequest } from 'payload'

import type { ID, Req, Resolved, User } from './types.js'

/** A refusal the site can show, with a stable code. */
export class GuardianError extends APIError<{ code: string }> {
  code: string
  constructor(code: string, message: string, status = 400) {
    super(message, status, { code }, true)
    this.code = code
  }
}

export const configOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.guardians as Resolved | undefined
  if (!o) throw new Error('Guardians: the plugin is not configured on this site.')
  return o
}

export const idOf = (v: unknown): ID | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'object') return ((v as { id?: ID }).id ?? null) as ID | null
  return v as ID
}
export const same = (a: unknown, b: unknown) => idOf(a) !== null && String(idOf(a)) === String(idOf(b))

export const asReq = (payload: Payload, req?: Req) => ({ ...(req ?? {}), payload }) as PayloadRequest
export const sys = { overrideAccess: true, depth: 0 } as const

/** A code that's easy to read aloud and type: 12 characters, no look-alikes, grouped in fours. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const newCode = () => {
  const bytes = randomBytes(12)
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`
}
export const normalCode = (code: unknown) => (typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '')
export const hashCode = (secret: string, code: string) => createHash('sha256').update(`${secret}:guardians:${normalCode(code)}`).digest('hex')

/**
 * Is this request a manager's? Only an answer of exactly `true` counts. If the site's rule throws, the answer is
 * no: the caller refuses (403 through the API, the plugin's own refusal in its functions), never a 500.
 */
export async function managerSays(payload: Payload, manage: Resolved['manage'], args: Parameters<Resolved['manage']>[0]): Promise<boolean> {
  try {
    return (await manage(args)) === true
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'guardians: access.manage failed, so it counts as no' })
    return false
  }
}

/** Is this account a minor now: yes, no, or unknown (isMinor threw, or gave something other than a boolean). */
export async function minorState(payload: Payload, user: User | null | undefined): Promise<'yes' | 'no' | 'unknown'> {
  if (!user) return 'unknown'
  try {
    const v = await configOf(payload).isMinor(user, { now: new Date() })
    return v === true ? 'yes' : v === false ? 'no' : 'unknown'
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'guardians: isMinor failed, so the account counts as unknown and nothing is allowed' })
    return 'unknown'
  }
}
/** For refusals that should hold when unsure: unknown counts as a minor. */
export async function minorNow(payload: Payload, user: User | null | undefined): Promise<boolean> {
  return (await minorState(payload, user)) !== 'no'
}

export async function loadUser(payload: Payload, id: ID | null, req?: Req): Promise<User | null> {
  if (id === null) return null
  const u = (await payload.findByID({ collection: configOf(payload).users as never, id, ...sys, disableErrors: true, ...(req?.transactionID ? { req: asReq(payload, req) } : {}) })) as User | null
  return u ? { ...u, collection: configOf(payload).users } : null
}

export async function emit(payload: Payload, event: Parameters<NonNullable<Resolved['onEvent']>>[0]) {
  await configOf(payload).onEvent?.(event)
}

/** A notice through the Notifications plugin when it's installed, else the site's own `onNotice`. Never throws. */
export async function notice(payload: Payload, args: { to: ID; kind: string; params?: Record<string, string>; link?: string; actor?: ID | null; req?: Req }) {
  try {
    const notify = payload.config.custom?.notifications?.notify as ((p: Payload, i: unknown, r?: Req) => Promise<unknown>) | undefined
    if (notify) await notify(payload, { recipient: args.to, kind: args.kind, params: args.params ?? {}, link: args.link, actor: args.actor ?? null }, args.req)
    else await configOf(payload).onNotice?.({ to: args.to, kind: args.kind, params: args.params ?? {}, link: args.link, req: args.req })
  } catch (error) {
    payload.logger.error({ kind: args.kind, err: { name: (error as Error)?.name }, msg: 'guardians: notice not sent' })
  }
}

/**
 * A write that lost a race inside a transaction: MongoDB's WriteConflict (code 112), or any error it labels
 * as a transient transaction error. Looked for on the error and on its causes.
 */
export function lostRace(error: unknown): boolean {
  for (let e = error as Record<string, unknown> | undefined, depth = 0; e && typeof e === 'object' && depth < 5; e = e.cause as Record<string, unknown> | undefined, depth++) {
    if (e.code === 112 || e.codeName === 'WriteConflict') return true
    const labels = (e.errorLabels ?? (e.errorLabelSet instanceof Set ? [...e.errorLabelSet] : [])) as unknown
    if (Array.isArray(labels) && labels.includes('TransientTransactionError')) return true
  }
  return false
}

/**
 * Run `fn` in a transaction, or inside the caller's. A lost race (a write conflict) is rolled back, then
 * `stillPending` is asked: if the request was decided meanwhile, the answer is `notPending` (409); if it's still
 * pending, the conflict was about something else, and the answer is `busy` (409), so the person can try again.
 */
export async function transaction<T>(payload: Payload, req: Req | undefined, fn: (req: PayloadRequest) => Promise<T>, stillPending?: () => Promise<boolean>): Promise<T> {
  const base = asReq(payload, req)
  if (base.transactionID) return fn(base)
  const id = (await payload.db.beginTransaction?.()) ?? undefined
  // Approving applies a change and records the decision together, or not at all: without transactions, refuse.
  if (!id) throw new GuardianError('noTransactions', 'Guardians needs database transactions (a MongoDB replica set) to apply decisions safely.', 500)
  const r = { ...base, transactionID: id } as PayloadRequest
  try {
    const out = await fn(r)
    if (id) await payload.db.commitTransaction(id)
    return out
  } catch (error) {
    if (id) await payload.db.rollbackTransaction(id).catch(() => undefined)
    if (lostRace(error)) {
      let pending = false
      try {
        pending = stillPending ? await stillPending() : false
      } catch {
        pending = false
      }
      if (pending) throw new GuardianError('busy', 'That didn’t go through. Please try again.', 409)
      throw new GuardianError('notPending', 'This has already been decided.', 409)
    }
    throw error
  }
}

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

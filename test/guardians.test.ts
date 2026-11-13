import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload, type PayloadRequest, type SanitizedConfig } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveSuggestion,
  canActAs,
  setKidLimit,
  createLinkCode,
  decideApproval,
  declineSuggestion,
  endComeOfAge,
  endLink,
  guardiansPlugin,
  pendingCount,
  reopenSuggestion,
  requestApproval,
  suggest,
  useLinkCode,
  viaGuardian,
  withdrawSuggestion,
  type GuardianEvent,
  type User,
} from '../src/index.js'
import { guardBeforeChange } from '../src/act.js'
import { lostRace } from '../src/util.js'

// Made-up people on a throwaway in-memory database. A minor has `minorUntil` in the future.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let config: SanitizedConfig
let mongo: MongoMemoryReplSet
const events: GuardianEvent[] = []
const notices: { to: string; kind: string }[] = []
let applySawUser: unknown = null
let n = 0
let isMinorThrows = false
let applyThrows = false
let applyConflicts = false
let eventThrows = false

const FUTURE = '2099-01'
const PAST = '2000-01'
const make = async (minorUntil: string | null = null, role = 'member') =>
  ({ ...((await payload.create({ collection: 'users', data: { email: `p${++n}@example.com`, password: 'a made-up password', minorUntil, role } as never, overrideAccess: true })) as Doc), collection: 'users' }) as User
const link = async (guardian: User, minor: User) => {
  const { code } = await createLinkCode(payload, { user: minor })
  return (await useLinkCode(payload, { user: guardian, code })).guardianship
}
const animal = async (keeper: User, name = 'Gecko') => (await payload.create({ collection: 'animals' as never, data: { keeper: keeper.id, name } as never, overrideAccess: true })) as Doc
const reqAs = (user: User, actingFor?: User) => ({ user, headers: new Headers(actingFor ? { 'x-acting-for': String(actingFor.id) } : {}), payload }) as unknown as PayloadRequest
const refusedCode = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string; data?: { code?: string } }).code ?? (e as { data?: { code?: string } }).data?.code ?? (e as Error).message
  }
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  config = await buildConfig({
    secret: 'test-secret-not-for-production',
    telemetry: false,
    typescript: { autoGenerate: false },
    db: mongooseAdapter({ url: mongo.getUri('guardians'), ensureIndexes: true }),
    admin: { user: 'users' },
    collections: [
      { slug: 'users', auth: true, access: { read: () => true }, fields: [{ name: 'minorUntil', type: 'text' }, { name: 'role', type: 'text' }] },
      {
        slug: 'animals',
        access: {
          read: () => true,
          create: ({ req, data }) => Boolean(req.user) && String(data?.keeper) === String(req.user!.id) && data?.name !== 'Not allowed',
          update: ({ req }) => (req.user ? { keeper: { equals: req.user.id } } : false),
          delete: ({ req }) => (req.user ? { keeper: { equals: req.user.id } } : false),
        },
        fields: [
          { name: 'keeper', type: 'relationship', relationTo: 'users' },
          { name: 'name', type: 'text' },
          { name: 'fedAt', type: 'date' },
        ],
      },
      { slug: 'joined', fields: [{ name: 'who', type: 'text' }, { name: 'what', type: 'text' }] },
      {
        // A site hook fills in the owner from who is being acted for, after the plugin's own beforeChange.
        slug: 'diary',
        access: { create: () => true, update: () => true, read: () => true },
        hooks: { beforeChange: [({ data, req }) => ({ ...data, keeper: data.keeper ?? req.headers?.get?.('x-acting-for') ?? req.user?.id })] },
        fields: [
          { name: 'keeper', type: 'relationship', relationTo: 'users' },
          // A hook on another field that moves the record to whoever is being acted for.
          { name: 'text', type: 'text', hooks: { beforeChange: [({ value, siblingData, req }) => { if (value === 'move me') siblingData.keeper = req.headers?.get?.('x-acting-for') ?? siblingData.keeper; return value }] } },
        ],
      },
      { slug: 'devices', auth: true, fields: [] },
    ],
    plugins: [
      guardiansPlugin({
        isMinor: (u) => {
          if (isMinorThrows || u.minorUntil === 'THROW') throw new Error('made-up failure')
          // Answers that aren't a boolean: a site rule with a bug.
          if (u.minorUntil === 'ODD') return 'maybe' as never
          if (u.minorUntil === 'NULL') return null as never
          return typeof u.minorUntil === 'string' && u.minorUntil > new Date().toISOString().slice(0, 7)
        },
        access: {
          manage: ({ req }) => {
            const role = (req.user as { role?: string } | null)?.role
            if (role === 'throws') throw new Error('made-up failure')
            // A truthy answer that isn't exactly true (a where query) doesn't make someone a manager.
            if (role === 'truthy') return { id: { exists: true } }
            return role === 'staff'
          },
        },
        actingFor: (req) => {
          const t = req.headers?.get?.('x-acting-for')
          return t && req.user ? { actor: req.user.id, target: t } : null
        },
        records: [{ collection: 'animals', ownerField: 'keeper', timeField: 'fedAt' }, { collection: 'diary', ownerField: 'keeper' }],
        approvals: {
          'join-project': {
            label: 'Join a project',
            expiresDays: 30,
            apply: async ({ request, minor, req, payload: p }) => {
              if (applyThrows) throw new Error('made-up failure')
              // A write conflict on something unrelated to the request, as MongoDB reports it.
              if (applyConflicts) throw Object.assign(new Error('made-up write conflict'), { code: 112, codeName: 'WriteConflict', errorLabels: ['TransientTransactionError'] })
              applySawUser = (req.user as { id?: unknown } | null)?.id ?? null
              await p.create({ collection: 'joined' as never, data: { who: String(minor.id), what: String(request.ref) } as never, overrideAccess: true, req })
            },
          },
        },
        onEvent: (e) => {
          if (eventThrows) throw new Error('made-up audit failure')
          events.push({ ...e, req: undefined })
        },
        onNotice: ({ to, kind }) => void notices.push({ to: String(to), kind }),
      }),
    ],
  })
  payload = await getPayload({ config })
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

beforeEach(() => {
  events.length = 0
  notices.length = 0
  applySawUser = null
  isMinorThrows = false
  applyThrows = false
  applyConflicts = false
  eventThrows = false
})

describe('links', () => {
  it('links by a code either side makes, used once by the other side', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const { code, role } = await createLinkCode(payload, { user: kid })
    expect(role).toBe('minor')
    await useLinkCode(payload, { user: parent, code: code.toLowerCase().replace(/-/g, ' ') })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).via).toBe('guardian')
    expect(await refusedCode(useLinkCode(payload, { user: await make(), code }))).toBe('badCode')
    // The parent can make the code too.
    const kid2 = await make(FUTURE)
    const { code: c2, role: r2 } = await createLinkCode(payload, { user: parent })
    expect(r2).toBe('guardian')
    await useLinkCode(payload, { user: kid2, code: c2 })
    expect((await canActAs(payload, { actor: parent.id, target: kid2.id })).allowed).toBe(true)
    expect(events.filter((e) => e.type === 'link-made')).toHaveLength(2)
  })

  it('answers the same for a made-up, used or expired code, and refuses one’s own', async () => {
    const kid = await make(FUTURE)
    const { code } = await createLinkCode(payload, { user: kid })
    expect(await refusedCode(useLinkCode(payload, { user: await make(), code: 'AAAA-BBBB-CCCC' }))).toBe('badCode')
    expect(await refusedCode(useLinkCode(payload, { user: await make(), code: 'short' }))).toBe('badCode')
    expect(await refusedCode(useLinkCode(payload, { user: kid, code }))).toBe('self')
    await payload.update({ collection: 'guardian-codes' as never, where: { creator: { equals: kid.id } } as never, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true })
    expect(await refusedCode(useLinkCode(payload, { user: await make(), code }))).toBe('badCode')
  })

  it('refuses a minor as guardian, an adult as minor, a duplicate, a third guardian and a sixth kid', async () => {
    const kid = await make(FUTURE)
    expect(await refusedCode(link(await make(FUTURE), kid))).toBe('guardianIsMinor')
    const { code } = await createLinkCode(payload, { user: await make() }) // an adult's code is for a minor to use
    expect(await refusedCode(useLinkCode(payload, { user: await make(), code }))).toBe('notMinor')
    const a = await make()
    await link(a, kid)
    expect(await refusedCode(link(a, kid))).toBe('alreadyLinked')
    await link(await make(), kid)
    expect(await refusedCode(link(await make(), kid))).toBe('tooManyGuardians')
    const busy = await make()
    for (let i = 0; i < 5; i++) await link(busy, await make(FUTURE))
    expect(await refusedCode(link(busy, await make(FUTURE)))).toBe('tooManyKids')
  })

  it('lets a manager raise one guardian’s kid limit', async () => {
    const busy = await make()
    const first = await link(busy, await make(FUTURE))
    for (let i = 0; i < 4; i++) await link(busy, await make(FUTURE))
    await payload.update({ collection: 'guardianships' as never, id: first as string, data: { kidLimit: 6 } as never, overrideAccess: true })
    await link(busy, await make(FUTURE))
    expect(await refusedCode(link(busy, await make(FUTURE)))).toBe('tooManyKids')
  })

  it('lets only one person use a code, even at the same moment', async () => {
    const kid = await make(FUTURE)
    const { code } = await createLinkCode(payload, { user: kid })
    const results = await Promise.all([await make(), await make(), await make()].map((u) => refusedCode(useLinkCode(payload, { user: u, code }))))
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
  })

  it('gives the last place to one of two racing links, never both', async () => {
    const kid = await make(FUTURE)
    await link(await make(), kid)
    const codes = await Promise.all([createLinkCode(payload, { user: kid }), createLinkCode(payload, { user: kid })])
    const results = await Promise.all(codes.map(async ({ code }) => refusedCode(useLinkCode(payload, { user: await make(), code }))))
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    const active = await payload.count({ collection: 'guardianships' as never, where: { and: [{ minor: { equals: kid.id } }, { status: { equals: 'active' } }] } as never, overrideAccess: true })
    expect(active.totalDocs).toBe(2)
  })

  it('ends by either side or by staff, keeping the record; came of age ends it at once and in the daily run', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    await expect(endLink(payload, { user: await make(), guardianship: g })).rejects.toThrow()
    await endLink(payload, { user: kid, guardianship: g })
    expect(((await payload.findByID({ collection: 'guardianships' as never, id: g as string, overrideAccess: true })) as Doc).endReason).toBe('removed-by-minor')
    const g2 = await link(parent, kid)
    await endLink(payload, { user: await make(null, 'staff'), guardianship: g2, asStaff: true })
    expect(((await payload.findByID({ collection: 'guardianships' as never, id: g2 as string, overrideAccess: true })) as Doc).endReason).toBe('removed-by-staff')
    await link(parent, kid)
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: PAST } as never, overrideAccess: true })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false) // at once, before the daily run
    expect(await endComeOfAge(payload)).toBe(1)
    const all = await payload.find({ collection: 'guardianships' as never, where: { minor: { equals: kid.id } } as never, overrideAccess: true })
    expect(all.docs.map((d) => (d as Doc).endReason).sort()).toEqual(['came-of-age', 'removed-by-minor', 'removed-by-staff'])
  })
})

describe('canActAs', () => {
  it('says self for oneself, guardian for an active link, and no for everything else or any error', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    expect(await canActAs(payload, { actor: kid.id, target: kid.id })).toEqual({ allowed: true, via: 'self' })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false)
    await link(parent, kid)
    expect(await canActAs(payload, { actor: parent.id, target: kid.id })).toEqual({ allowed: true, via: 'guardian' })
    expect((await canActAs(payload, { actor: kid.id, target: parent.id })).allowed).toBe(false)
    expect((await canActAs(payload, { actor: null, target: kid.id })).allowed).toBe(false)
    isMinorThrows = true
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false)
  })

  it('tells an audit trail when a guardian acts for a minor', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    expect(await viaGuardian(reqAs(parent, kid))).toBeNull()
    await link(parent, kid)
    expect(await viaGuardian(reqAs(parent, kid))).toEqual({ kind: 'guardian', id: String(parent.id) })
    expect(await viaGuardian(reqAs(parent))).toBeNull()
  })
})

describe('the kid always decides: a guardian’s change to a minor’s records is only ever a suggestion', () => {
  it('refuses every direct write by a linked guardian, switched in or from their own account, and changes nothing', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    for (const req of [reqAs(parent, kid), reqAs(parent)]) {
      expect(await refusedCode(payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'Changed' } as never, overrideAccess: true, req }))).toBe('suggestionRequired')
      expect(await refusedCode(payload.delete({ collection: 'animals' as never, id: a.id, overrideAccess: true, req }))).toBe('suggestionRequired')
      expect(await refusedCode(payload.create({ collection: 'animals' as never, data: { keeper: kid.id, name: 'New' } as never, overrideAccess: true, req }))).toBe('suggestionRequired')
    }
    expect(((await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc).name).toBe('Gecko')
    expect((await payload.count({ collection: 'animals' as never, where: { keeper: { equals: kid.id } } as never, overrideAccess: true })).totalDocs).toBe(1)
    // The kid's own writes, and an unlinked adult's writes to their own records, aren't stopped.
    await payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'Mine' } as never, overrideAccess: true, req: reqAs(kid) })
    const other = await make()
    await payload.create({ collection: 'animals' as never, data: { keeper: other.id, name: 'Theirs' } as never, overrideAccess: true, req: reqAs(other) })
  })

  it('refuses when it can’t tell whether the writer is linked', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const spy = vi.spyOn(payload, 'count').mockRejectedValue(new Error('made-up outage'))
    expect(await refusedCode(payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'x' } as never, overrideAccess: true, req: reqAs(parent) }))).toBe('suggestionRequired')
    spy.mockRestore()
  })

  it('applies an approval with the minor’s own access, so it can’t do more than the minor could', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'create', data: { name: 'Not allowed' } })
    await expect(approveSuggestion(payload, { minor: kid, request })).rejects.toThrow()
    expect(await pendingCount(payload, kid.id)).toBe(1)
  })

  it('refuses when it can’t tell who is writing', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const broken = { ...reqAs(parent, kid), headers: { get: () => { throw new Error('made-up failure') } } } as unknown as PayloadRequest
    expect(await refusedCode(payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'x' } as never, overrideAccess: true, req: broken }))).toBe('suggestionRequired')
  })

  it('suggests, and only the minor approves: applied as the minor, with the time it was suggested', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'Fed and named' } })
    const suggestedAt = ((await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc).suggestedAt
    expect(await pendingCount(payload, kid.id)).toBe(1)
    expect(((await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc).name).toBe('Gecko')
    expect(await refusedCode(approveSuggestion(payload, { minor: parent, request }))).toBe('notFound')
    await approveSuggestion(payload, { minor: kid, request })
    const after = (await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc
    expect([after.name, after.fedAt ?? null]).toEqual(['Fed and named', null]) // an edit keeps the record's own time
    void suggestedAt
    expect(await pendingCount(payload, kid.id)).toBe(0)
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request }))).toBe('notPending')
  })

  it('creates and deletes through suggestions too, with the minor’s own access', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'create', data: { name: 'Hatchling', keeper: kid.id } })
    const { applied } = await approveSuggestion(payload, { minor: kid, request })
    const when = ((await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc).suggestedAt
    expect(new Date(((await payload.findByID({ collection: 'animals' as never, id: applied as string, overrideAccess: true })) as Doc).fedAt).toISOString()).toBe(new Date(when).toISOString())
    expect(((await payload.findByID({ collection: 'animals' as never, id: applied as string, overrideAccess: true, depth: 0 })) as Doc).keeper).toBe(kid.id)
    const del = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'delete', id: applied! })
    await approveSuggestion(payload, { minor: kid, request: del.request })
    expect(await payload.findByID({ collection: 'animals' as never, id: applied as string, overrideAccess: true, disableErrors: true })).toBeNull()
    // A suggestion can't move a record to someone else, or touch another kid's record.
    expect(await refusedCode(suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'create', data: { keeper: parent.id } }))).toBe('badData')
    const stranger = await animal(await make(FUTURE))
    expect(await refusedCode(suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: stranger.id, data: {} }))).toBe('notFound')
  })

  it('needs `replace` when the minor changed the record since, and says `gone` when it was deleted', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'Parent’s' } })
    await new Promise((r) => setTimeout(r, 5))
    await payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'Kid’s' } as never, overrideAccess: true, req: reqAs(kid) })
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request }))).toBe('conflict')
    await approveSuggestion(payload, { minor: kid, request, replace: true })
    expect(((await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc).name).toBe('Parent’s')
    const b = await animal(kid)
    const s2 = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: b.id, data: { name: 'x' } })
    await payload.delete({ collection: 'animals' as never, id: b.id, overrideAccess: true, req: reqAs(kid) })
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request: s2.request }))).toBe('gone')
    expect(await pendingCount(payload, kid.id)).toBe(1)
  })

  it('keeps a declined suggestion for good: the minor can reopen it and approve it later; the guardian can withdraw a pending one', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'Nice' } })
    await declineSuggestion(payload, { minor: kid, request })
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request }))).toBe('notPending')
    expect(await refusedCode(reopenSuggestion(payload, { minor: parent, request }))).toBe('notFound')
    await reopenSuggestion(payload, { minor: kid, request })
    await approveSuggestion(payload, { minor: kid, request })
    expect(((await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc).name).toBe('Nice')
    const s2 = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'Oops' } })
    expect(await refusedCode(withdrawSuggestion(payload, { guardian: kid, request: s2.request }))).toBe('notFound')
    await withdrawSuggestion(payload, { guardian: parent, request: s2.request })
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request: s2.request }))).toBe('notPending')
    // Suggestions never expire: there's no expiry on them at all.
    const doc = (await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc
    expect(doc.expiresAt ?? null).toBeNull()
  })

  it('refuses a suggestion from someone who isn’t the minor’s guardian', async () => {
    const kid = await make(FUTURE)
    const a = await animal(kid)
    expect(await refusedCode(suggest(payload, { guardian: await make(), minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } }))).toBe('notGuardian')
  })
})

describe('requests from the minor to a guardian', () => {
  it('goes to every guardian; the first decision wins, and approving applies it as one step', async () => {
    const [p1, p2] = [await make(), await make()]
    const kid = await make(FUTURE)
    await link(p1, kid)
    await link(p2, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'project-1' })
    const results = await Promise.all([decideApproval(payload, { guardian: p1, request, approve: true }), decideApproval(payload, { guardian: p2, request, approve: false })].map(refusedCode))
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    const doc = (await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc
    const joined = await payload.count({ collection: 'joined' as never, where: { who: { equals: String(kid.id) } } as never, overrideAccess: true })
    expect(joined.totalDocs).toBe(doc.status === 'approved' ? 1 : 0)
  })

  it('leaves the request pending when apply fails, refuses strangers, and expires', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'p' })
    expect(await refusedCode(decideApproval(payload, { guardian: await make(), request, approve: true }))).toBe('notFound')
    applyThrows = true
    await expect(decideApproval(payload, { guardian: parent, request, approve: true })).rejects.toThrow()
    applyThrows = false
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc).status).toBe('pending')
    await payload.update({ collection: 'guardian-requests' as never, id: request as string, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true })
    expect(await refusedCode(decideApproval(payload, { guardian: parent, request, approve: true }))).toBe('expired')
    expect(await refusedCode(requestApproval(payload, { minor: await make(FUTURE), kind: 'join-project' }))).toBe('noGuardian')
    expect(await refusedCode(requestApproval(payload, { minor: kid, kind: 'made-up' }))).toBe('unknownKind')
  })
})

describe('access and records', () => {
  it('shows links and requests only to their two sides and to staff; nobody writes them through the API', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    const a = await animal(kid)
    await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    const as = (u: User) => ({ overrideAccess: false, user: u as never })
    const stranger = await make()
    const staff = await make(null, 'staff')
    for (const slug of ['guardianships', 'guardian-requests']) {
      expect((await payload.find({ collection: slug as never, where: { minor: { equals: kid.id } } as never, ...as(stranger) })).docs).toHaveLength(0)
      expect((await payload.find({ collection: slug as never, where: { minor: { equals: kid.id } } as never, ...as(kid) })).docs.length).toBeGreaterThan(0)
      expect((await payload.find({ collection: slug as never, where: { minor: { equals: kid.id } } as never, ...as(parent) })).docs.length).toBeGreaterThan(0)
      expect((await payload.find({ collection: slug as never, where: { minor: { equals: kid.id } } as never, ...as(staff) })).docs.length).toBeGreaterThan(0)
    }
    await expect(payload.update({ collection: 'guardianships' as never, id: g as string, data: { status: 'ended' } as never, ...as(parent) })).rejects.toThrow()
    await expect(payload.create({ collection: 'guardianships' as never, data: { guardian: stranger.id, minor: kid.id, status: 'active', startedAt: new Date().toISOString() } as never, ...as(stranger) })).rejects.toThrow()
    await expect(payload.find({ collection: 'guardian-codes' as never, ...as(staff) })).rejects.toThrow()
  })

  it('records events with references only', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'A private note' } })
    const text = JSON.stringify(events)
    expect(text).not.toMatch(/A private note|2099/)
    expect(events.map((e) => e.type)).toEqual(['link-made', 'suggested'])
  })
})

describe('what the security read found', () => {
  it('refuses a guardian’s create whose owner a later site hook fills in (checked again after the write)', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    expect(await refusedCode(payload.create({ collection: 'diary' as never, data: { text: 'by the parent' } as never, overrideAccess: true, req: reqAs(parent, kid) }))).toBe('suggestionRequired')
    expect((await payload.count({ collection: 'diary' as never, where: { keeper: { equals: kid.id } } as never, overrideAccess: true })).totalDocs).toBe(0)
    await payload.create({ collection: 'diary' as never, data: { text: 'by the kid' } as never, overrideAccess: true, req: reqAs(kid) })
  })

  it('refuses a guardian’s bulk update when a later hook sets the owner, with nothing saved', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const mine = (await payload.create({ collection: 'diary' as never, data: { keeper: parent.id, text: 'the parent’s own' } as never, overrideAccess: true, req: reqAs(parent) })) as Doc
    // The site hook moves it to the kid (the acting-for header), in a bulk update by where.
    expect(await refusedCode(payload.update({ collection: 'diary' as never, where: { id: { equals: mine.id } } as never, data: { keeper: null, text: 'moved' } as never, overrideAccess: true, req: reqAs(parent, kid) }))).toBe('suggestionRequired')
    const after = (await payload.findByID({ collection: 'diary' as never, id: mine.id, overrideAccess: true, depth: 0 })) as Doc
    expect([String(after.keeper), after.text]).toEqual([String(parent.id), 'the parent’s own'])
    // A hook on another field that moves the owner, in a bulk update: refused before anything runs.
    expect(await refusedCode(payload.update({ collection: 'diary' as never, where: { id: { equals: mine.id } } as never, data: { text: 'move me' } as never, overrideAccess: true, req: reqAs(parent, kid) }))).toBe('suggestionRequired')
    const still = (await payload.findByID({ collection: 'diary' as never, id: mine.id, overrideAccess: true, depth: 0 })) as Doc
    expect(String(still.keeper)).toBe(String(parent.id))
    // The same field hook in a single update is caught after the write, inside its transaction.
    expect(await refusedCode(payload.update({ collection: 'diary' as never, id: mine.id, data: { text: 'move me' } as never, overrideAccess: true, req: reqAs(parent, kid) }))).toBe('suggestionRequired')
    expect(String(((await payload.findByID({ collection: 'diary' as never, id: mine.id, overrideAccess: true, depth: 0 })) as Doc).keeper)).toBe(String(parent.id))
    // Someone who isn't anyone's guardian can still bulk-update their own records.
    const loner = await make()
    const theirs = (await payload.create({ collection: 'diary' as never, data: { keeper: loner.id, text: 'a' } as never, overrideAccess: true, req: reqAs(loner) })) as Doc
    const ok = await payload.update({ collection: 'diary' as never, where: { id: { equals: theirs.id } } as never, data: { text: 'b' } as never, overrideAccess: true, req: reqAs(loner) })
    expect(ok.docs).toHaveLength(1)
    // If it can't tell whether the writer is a guardian, a bulk update is refused.
    const spy = vi.spyOn(payload, 'count').mockRejectedValue(new Error('made-up outage'))
    expect(await refusedCode(payload.update({ collection: 'diary' as never, where: { id: { equals: theirs.id } } as never, data: { text: 'c' } as never, overrideAccess: true, req: reqAs(loner) }))).toBe('suggestionRequired')
    spy.mockRestore()
  })

  it('won’t start with an owner field that has its own beforeChange hook', () => {
    expect(() =>
      guardiansPlugin({ isMinor: () => false, access: { manage: () => true }, actingFor: () => null, records: [{ collection: 'x', ownerField: 'owner' }] } as never)({
        collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'x', fields: [{ name: 'owner', type: 'text', hooks: { beforeChange: [() => 'someone'] } }] }],
      } as never),
    ).toThrow(/its own beforeChange hook/)
  })

  it('won’t start with an owner field it can’t read for certain, or without actingFor', async () => {
    const cfg = (fields: object[], records: object[], extra: object = {}) =>
      guardiansPlugin({ isMinor: () => false, access: { manage: () => true }, actingFor: () => null, records, ...extra } as never)({ collections: [{ slug: 'users', auth: true, fields: [] }, { slug: 'x', fields }] } as never)
    expect(() => cfg([{ name: 'owner', type: 'relationship', relationTo: 'users', hasMany: true }], [{ collection: 'x', ownerField: 'owner' }])).toThrow(/single relationship/)
    expect(() => cfg([{ name: 'owner', type: 'relationship', relationTo: ['users', 'x'] }], [{ collection: 'x', ownerField: 'owner' }])).toThrow(/single relationship/)
    expect(() => cfg([{ name: 'owner', type: 'text' }], [{ collection: 'x', ownerField: 'owner' }], { actingFor: undefined })).toThrow(/actingFor/)
  })

  it('treats an age it can’t tell as no: no guardian access, and no link', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: 'THROW' } as never, overrideAccess: true })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false)
    const unsure = await make('THROW')
    const { code } = await createLinkCode(payload, { user: await make() })
    expect(await refusedCode(useLinkCode(payload, { user: unsure, code }))).toBe('unknownAge')
  })

  it('tells the kid’s other guardians when a new link is made', async () => {
    const [p1, p2] = [await make(), await make()]
    const kid = await make(FUTURE)
    await link(p1, kid)
    notices.length = 0
    await link(p2, kid)
    expect(notices.filter((n) => n.kind === 'guardians:link-made').map((n) => n.to).sort()).toEqual([String(p1.id), String(p2.id), String(kid.id)].sort())
  })

  it('makes only one link when the same adult enters two of a kid’s codes at once', async () => {
    const kid = await make(FUTURE)
    const parent = await make()
    const codes = await Promise.all([createLinkCode(payload, { user: kid }), createLinkCode(payload, { user: kid })])
    await Promise.all(codes.map(({ code }) => refusedCode(useLinkCode(payload, { user: parent, code }))))
    expect((await payload.count({ collection: 'guardianships' as never, where: { and: [{ minor: { equals: kid.id } }, { status: { equals: 'active' } }] } as never, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('checks the manage rule before ending a link as staff, and only staff set a kid limit', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    expect(await refusedCode(endLink(payload, { user: await make(), guardianship: g, asStaff: true }))).toBe('notFound')
    expect(await refusedCode(setKidLimit(payload, { user: parent, guardian: parent.id, limit: 9 }))).toBe('notAllowed')
    await setKidLimit(payload, { user: await make(null, 'staff'), guardian: parent.id, limit: 9 })
    const member = await make()
    const seen = (await payload.find({ collection: 'guardianships' as never, where: { guardian: { equals: parent.id } } as never, overrideAccess: false, user: parent as never })).docs[0] as Doc
    expect(seen.kidLimit).toBeUndefined()
    void member
  })

  it('withdraws an ex-guardian’s pending suggestions when the link ends', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    const a = await animal(kid)
    await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project' })
    await endLink(payload, { user: kid, guardianship: g })
    expect(await pendingCount(payload, kid.id)).toBe(0)
    // The ex-guardian no longer reads the kid's requests.
    expect((await payload.find({ collection: 'guardian-requests' as never, where: { id: { equals: request } } as never, overrideAccess: false, user: parent as never })).docs).toHaveLength(0)
  })

  it('lets a guardian read requests sent to them, and applies an approval as the minor', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'p' })
    expect((await payload.find({ collection: 'guardian-requests' as never, where: { id: { equals: request } } as never, overrideAccess: false, user: parent as never })).docs).toHaveLength(1)
    expect((await payload.find({ collection: 'guardian-requests' as never, where: { id: { equals: request } } as never, overrideAccess: false, user: (await make()) as never })).docs).toHaveLength(0)
    await decideApproval(payload, { guardian: parent, request, approve: true })
    expect(String(applySawUser)).toBe(String(kid.id))
  })

  it('keeps an existing record’s time when an edit is approved, and keeps an expired request expired', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = (await payload.create({ collection: 'animals' as never, data: { keeper: kid.id, name: 'G', fedAt: '2026-01-01T00:00:00.000Z' } as never, overrideAccess: true })) as Doc
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'Renamed' } })
    await approveSuggestion(payload, { minor: kid, request })
    expect(new Date(((await payload.findByID({ collection: 'animals' as never, id: a.id, overrideAccess: true })) as Doc).fedAt).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    const r = await requestApproval(payload, { minor: kid, kind: 'join-project' })
    await payload.update({ collection: 'guardian-requests' as never, id: r.request as string, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true })
    await decideApproval(payload, { guardian: parent, request: r.request, approve: true }).catch(() => undefined)
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: r.request as string, overrideAccess: true })) as Doc).status).toBe('expired')
  })

  it('closes the gaps the mutation check found: other sign-in collections, moved records, self-suggestions', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    // A device account with the guardian's id is someone else, not the guardian.
    const device = { id: parent.id, collection: 'devices' }
    await payload.update({ collection: 'animals' as never, id: a.id, data: { name: 'device' } as never, overrideAccess: true, req: { user: device, headers: new Headers(), payload } as never })
    // A record moved to someone else since the suggestion can't be approved.
    const { request } = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    await payload.update({ collection: 'animals' as never, id: a.id, data: { keeper: (await make()).id } as never, overrideAccess: true })
    expect(await refusedCode(approveSuggestion(payload, { minor: kid, request }))).toBe('gone')
    // A kid can't "suggest" to themself.
    expect(await refusedCode(suggest(payload, { guardian: kid, minor: kid.id, collection: 'animals', operation: 'create', data: {} }))).toBe('notGuardian')
  })
})

describe('the final security read', () => {
  const rest = async (user: User, path: string) => {
    const { token } = await payload.login({ collection: 'users', data: { email: user.email as string, password: 'a made-up password' } })
    return handleEndpoints({ config, request: new Request(`http://localhost/api${path}`, { headers: { Authorization: `JWT ${token}` } }) })
  }

  it('refuses, never a 500, when the site’s manage rule throws', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    const broken = await make(null, 'throws')
    expect((await rest(parent, '/guardianships')).status).toBe(200)
    expect((await rest(broken, '/guardianships')).status).toBe(403)
    expect(await refusedCode(endLink(payload, { user: broken, guardianship: g, asStaff: true }))).toBe('notFound')
    expect(await refusedCode(setKidLimit(payload, { user: broken, guardian: parent.id, limit: 9 }))).toBe('notAllowed')
    // A side of the link whose manage answer throws reads nothing, and the kid limit stays hidden.
    const brokenParent = await make(null, 'throws')
    await link(brokenParent, await make(FUTURE))
    expect((await rest(brokenParent, '/guardianships')).status).toBe(403)
    expect(((await payload.findByID({ collection: 'guardianships' as never, id: g as string, overrideAccess: true })) as Doc).status).toBe('active')
  })

  it('lets a guardian decide only while they may act for the kid: not after the kid comes of age, and not when the guardian’s age is unknown', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'grown' })
    // The kid turns 18 before the daily run has ended the link.
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: PAST } as never, overrideAccess: true })
    expect(await refusedCode(decideApproval(payload, { guardian: parent, request, approve: true }))).toBe('notFound')
    expect((await payload.count({ collection: 'joined' as never, where: { what: { equals: 'grown' } } as never, overrideAccess: true })).totalDocs).toBe(0)
    // A guardian whose own age can't be told.
    const unsure = await make()
    const kid2 = await make(FUTURE)
    await link(unsure, kid2)
    const r2 = await requestApproval(payload, { minor: kid2, kind: 'join-project', ref: 'unsure' })
    await payload.update({ collection: 'users', id: unsure.id, data: { minorUntil: 'THROW' } as never, overrideAccess: true })
    expect(await refusedCode(decideApproval(payload, { guardian: { ...unsure, minorUntil: 'THROW' }, request: r2.request, approve: true }))).toBe('notFound')
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: r2.request as string, overrideAccess: true })) as Doc).status).toBe('pending')
    // The kid can't decide their own request: canActAs says self, which isn't a guardian.
    const kid3 = await make(FUTURE)
    await link(await make(), kid3)
    const r3 = await requestApproval(payload, { minor: kid3, kind: 'join-project', ref: 'self' })
    expect(await refusedCode(decideApproval(payload, { guardian: kid3, request: r3.request, approve: true }))).toBe('notFound')
  })

  it('knows a lost race by its code or by its label, also on a cause', () => {
    expect(lostRace({ code: 112 })).toBe(true)
    expect(lostRace({ codeName: 'WriteConflict' })).toBe(true)
    expect(lostRace({ errorLabels: ['TransientTransactionError'] })).toBe(true)
    expect(lostRace({ errorLabelSet: new Set(['TransientTransactionError']) })).toBe(true)
    expect(lostRace(new Error('wrapped', { cause: { code: 112 } }))).toBe(true)
    expect(lostRace(new Error('something else'))).toBe(false)
    expect(lostRace({ code: 11000 })).toBe(false)
  })

  it('stops an ex-guardian reading a request they decided, and still lets them read their own past suggestions', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'decided' })
    await decideApproval(payload, { guardian: parent, request, approve: false })
    const a = await animal(kid)
    const s = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    const read = (u: User, id: unknown) => payload.find({ collection: 'guardian-requests' as never, where: { id: { equals: id } } as never, overrideAccess: false, user: u as never })
    expect((await read(parent, request)).docs).toHaveLength(1)
    // Who decided is for managers only.
    expect(((await read(kid, request)).docs[0] as Doc).decidedBy).toBeUndefined()
    const seenByStaff = ((await read(await make(null, 'staff'), request)).docs[0] as Doc).decidedBy
    expect(String(seenByStaff?.id ?? seenByStaff)).toBe(String(parent.id))
    await endLink(payload, { user: kid, guardianship: g })
    expect((await read(parent, request)).docs).toHaveLength(0)
    expect((await read(parent, s.request)).docs).toHaveLength(1)
    expect((await read(kid, request)).docs).toHaveLength(1)
  })

  it('answers notPending, with a 409, to the loser of two decisions at once, never a database error', async () => {
    const seen: string[] = []
    const statuses: number[] = []
    const code = async (p: Promise<unknown>) => {
      try {
        await p
        return 'ok'
      } catch (e) {
        statuses.push((e as { status?: number }).status ?? 0)
        return (e as { code?: string }).code ?? String((e as { codeName?: string }).codeName ?? (e as Error).message)
      }
    }
    for (let i = 0; i < 4; i++) {
      const [p1, p2] = [await make(), await make()]
      const kid = await make(FUTURE)
      await link(p1, kid)
      await link(p2, kid)
      const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: `race-${i}` })
      const r = await Promise.all([code(decideApproval(payload, { guardian: p1, request, approve: true })), code(decideApproval(payload, { guardian: p2, request, approve: true }))])
      expect(r.filter((x) => x === 'ok')).toHaveLength(1)
      expect((await payload.count({ collection: 'joined' as never, where: { what: { equals: `race-${i}` } } as never, overrideAccess: true })).totalDocs).toBe(1)
      seen.push(...r)
      const a = await animal(kid)
      const sg = await suggest(payload, { guardian: p1, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: `n${i}` } })
      const r2 = await Promise.all([code(approveSuggestion(payload, { minor: kid, request: sg.request })), code(approveSuggestion(payload, { minor: kid, request: sg.request }))])
      expect(r2.filter((x) => x === 'ok')).toHaveLength(1)
      seen.push(...r2)
    }
    expect(seen.filter((x) => x !== 'ok').every((x) => x === 'notPending')).toBe(true)
    expect(statuses.every((s) => s === 409)).toBe(true)
  })

  it('closes the gaps the last mutation check found', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)

    // An owner value the guard can't read (a localized field's { en: id }, an array) is refused, even from someone unlinked.
    const hook = guardBeforeChange('keeper')
    const stranger = await make()
    for (const keeper of [{ en: kid.id }, [kid.id]]) expect(await refusedCode(Promise.resolve(hook({ data: { keeper }, req: reqAs(stranger) } as never)))).toBe('suggestionRequired')
    await hook({ data: { keeper: stranger.id }, req: reqAs(stranger) } as never)

    // canActAs needs the actor known to be an adult.
    await payload.update({ collection: 'users', id: parent.id, data: { minorUntil: 'THROW' } as never, overrideAccess: true })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false)
    await payload.update({ collection: 'users', id: parent.id, data: { minorUntil: null } as never, overrideAccess: true })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(true)

    // An isMinor answer that isn't a boolean counts as unknown: no link, and no guardian access.
    const { code } = await createLinkCode(payload, { user: await make() })
    expect(await refusedCode(useLinkCode(payload, { user: await make('ODD'), code }))).toBe('unknownAge')
    const { code: kidCode } = await createLinkCode(payload, { user: await make(FUTURE) })
    expect(await refusedCode(useLinkCode(payload, { user: await make('NULL'), code: kidCode }))).toBe('unknownAge')
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: 'ODD' } as never, overrideAccess: true })
    expect((await canActAs(payload, { actor: parent.id, target: kid.id })).allowed).toBe(false)
    await payload.update({ collection: 'users', id: kid.id, data: { minorUntil: FUTURE } as never, overrideAccess: true })

    // A manage answer that's truthy but not exactly true doesn't reveal the kid limit.
    const truthy = await make(null, 'truthy')
    await link(truthy, await make(FUTURE))
    await setKidLimit(payload, { user: await make(null, 'staff'), guardian: truthy.id, limit: 7 })
    const own = (await payload.find({ collection: 'guardianships' as never, where: { guardian: { equals: truthy.id } } as never, overrideAccess: false, user: truthy as never })).docs[0] as Doc
    expect(own.kidLimit).toBeUndefined()
    void g
  })

  it('lets only the first decision through even when a decision reads a stale pending status', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'stale' })
    await decideApproval(payload, { guardian: parent, request, approve: true })
    const a = await animal(kid)
    const sg = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'once' } })
    await approveSuggestion(payload, { minor: kid, request: sg.request })
    // Each read of a request says pending, as a read made just before another decision committed would.
    const findByID = payload.findByID.bind(payload)
    const spy = vi.spyOn(payload, 'findByID').mockImplementation((async (args: { collection: string }) => {
      const doc = (await findByID(args as never)) as Doc | null
      return args.collection === 'guardian-requests' && doc ? { ...doc, status: 'pending' } : doc
    }) as never)
    try {
      expect(await refusedCode(decideApproval(payload, { guardian: parent, request, approve: true }))).toBe('notPending')
      expect(await decideApproval(payload, { guardian: parent, request, approve: true }).catch((e: { status?: number }) => e.status)).toBe(409)
      expect(await refusedCode(approveSuggestion(payload, { minor: kid, request: sg.request, replace: true }))).toBe('notPending')
    } finally {
      spy.mockRestore()
    }
    expect((await payload.count({ collection: 'joined' as never, where: { what: { equals: 'stale' } } as never, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('checks expiry again inside the decision’s transaction', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'late' })
    // Inside the caller's transaction the request has expired; outside it, not yet.
    const transactionID = await payload.db.beginTransaction()
    const req = { payload, transactionID } as unknown as PayloadRequest
    try {
      await payload.update({ collection: 'guardian-requests' as never, id: request as string, data: { expiresAt: new Date(Date.now() - 1000).toISOString() } as never, overrideAccess: true, req })
      expect(await refusedCode(decideApproval(payload, { guardian: parent, request, approve: true, req }))).toBe('expired')
      expect((await payload.count({ collection: 'joined' as never, where: { what: { equals: 'late' } } as never, overrideAccess: true, req })).totalDocs).toBe(0)
    } finally {
      await payload.db.rollbackTransaction(transactionID!)
    }
  })

  it('ends a deleted account’s links, so a deleted guardian stops holding one of the kid’s places', async () => {
    const [p1, p2] = [await make(), await make()]
    const kid = await make(FUTURE)
    const g1 = await link(p1, kid)
    await link(p2, kid)
    const a = await animal(kid)
    await suggest(payload, { guardian: p1, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    expect(await refusedCode(link(await make(), kid))).toBe('tooManyGuardians')
    notices.length = 0
    await payload.delete({ collection: 'users', id: p1.id, overrideAccess: true })
    const ended = (await payload.findByID({ collection: 'guardianships' as never, id: g1 as string, overrideAccess: true, depth: 0 })) as Doc
    expect([ended.status, ended.endReason]).toEqual(['ended', 'account-deleted'])
    expect(await pendingCount(payload, kid.id)).toBe(0)
    expect(notices.some((n) => n.to === String(kid.id) && n.kind === 'guardians:link-ended')).toBe(true)
    expect(await refusedCode(link(await make(), kid))).toBe('ok')
    // A deleted minor's links end too, freeing the guardian's place.
    const kid2 = await make(FUTURE)
    const g2 = await link(p2, kid2)
    await payload.delete({ collection: 'users', id: kid2.id, overrideAccess: true })
    expect(((await payload.findByID({ collection: 'guardianships' as never, id: g2 as string, overrideAccess: true, depth: 0 })) as Doc).endReason).toBe('account-deleted')
  })

  it('refuses a suggestion whose data is over 64 KB, with a plain error', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const a = await animal(kid)
    const try_ = (n: number) => suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x'.repeat(n) } })
    expect(await refusedCode(try_(64 * 1024))).toBe('tooLarge')
    expect(await refusedCode(try_(60 * 1024))).toBe('ok')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(await refusedCode(suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: circular }))).toBe('badData')
  })

  it('answers busy, not notPending, when a write conflict has nothing to do with another decision', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    await link(parent, kid)
    const { request } = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'busy' })
    applyConflicts = true
    const failed = (await decideApproval(payload, { guardian: parent, request, approve: true }).catch((e: unknown) => e)) as { code?: string; status?: number }
    applyConflicts = false
    expect([failed?.code, failed?.status]).toEqual(['busy', 409])
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc).status).toBe('pending')
    await decideApproval(payload, { guardian: parent, request, approve: true })
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: request as string, overrideAccess: true })) as Doc).status).toBe('approved')
    expect((await payload.count({ collection: 'joined' as never, where: { what: { equals: 'busy' } } as never, overrideAccess: true })).totalDocs).toBe(1)
  })

  it('keeps the account and its links when the delete fails partway (onEvent throws)', async () => {
    const parent = await make()
    const kid = await make(FUTURE)
    const g = await link(parent, kid)
    const a = await animal(kid)
    const sg = await suggest(payload, { guardian: parent, minor: kid.id, collection: 'animals', operation: 'update', id: a.id, data: { name: 'x' } })
    const r = await requestApproval(payload, { minor: kid, kind: 'join-project', ref: 'kept' })
    eventThrows = true
    await expect(payload.delete({ collection: 'users', id: parent.id, overrideAccess: true })).rejects.toThrow()
    eventThrows = false
    expect(await payload.findByID({ collection: 'users', id: parent.id, overrideAccess: true, disableErrors: true })).not.toBeNull()
    expect(((await payload.findByID({ collection: 'guardianships' as never, id: g as string, overrideAccess: true })) as Doc).status).toBe('active')
    expect(((await payload.findByID({ collection: 'guardian-requests' as never, id: sg.request as string, overrideAccess: true })) as Doc).status).toBe('pending')
    const audience = (((await payload.findByID({ collection: 'guardian-requests' as never, id: r.request as string, overrideAccess: true, depth: 0 })) as Doc).audience ?? []) as unknown[]
    expect(audience.map(String)).toContain(String(parent.id))
  })
})


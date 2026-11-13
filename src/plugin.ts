import type { Access, CollectionConfig, Config, Plugin } from 'payload'

import { guardAfterChange, guardBeforeChange, guardBeforeDelete, guardBulkUpdate } from './act.js'
import { codesCollection, guardianshipsCollection, requestsCollection } from './collections.js'
import { endLinksOfDeleted } from './links.js'
import type { GuardiansOptions, Resolved } from './types.js'

/** Words for the plugin's notices, when the Notifications plugin is installed. They carry no names or ages. */
const KINDS = {
  'guardians:link-made': { text: () => 'A guardian link was made with your account.', email: () => ({ subject: 'A guardian link was made', text: 'A guardian link was made with your account.' }), required: true, group: 'Guardians' },
  'guardians:link-ended': { text: () => 'A guardian link with your account ended.', email: () => ({ subject: 'A guardian link ended', text: 'A guardian link with your account ended.' }), required: true, group: 'Guardians' },
  'guardians:came-of-age': { text: () => 'You’re an adult on this site now, so your guardian links have ended.', group: 'Guardians' },
  'guardians:suggestion': { text: () => 'Your guardian suggested a change. You decide.', group: 'Guardians' },
  'guardians:suggestion-decided': { text: (p: Record<string, string>) => `Your suggestion was ${p.decision === 'approved' ? 'approved' : 'declined'}.`, group: 'Guardians' },
  'guardians:approval-requested': { text: (p: Record<string, string>) => `Your kid asked you to approve: ${p.what ?? 'a request'}.`, email: (p: Record<string, string>) => ({ subject: 'Your kid asked for your approval', text: `Your kid asked you to approve: ${p.what ?? 'a request'}.` }), group: 'Guardians', priority: 'high' as const },
  'guardians:approval-decided': { text: (p: Record<string, string>) => `Your guardian ${p.decision === 'approved' ? 'approved' : 'declined'} your request.`, group: 'Guardians' },
}

/**
 * Guardians: links between a guardian's account and a minor's, made by a code handed over in person; `canActAs`;
 * a guardian's writes to a minor's records refused and turned into suggestions the minor decides (the kid always decides); and
 * requests from the minor to a guardian.
 */
export const guardiansPlugin =
  (options: GuardiansOptions): Plugin =>
  (config: Config): Config => {
    const o: Resolved = {
      users: options.users ?? config.admin?.user ?? 'users',
      guardianships: options.slugs?.guardianships ?? 'guardianships',
      codes: options.slugs?.codes ?? 'guardian-codes',
      requests: options.slugs?.requests ?? 'guardian-requests',
      isMinor: options.isMinor,
      manage: options?.access?.manage as Access,
      actingFor: options.actingFor,
      records: options.records ?? [],
      approvals: options.approvals ?? {},
      maxGuardians: options.maxGuardians ?? 2,
      maxKids: options.maxKids ?? 5,
      codeHours: options.codeHours ?? 168,
      codesPerDay: options.codesPerDay ?? 10,
      onEvent: options.onEvent,
      onNotice: options.onNotice,
      adminGroup: options.adminGroup ?? 'Guardians',
    }
    // Fail closed: no rule for who's a minor, or for who manages, means nothing works rather than everything.
    if (typeof o.isMinor !== 'function') throw new Error('Guardians: give `isMinor`, saying who is a minor now (for example from Age Gate’s minorUntil).')
    if (typeof o.manage !== 'function') throw new Error('Guardians: give `access.manage`, saying who may see every link and request.')
    // A switcher that acts as another account must say so, or a guardian acting as the kid would look like the kid.
    if (typeof o.actingFor !== 'function') throw new Error('Guardians: give `actingFor`, saying who is acting for whom when your site lets one account act as another (return null when it doesn’t).')
    const collections = config.collections ?? []
    if (!collections.some((c) => c.slug === o.users && c.auth)) throw new Error(`Guardians: "${o.users}" isn't an auth collection in this config. Set \`users\`.`)
    for (const r of o.records) {
      const c = collections.find((x) => x.slug === r.collection)
      if (!c) throw new Error(`Guardians: records names "${r.collection}", which isn't a collection.`)
      const field = c.fields.find((f) => 'name' in f && f.name === r.ownerField) as { type?: string; relationTo?: unknown; hasMany?: boolean } | undefined
      if (!field) throw new Error(`Guardians: "${r.collection}" has no field "${r.ownerField}".`)
      // Only owner fields the guard can read for certain: one user, by relationship or id text.
      const oneUser = field.type === 'relationship' && field.relationTo === o.users && !field.hasMany
      // Field hooks run after collection hooks, so one on the owner field could change it after the last check.
      if ((field as { hooks?: { beforeChange?: unknown[] } }).hooks?.beforeChange?.length) throw new Error(`Guardians: "${r.collection}.${r.ownerField}" has its own beforeChange hook, which could change the owner after the guard checks it. Move that logic to a collection hook.`)
      if (!oneUser && field.type !== 'text') throw new Error(`Guardians: "${r.collection}.${r.ownerField}" must be a single relationship to "${o.users}" (not hasMany or to several collections), or a text id.`)
    }
    const clash = collections.filter((c) => [o.guardianships, o.codes, o.requests].includes(c.slug)).map((c) => c.slug)
    if (clash.length) throw new Error(`Guardians: ${clash.join(', ')} already exist in this config. Give Guardians other slugs with \`slugs\`.`)

    const guarded = collections.map((c0): CollectionConfig => {
      // A deleted account's links end, so a deleted guardian stops holding one of a minor's places.
      const c = c0.slug === o.users ? { ...c0, hooks: { ...c0.hooks, afterDelete: [...(c0.hooks?.afterDelete ?? []), endLinksOfDeleted] } } : c0
      const r = o.records.find((x) => x.collection === c.slug)
      if (!r) return c
      return {
        ...c,
        hooks: {
          ...c.hooks,
          // First and last. The first is deliberate defense in depth: it refuses before the site's own beforeChange hooks
          // run, so a guardian's write never reaches them. The last sees the owner after every site hook,
          // before anything is written, which matters for bulk updates (Payload doesn't roll back one document of
          // a bulk update when it fails).
          beforeChange: [guardBeforeChange(r.ownerField), ...(c.hooks?.beforeChange ?? []), guardBeforeChange(r.ownerField)],
          afterChange: [...(c.hooks?.afterChange ?? []), guardAfterChange(r.ownerField)],
          beforeOperation: [guardBulkUpdate, ...(c.hooks?.beforeOperation ?? [])],
          beforeDelete: [guardBeforeDelete(c.slug, r.ownerField), ...(c.hooks?.beforeDelete ?? [])],
        },
      }
    })
    const custom = config.custom ?? {}
    return {
      ...config,
      custom: {
        ...custom,
        guardians: o,
        // Registered for the Notifications plugin when it's there; ignored otherwise. No import either way.
        notificationKinds: [...((custom.notificationKinds as unknown[]) ?? []), { owner: 'guardians', kinds: KINDS }],
      },
      collections: [...guarded, guardianshipsCollection(o), codesCollection(o), requestsCollection(o)],
    }
  }

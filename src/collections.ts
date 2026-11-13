import type { Access, CollectionConfig } from 'payload'

import type { Resolved } from './types.js'
import { managerSays } from './util.js'

const nobody: Access = () => false
const isManager = (o: Resolved) => async (args: Parameters<Access>[0]) => managerSays(args.req.payload, o.manage, args)

/** The two sides of a link or request, and managers. Others see nothing. If the manage rule throws, nobody does. */
const sides =
  (o: Resolved, fields: string[]): Access =>
  async (args) => {
    let manager: boolean
    try {
      manager = (await o.manage(args)) === true
    } catch (error) {
      args.req.payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'guardians: access.manage failed, so this read is refused' })
      return false
    }
    if (manager) return true
    const u = args.req.user
    if (!u || u.collection !== o.users) return false
    return { or: fields.map((f) => ({ [f]: { equals: u.id } })) }
  }

const who = (name: string, o: Resolved) => ({ name, type: 'relationship' as const, relationTo: o.users as never, admin: { readOnly: true } })

export const guardianshipsCollection = (o: Resolved): CollectionConfig => ({
  slug: o.guardianships,
  labels: { singular: 'Guardianship', plural: 'Guardianships' },
  admin: { group: o.adminGroup, defaultColumns: ['guardian', 'minor', 'status', 'startedAt', 'endedAt'] },
  // Every change goes through the plugin's functions, which check the person. Ended links are kept.
  access: { read: sides(o, ['guardian', 'minor']), create: nobody, update: nobody, delete: nobody },
  timestamps: true,
  indexes: [{ fields: ['minor', 'status'] }, { fields: ['guardian', 'status'] }],
  fields: [
    { ...who('guardian', o), required: true, index: true },
    { ...who('minor', o), required: true, index: true },
    { name: 'status', type: 'select', options: ['active', 'ended'], required: true, index: true },
    { name: 'startedAt', type: 'date', required: true },
    { name: 'endedAt', type: 'date' },
    { name: 'endReason', type: 'select', options: ['came-of-age', 'removed-by-guardian', 'removed-by-minor', 'removed-by-staff', 'account-deleted'] },
    who('madeBy', o),
    who('endedBy', o),
    { name: 'kidLimit', type: 'number', min: 1, max: 50, admin: { readOnly: true, description: 'Set by staff with setKidLimit.' }, access: { read: isManager(o) } },
  ],
})

export const codesCollection = (o: Resolved): CollectionConfig => ({
  slug: o.codes,
  admin: { hidden: true },
  access: { read: nobody, create: nobody, update: nobody, delete: nobody },
  timestamps: true,
  fields: [
    { name: 'hash', type: 'text', required: true, unique: true, index: true },
    { ...who('creator', o), required: true, index: true },
    { name: 'role', type: 'select', options: ['guardian', 'minor'], required: true, admin: { description: 'The creator’s side of the link.' } },
    { name: 'expiresAt', type: 'date', required: true, index: true },
    { name: 'usedAt', type: 'date' },
  ],
})

export const requestsCollection = (o: Resolved): CollectionConfig => ({
  slug: o.requests,
  labels: { singular: 'Guardian request', plural: 'Guardian requests' },
  admin: { group: o.adminGroup, defaultColumns: ['direction', 'kind', 'minor', 'status', 'createdAt'] },
  // The minor, the guardian who suggested (to-minor), and the guardians a request went to while they're linked.
  access: { read: sides(o, ['minor', 'guardian', 'audience']), create: nobody, update: nobody, delete: nobody },
  timestamps: true,
  indexes: [{ fields: ['minor', 'status'] }],
  fields: [
    { name: 'direction', type: 'select', options: ['to-minor', 'to-guardian'], required: true, index: true },
    { name: 'kind', type: 'text', required: true },
    { ...who('minor', o), required: true, index: true },
    { ...who('guardian', o), index: true, admin: { readOnly: true, description: 'The guardian who suggested it (to-minor only).' } },
    { name: 'status', type: 'select', options: ['pending', 'approved', 'declined', 'withdrawn', 'expired'], required: true, index: true },
    { name: 'audience', type: 'relationship', relationTo: o.users as never, hasMany: true, index: true, admin: { readOnly: true, description: 'The guardians a request to a guardian went to.' } },
    { name: 'summary', type: 'text' },
    { name: 'ref', type: 'text', admin: { description: 'What a to-guardian request is about (a project id, say).' } },
    { name: 'collectionSlug', type: 'text' },
    { name: 'operation', type: 'select', options: ['create', 'update', 'delete'] },
    { name: 'recordId', type: 'text' },
    // The suggested change: only the two sides and managers read it (the collection's read already says so).
    { name: 'data', type: 'json' },
    { name: 'baseUpdatedAt', type: 'date', admin: { hidden: true } },
    { name: 'suggestedAt', type: 'date', required: true },
    { name: 'expiresAt', type: 'date' },
    { name: 'decidedAt', type: 'date' },
    // Who decided: managers only, so it never widens who reads a request.
    { ...who('decidedBy', o), access: { read: isManager(o) } },
    { name: 'appliedId', type: 'text', admin: { description: 'The record an approved create made.' } },
  ],
})

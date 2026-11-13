import type { Req } from './types.js'
import { configOf, idOf, same } from './util.js'
import { canActAs } from './act.js'

/**
 * `{ kind: 'guardian', id }` when the request is a guardian acting for a minor they're linked to (through the
 * site's switcher), else null. Give it to an audit trail's `via`, so changes made that way say so.
 */
export async function viaGuardian(req: Req): Promise<{ kind: 'guardian'; id: string } | null> {
  try {
    const o = configOf(req.payload!)
    const acting = await o.actingFor?.(req)
    if (!acting || same(acting.actor, acting.target)) return null
    const act = await canActAs(req.payload!, { actor: acting.actor, target: acting.target })
    return act.allowed && act.via === 'guardian' ? { kind: 'guardian', id: String(idOf(acting.actor)) } : null
  } catch {
    return null
  }
}

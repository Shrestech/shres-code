/** Read-only Remote projection of the remote registry for trusted client RPCs. */
import { TypertRemoteService } from '@shres-code/shres-code-typert-protocol';
import type { Context } from '@shres-code/cordis';
import type { RemoteRegistrySnapshot } from './types.ts';
export type { RemoteEntryView, RemoteRegistrySnapshot } from './types.ts';
/**
 * Serve the remote registry as the `remoteControl` Remote namespace. The
 * projection is read-only: mutating and connecting must mount as a separate
 * token-gated namespace, because this service is served identically by local
 * and tunneled remotes and cannot enforce the local user's gesture authority.
 * The Gateway maps business throws to its generic wire failure (message
 * without a typed code), so callers render the message as-is; `registry-corrupt`
 * divergence stays loud server-side.
 */
export declare class RemoteControlGateway extends TypertRemoteService {
    constructor(ctx: Context);
    /**
     * Read the registry file on every call; a missing file is the empty set and
     * never an error, so a fresh installation renders an empty Remote group.
     * @returns Current registry entries in registry order.
     */
    list(): Promise<RemoteRegistrySnapshot>;
}
export default RemoteControlGateway;
//# sourceMappingURL=gateway.d.ts.map
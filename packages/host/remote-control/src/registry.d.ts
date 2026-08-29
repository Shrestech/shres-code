/**
 * Durable remote-alias registry persisted at `$SHRES_HOME/remote/remotes.json`
 * (path explicit at call time). Single-writer serialized through
 * `withFileLock`, committed with `writeFileAtomic` at mode 0600/0700, and
 * schema-validated on every read: unknown on-disk formats fail loud.
 * @module @shres-code/shres-code-host-remote-control
 */
import type { RemoteEntry, RemoteId, RemoteTarget } from './types.ts';
/** Current on-disk registry schema version; bumped only with a format break. */
export declare const REGISTRY_VERSION = 1;
/**
 * Validate an alias and brand it; the registry is a durable file boundary, so
 * charset validation re-runs on every read entry.
 * @param alias - candidate alias.
 * @returns the branded remote id.
 */
export declare function asRemoteId(alias: string): RemoteId;
/**
 * Validate and brand a `user@host` connect target.
 * @param target - candidate target string.
 * @returns the branded remote target.
 */
export declare function asRemoteTarget(target: string): RemoteTarget;
/**
 * Validate the remote daemon port.
 * @param port - candidate port number.
 * @returns the same port.
 */
export declare function asRemotePort(port: number): number;
/**
 * Load and validate the registry; a missing file is an empty registry.
 * @param path - registry file path.
 * @returns parsed entries keyed by alias.
 */
export declare function loadRegistry(path: string): Promise<Map<RemoteId, RemoteEntry>>;
/** On-disk registry document. */
export interface RegistryFile {
    /** Schema version; readers reject other values. */
    version: number;
    /** All alias entries. */
    entries: RemoteEntry[];
}
/**
 * Insert or replace one entry under a read-modify-write lock that reloads
 * current state first, so two `remote add` calls never lose each other.
 * @param path - registry file path.
 * @param entry - entry to persist (replaces by id).
 */
export declare function upsertEntry(path: string, entry: RemoteEntry): Promise<void>;
/**
 * Remove one alias under the same read-modify-write lock as insert.
 * @param path - registry file path.
 * @param id - alias to remove.
 * @returns true when an entry was removed.
 */
export declare function removeEntry(path: string, id: RemoteId): Promise<boolean>;
//# sourceMappingURL=registry.d.ts.map
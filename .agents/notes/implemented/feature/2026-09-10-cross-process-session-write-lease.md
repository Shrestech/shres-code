# Agent Note: Cross-process JSONL session write lease

Status: implemented

## Problem

The JSONL backend excluded a second writer only inside one process. Two harness processes writing one session's log could interleave appends and tear compressed frames and seq contiguity. The persistence seam needed durable cross-process write ownership whose arbiter lives outside every writer process, because no writer outlives every failure mode.

## Decision

`SessionWriteLease` (`packages/session/session-persistence-jsonl/src/lease.ts`) holds a kernel lock on `session.lock` beside the log. POSIX takes a non-blocking `flock(2)` through the existing koffi dependency against the platform libc (`libSystem.B.dylib` on macOS, `libc.so.6` on Linux), passing the numeric fd of an open FileHandle. Windows holds a named kernel semaphore (count 1) derived from the canonical lock path (`CreateSemaphoreW` in `src/win32.ts` beside the existing koffi bindings) — a kernel object with no filesystem footprint, destroyed with its last handle. Contention maps to `SessionWriteAlreadyOwnedError`, exported from `shres-session-persistence` so consumers recognize it without JSONL internals. The kernel releases the lock when the holder's descriptor or handle closes, including on any process death, so a crashed holder never blocks a successor and no expiry bookkeeping exists. A live but wedged holder keeps the lock until its process exits: expropriating a stalled writer was rejected because its resumed appends would tear the log, and on POSIX removing the lock file remains the explicit forfeit for that case. Because a POSIX lock names an inode rather than a path, acquisition verifies the locked inode is still the file at the lock path and retries otherwise. Release never removes the lock file, preserving the stable inode later lockers verify against.

shres has no write-handle seam. The coordinator claims the lock immediately before the first materializing `appendBatch` or `commitRepair`, and when a live session binds to an already-materialized log. A live session keeps the lock until retirement or backend close, which is the exclusion a write handle would give: two processes cannot alternate appends into one log. An ownerless public `append`/`load` is a discrete write, not a handle, so the lock is released when that call returns; another process may then continue the log. Readers (`inspect`, `readFrom`, listings, sync reads) never take the lock. An unmaterialized create leaves no session directory and no lock file.

## Alternatives considered

**TTL record with renewal and claim-by-rename.** A JSON record beside the log carrying an owner token and expiry, renewed on an interval, taken over after expiry. It survives every filesystem but is a distributed algorithm: renewal timers, loss detection, takeover claiming — and residual multi-actor races still allow bounded dual-writer overlap. Kernel arbitration deletes that family, at the cost of the wedged-holder rule above.

**`proper-lockfile` / `fs-ext` / a new native addon.** `proper-lockfile` is the same TTL model. `fs-ext` and a new native addon are out of scope: this repo already depends on koffi in the JSONL package, so POSIX `flock` and the Windows semaphore both go through that FFI.

**fs-ext's Windows `LockFileEx` byte-range locks.** Windows byte-range locks are mandatory, so any reader touching the locked file hard-fails.

**Windows exclusive-open sharing mode.** Leaves readers untouched but pins the lock file's name and directory while held, so recursive removal of a session directory fails with EBUSY. The named semaphore keeps kernel arbitration with zero filesystem footprint.

**Per-call acquire/release around every `appendBatch`.** That would let two live processes alternate appends into one log. Live sessions therefore hold the lock until retirement. Ownerless public `append`/`load` remain discrete writes and release when the call returns, matching this architecture's lack of a write handle.

## Testing

Package specs pin acquisition, contention, release, re-acquisition, inode retry, and the readers-are-unaffected rule. `lease.two-process.e2e.ts` launches a live holder subprocess, proves a second process's write rejects with `SessionWriteAlreadyOwnedError`, and takes over immediately after `SIGKILL`. Windows semaphore paths are unit-tested against mocked koffi; they are not exercised on POSIX hosts.

## Consequences

Cross-process exclusion costs one lock file per materialized POSIX session that release deliberately leaves in place, and the wedged-holder rule: a stuck process blocks that session's writers until it exits. It buys immediate crash recovery (no waiting period) and no renewal traffic. Advisory `flock` is unreliable on some network filesystems (NFSv3); a root on such a mount degrades toward in-process-only exclusion. Deleting a live session's lock file forfeits exclusion on POSIX by design — the harness never does so. Windows lock behavior is implemented and unit-tested against mocked koffi; it is not exercised on POSIX hosts.

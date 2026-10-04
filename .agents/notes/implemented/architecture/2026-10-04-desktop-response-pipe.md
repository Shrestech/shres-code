# Agent Note: Desktop response pipe stays shared without head-of-line stalls

Status: implemented

## Problem

The desktop page cannot open a WebSocket, so session events are a long `POST` body on the same pipe as every API call and asset. The shell paused that pipe when any one response queue held a single unread chunk. A live token stream then froze history fetches, session switches, and the next token behind one unread frame. Each token was also its own pipe frame, copied twice, and the composer shell re-rendered on every snapshot because it subscribed to the whole object. The trajectory projection walked every loaded record on each of those frames even while the Chat tab was the one on screen.

## Decision

The shell keeps reading the response pipe while a slow body has unread bytes. Each body may queue 256 KiB. Further frames for that body wait in a side buffer. The shared pipe pauses only after the shell is holding 2 MiB across every body, and it resumes as the renderer reads. Event downlinks coalesce up to 16 KiB or 8 ms of NDJSON into one chunk, and they wait when that chunk's own queue is full. Response data frames copy each payload once, into the frame buffer. Host stderr kept for the exit diagnostic is capped at 64 KiB.

The composer shell compares the fields its takeover selectors read and skips a render when only chat text changed. Rows still subscribe to their own nodes. The trajectory builder stages node updates and builds its snapshot on read, so a hidden Trajectory tab does not walk the loaded window. Nested `tool/code-dispatch` updates publish on the animation frame. The fetch-stream reader copies the unread tail once per read and yields to the event loop after 32 lines.

## Alternatives considered

- **Pause the shared pipe at the first unread chunk.** That is the behavior this change removes. It made one event stream stall every other response.
- **Give events their own operating-system pipe.** A second pipe would also avoid the stall, and it would split flow control, shutdown, and the frame codec across two carriers. The byte cap keeps one pipe and still bounds memory.
- **Rebuild the trajectory snapshot on every assembler flush.** The Chat tab never reads it. Building on read keeps the open tab current and leaves the hidden tab idle.
- **Subscribe the composer shell to the whole conversation snapshot.** Token text does not change the takeover decision. The per-row subscription already updates the streaming message.

## Consequences

A chat can stream while a history or asset response completes. A reader that never consumes a body holds at most 2 MiB and then applies backpressure to the host, including other responses, until it reads or cancels. The first event in a quiet stretch can wait up to 8 ms to share a frame with the next line. Opening the Trajectory tab pays for one snapshot build of the loaded window at that moment. A code-dispatch update can wait until the next animation frame to appear. The shell keeps only the tail of host stderr, so a long crash log loses its head.

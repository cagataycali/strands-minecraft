# Memory: what killed this process, and how to tell next time

Issue #44. A soak died at **4,050MiB heap / 4,148MiB RSS after exactly 51
minutes**, and the final scavenge stopped the world for **4,338ms to reclaim
5MiB of 4,050MiB** — nearly the whole heap was still *reachable*. That number is
the diagnosis: this was retention, not GC pressure. Nothing was leaking in the
C++ sense; we were holding on.

Two consequences before any code: every soak conclusion we had ever drawn had a
**51-minute shelf life** (soaks #3–#9 all ran 30–50 minutes, so we had never
once observed this bot past its OOM point), and every late-soak *latency* number
was suspect, because a 4.3s GC pause blocks the event loop exactly like six busy
workers and is invisible to a sampler living inside the same loop (#37).

## The cause, in two halves

**Half one — a dead body kept its whole world.** `bot.quit()` closes a socket.
It frees nothing. A mineflayer Bot pins a prismarine world, and the heap
snapshot found **3,343 ChunkColumns / 80,064 ChunkSections / 204MiB of
ArrayBufferData** belonging to bodies that had already left the server. Two
holders: the finished-worker record kept its `body` (`0f0f439`), and nothing
ever emptied the world (`c2d82f7` — `releaseBot()` clears the column store and
entity table *in place* and strips listeners, wired into `retire()` **and**
`revive()`, because every reconnect stranded a world too).

```
♻️ retired body released 637 chunk column(s), 142 entit(ies)
```

**Half two — a living body was too expensive, and this was never a leak at
all.** Nine bodies alive, 513MiB RSS four minutes in. Measured on a real
server, one bot standing still:

| viewDistance | chunk columns | |
|---|---|---|
| mineflayer default | 637 | what every worker used to pay |
| `'short'` | 329 | −48% |
| `'tiny'` | 213 | −67% |
| **3** | **81** | **−87%** ← `FLEET_WORKER_VIEW_DISTANCE` default |
| 2 | 56 | −91% |

A bot at `viewDistance: 3` then **pathfound 60 blocks in 15s with its column
count never leaving 81** — the world unloads behind it as fast as it loads
ahead. So: **travel needs a path, not a horizon.** A horizon is only what you
keep while *standing still*, which is exactly what idle worker bodies were each
paying 637 columns for (`74a2290`, `a7a0a6d`). Live in the running process,
`fleet.columns` reads **341 for the whole crew** where the same crew used to
hold ~3,185.

The OOM was therefore `retained dead bodies × full horizon`. Churn multiplied
both factors, which is why it took ~51 minutes and six workers to reach 4GB.

**And the same defect twice more, found by audit rather than by the next
crash:** a Map whose *disk write* was capped while memory kept everything — the
fleet's worker records (`0f0f439`) and every journey ever run with all its
journal lines, plus stop/doomed flags that outlived their journeys (`0fe791b`).

## Rules

1. **A number that only goes up is the only proof.** Heap sawtooths; a since-boot
   delta is invalidated by one GC (`+5469MiB/h → cap in 43m` printed during a
   perfectly healthy run). Judge a leak by the **post-GC floor** — the minimum
   heap over a window — and nothing else.
2. **Print the heap next to every lag number.** Otherwise a GC pause gets
   reported as load, and you spend a night optimising workers (`47de686`).
3. **Name the collection, not the total.** "Memory grew" starts a hunt; `fleet.workers 22
   while alive 3` ends one. Every long-lived collection reports its own size by
   name, with an alarm cap.
4. **Read a gap over time, not an equality.** `fleet.bodies=3` with
   `census.bots.alive=6` looks damning and is fine: census counts through
   WeakRefs, so a released body stays "alive" until a GC reaches it. Growing gap
   = retention. Gap that comes and goes = uncollected garbage.
5. **Verify the accessor before trusting the probe.** `bot.world` is a *sync
   wrapper*; the columns live at `bot.world.async.columns`. The first probe read
   0 forever and would have "proved" chunks innocent (`cb60db2`), so a boot line
   now prints every collection's size once — "flat at zero" and "wrong property"
   look identical otherwise (`89f4550`).
6. **Closing a connection frees nothing.** If an object owns megabytes, empty it
   explicitly on the way out; the GC cannot help while one reference remains.
7. **Silence a dying emitter before you dismantle it.** `removeAllListeners()`
   removed *mineflayer's own cleanup*: keepalive's 30s timer is cleared by its
   `'end'` listener, so stripping listeners early left the timer to fire, emit
   `error` at an emitter with no error listener, and kill the process
   (`2a2922d`). Free heavy state immediately, install a no-op `error` sink, and
   strip listeners only after `'end'`.
8. **Live state is not history.** Caps apply to what has finished. An unfinished
   journey survives a cap of zero, however old it is.
9. **A running process cannot pick up a fix.** Compare `ps -o lstart=` against
   the commit time before believing anything a soak tells you.
10. **Soak past the failure point.** A leak with a 51-minute fuse is invisible in
    a 40-minute test, and "it survived the whole soak" was only ever true
    because the soak was shorter than the leak.

## The ceilings (Docker)

The stack layers its ceilings on purpose: V8's heap cap (`BOT_HEAP_MB` 2048) sits below the
container's `mem_limit` (`BOT_MEM_LIMIT` 3g), so the collector works hard *before* the kernel
kills the process blind. That only holds while `mem_limit` is below memory that actually exists
— and on Docker Desktop / colima / Rancher the VM defaults to about **4GB for everything**, which
the 2G server JVM (`MC_MEMORY`) plus the 3G bot already overspend. The failure mode is the OOM
killer arriving first: exactly the blind death the heap cap exists to prevent. `memcheck.ts`
audits all three numbers at boot and prints `🚨 memory ceiling is fiction: …` when they don't
hold, so you learn it from a log line instead of a crash. Sizing table and commands: the
README's *Docker VM memory* note under Install.

# MinecraftDwarfFortress — Design Spec

> **Vision:** Play Dwarf Fortress *inside* Minecraft. One world, two engines, both
> authoritative, kept in sync so that mining/building in Minecraft and the living
> simulation of a Dwarf Fortress fort are the *same world* seen two ways.

**Status:** Draft v0.1 — architecture & staged plan. Nothing built yet.
**Authority model:** Model 3 — *both engines authoritative, full two-way sync* (chosen).
**Target host:** Containerized, headless (Colima on the Mac Studio). DF renders to a
dummy X display; nobody looks at DF's own UI.

---

## Table of contents

1. [Goals & non-goals](#1-goals--non-goals)
2. [The core problem](#2-the-core-problem-two-authoritative-sims)
3. [Architecture overview](#3-architecture-overview)
4. [Authority model](#4-authority-model)
5. [Canonical event model](#5-canonical-event-model)
   - [5b. Entities & combat](#5b-entities--combat-cross-engine-interaction)
6. [Conflict resolution](#6-conflict-resolution)
7. [Tick reconciliation & client prediction](#7-tick-reconciliation--client-prediction)
8. [Coordinate & material mapping](#8-coordinate--material-mapping)
   - [8b. Interaction model (UX)](#8b-interaction-model-ux--the-overseer-layer)
9. [Component specs](#9-component-specs)
10. [Container topology](#10-container-topology)
11. [Tech stack & rationale](#11-tech-stack--rationale)
12. [Staged roadmap](#12-staged-roadmap)
13. [Risks & open questions](#13-risks--open-questions)
14. [Glossary](#14-glossary)

---

## 1. Goals & non-goals

### Goals
- A running DF fort is mirrored into a Minecraft world you can walk around in.
- Actions in **either** engine propagate to the other: mine/build in MC affects DF;
  dwarves digging, liquids flowing, and construction in DF affect MC.
- The sync is **eventually consistent** with a *deterministic* conflict policy — no
  "which one randomly won" surprises.
- Every milestone is independently playable/observable (no big-bang integration).

### Non-goals (v1)
- **Perfect fidelity.** DF has hundreds of materials, moods, item wear, engravings; MC
  has redstone and its own mobs. We map what maps and drop the rest. Losses are documented,
  not hidden.
- **MC→DF terrain *generation*.** DF's map is a fixed, bounded, pre-generated structure
  with geology/aquifers/history. We do **not** stream MC's infinite procedural terrain into
  DF. Terrain *authority* lives with DF (see §4). MC→DF is limited to *edits* of existing
  tiles, not world-gen.
- **Multiplayer beyond a handful of players.** Single fort, small player count.
- **The Steam/premium DF build.** DRM makes it hostile to containers. We target the free
  classic build (see §11).

---

## 2. The core problem: two authoritative sims

Both DF and Minecraft are *authoritative simulations* — each believes it owns the world.
Naively syncing block-state between them is unanswerable: if you mine a block in MC the same
tick DF floods that tile with magma, **whose state is true?**

This is a distributed-systems problem, and it does not get solved by translation tables or
Docker. It gets solved by three disciplines, borrowed from distributed databases and game
netcode:

1. **Event sourcing** — sync *events*, not *state*, through one ordered log that is the sole
   arbiter of ordering.
2. **Authority partitioning** — the two engines are not both authoritative over the *same*
   things; ownership is split by domain, shrinking the true-conflict surface to a small set.
3. **Client-side prediction + reconciliation** — the tick-rate mismatch (MC is instant, DF
   digging takes game-time) is handled with optimistic ghost state and rollback, exactly like
   multiplayer netcode.

The rest of this document is the concrete form of those three ideas.

---

## 3. Architecture overview

Neither engine is the source of truth. **The bridge is.** It owns an ordered, append-only
**event log** and a derived **canonical world model**. DF and MC are *clients* that emit
events into the log and apply events out of it.

```
   ┌──────────────┐        ┌───────────────────────────────────┐        ┌──────────────┐
   │  DF + DFHack │        │              BRIDGE               │        │  Minecraft   │
   │              │  RPC   │  ┌─────────────────────────────┐  │  sock  │   server     │
   │  DF adapter  │◀──────▶│  │  ordered append-only log    │  │◀──────▶│  MC adapter  │
   │ (read+write) │  :5000 │  │  canonical world model      │  │ :8686  │ (plugin/     │
   │              │        │  │  conflict resolver          │  │        │  valence)    │
   └──────────────┘        │  │  reconciler (ghost/rollback)│  │        └──────┬───────┘
                           │  └─────────────────────────────┘  │               │
                           └───────────────────────────────────┘          player client
                                    the log is the arbiter
```

- **DF adapter** reads fort state from DFHack and writes designations/commands back.
- **MC adapter** applies block/entity updates and captures player actions.
- **Bridge** ingests events from both, orders them, resolves conflicts, updates the canonical
  model, and emits derived events back out to each engine.

The canonical model is the truth; DF and MC are two *projections* of it that also feed it.

---

## 4. Authority model

"Both authoritative" does **not** mean both own everything. It means each engine is the
authoritative *input* for the domains it simulates best. The log is the arbiter across all of
them. Most of the map is never contested — a magma flow and a player's pickaxe rarely touch
the same tile the same tick — so partitioning collapses the conflict surface to a small hot set.

| Domain | Authoritative owner | Notes |
|---|---|---|
| Geology / ore / raw terrain material | **DF** | DF generated it; MC never invents terrain. |
| Liquids (magma/water), pressure, flow | **DF** | DF's flow model is the physics of record. |
| Temperature, fire, melting/freezing | **DF** | Derived, cached, fragile — DF owns it outright. |
| **DF creatures'** AI, jobs, moods (dwarves, wildlife, invaders) | **DF** | Each engine owns *its own* creatures — see §5b. |
| **MC mobs'** AI (zombies, cows, etc.) | **MC** | MC keeps simulating its own mobs; they exist in DF as interactive puppets. |
| Dwarf/creature economy, world history, civs, invasions | **DF** | Read-only into MC. |
| Player **movement, camera, input** | **MC** | Always — first-person must be responsive; DF-owned position = unplayable lag. |
| Player **body simulation** (needs, health, wounds) | **MC → DF as you climb the depth dial** | Split-authority player; see §5b / §8b. Embodied by design. |
| Player-placed decorative blocks (player zones) | **MC** | See "zones" below. |
| Redstone & MC-native mechanics | **MC** | No DF equivalent; stays MC-local. |
| **Shared terrain edits** (dig / build a tile) | **contested** | Needs an explicit rule — see §6. |

**Zones.** Regions can be flagged `df-managed` (the fort proper — DF owns terrain there) or
`player-sandbox` (MC owns terrain there; DF sees it as inert constructed walls/floors). This
lets a player build freely in MC without fighting DF, while the fort stays DF-authoritative.
Zone assignment is itself an event.

---

## 5. Canonical event model

Everything that happens is an **event** appended to the log. Events are the wire format, the
persistence format, and the reconciliation unit. State is a *fold* over the log.

### Event shape

```jsonc
{
  "id":        1234,                 // monotonic sequence, assigned by the bridge
  "wallTick":  918273,               // bridge wall-clock tick (arbiter ordering)
  "srcTick":   { "df": 45001 },      // originating engine's own tick, if any
  "source":    "df" | "mc" | "bridge",
  "domain":    "terrain" | "liquid" | "unit" | "item" | "player" | "job" | "zone",
  "type":      "tile.dig.designate", // dotted verb, see catalog below
  "pos":       { "x": 10, "y": 64, "z": 12 },   // CANONICAL coords (see §8)
  "payload":   { /* type-specific */ },
  "status":    "proposed" | "in_progress" | "committed" | "rejected",
  "causedBy":  1201                   // links a commit back to its designation/intent
}
```

### Event type catalog (v1 core)

| `type` | source | meaning |
|---|---|---|
| `tile.dig.designate` | mc → | player wants tile removed → becomes a DF dig designation |
| `tile.dig.commit`    | df → | a dwarf finished digging; tile is now open |
| `tile.dig.reject`    | df → | unreachable/undiggable; MC must roll back its ghost |
| `tile.build.designate` | mc → | player placed a block → DF build order |
| `tile.build.commit`  | df → | dwarf finished construction |
| `block.set`          | bridge → mc | authoritative block state for a cell (render) |
| `liquid.flow`        | df → | liquid level changed at a cell |
| `unit.spawn` / `unit.move` / `unit.despawn` | df/mc → | creatures as foreign-engine puppets (home engine drives) |
| `combat.attack.intent` | df/mc → | attacker declares a hit; defender's home engine resolves (§5b) |
| `combat.attack.result` | df/mc → | defender's home engine reports outcome (wound/damage/death) |
| `item.set`           | df → | item appeared/moved (rendered as block/entity) |
| `zone.assign`        | mc/bridge → | mark a region df-managed or player-sandbox |

Designations and commits are **separate events** linked by `causedBy` — this is what makes
the tick lifecycle (§7) representable. `proposed → in_progress → committed | rejected`.

### The log

- v1: in-process append-only **JSONL** file for durability + an in-memory index for the fold.
  Single box, single bridge process — this is plenty.
- Upgrade path if we ever split processes: Redis Streams or NATS JetStream (same append-only
  ordered-log semantics, out-of-process).

---

## 5b. Entities & combat (cross-engine interaction)

Creatures are **not** mirror-synced (two brains fighting over one body — worse than the terrain
problem, because AI is continuous). Instead:

**Model: home-authoritative + *interactive* puppet.** Every creature is authoritative in its
**home** engine — MC mobs run MC AI, DF creatures run DF AI — and exists in the **foreign**
engine as an *interactive puppet*: a real entity with a body/health proxy that can be targeted
and hit, whose position/state is driven by the home engine (never re-simulated foreign-side).

**Rule: the *defender's* home engine resolves every attack.** Nobody computes damage to a
creature they don't own.

1. Attacker's engine emits `combat.attack.intent` (attacker, target, weapon, material, force,
   optional body region).
2. The **defender's** home engine — owner of that body/health model — computes the outcome
   (miss / dodge / block / wound / damage / death) and emits `combat.attack.result`.
3. The attacker's engine renders the result. Prediction/rollback (§7) applies: the attacker
   sees an optimistic hit-flash, confirmed or overturned by the result.

```jsonc
{ "type": "combat.attack.intent",
  "attacker": "<entityRef>", "target": "<entityRef>",
  "weapon": "iron_axe", "material": "iron", "force": 42,
  "bodyRegion": "upper_body" }        // optional; defender picks if absent
// defender's home engine replies:
{ "type": "combat.attack.result",
  "outcome": "wound", "region": "left_arm", "severity": "sever",
  "damageHp": 12, "died": false }     // both native forms; each side reads what it needs
```

**This model sidesteps the DF-raws problem.** Because MC keeps owning MC mobs, DF never needs a
raw for a creeper — it only needs a **generic proxy body** its dwarves can path to and swing at;
the hit is forwarded to MC (the mob's owner) to resolve. Each engine only ever computes damage
for creatures it already understands.

**Death & wound fidelity follows authority.** How a creature dies is decided by whoever owns its
body. **DF-owned creatures** (dwarves, wildlife, invaders) get DF's full model *for free* —
downed, pain, bleeding, severed limbs, bleed-out, infection — because that's just DF; we surface
it into MC. **MC-owned mobs** die by MC's simple hitpoint model (a dwarf-killed creeper just
dies, no bleed-out) — the one asymmetry. *Optional toggle:* give MC mobs a DF **proxy body** so
DF resolves their wounds too, for uniform DF-flavored death, at the cost of per-mob translation +
an MC-mob → DF-body mapping. **Default: fidelity-follows-authority** (DF creatures rich, MC mobs
simple). The player at L3 has a DF-owned body, so player death is DF-flavored (§13).

**The two hard parts (why this is a late subsystem):**

- **Combat-model impedance mismatch — lossy both ways, asymmetric.** MC is hitpoints + armor
  points + knockback. DF is body parts × tissue layers × material × momentum × wound types ×
  pain × bleeding × organs, with *no single hitpoint number*. **MC→DF** means *synthesizing* a
  DF wound from "~3 melee damage" (pick region, attack type, momentum — crude). **DF→MC** means
  collapsing "left arm severed, heavy bleeding" into a hitpoint delta. Unavoidable — DF's combat
  is the deepest system in the game and MC's is deliberately shallow.
- **Timing & defense resolution.** DF resolves combat over ticks with dodge/block/parry rolls;
  MC is instant-per-hit. Letting an MC hit bypass DF would skip the dwarf's armor/shield/skill,
  so the defender's engine *must* resolve — which reintroduces latency and puts the §7
  prediction/rollback machinery on combat.

**Cost:** every puppet becomes interactive (a body + health proxy), which raises entity count,
health-sync bookkeeping, and the MC entity-limit/perf concern. Depends on rendering, entities,
and the reconciler all working first — see roadmap Stage 6b. **Does not touch Stages 0–3.**

**Player — split-authority, embodied by design.** The player is *always embodied* (a first-person
body in the world), never a disembodied overseer. Authority over the player entity is **split**:
MC always owns **movement/camera/input** (responsiveness is non-negotiable — DF-owned position
would rubber-band your own body); DF owns as much of the **body** (needs, health, wounds) as the
chosen depth level dictates. **Death is DF-flavored** (§13): lethal damage downs you; a dwarf
rescues you or you bleed out — not instant respawn.

| Level | You are | Body owner |
|---|---|---|
| **L1 Present** | walk/mine/build/designate | MC (hearts) — **free, Stages 1+** |
| **L2 Vulnerable** | a valid combat target | MC hearts, hit via §5b — Stage 6b |
| **L3 Embodied dwarf** | needs + DF-style wounds surfaced to MC | **DF** — Stage 6b+, the payoff |
| **L4 Full citizen** | skills, moods, draftable | DF — stretch |

Embodied movement is free (L1 is just being an MC player); deep DF embodiment (L3) rides in on
the combat system. The overseer's management tools stay diegetic (§8b) so embodiment is never
broken. **Death handling** (respawn vs permadeath vs downed-then-rescued) is an open decision —
see §13.

---

## 6. Conflict resolution

A conflict is two events targeting the same cell in the same reconciliation window with
incompatible effects. Policy, in order:

### 6.1 Compose first
Many "conflicts" aren't. Model actions as *intents on a shared substrate*, not absolute
states, and they merge:

- Player mines tile `p` **and** DF floods `p` with magma same tick → **both apply**: the rock
  is removed *and* magma fills the void. Result: an open, magma-filled tile. No conflict.
- Dwarf drops an item on `p` **and** player walks onto `p` → both fine.

Composition is tried before any winner is picked.

### 6.2 Domain-priority table (when composition fails)
If two events genuinely cannot both hold, the owner of the relevant **domain** (§4) wins:

| Conflict class | Winner | Rationale |
|---|---|---|
| Terrain edit vs. liquid/temperature | **DF** | DF owns physics. |
| Terrain edit vs. terrain edit, in `df-managed` zone | **DF** | Fort integrity. |
| Terrain edit vs. terrain edit, in `player-sandbox` zone | **MC** | Player's space. |
| Player-intent vs. player-intent (two players) | first in log | Log order is truth. |
| Anything vs. world-history/geology | **DF** | Immutable substrate. |

### 6.3 Loser handling
The losing event is not silently dropped — it's marked `rejected` with a reason and surfaced:
MC rolls back its optimistic ghost (§7); the player sees the block reappear (or a "the dwarves
refused" cue). Determinism over surprise, always.

---

## 7. Tick reconciliation & client prediction

The hardest ergonomic problem: **MC is instant (20 TPS, mine → gone now); DF digging is a
job a dwarf walks over and performs over many game-ticks.** We reconcile with the netcode
playbook.

Lifecycle of a player dig:

```
1. Player breaks block in MC
   → MC adapter IMMEDIATELY shows a "ghost" (block set to a cracked/marked state, or removed
     optimistically) and emits  tile.dig.designate {status: proposed}
2. Bridge appends it, translates to a DF dig designation via the DF adapter (write path)
3. DF assigns a dwarf → emits  tile.dig.designate {status: in_progress}
     → MC may show a subtle "claimed" cue
4a. Dwarf finishes → DF emits  tile.dig.commit  → bridge → block.set → MC confirms (ghost
      becomes real removal)
4b. DF can't reach/dig it → DF emits tile.dig.reject → bridge → MC ROLLS BACK the ghost
      (block reappears)
```

- **Optimistic ghost** = client-side prediction. The player gets instant feedback.
- **Commit/reject** = server reconciliation. DF (the authority for that domain) confirms or
  overturns.
- The delay between predict and commit is not a bug to hide — it's *how DF plays*. You
  designate; dwarves execute. We lean into it.

Ghost state is tracked per-cell in the MC adapter with a timeout; a designation that never
commits/rejects within N seconds is re-queried, then rolled back if still unknown.

---

## 8. Coordinate & material mapping

### Coordinates
- **Scale (v1):** 1 DF tile → 1 MC block. Everything is a touch small (a DF tile is
  person-sized, ~2m; an MC block is 1m³) but it's coherent and simplest. Documented upgrade:
  1 tile → 2×2×N block region for a roomier feel.
- **Axes:** DF `(x, y, z-level)` → MC `(x, z, y)`. DF z-levels map to MC **y** (vertical). DF
  north/south (`y`) maps to MC `z`.
- **Origin:** a fixed offset `O` places the DF map inside the MC world. `mc = df·scale + O`.
- **Bounds check:** typical DF fort ≈ 144–192 tiles per side, ~100–200 z-levels. MC y-range
  is −64…319 (384 tall) on modern versions — fits with an offset unless a fort exceeds ~384 z.
  Flag at load if the embark is too tall.

### Materials (starter table — extend during build)

| DF tile/material | MC block |
|---|---|
| soil / loam / clay | dirt / coarse dirt |
| grass floor | grass block |
| rock (generic stone layer) | stone |
| granite / gabbro / basalt | andesite / diorite / basalt |
| ore vein (magnetite, etc.) | iron/gold/… ore (nearest) |
| gem cluster | corresponding MC ore/deepslate variant |
| magma | lava |
| water (by level 1–7) | water (level mapped) |
| open space | air |
| constructed wall | (material)'s block form |
| tree / sapling | log + leaves / sapling |

Unmapped DF materials fall back to a "nearest by color/category" heuristic + a logged
`unmapped-material` warning so the table can be grown empirically.

Dwarves/creatures → MC entities (villagers or armor-stands with nametags). **DF owns their
motion**; MC never pathfinds them — the adapter teleports entities to match `unit.move`.

---

## 8b. Interaction model (UX & the overseer layer)

**The core tension:** DF is *indirect region-command* (paint regions, configure menus, queue
orders, god-view, pause) while MC is *direct point-and-act* (one body, one block, real time).
You cannot make DF's management diegetic as pure hand-actions. So MC's **two UX registers** each
carry part of DF, and the whole overseer layer stays **diegetic** so embodiment (§4/§5b) is never
broken — no disembodied camera, ever.

- **Embodied register** (walk, mine, place, open chest) → local/fine actions you do yourself.
- **Overseer register** → DF's region & order management, re-introduced via three *proven* MC
  patterns, all as in-world objects you use with your body:
  1. **Selection wand** (WorldEdit paradigm: click corner A, corner B) — every region op.
  2. **Console blocks with custom GUIs** (Paper chest-inventory GUIs) — configuration & orders.
  3. **Map table** — an in-world object showing a top-down rendered fort view; place designations
     *on the map* without leaving your body. Replaces any spectator "fly overhead" mode precisely
     *because* it would break embodiment. May pause the DF tick while open (bridge controls it).

### DF interface → MC UX

| DF interface | MC UX translation |
|---|---|
| Dig designation (paint rectangle) | **Selection wand** → volume → `tile.dig.designate` per cell |
| Stockpile (region + item filter) | Wand marks footprint → right-click **stockpile marker block** → chest-GUI toggles item categories; items render as item-frames/blocks on the floor |
| Zones (meeting, pasture, farm, hospital) | Wand + **type-picker GUI** |
| Burrows (restrict dwarves) | Wand + **assign-dwarves GUI** |
| Room (bed → make room → assign owner) | Place **MC bed** → "designate bedroom" → bridge asks DF to detect enclosure → assign owner via GUI |
| Work orders ("make 5 tables", manager) | **Manager's desk / lectern block** → work-order GUI (craftable list + qty) |
| Scroll z-levels / whole-fort view | **Map table** (top-down render), designate on the map |
| Pause to plan | Map table pauses the DF tick |
| Dense info screens (units, health, stocks, trade) | GUIs on console blocks — functional, but this is where we are genuinely *rebuilding DF's menus*; least-polished-longest |

**Honest cost:** DF's UI is enormous and information-dense. Every info/management screen becomes
a custom GUI built inside MC's constrained input (mouse + hotbar + chat + chest-menus). That's a
large, long-tail surface — plugin GUI work, not new tech, but not small either. Belongs to the
MC adapter, **Stage 3+**; does not affect Stages 0–2.

---

## 9. Component specs

### 9.1 DF adapter
- **Read:** DFHack's **RemoteFortressReader** plugin (protobuf RPC over TCP :5000). Key calls:
  `GetBlockList` (tiles, materials, designations, liquids), `GetUnitList` (positions), map
  info. This is the exact API Armok Vision uses to render DF in 3D — proven data path.
- **Write:** RemoteFortressReader is read-oriented, so writes go through a small **custom
  DFHack Lua script / plugin** the bridge triggers over the core RPC (`RunCommand`) — e.g.
  set `designation.dig` on a tile, queue a build job, spawn/remove. This is DFHack's sharpest
  edge (poking tiles out from under the engine can desync pathfinding/flow/temperature caches);
  writes must go through DFHack's own helpers where they exist, and be validated during the
  digging milestone.
- Emits `unit.*`, `liquid.flow`, `tile.dig.commit/reject`, `tile.build.commit`, `item.set`.
- Consumes `tile.dig.designate`, `tile.build.designate` and applies them via the write path.
- **Diffing:** DF state is large; the adapter keeps last-seen block hashes and emits only
  changed cells. Throttle to a configurable poll rate.

### 9.2 Bridge core
- Owns the log, canonical model, conflict resolver, reconciler, zone registry.
- Single process, hot-reloaded in dev.
- Deterministic: given the same log, folds to the same world. (Enables replay/debugging.)

### 9.3 MC adapter
- **v1: Paper plugin** (Bukkit API). Applies `block.set` via `setBlockData`, moves entities to
  match `unit.move`, and captures `BlockBreakEvent`/`BlockPlaceEvent` → emits
  `tile.dig.designate`/`tile.build.designate`. Manages optimistic ghosts + rollback.
- **Future: Valence** (Rust, ECS) custom server that speaks the MC protocol directly — serves
  chunk packets built straight from the canonical model, no game engine to fight. Migration
  target once the plugin's engine-fighting (mob AI, physics, chunk-gen clobbering our blocks)
  becomes the bottleneck. The event interface stays identical, so this is a swap, not a rewrite.

---

## 10. Container topology

```
┌─ df ───────────────────┐   ┌─ bridge ───────────────┐   ┌─ mc ──────────────────┐
│ DF (classic, Linux)    │   │ bridge core (TS)       │   │ Paper server          │
│ + DFHack               │   │ - event log (JSONL)    │   │ + mdf-receiver plugin │
│   + RemoteFortressReader│──▶│ - canonical model      │──▶│ port 25565 (players)  │
│ + custom write script  │   │ - conflict/reconcile   │◀──│ socket :8686 ↔ bridge │
│ + Xvfb (dummy :99)     │◀──│ HOT-RELOADED (dev)     │   └───────────────────────┘
│ PRINT_MODE:TEXT        │   └────────────────────────┘
│ exposes DFHack :5000   │
└────────────────────────┘
```

`docker-compose.yaml` skeleton:

```yaml
services:
  df:
    build: ./df            # DF classic + DFHack + RemoteFortressReader + Xvfb
    environment:
      - DISPLAY=:99
      - DFHACK_HEADLESS=1
    volumes:
      - ./saves:/df/data/save   # a pre-made fort to load
    ports:
      - "5000:5000"             # DFHack RemoteFortressReader RPC
    # entrypoint runs: Xvfb :99 & dfhack (loads the save, no visible UI)

  bridge:
    build: ./bridge
    depends_on: [df]
    volumes:
      - ./bridge/src:/app/src   # mounted for hot reload
      - ./data:/app/data        # the JSONL event log lives here
    environment:
      - DF_RPC=df:5000
      - MC_SOCK=mc:8686
    command: npx tsx watch src/index.ts   # hot reload

  mc:
    build: ./mc                # Paper + mdf-receiver plugin
    depends_on: [bridge]
    ports:
      - "25565:25565"          # players connect here
      - "8686:8686"            # bridge ↔ plugin socket
    volumes:
      - ./mc/world:/data/world
```

Hot reload only matters for `bridge` (the iteration surface). `df` and `mc` are start-once.
Only the bridge/DF RPC ports need exposing beyond the compose network; this can later ride the
PowStation Traefik stack if we want remote access, but that's out of scope for v1.

**DF containerization notes:**
- Use the **free classic Linux build** (no Steam DRM). Run headless under **Xvfb** with
  `PRINT_MODE:TEXT`; DFHack's RemoteFortressReader still serves state with no visible UI.
- Pin the DF **and** DFHack versions together — DFHack is version-locked to DF.

---

## 11. Tech stack & rationale

| Concern | Choice | Why |
|---|---|---|
| Bridge language | **TypeScript (Node, `tsx watch`)** | Matches the rest of `~/Projects` (Astro/React/TS, TS MCP servers). Fast iteration, trivial hot reload. Perf is fine for the staged build; escape hatch below. |
| Bridge perf escape hatch | **Rust** | If diffing large forts at high poll rates bottlenecks, move the hot path (or the whole bridge) to Rust — and it would then share types with a future Valence MC adapter. |
| MC side (v1) | **Paper plugin** | Running in minutes; block/entity API is trivial; player events are first-class. |
| MC side (future) | **Valence (Rust)** | Pure protocol server, no engine to fight — the architecturally-correct endgame. Event interface unchanged, so it's a swap. |
| DF read | **DFHack RemoteFortressReader** | Proven by Armok Vision; structured protobuf; no memory reverse-engineering. |
| DF write | **Custom DFHack Lua/plugin over RPC** | RemoteFortressReader is read-only; writes need our own DFHack-side code. |
| DF version | **Classic 0.47.05 (or matched v50 classic)** | 0.47.05 + its DFHack has the most mature RemoteFortressReader and script ecosystem, and no Steam DRM. Confirm remote-reader completeness on whatever version we pin (see risks). |
| Event log (v1) | **JSONL + in-memory index** | Single box, single process; durable, replayable, dead simple. |
| Event log (future) | **Redis Streams / NATS JetStream** | If/when processes split. |

---

## 12. Staged roadmap

Every stage is independently observable. "Both authoritative" is switched on **one domain at
a time** — we never integrate everything at once. Note: **Stage 1–2 are literally Model 1
(DF-authoritative) with the conflict resolver stubbed to "DF wins."** Choosing Model 3 didn't
change the early work; it changed where we're pointed.

- **Stage 0 — Scaffolding.** Compose skeleton; DF container boots a pre-made fort headless and
  answers RPC on :5000; empty bridge connects and logs a heartbeat. *Done when:* bridge prints
  "connected, N units, MxM map."
- **Stage 1 — DF→MC render (read-only).** Bridge pulls one z-level + unit list, maps materials,
  Paper plugin builds the blocks and spawns an entity per dwarf; `unit.move` teleports them.
  *Done when:* you walk around your fort in MC and watch dwarves move. **This is the make-or-break
  data-flow spike.**
- **Stage 2 — MC→DF digging (first real two-way).** Player breaks a block → `tile.dig.designate`
  → DF write path → dwarf digs → `tile.dig.commit` → MC confirms. Optimistic ghost + rollback on
  reject. *Done when:* you mine in MC and a dwarf actually comes and does it, with correct
  ghost/rollback. **First taste of the reconciler on the smallest surface.**
- **Stage 3 — Building.** `tile.build.designate` → construction job → commit. Player-placed
  blocks in `df-managed` zones become build orders.
- **Stage 4 — Liquids & multi-z.** Stream `liquid.flow`; render magma/water levels; full fort
  height, diffed. Exercises composition (§6.1) for real.
- **Stage 5 — Zones & player sandbox.** `zone.assign`; MC-authoritative regions where the player
  builds freely without DF fighting them.
- **Stage 6 — Harden the reconciler.** Contested-terrain edge cases, priority table under load,
  reject-storm handling. Only now are we doing the genuinely novel research.
- **Stage 6b — Cross-engine entities & combat (§5b).** Interactive puppets with health proxies;
  DF generic proxy body for MC mobs; `combat.attack.intent`/`result`; the MC↔DF attack-model
  translation (lossy both ways). *Done when:* an MC zombie and a DF dwarf can actually fight and
  both engines agree on who died. The deepest rabbit hole — depends on everything above.
- **Stage 7 (stretch) — Valence migration.** Swap the Paper plugin for a custom protocol server
  once engine-fighting is the bottleneck.

---

## 13. Risks & open questions

- **[HIGH] DFHack write path stability.** Writing tiles/designations can desync DF's cached
  pathfinding/flow/temperature state and corrupt saves. *Mitigation:* go through DFHack's own
  helpers; validate hard in Stage 2 on throwaway saves before trusting it.
- **[RESOLVED, Stage 0] RemoteFortressReader reachability.** Pinned DF 0.47.05 + DFHack
  0.47.05-r8; `GetVersionInfo` verified over the wire. **Key finding:** in this build RFR
  forbids all RPC methods from non-localhost clients, so the bridge shares DF's network
  namespace (`network_mode: service:df`) and connects to `127.0.0.1:5000`. This is also
  what the core `RunLua`/`RunCommand` write path (§9.1) needs. Field-completeness for
  `GetBlockList` still to be checked once a fort is loaded.
- **[MED] Diffing throughput.** A big fort × many z-levels × high poll rate could flood the
  link. *Mitigation:* per-cell hashing, change-only emission, throttled polling; Rust escape
  hatch if needed.
- **[MED] MC entity limits & engine-fighting.** Hundreds of dwarves as entities, plus Paper
  simulating mob AI/physics/chunk-gen over our blocks. *Mitigation:* puppets have AI disabled
  (home engine drives them); Valence migration (Stage 7) removes engine-fighting entirely.
- **[HIGH, Stage 6b] Combat-model translation.** DF's body-part/wound model vs MC hitpoints is
  lossy in both directions and asymmetric; MC→DF requires synthesizing a wound from near-zero
  data. *Mitigation:* defender's-home-resolves rule (§5b) keeps it principled; accept documented
  fidelity loss; isolate as a late subsystem so nothing else depends on getting it perfect.
- **[MED] Tick lifecycle for non-dig actions.** Not every action has a clean designate→commit
  arc in DF. *Open:* enumerate which DF interactions expose an observable job lifecycle vs. which
  we must force + fake-commit.
- **[LOW] Coordinate scale feel.** 1:1 may feel cramped. *Mitigation:* documented 2×2×N upscale.
- **[DECIDED] Player death = DF-flavored.** On lethal damage you are **downed/incapacitated**,
  not deleted: a dwarf hauls you to a hospital and you recover, or you **bleed out** if no one
  reaches you in time. Config toggle for pure-respawn / pure-permadeath, but DF-flavored downed
  is the default. Requires L3 embodiment (DF owns your body) to be meaningful — Stage 6b.
- **Open:** Player needs (hunger/thirst/sleep) — map MC hunger to DF needs, or let DF drive them
  at embodiment L3? Deferred to Stage 6b.
- **Open:** How to represent DF-only concepts (moods, engravings, item quality) in MC — signage?
  particle cues? Deferred past v1.
- **Open:** Do we ever want MC→DF *terrain generation* (the "Minecraft map inside DF" idea)?
  Explicitly out of scope now; it fights DF's fixed map model and needs a DF-worldgen ingest we
  haven't scoped.

---

## 14. Glossary

- **Authority / authoritative** — the engine whose version of a domain is treated as truth.
- **Canonical model** — the bridge's own world state, the fold of the event log; the real truth
  that DF and MC each project.
- **Composition** — resolving two concurrent events by *applying both* when their effects don't
  actually conflict (mine + flood = open magma tile).
- **Ghost** — an optimistic, not-yet-confirmed MC block state shown for instant feedback,
  pending DF commit/reject.
- **Reconciliation** — confirming or rolling back predicted (ghost) state against the
  authority's commit.
- **Zone** — a tagged region designating terrain authority (`df-managed` vs `player-sandbox`).
- **RemoteFortressReader** — DFHack plugin exposing fort state over protobuf RPC (the read path).
- **Home / foreign engine** — a creature's home engine runs its AI (authoritative); the foreign
  engine shows an interactive puppet of it.
- **Interactive puppet** — a foreign-engine representation of a creature that can be targeted and
  hit (has a body/health proxy), not just rendered.
- **Attack intent / result** — the canonical two-event combat exchange; the *defender's* home
  engine turns an intent into a result (§5b).
```

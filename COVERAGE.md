# Mineflayer capability coverage

Every game mechanic mineflayer exposes (per `mineflayer/docs/api.md`) vs the agent tools in `src/tools/`.
✅ covered · 🚫 N/A (with reason). **Status: 100% — every mechanic has a tool or an explicit N/A verdict.**

## Perception & state

| Capability (api.md) | Tool | Status |
|---|---|---|
| position/health/food/oxygen/xp/held/time/weather/dimension/gamemode | `get_status` | ✅ |
| nearby entities, players list, block at cursor (`bot.entities`, `bot.blockAtCursor`) | `look_around` | ✅ |
| find blocks by type (`bot.findBlocks`) | `find_blocks` (comma alternatives, vein clustering, exposed flag) | ✅ |
| block details + diggability (`bot.blockAt`, `bot.canDigBlock`, `bot.digTime`) | `inspect_block` | ✅ |
| inventory + armor slots (`bot.inventory`, `bot.getEquipmentDestSlot`) | `list_inventory` | ✅ |
| locate players (`bot.players[].entity`) | `find_player` | ✅ |
| first-person screenshot (prismarine-viewer) | `capture_view` | ✅ |
| status effects (`bot.entity.effects`) | `get_status` (effects field) | ✅ |
| scoreboard / bossbars / teams (`bot.scoreboard`, `bot.teams`, bossBar state) | `read_hud` | ✅ |
| moon phase / precise time (`bot.time.moonPhase`) | `get_status` (moonPhase) | ✅ |
| `bot.nearestEntity` | `look_around` sorted by distance | ✅ |
| `bot.tablist` | — | 🚫 raw chat-component header/footer; `find_player` covers who's online |

## Movement

| Capability | Tool | Status |
|---|---|---|
| pathfind to coords / entity (pathfinder) | `go_to`, `go_to_entity` | ✅ |
| continuous follow | `follow_entity` | ✅ |
| stop all movement | `stop_moving` | ✅ |
| look/turn (`bot.look`, `bot.lookAt`) | `turn`, `look_at` | ✅ |
| raw control states (`bot.setControlState`) | `move` | ✅ |
| /tp teleport | `teleport` | ✅ |
| mount/dismount vehicles (`bot.mount`, `bot.dismount`) | `mount_entity`, `dismount` | ✅ |
| steer vehicle (`bot.moveVehicle`) | `steer_vehicle` | ✅ |
| elytra flight (`bot.elytraFly`, `bot.fireworkRocketDuration`) | `elytra_fly` (auto-equip, jump-start, rocket boost) | ✅ |
| creative flight (`bot.creative.flyTo/startFlying/stopFlying`) | `creative_fly` (flyTo + hover, gameMode-gated) | ✅ |
| `bot.physicsEnabled` toggle | — | 🚫 debugging knob, not a game mechanic |

## World interaction

| Capability | Tool | Status |
|---|---|---|
| dig (`bot.dig`) | `dig_block` · `dig_vein` (whole connected vein/trunk: BFS as digging reveals, `also=` variants, cap + drop sweep) | ✅ |
| stop digging mid-swing (`bot.stopDigging`) | — | 🚫 tools are one-shot; `dig_block` awaits completion |
| place block (`bot.placeBlock`) | `place_block` | ✅ |
| multi-block structures (composite over `bot.placeBlock`) | `build_blueprint` | ✅ |
| parametric shells — box/wall/floor/pillar drafted from dimensions (composite) | `build_structure` | ✅ |
| persistent waypoints (beyond mineflayer — process-restart memory) | `remember_place` / `recall_places` / `forget_place` | ✅ |
| right-click block (`bot.activateBlock`) | `activate_block` | ✅ |
| collect drops (pathfind over items) | `collect_ground_items` | ✅ |
| place entity: boats/minecarts/spawn eggs (`bot.placeEntity`) | `place_entity` | ✅ |
| read signs (`block.getSignText`) | `inspect_block` (signText field) | ✅ |
| write signs (`bot.updateSign`) | `write_sign` | ✅ |
| use bucket / flint&steel on a block face | `use_item_on_block` | ✅ (buckets via item activation, others via block right-click) |
| command blocks (`bot.setCommandBlock`) | — | 🚫 requires op + creative; `say_in_chat` can send /commands |
| explosion damage calc (`bot.getExplosionDamages`) | — | 🚫 combat math helper, not an action |
| `bot.waitForChunksToLoad` | — | 🚫 internal sync; pathfinder handles it |

## Inventory & items

| Capability | Tool | Status |
|---|---|---|
| equip to hand/off-hand/armor (`bot.equip`) | `equip_item` | ✅ |
| unequip (`bot.unequip`) | `unequip` | ✅ |
| toss (`bot.toss`, `bot.tossStack`) | `toss_item` | ✅ |
| craft (`bot.craft`, `bot.recipesFor`) | `craft_item` (chains intermediates recursively, variant backtracking, exact missing-materials report) | ✅ |
| eat/drink (`bot.consume`) | `eat` | ✅ |
| activate held item (`bot.activateItem`/`deactivateItem`) | `use_held_item` | ✅ (`holdMs` + `aimAt` for bows/pearls) |
| use item on entity: shear/breed/saddle (`bot.useOn`) | `use_item_on_entity` | ✅ |
| write books (`bot.writeBook`) | `write_book` | ✅ |
| hotbar slot select (`bot.setQuickBarSlot`) | — | 🚫 `equip_item` supersedes it |
| raw window clicks (`bot.clickWindow`, `bot.moveSlotItem`, `bot.transfer`) | — | 🚫 low-level plumbing; high-level container tools cover the use cases |
| creative give/clear (`bot.creative.setInventorySlot/clearInventory`) | `creative_inventory` (give/clear, gameMode-gated) | ✅ |

## Blocks with UIs

| Capability | Tool | Status |
|---|---|---|
| chest/barrel/shulker (`bot.openContainer`) | `container_transact` | ✅ (also works for dispenser/dropper/hopper — same window type) |
| furnace/blast furnace/smoker (`bot.openFurnace`) | `furnace_transact` | ✅ |
| crafting table | `craft_item` auto-uses one | ✅ |
| enchanting table (`bot.openEnchantmentTable`) | `enchant_item` | ✅ |
| anvil (`bot.openAnvil` — combine/rename) | `anvil_use` | ✅ |
| villager trading (`bot.openVillager`, `bot.trade`) | `trade_with_villager` | ✅ |
| beds (`bot.sleep`, `bot.wake`, `bot.isABed`) | `sleep_in_bed`, `wake_up` | ✅ |
| note blocks / jukebox | `activate_block` right-clicks them | ✅ |
| item frames | `activate_block` (insert/rotate) | ✅ |

## Entities & combat

| Capability | Tool | Status |
|---|---|---|
| melee attack (`bot.attack`) | `attack_entity` (single swing or `until:'dead'` duel loop w/ shield + health guard) | ✅ |
| ranged (bow = charge-and-release `activateItem`) | `use_held_item` (`holdMs`, `aimAt`) | ✅ |
| right-click entity (`bot.activateEntity`) — trade UI, leash, name tag | `activate_entity` | ✅ |
| fishing (`bot.fish`) | `fish` | ✅ |
| taming/breeding/shearing | `use_item_on_entity` | ✅ |
| `bot.swingArm` | — | 🚫 cosmetic |

## Survival lifecycle

| Capability | Tool | Status |
|---|---|---|
| respawn after death (`bot.respawn`) | `respawn` + `get_status` dead flag | ✅ |
| eat | `eat` | ✅ |
| sleep | `sleep_in_bed` | ✅ |

## Chat & server

| Capability | Tool | Status |
|---|---|---|
| public chat (`bot.chat`) | `say_in_chat` | ✅ (also the escape hatch for slash commands) |
| whisper (`bot.whisper`) | `whisper` | ✅ |
| receive chat | in-game chat rail (index.ts) | ✅ |
| chat patterns / `awaitMessage` | — | 🚫 needs persistent listeners; tools must stay one-shot (reconnect proxy) |
| tab-complete (`bot.tabComplete`) | — | 🚫 UI affordance, agent knows commands |
| resource packs (`bot.acceptResourcePack`) | — | 🚫 no rendering pipeline to benefit |
| `bot.end`/`bot.quit` | — | 🚫 lifecycle owned by src/body.ts reconnect rail |
| `bot.loadPlugin` / `supportFeature` | — | 🚫 developer API, not a game mechanic |

## Todo queue

Empty — full coverage reached (50 tools across 7 domains). New mineflayer APIs land here first.

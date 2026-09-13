package com.mdf;

import com.google.gson.*;
import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * MDF receiver: the Minecraft side of the DF<->MC bridge (DESIGN.md §9.3).
 * - bridge -> plugin : {"t":"blocks","cells":[[x,y,z,"MATERIAL"],...]}
 *                      {"t":"units","list":[{"id":N,"x":..,"y":..,"z":..,"name":".."}]}
 *                      {"t":"clear"}
 * - plugin -> bridge : {"t":"break","x":..,"y":..,"z":..}   (player mined -> dig designation)
 *                      {"t":"place","x":..,"y":..,"z":..,"mat":".."} (player built)
 * The bridge does all DF<->MC coordinate/material translation; the plugin speaks raw MC coords.
 */
public class MdfPlugin extends JavaPlugin implements Listener {

    private volatile ServerSocket server;
    private World world;
    private final Gson gson = new Gson();
    private final Map<Integer, UUID> unitEntities = new ConcurrentHashMap<>();
    private volatile Writer out;   // current bridge connection's writer (for events back)

    // Bounded-per-tick block application so a whole-map render (millions of blocks)
    // never freezes the server main thread.
    private record Cell(int x, int y, int z, Material m) {}
    private final java.util.Queue<Cell> blockQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();
    private final Map<String, Material> matCache = new ConcurrentHashMap<>();
    private int drainPerTick;
    private volatile Location spawn;   // fort-surface spawn set by the bridge

    // DF-map snapshot -> the "dffort" world is generated from it (no live mass edits)
    private byte[] snap;
    private int sx, sy, sz, ox, oy, oz;
    private Material[] palette;
    // Name of the world GENERATED from the snapshot. Configurable so a second
    // server instance (e.g. MinecraftEarth) can use its own world name and not
    // collide with the DF fort's "dffort". Defaults to "dffort".
    private String genWorld = "dffort";

    @Override
    public void onEnable() {
        saveDefaultConfig();
        int port = getConfig().getInt("port", 8686);
        drainPerTick = getConfig().getInt("drainPerTick", 12000);
        genWorld = getConfig().getString("generatedWorld", "dffort");
        String worldName = getConfig().getString("world", "");
        world = (worldName == null || worldName.isBlank())
                ? Bukkit.getWorlds().get(0)
                : Bukkit.getWorld(worldName);
        if (world == null) world = Bukkit.getWorlds().get(0);

        getServer().getPluginManager().registerEvents(this, this);

        try {
            server = new ServerSocket(port);
        } catch (IOException e) {
            getLogger().severe("Could not bind port " + port + ": " + e.getMessage());
            return;
        }
        Thread accept = new Thread(this::acceptLoop, "mdf-accept");
        accept.setDaemon(true);
        accept.start();

        // drain the block queue every tick, bounded
        Bukkit.getScheduler().runTaskTimer(this, this::drainBlocks, 1L, 1L);

        getLogger().info("MDF receiver listening on " + port + ", world=" + world.getName()
                + ", drainPerTick=" + drainPerTick);
    }

    private void drainBlocks() {
        int n = 0;
        Cell c;
        java.util.List<org.bukkit.block.BlockState> changed = new java.util.ArrayList<>();
        while (n < drainPerTick && (c = blockQueue.poll()) != null) {
            Block b = world.getBlockAt(c.x(), c.y(), c.z());
            b.setType(c.m(), false);
            changed.add(b.getState());
            n++;
        }
        if (!changed.isEmpty()) {
            // Reliable client update: one multi-block change per player rebuilds the
            // affected chunk-section meshes correctly. Scattered single-block packets
            // from setType can be dropped by the client, nuking whole sections
            // (the "break one block, lose a chunk" bug).
            for (Player p : world.getPlayers()) {
                try { p.sendBlockChanges(changed); } catch (Throwable ignored) {}
            }
        }
    }

    private Material mat(String name) {
        if (name == null || name.equals("air")) return Material.AIR;
        return matCache.computeIfAbsent(name, k -> {
            Material m = Material.matchMaterial(k);
            return m == null ? Material.STONE : m;
        });
    }

    // Build (or reuse) the 'dffort' world generated from the DF snapshot, and move
    // the render/entity target there. Runs on the main thread.
    private void createDfWorld() {
        if (snap == null) { getLogger().warning("snap_end with no snapshot"); return; }
        World existing = Bukkit.getWorld(genWorld);
        if (existing != null) {
            world = existing;
        } else {
            getLogger().info("generating world '" + genWorld + "' from snapshot…");
            world = new WorldCreator(genWorld)
                    .environment(World.Environment.NORMAL)
                    .generateStructures(false)
                    .generator(new DfGenerator(snap, sx, sy, sz, ox, oy, oz, palette))
                    .createWorld();
        }
        if (world == null) { getLogger().severe("failed to create DF world"); return; }
        // Do NOT force-load the whole map: ~169 always-ticking chunks overloads the
        // server so it drops chunk packets to clients (random missing chunks). Let
        // chunks stream normally around players (the generator builds them on demand);
        // that's what Minecraft is designed for and it's reliable.
        world.setChunkForceLoaded(ox >> 4, oz >> 4, false);   // ensure not stuck-loaded
        for (Player p : Bukkit.getOnlinePlayers()) if (spawn != null) p.teleport(spawn);
        getLogger().info("DF world ready: " + world.getName());
    }

    @Override
    public void onDisable() {
        try { if (server != null) server.close(); } catch (IOException ignored) {}
    }

    // ---- networking --------------------------------------------------------

    private void acceptLoop() {
        while (server != null && !server.isClosed()) {
            try {
                Socket s = server.accept();
                getLogger().info("bridge connected from " + s.getRemoteSocketAddress());
                Thread t = new Thread(() -> handle(s), "mdf-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (server != null && !server.isClosed())
                    getLogger().warning("accept error: " + e.getMessage());
            }
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s;
             BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
             Writer w = new OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8)) {
            this.out = w;
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isBlank()) continue;
                try {
                    dispatch(JsonParser.parseString(line).getAsJsonObject());
                } catch (Exception e) {
                    getLogger().warning("bad message: " + e.getMessage());
                }
            }
        } catch (IOException e) {
            getLogger().info("bridge disconnected: " + e.getMessage());
        } finally {
            this.out = null;
        }
    }

    /** Send an event line back to the bridge (player actions). */
    private synchronized void sendEvent(JsonObject o) {
        Writer w = this.out;
        if (w == null) return;
        try { w.write(gson.toJson(o)); w.write("\n"); w.flush(); }
        catch (IOException e) { /* connection gone */ }
    }

    private void runSync(Runnable r) { Bukkit.getScheduler().runTask(this, r); }

    // ---- inbound commands (bridge -> plugin) -------------------------------

    private void dispatch(JsonObject msg) {
        String t = msg.has("t") ? msg.get("t").getAsString() : "";
        switch (t) {
            case "blocks" -> {
                // enqueue off the main thread; drainBlocks() applies them bounded-per-tick
                JsonArray cells = msg.getAsJsonArray("cells");
                for (JsonElement el : cells) {
                    JsonArray c = el.getAsJsonArray();
                    blockQueue.add(new Cell(c.get(0).getAsInt(), c.get(1).getAsInt(),
                            c.get(2).getAsInt(), mat(c.get(3).getAsString())));
                }
            }
            case "units" -> {
                JsonArray list = msg.getAsJsonArray("list");
                runSync(() -> updateUnits(list));
            }
            case "snap_begin" -> {
                sx = msg.get("sx").getAsInt(); sy = msg.get("sy").getAsInt(); sz = msg.get("sz").getAsInt();
                ox = msg.get("ox").getAsInt(); oy = msg.get("oy").getAsInt(); oz = msg.get("oz").getAsInt();
                snap = new byte[msg.get("total").getAsInt()];
                JsonArray pal = msg.getAsJsonArray("palette");
                palette = new Material[pal.size()];
                for (int i = 0; i < pal.size(); i++) palette[i] = mat(pal.get(i).getAsString());
                getLogger().info("snapshot begin: " + sx + "x" + sy + "x" + sz + ", " + snap.length + " bytes, palette " + pal.size());
            }
            case "snap" -> {
                int off = msg.get("off").getAsInt();
                byte[] chunk = Base64.getDecoder().decode(msg.get("data").getAsString());
                System.arraycopy(chunk, 0, snap, off, chunk.length);
            }
            case "snap_end" -> runSync(this::createDfWorld);
            case "spawn" -> {
                int x = msg.get("x").getAsInt(), y = msg.get("y").getAsInt(), z = msg.get("z").getAsInt();
                runSync(() -> {
                    spawn = new Location(world, x + 0.5, y, z + 0.5);
                    world.setSpawnLocation(spawn);
                    for (Player p : Bukkit.getOnlinePlayers()) p.teleport(spawn);
                    getLogger().info("spawn set to " + x + "," + y + "," + z);
                });
            }
            case "clear" -> { blockQueue.clear(); runSync(this::clearEntities); }
            default -> getLogger().warning("unknown command: " + t);
        }
    }

    // ---- unit entities (DF creatures rendered as villagers) ----------------

    private void updateUnits(JsonArray list) {
        Set<Integer> present = new HashSet<>();
        for (JsonElement el : list) {
            JsonObject u = el.getAsJsonObject();
            int id = u.get("id").getAsInt();
            present.add(id);
            double x = u.get("x").getAsDouble() + 0.5;
            double y = u.get("y").getAsDouble();
            double z = u.get("z").getAsDouble() + 0.5;
            String name = u.has("name") ? u.get("name").getAsString() : ("unit " + id);
            Location loc = new Location(world, x, y, z);
            // Don't force-generate a chunk from the unit loop (blocks main thread);
            // if it's not loaded yet, skip — the unit appears once terrain gens.
            if (!world.isChunkLoaded(loc.getBlockX() >> 4, loc.getBlockZ() >> 4)) continue;

            UUID uuid = unitEntities.get(id);
            Entity e = uuid == null ? null : Bukkit.getEntity(uuid);
            if (e == null || e.isDead()) {
                // Armor stands have NO AI brain — villager brains (POI searches) block
                // the main thread and overload the server when spawning many at once.
                ArmorStand a = world.spawn(loc, ArmorStand.class, s -> {
                    s.setGravity(false);
                    s.setInvulnerable(true);
                    s.setSilent(true);
                    s.setCustomName(name);
                    s.setCustomNameVisible(true);
                    s.setArms(true);
                    s.setBasePlate(false);
                    s.setRemoveWhenFarAway(false);
                });
                unitEntities.put(id, a.getUniqueId());
            } else {
                e.teleport(loc);
            }
        }
        // despawn units no longer present
        unitEntities.entrySet().removeIf(entry -> {
            if (present.contains(entry.getKey())) return false;
            Entity e = Bukkit.getEntity(entry.getValue());
            if (e != null) e.remove();
            return true;
        });
    }

    private void clearEntities() {
        for (UUID id : unitEntities.values()) {
            Entity e = Bukkit.getEntity(id);
            if (e != null) e.remove();
        }
        unitEntities.clear();
    }

    // ---- player actions (plugin -> bridge), Stage 2 groundwork -------------

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        if (spawn != null) Bukkit.getScheduler().runTask(this, () -> e.getPlayer().teleport(spawn));
    }

    @EventHandler
    public void onBreak(BlockBreakEvent e) {
        Block b = e.getBlock();
        JsonObject o = new JsonObject();
        o.addProperty("t", "break");
        o.addProperty("x", b.getX());
        o.addProperty("y", b.getY());
        o.addProperty("z", b.getZ());
        sendEvent(o);
    }

    @EventHandler
    public void onPlace(BlockPlaceEvent e) {
        Block b = e.getBlock();
        JsonObject o = new JsonObject();
        o.addProperty("t", "place");
        o.addProperty("x", b.getX());
        o.addProperty("y", b.getY());
        o.addProperty("z", b.getZ());
        o.addProperty("mat", b.getType().getKey().toString());
        sendEvent(o);
    }
}

# Dwarf Fortress 0.47.05 (classic) + DFHack 0.47.05-r8, headless under Xvfb,
# exposing RemoteFortressReader RPC on :5000.
#
# 0.47.05-era binaries are built against an older toolchain; Ubuntu 20.04 (focal)
# gives the right-vintage SDL 1.2 / libstdc++ so DF and the gcc-7 DFHack build run
# without library surprises.
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DF_DIR=/opt/df

# DF classic (64-bit) links against SDL 1.2 + friends; Xvfb gives it a display,
# x11vnc lets you do the one-time embark headlessly if you want (MODE=embark).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget bzip2 \
      xvfb x11vnc \
      libsdl1.2debian libsdl-image1.2 libsdl-ttf2.0-0 \
      libgl1-mesa-glx libglu1-mesa \
      libgtk2.0-0 libsndfile1 libopenal1 \
      libncursesw5 zlib1g procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# --- Dwarf Fortress (extracts to ./df_linux) ---
RUN wget -q "https://www.bay12games.com/dwarves/df_47_05_linux.tar.bz2" -O df.tar.bz2 \
    && tar xjf df.tar.bz2 \
    && mv df_linux "$DF_DIR" \
    && rm df.tar.bz2

# --- DFHack (extracts over the DF folder) ---
RUN wget -q "https://github.com/DFHack/dfhack/releases/download/0.47.05-r8/dfhack-0.47.05-r8-Linux-64bit-gcc-7.tar.bz2" -O dfhack.tar.bz2 \
    && tar xjf dfhack.tar.bz2 -C "$DF_DIR" \
    && rm dfhack.tar.bz2

# Expose the RPC server on all interfaces (default binds localhost only).
COPY dfhack-config/remote-server.json "$DF_DIR/dfhack-config/remote-server.json"

# noVNC + websockify: serve the VNC display over HTTP so the one-time embark can
# be done in a browser (no native VNC client). Late layer => DF/DFHack stay cached.
RUN apt-get update && apt-get install -y --no-install-recommends \
      novnc websockify && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 5000 = RemoteFortressReader RPC. 5900 = VNC. 6080 = noVNC (browser) for embark.
EXPOSE 5000 5900 6080

ENTRYPOINT ["/entrypoint.sh"]

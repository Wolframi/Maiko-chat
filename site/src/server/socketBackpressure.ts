import type { Socket } from "socket.io";

const queued = new WeakMap<Socket, { packets: number; bytes: number }>();

export function isSocketBackedUp(socket: Socket) {
  const state = queued.get(socket);
  return Boolean(state && (state.packets > 32 || state.bytes > 1024 * 1024));
}

export function monitorSocketBackpressure(socket: Socket) {
  const state = { packets: 0, bytes: 0 };
  queued.set(socket, state);
  let disconnecting = false;
  const onPacket = (packet: { data?: string | Buffer }) => {
    if (disconnecting) return;
    state.packets++;
    state.bytes += typeof packet.data === "string" ? Buffer.byteLength(packet.data) : packet.data?.length || 0;
    if (state.packets > 64 || state.bytes > 2 * 1024 * 1024) {
      disconnecting = true;
      socket.disconnect(true);
    }
  };
  const onDrain = () => { state.packets = state.bytes = 0; };
  socket.conn.on("packetCreate", onPacket);
  socket.conn.on("drain", onDrain);
  socket.once("disconnect", () => {
    socket.conn.off("packetCreate", onPacket);
    socket.conn.off("drain", onDrain);
    queued.delete(socket);
  });
}

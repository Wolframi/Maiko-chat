import { rateLimit } from "./rateLimit";

export class MessageAdmission {
  private pending = 0;
  private byUser = new Map<string, number>();
  private accepted = 0;
  private rejected = 0;

  acquire(userId: string, room: string, recipients: number) {
    if (this.pending >= 64 || (this.byUser.get(userId) || 0) >= 2
      || !rateLimit(`message-burst:${userId}`, 5, 1000)
      || !rateLimit(`message-room:${room}`, 120, 60_000)
      || !rateLimit(`message-room-burst:${room}`, 15, 1000)
      || !rateLimit("message-global", 300, 60_000)
      || !rateLimit("message-fanout", 6000, 60_000, Math.max(1, recipients))) {
      this.rejected++;
      return null;
    }
    this.accepted++;
    this.pending++;
    this.byUser.set(userId, (this.byUser.get(userId) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
      const count = (this.byUser.get(userId) || 1) - 1;
      if (count) this.byUser.set(userId, count); else this.byUser.delete(userId);
    };
  }

  sample() {
    const result = { accepted: this.accepted, rejected: this.rejected, pending: this.pending };
    this.accepted = this.rejected = 0;
    return result;
  }
}

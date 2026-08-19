export class EventHub {
  constructor({ maxEvents = 2000 } = {}) {
    this.maxEvents = maxEvents;
    this.seq = 0;
    this.events = [];
    this.clients = new Set();
  }

  addClient(client) {
    client.subscriptions ||= new Set();
    this.clients.add(client);
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  key(channel, resourceId) {
    return `${channel}:${resourceId || '*'}`;
  }

  subscribe(client, channel, resourceId) {
    client.subscriptions.add(this.key(channel, resourceId));
  }

  unsubscribe(client, channel, resourceId) {
    client.subscriptions.delete(this.key(channel, resourceId));
  }

  matches(client, event) {
    return client.subscriptions.has(this.key(event.channel, event.resourceId))
      || client.subscriptions.has(this.key(event.channel, '*'))
      || client.subscriptions.has('*:*');
  }

  publish(channel, resourceId, event) {
    const envelope = { seq: ++this.seq, channel, resourceId, event, at: new Date().toISOString() };
    this.events.push(envelope);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const client of this.clients) if (this.matches(client, envelope)) client.sendJson(envelope);
    return envelope;
  }

  resume(client, lastSeq) {
    const last = Number(lastSeq || 0);
    if (!this.events.length || last >= this.seq) return { ok: true, replayed: 0 };
    const oldest = this.events[0].seq;
    if (last + 1 < oldest) {
      client.sendJson({ type: 'resync_required', oldestSeq: oldest, currentSeq: this.seq });
      return { ok: false, replayed: 0 };
    }
    let replayed = 0;
    for (const event of this.events) {
      if (event.seq > last && this.matches(client, event)) {
        client.sendJson(event);
        replayed += 1;
      }
    }
    return { ok: true, replayed };
  }
}

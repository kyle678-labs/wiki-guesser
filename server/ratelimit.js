"use strict";

// Token buckets for Socket.IO events. express-rate-limit only sees HTTP, but the
// expensive things a client can ask for — allocating a room, broadcasting chat,
// churning the matchmaking queue — all arrive over the socket.
//
// A bucket refills continuously at `perSec` and holds at most `burst` tokens, so
// a player can act in short bursts (rattling off two chat lines) without ever
// sustaining more than the steady rate. Buckets are lazily created per socket
// and dropped wholesale on disconnect, so there's nothing to sweep.

class TokenBucket {
  constructor(burst, perSec) {
    this.burst = burst;
    this.perSec = perSec;
    this.tokens = burst;
    this.last = Date.now();
  }

  // Take one token if available. Returns false when the caller is over budget.
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// Per-socket limiter. `limits` maps an event name to { burst, perSec }; events
// with no entry are unlimited (they're either cheap or already idempotent).
class SocketLimiter {
  constructor(limits) {
    this.limits = limits;
    this.buckets = new Map(); // event -> TokenBucket
  }

  allow(event) {
    const spec = this.limits[event];
    if (!spec) return true;
    let bucket = this.buckets.get(event);
    if (!bucket) {
      bucket = new TokenBucket(spec.burst, spec.perSec);
      this.buckets.set(event, bucket);
    }
    return bucket.take();
  }
}

// Sensible ceilings: high enough that no honest player will ever see them, low
// enough that a script can't allocate rooms or flood a channel. Overridable via
// buildServer({ socketLimits }) so tests can drive the limiter directly.
const DEFAULT_SOCKET_LIMITS = {
  "chat:send": { burst: 5, perSec: 1 },
  "room:create": { burst: 3, perSec: 0.1 }, // ~6/min sustained
  "room:join": { burst: 5, perSec: 0.5 }, // also throttles room-code guessing
  "queue:join": { burst: 5, perSec: 0.5 },
  "room:settings": { burst: 10, perSec: 2 },
  "guess:submit": { burst: 5, perSec: 1 },
};

module.exports = { TokenBucket, SocketLimiter, DEFAULT_SOCKET_LIMITS };

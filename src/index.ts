// Apply dependency mitigation before loading any Solana modules.
import "./security/bigint-buffer.js";
await import("./server.js");

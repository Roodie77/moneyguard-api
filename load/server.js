// Runs the real src/server.js unchanged, and reports its memory and event-loop delay to the load runner once a second.
import { monitorEventLoopDelay } from 'node:perf_hooks';

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();

await import('../src/server.js');

setInterval(() => {
  const { rss, heapUsed } = process.memoryUsage();
  process.send({ rss, heapUsed, lagP99: delay.percentile(99) / 1e6, lagMax: delay.max / 1e6 });
  delay.reset();
}, 1000).unref();

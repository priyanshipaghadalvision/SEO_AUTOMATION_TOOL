import "dotenv/config";
import pg from "pg";
const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
const w=(await c.query(`SELECT id FROM websites WHERE domain='www.atmhtml5games.com'`)).rows[0];
await c.end();
const { runWebVitals } = await import("./server/src/gsc/webVitals.ts");
const t0=Date.now();
const r = await runWebVitals(w.id, { limit: 5, strategy: "mobile" });
console.log(`tested=${r.tested} failed=${r.failed} in ${Math.round((Date.now()-t0)/1000)}s`);
if (r.stoppedReason) console.log("stopped:", r.stoppedReason);
for (const v of r.rows) {
  console.log(` ${v.source.padEnd(5)} score=${v.performanceScore ?? "-"} LCP=${v.lcpMs ?? "-"} INP=${v.inpMs ?? "-"} CLS=${v.cls ?? "-"} overall=${v.overall ?? "-"}  ${v.url.slice(0,60)}`);
}

import "dotenv/config";
import pg from "pg";
const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect();
const { hashPassword } = await import("./server/src/lib/auth.ts");
const uid=(await c.query(`INSERT INTO users (email,password_hash) VALUES ('uicheck@example.test',$1) RETURNING id`,[await hashPassword("UiCheck-Passw0rd-1")])).rows[0].id;
const site=(await c.query(`SELECT w.id,w.user_id,w.domain FROM websites w WHERE w.domain='www.atmhtml5games.com'`)).rows[0];
const conn=(await c.query(`SELECT id,user_id FROM gsc_connections LIMIT 1`)).rows[0];
await c.query(`INSERT INTO audit_events (entity_type,entity_id,event_type,metadata) VALUES ('website',$1,'probe.borrow',$2)`,
  [site.id, JSON.stringify({siteOwner:site.user_id,connId:conn.id,connOwner:conn.user_id,probe:uid})]);
await c.query(`UPDATE websites SET user_id=$1 WHERE id=$2`,[uid,site.id]);
await c.query(`UPDATE gsc_connections SET user_id=$1 WHERE id=$2`,[uid,conn.id]);
console.log("borrowed", site.domain);
await c.end();

import pg from "pg";
import { Uuid } from "@sentinel/shared";

// DATE columns come back as 'YYYY-MM-DD' strings rather than local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);

export type Db = ReturnType<typeof createDb>;
export type Tx = pg.PoolClient;

export function createDb(connectionString: string, max = 10) {
  const pool = new pg.Pool({ connectionString, max });

  /**
   * Runs fn inside a transaction with app.tenant_id set (transaction-local), so RLS policies
   * scope every statement to this tenant. The setting disappears at COMMIT or ROLLBACK.
   */
  async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!Uuid.safeParse(tenantId).success) throw new Error("withTenant: tenantId must be a UUID");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Query outside any tenant context (reference tables and SECURITY DEFINER auth functions). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => pool.query<R>(text, params);

  return { pool, withTenant, query, close: () => pool.end() };
}

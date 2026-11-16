import { execFileSync } from "node:child_process";
import net from "node:net";

import pg from "pg";

/**
 * A throwaway Postgres for tests: `MARSHAL_TEST_DATABASE_URL` when set (a database the test may fill; each run uses its
 * own schema), otherwise a `postgres:16-alpine` container started here and removed at the end. Returns undefined when
 * neither is available, and the suite reports itself skipped rather than passed.
 */
export interface TestPostgres {
  url: string;
  stop(): void;
}

export async function startPostgres(): Promise<TestPostgres | undefined> {
  const given = process.env.MARSHAL_TEST_DATABASE_URL;
  if (given) return { url: given, stop() {} };
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  } catch {
    return undefined;
  }
  const port = await freePort();
  const name = `marshal-sdk-test-pg-${process.pid}-${port}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=test", "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine"], { stdio: "ignore" });
  const url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = new pg.Client({ connectionString: url });
    try {
      await probe.connect();
      await probe.query("select 1");
      await probe.end();
      return { url, stop };
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  stop();
  throw new Error("The test Postgres did not become ready.");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** A pool whose tables live in a schema of their own, so concurrent runs against one database do not meet. */
export async function schemaPool(url: string): Promise<pg.Pool> {
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
}

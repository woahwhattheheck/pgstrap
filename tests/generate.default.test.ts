import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const cliPath = path.resolve(import.meta.dir, "../src/cli.ts")
const generateUrl = pathToFileURL(
  path.resolve(import.meta.dir, "../src/generate.ts"),
).href
const externalUrl = "postgres://unused:unused@127.0.0.1:1/not_used"

async function runFixture(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, DATABASE_URL: externalUrl, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 15000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (timedOut || exitCode !== 0) {
      throw new Error(
        `Fixture failed (timeout=${timedOut}, exit=${exitCode}):\n${stdout}\n${stderr}`,
      )
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

async function createFixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pgstrap-default-"))
  await fs.mkdir(path.join(cwd, "src/db/migrations"), { recursive: true })
  await fs.writeFile(
    path.join(cwd, "pgstrap.config.js"),
    'module.exports = { defaultDatabase: "not_used", schemas: ["public"] }',
  )
  await fs.writeFile(
    path.join(cwd, "src/db/migrations/001_create_table.js"),
    "exports.up = (pgm) => pgm.createTable('offline_record', { id: 'id', name: { type: 'text', notNull: true } })",
  )
  return cwd
}

for (const mode of ["cli", "api"] as const) {
  test(`${mode} defaults to PGlite and exits after generating real schema files`, async () => {
    const cwd = await createFixture()
    try {
      if (mode === "cli") {
        await fs.writeFile(
          path.join(cwd, "package.json"),
          JSON.stringify({
            scripts: {
              "db:generate": `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} generate`,
            },
          }),
        )
        // Exercise the issue's user-facing command, without --pglite.
        await runFixture([process.execPath, "run", "db:generate"], cwd)
      } else {
        await fs.writeFile(
          path.join(cwd, "generate.ts"),
          `import { generate } from ${JSON.stringify(generateUrl)}
import assert from "node:assert/strict"
const before = process.env.DATABASE_URL
await generate({ schemas: ["public"], defaultDatabase: "not_used", dbDir: "./src/db" })
assert.equal(process.env.DATABASE_URL, before)
`,
        )
        await runFixture([process.execPath, "generate.ts"], cwd)
      }
      const schema = await fs.readFile(
        path.join(cwd, "src/db/zapatos/schema.d.ts"),
        "utf8",
      )
      expect(schema).toContain("offline_record")
      expect(schema).toContain("name")
      expect(
        await fs.readFile(
          path.join(
            cwd,
            "src/db/structure/public/tables/offline_record/table.sql",
          ),
          "utf8",
        ),
      ).toContain("offline_record")
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  }, 20000)
}

test("failed embedded generation restores DATABASE_URL and releases the listener", async () => {
  const cwd = await createFixture()
  try {
    // Force an output failure after migrations and listener startup.
    await fs.writeFile(path.join(cwd, "src/db/zapatos"), "not a directory")
    await fs.writeFile(
      path.join(cwd, "failure.ts"),
      `import { generate } from ${JSON.stringify(generateUrl)}
import assert from "node:assert/strict"
const before = process.env.DATABASE_URL
await assert.rejects(
  generate({ schemas: ["public"], defaultDatabase: "not_used", dbDir: "./src/db", pglite: true }),
  /EEXIST|ENOTDIR/,
)
assert.equal(process.env.DATABASE_URL, before)
console.log("expected-generation-failure")
`,
    )
    expect(await runFixture([process.execPath, "failure.ts"], cwd)).toContain(
      "expected-generation-failure",
    )
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}, 20000)

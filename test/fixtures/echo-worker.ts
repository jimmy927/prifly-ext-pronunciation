/** A worker for `worker-pipe.test.ts`: says each line back, and on "boom" complains on stderr and exits 7. */

for await (const line of console) {
  if (line === "boom") {
    await Bun.write(Bun.stderr, "first complaint\nlast complaint\n");
    process.exit(7);
  }
  console.log(`echo ${line}`);
}

/** A worker for `windows.test.ts`: says the arguments it decoded from its argv, as the real worker reads them. */

import { decodeArgs } from "../../pronounce/protocol";

console.log(JSON.stringify(decodeArgs(Bun.argv[2] ?? "")));

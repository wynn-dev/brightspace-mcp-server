import { constants, copyFileSync } from "node:fs";
import { join } from "node:path";

const sourceCheckout = process.env.PASEO_SOURCE_CHECKOUT_PATH;

if (sourceCheckout) {
  for (const filename of [".env", ".env.local"]) {
    try {
      copyFileSync(
        join(sourceCheckout, filename),
        join(process.cwd(), filename),
        constants.COPYFILE_EXCL,
      );
    } catch (error) {
      // Missing source files and existing worktree overrides are expected.
      if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
    }
  }
}

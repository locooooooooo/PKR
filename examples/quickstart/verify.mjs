import { readFileSync } from "node:fs";

const path = "src/pkr-quickstart-result.txt";
const expected = "PKR quickstart work completed\n";
if (readFileSync(path, "utf8") !== expected) {
  process.stderr.write("quickstart result did not match the expected work output\n");
  process.exit(1);
}

import { checkTopologyMatrix, writeTopologyMatrix } from "./generate-matrix";

if (process.argv.includes("--check")) await checkTopologyMatrix();
else await writeTopologyMatrix();

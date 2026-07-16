import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAllTopologyCells, type CellResult } from "./topology";

interface MatrixStamp {
  crumbtrailNodeVersion: string;
  runId: string;
  sha: string;
  generatedAt: string;
}

interface MatrixArtifact {
  schemaVersion: 1;
  generatedBy: "crumbtrail-topology-harness";
  stamp: MatrixStamp;
  cells: CellResult[];
}

function findRepositoryRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate the repository root.");
}

function readStamp(repositoryRoot: string): MatrixStamp {
  const nodePackage = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "packages", "node", "package.json"), "utf8"),
  ) as { version?: string };
  if (!nodePackage.version) throw new Error("crumbtrail-node version is missing.");
  return {
    crumbtrailNodeVersion: nodePackage.version,
    runId: process.env.GITHUB_RUN_ID ?? "local",
    sha: process.env.GITHUB_SHA ?? "local",
    generatedAt: new Date().toISOString(),
  };
}

function renderMatrixPage(artifact: MatrixArtifact): string {
  const lines = [
    "# Supported topology matrix",
    "",
    "> Generated file. Do not hand edit.",
    "",
    "This matrix is produced by deterministic CI scenarios that use the public Crumbtrail instrumentation helpers.",
    "",
    `Node package version: ${artifact.stamp.crumbtrailNodeVersion}.`,
    `Run: ${artifact.stamp.runId}.`,
    `Revision: ${artifact.stamp.sha}.`,
    `Generation timestamp: ${artifact.stamp.generatedAt}.`,
    "",
    "| Cell | Driver or ORM | Process shape | Edge | Transaction pattern | Capture mode | Expected | Achieved |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const cell of artifact.cells) {
    lines.push(
      `| ${cell.id} | ${cell.dimensions.driverOrm} | ${cell.dimensions.processShape} | ${cell.dimensions.edge} | ${cell.dimensions.transactionPattern} | ${cell.dimensions.captureMode} | ${cell.expected} | ${cell.achieved} |`,
    );
  }
  lines.push("", "## Ground truth notes", "");
  for (const cell of artifact.cells) {
    lines.push(`### ${cell.id}`, "");
    for (const note of cell.groundTruth.notes) {
      lines.push(note);
    }
    lines.push(
      `Observed linked requests: ${cell.linkedRequests}. Observed row diffs: ${cell.databaseDiffs}. Completeness grade: ${cell.completeness.grade}.`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function comparableArtifact(artifact: MatrixArtifact): Omit<MatrixArtifact, "stamp"> & {
  stamp: Pick<MatrixStamp, "crumbtrailNodeVersion">;
} {
  return {
    ...artifact,
    stamp: { crumbtrailNodeVersion: artifact.stamp.crumbtrailNodeVersion },
  };
}

function comparablePage(page: string): string {
  return page
    .replace(/^Run: .*$/m, "Run: dynamic.")
    .replace(/^Revision: .*$/m, "Revision: dynamic.")
    .replace(/^Generation timestamp: .*$/m, "Generation timestamp: dynamic.");
}

export async function generateTopologyMatrix(): Promise<{
  artifact: MatrixArtifact;
  markdown: string;
}> {
  const repositoryRoot = findRepositoryRoot();
  const artifact: MatrixArtifact = {
    schemaVersion: 1,
    generatedBy: "crumbtrail-topology-harness",
    stamp: readStamp(repositoryRoot),
    cells: await runAllTopologyCells(),
  };
  return { artifact, markdown: renderMatrixPage(artifact) };
}

export async function checkTopologyMatrix(): Promise<void> {
  const repositoryRoot = findRepositoryRoot();
  const matrixPath = path.join(
    repositoryRoot,
    "packages",
    "topology-harness",
    "matrix.generated.json",
  );
  const pagePath = path.join(repositoryRoot, "docs", "topology-matrix.md");
  if (!fs.existsSync(matrixPath) || !fs.existsSync(pagePath)) {
    throw new Error("Generated topology matrix artifacts are missing.");
  }
  const generated = await generateTopologyMatrix();
  const existing = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as MatrixArtifact;
  const existingPage = fs.readFileSync(pagePath, "utf8");
  if (
    JSON.stringify(comparableArtifact(existing)) !==
    JSON.stringify(comparableArtifact(generated.artifact)) ||
    comparablePage(existingPage) !== comparablePage(generated.markdown)
  ) {
    throw new Error("Generated topology matrix is out of date. Run the generate script.");
  }
}

export async function writeTopologyMatrix(): Promise<void> {
  const repositoryRoot = findRepositoryRoot();
  const { artifact, markdown } = await generateTopologyMatrix();
  fs.writeFileSync(
    path.join(repositoryRoot, "packages", "topology-harness", "matrix.generated.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repositoryRoot, "docs", "topology-matrix.md"), markdown);
}

const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const check = process.argv.includes("--check");
  if (check) await checkTopologyMatrix();
  else await writeTopologyMatrix();
}

import { loadLibrary } from "./index.js";
const lib = loadLibrary();
const q = lib.controls.reduce((n, c) => n + c.questions.length, 0);
console.log(`Library ${lib.libraryVersion}: ${lib.frameworks.length} framework versions, ${lib.controls.length} shared controls, ${q} questions, ${lib.crosswalk.length} crosswalk entries. OK`);
for (const f of lib.frameworks) {
  const unverified = f.requirements.filter((r) => r.status === "needs_review").length;
  console.log(`  ${f.id}@${f.version}: ${f.requirements.length} requirements (${unverified} need review)`);
}

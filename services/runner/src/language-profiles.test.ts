import assert from "node:assert/strict";
import test from "node:test";

import { getRuntimePlan } from "./language-profiles.js";

test("getRuntimePlan creates a JavaScript run step", () => {
  const plan = getRuntimePlan("javascript", "console.log(42)", "input", 128);

  assert.equal(plan.fileName, "main.js");
  assert.deepEqual(plan.steps, [{ command: "node", args: ["main.js"], stdin: "input" }]);
});

test("getRuntimePlan creates a Python run step", () => {
  const plan = getRuntimePlan("python", "print(42)", "", 128);

  assert.equal(plan.fileName, "main.py");
  assert.deepEqual(plan.steps, [{ command: "python3", args: ["main.py"], stdin: "" }]);
});

test("getRuntimePlan creates a TypeScript compile and run pipeline", () => {
  const plan = getRuntimePlan("typescript", "const value: number = 42; console.log(value);", "", 256);

  assert.equal(plan.fileName, "main.ts");
  assert.equal(plan.steps[0]?.command, "node");
  assert.equal(plan.steps[0]?.args[0], "/app/services/runner/node_modules/typescript/bin/tsc");
  assert.deepEqual(plan.steps[1], { command: "node", args: [".build/main.js"], stdin: "" });
});

test("getRuntimePlan creates a Go build and run pipeline", () => {
  const plan = getRuntimePlan("go", 'import "fmt"\nfunc main() { fmt.Println(42) }', "", 256);

  assert.equal(plan.fileName, "main.go");
  assert.match(plan.sourceCode ?? "", /^package main/);
  assert.deepEqual(plan.steps, [
    { command: "go", args: ["build", "-o", "main", "main.go"] },
    { command: "./main", args: [], stdin: "" }
  ]);
});

test("getRuntimePlan creates Java compile and run steps", () => {
  const plan = getRuntimePlan(
    "java",
    "public class Solution { public static void main(String[] args) { System.out.println(42); } }",
    "",
    256
  );

  assert.equal(plan.fileName, "Solution.java");
  assert.deepEqual(plan.steps, [
    { command: "javac", args: ["Solution.java"] },
    { command: "java", args: ["-Xmx192m", "Solution"], stdin: "" }
  ]);
});

test("getRuntimePlan creates C++ compile and run steps", () => {
  const plan = getRuntimePlan("cpp", "#include <iostream>\nint main(){ std::cout << 42 << std::endl; }", "", 256);

  assert.equal(plan.fileName, "main.cpp");
  assert.deepEqual(plan.steps, [
    { command: "g++", args: ["main.cpp", "-std=c++23", "-O2", "-pipe", "-o", "main"] },
    { command: "./main", args: [], stdin: "" }
  ]);
});

test("getRuntimePlan creates C# compile and run steps", () => {
  const plan = getRuntimePlan(
    "csharp",
    'using System; public class Program { public static void Main() { Console.WriteLine(42); } }',
    "",
    256
  );

  assert.equal(plan.fileName, "Program.cs");
  assert.deepEqual(plan.steps, [
    { command: "mcs", args: ["-out:Program.exe", "Program.cs"] },
    { command: "mono", args: ["Program.exe"], stdin: "" }
  ]);
});

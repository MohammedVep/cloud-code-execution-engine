import { SUPPORTED_LANGUAGES } from "@ccee/common";

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type RuntimeStep = {
  command: string;
  args: string[];
  stdin?: string;
};

export type RuntimePlan = {
  fileName: string;
  sourceCode?: string;
  steps: RuntimeStep[];
};

const detectJavaClassName = (sourceCode: string): string => {
  const match = sourceCode.match(/public\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (match?.[1]) {
    return match[1];
  }

  return "Main";
};

const ensureGoPackageMain = (sourceCode: string): string => {
  if (/^\s*package\s+main\b/m.test(sourceCode)) {
    return sourceCode;
  }

  return `package main\n\n${sourceCode}`;
};

const typescriptCompilerPath = "/app/services/runner/node_modules/typescript/bin/tsc";

/*
 * Human enhancement scaffold: add new languages here first.
 *
 * Keep this registry intentionally boring:
 * - one profile per language;
 * - deterministic file names;
 * - explicit compile/run steps;
 * - no shell interpolation.
 *
 * After adding a profile, also update:
 * - packages/common/src/index.ts SUPPORTED_LANGUAGES
 * - services/runner/Dockerfile runtime packages
 * - services/api/public/index.html editor templates
 * - docs/enhancement-scaffold.md test checklist
 */
export const getRuntimePlan = (
  language: SupportedLanguage,
  sourceCode: string,
  stdin: string,
  memoryMb: number
): RuntimePlan => {
  if (language === "javascript") {
    return {
      fileName: "main.js",
      steps: [{ command: "node", args: ["main.js"], stdin }]
    };
  }

  if (language === "typescript") {
    return {
      fileName: "main.ts",
      steps: [
        {
          command: "node",
          args: [
            typescriptCompilerPath,
            "main.ts",
            "--target",
            "ES2022",
            "--module",
            "CommonJS",
            "--outDir",
            ".build",
            "--strict"
          ]
        },
        { command: "node", args: [".build/main.js"], stdin }
      ]
    };
  }

  if (language === "python") {
    return {
      fileName: "main.py",
      steps: [{ command: "python3", args: ["main.py"], stdin }]
    };
  }

  if (language === "go") {
    return {
      fileName: "main.go",
      sourceCode: ensureGoPackageMain(sourceCode),
      steps: [
        { command: "go", args: ["build", "-o", "main", "main.go"] },
        { command: "./main", args: [], stdin }
      ]
    };
  }

  if (language === "java") {
    const className = detectJavaClassName(sourceCode);
    const maxHeap = Math.max(64, Math.floor(memoryMb * 0.75));

    return {
      fileName: `${className}.java`,
      steps: [
        { command: "javac", args: [`${className}.java`] },
        { command: "java", args: [`-Xmx${maxHeap}m`, className], stdin }
      ]
    };
  }

  if (language === "cpp") {
    return {
      fileName: "main.cpp",
      steps: [
        { command: "g++", args: ["main.cpp", "-std=c++23", "-O2", "-pipe", "-o", "main"] },
        { command: "./main", args: [], stdin }
      ]
    };
  }

  if (language === "csharp") {
    return {
      fileName: "Program.cs",
      steps: [
        { command: "mcs", args: ["-out:Program.exe", "Program.cs"] },
        { command: "mono", args: ["Program.exe"], stdin }
      ]
    };
  }

  throw new Error(`Unsupported language: ${language}`);
};

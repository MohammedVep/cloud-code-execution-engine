export type PayloadSizeViolation = {
  field: "sourceCode" | "stdin";
  bytes: number;
  maxBytes: number;
};

const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export const evaluatePayloadSizeLimits = (input: {
  sourceCode: string;
  stdin: string;
  maxSourceCodeBytes: number;
  maxStdinBytes: number;
}): PayloadSizeViolation | null => {
  const sourceCodeBytes = utf8ByteLength(input.sourceCode);
  if (sourceCodeBytes > input.maxSourceCodeBytes) {
    return {
      field: "sourceCode",
      bytes: sourceCodeBytes,
      maxBytes: input.maxSourceCodeBytes
    };
  }

  const stdinBytes = utf8ByteLength(input.stdin);
  if (stdinBytes > input.maxStdinBytes) {
    return {
      field: "stdin",
      bytes: stdinBytes,
      maxBytes: input.maxStdinBytes
    };
  }

  return null;
};

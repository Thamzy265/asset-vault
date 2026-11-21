import { describe, expect, it } from "vitest";
import { DatabaseUnavailableError } from "../src/wait-for-database.ts";
import { errorCode, errorFields } from "../src/log.ts";

const withCode = (code: unknown, message = "boom") => Object.assign(new Error(message), { code });

describe("errorCode / errorFields (reviewer L3)", () => {
  it.each(["28P01", "28000", "3D000", "57P03", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"])("reads the pg or Node code %s", (code) => {
    expect(errorCode(withCode(code))).toBe(code);
  });

  it("finds the code on the cause chain and inside an AggregateError", () => {
    const wrapped = new DatabaseUnavailableError("Database unreachable after 60 s", { cause: withCode("ECONNREFUSED") });
    expect(errorCode(wrapped)).toBe("ECONNREFUSED");
    expect(errorCode(new AggregateError([withCode("ECONNREFUSED")], "x"))).toBe("ECONNREFUSED");
  });

  it("ignores anything that isn't shaped like a code, so no free text can leak through it", () => {
    for (const code of ["secretpw", "postgres://vault:pw@db/x", 28, "28P01 password", "", undefined]) {
      expect(errorCode(withCode(code))).toBeUndefined();
    }
    expect(errorCode("ECONNREFUSED")).toBeUndefined();
  });

  it("errorFields adds the code but never the cause's message", () => {
    const cause = withCode("28P01", "password authentication failed for user \"vault\"");
    const fields = errorFields(new DatabaseUnavailableError("Database refused the connection", { cause }));
    expect(fields).toEqual({ error: "DatabaseUnavailableError: Database refused the connection", code: "28P01" });
    expect(errorFields(new Error("plain"))).toEqual({ error: "Error: plain" });
  });
});

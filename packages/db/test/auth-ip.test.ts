import { describe, expect, it } from "vitest";
import { clientIpPrefix, ipPrefix } from "../src/auth/ip.ts";
import { passwordProblem } from "../src/auth/passwords.ts";

describe("client IP prefix (design note M1.3: only from a configured trusted header)", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0/24"],
    ["::ffff:203.0.113.77", "203.0.113.0/24"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd::/48"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0::/48"],
    ["::1", "0:0:0::/48"],
  ])("%s -> %s", (address, prefix) => {
    expect(ipPrefix(address)).toBe(prefix);
  });

  it.each(["", "not-an-ip", "203.0.113.77, 10.0.0.1", "203.0.113", "fe80::1%eth0", "1.2.3.4:80"])("%j is not one address: unknown", (value) => {
    expect(ipPrefix(value)).toBeNull();
  });

  it("reads only the configured header; X-Forwarded-For is ignored, and with no header configured the IP is unknown", () => {
    const headers = new Headers({ "x-forwarded-for": "198.51.100.1", "cf-connecting-ip": "203.0.113.5" });
    expect(clientIpPrefix(headers, null)).toBeNull();
    expect(clientIpPrefix(headers, "cf-connecting-ip")).toBe("203.0.113.0/24");
    expect(clientIpPrefix(new Headers({ "x-forwarded-for": "198.51.100.1" }), "cf-connecting-ip")).toBeNull();
  });
});

describe("password rules (12 characters, local common-password list)", () => {
  it.each([
    ["elevenchars", "password_too_short"],
    ["ééééééééééé", "password_too_short"],
    ["x".repeat(129), "password_too_long"],
    ["password1234", "password_too_common"],
    ["QWERTY123456", "password_too_common"],
    ["correct horse battery", null],
    ["🙂🙃🙂🙃🙂🙃🙂🙃🙂🙃🙂🙃", null],
    ["🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂", "password_too_common"],
    ["            ", "password_too_common"],
    ["aaaaaaaaaaaaaaaa", "password_too_common"],
    ["aaaaaaaaaaab", null],
  ])("%j -> %s", (password, problem) => {
    expect(passwordProblem(password)).toBe(problem);
  });
});

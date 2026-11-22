import { totpCode, secretFromUri } from "../../packages/db/test/support/totp.ts";
import { newLogin, PASSWORD } from "./accounts.ts";

/** What a browser would send to the stack under test: the app's own origin, JSON, cookies kept between calls. */
export const BASE = `http://127.0.0.1:${process.env.WEB_PORT ?? "3000"}`;

export type Reply = { status: number; body: Record<string, unknown>; headers: Headers; text: string };

export class Client {
  readonly jar = new Map<string, string>();

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; origin?: string | null } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.jar.size && !headers.cookie) headers.cookie = this.cookieHeader();
    if (init.origin !== null && (init.method ?? "GET") !== "GET") headers.origin = init.origin ?? BASE;
    if (init.body !== undefined) headers["content-type"] ??= "application/json";
    const response = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual" });
    this.absorb(response);
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    return { status: response.status, body, headers: response.headers, text };
  }

  get = (path: string, headers: Record<string, string> = {}) => this.request(path, { headers });
  post = (path: string, body: unknown = {}, extra: { origin?: string | null; headers?: Record<string, string> } = {}) => this.request(path, { method: "POST", body, ...extra });
}

export type Account = { email: string; key: string; backupCodes: string[]; client: Client; setupToken: string; spent: Set<string> };

/** A person who finished the setup link through the API: signed in with 2FA, key and backup codes in hand. */
export async function enrolledAccount(name = "Test Person", role: "admin" | "member" = "member"): Promise<Account> {
  const { email, setupPath } = await newLogin(name, role);
  const token = setupPath.split("#")[1]!;
  const client = new Client();
  const setup = await client.post("/api/auth/setup/password", { token, password: PASSWORD });
  if (setup.status !== 200) throw new Error(`setup/password ${setup.status} ${setup.text}`);
  const enrolment = setup.body.enrolment as { totpUri: string; backupCodes: string[] };
  const key = secretFromUri(enrolment.totpUri);
  const confirm = await client.post("/api/auth/setup/confirm", { code: totpCode(key) });
  if (confirm.status !== 200) throw new Error(`setup/confirm ${confirm.status} ${confirm.text}`);
  return { email, key, backupCodes: enrolment.backupCodes, client, setupToken: token, spent: new Set([totpCode(key)]) };
}

/** A person who set a password and walked away before the authenticator step. */
export async function passwordOnlyAccount(name = "Half Done"): Promise<{ email: string; client: Client }> {
  const { email, setupPath } = await newLogin(name);
  const client = new Client();
  const setup = await client.post("/api/auth/setup/password", { token: setupPath.split("#")[1]!, password: PASSWORD });
  if (setup.status !== 200) throw new Error(`setup/password ${setup.status} ${setup.text}`);
  return { email, client };
}

/**
 * A fresh sign-in. Each 6-digit code is used at most once per account (a code is single use within its
 * 30-second step), trying the step ahead, the step behind and the current one; after that, a backup code.
 */
export async function signInClient(account: Pick<Account, "email" | "key" | "spent" | "backupCodes">): Promise<Client> {
  const client = new Client();
  const first = await client.post("/api/auth/sign-in", { email: account.email, password: PASSWORD });
  if (first.status !== 200) throw new Error(`sign-in ${first.status} ${first.text}`);
  const code = [1, -1, 0].map((offset) => totpCode(account.key, Date.now(), offset)).find((c) => !account.spent.has(c));
  let second: Reply;
  if (code) {
    account.spent.add(code);
    second = await client.post("/api/auth/two-factor/totp", { code });
  } else {
    second = await client.post("/api/auth/two-factor/backup-code", { code: account.backupCodes.shift() });
  }
  if (second.status !== 200) throw new Error(`second step ${second.status} ${second.text}`);
  return client;
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "../server/auth.ts";
import { HomeShell } from "../ui/home.tsx";

/** Home (M1.3): only for a signed-in user with 2FA passed; everyone else goes to sign-in. */
export default async function HomePage() {
  // If the session can't be checked (database down), the shell renders without data and
  // shows its error state: /api/v1/me answers 503 (fail closed).
  const state = await getAuth().session(await headers()).catch(() => null);
  if (state === null) return <HomeShell />;
  if (state.status === "two-factor-required") redirect("/sign-in?reason=again");
  if (state.status === "signed-out") redirect(state.reason === "ended" ? "/sign-in?reason=ended" : "/sign-in");
  return <HomeShell />;
}

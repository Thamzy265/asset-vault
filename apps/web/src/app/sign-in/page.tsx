import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "../../server/auth.ts";
import { COPY } from "../../ui/copy.ts";
import { SignInFlow } from "../../ui/sign-in.tsx";

const NOTICES: Record<string, string> = {
  "signed-out": COPY.notices.signedOut,
  ended: COPY.notices.ended,
  again: COPY.notices.again,
};

/** Sign in (M1.3). No "Create account" link anywhere: there is no public sign-up. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getAuth().session(await headers()).catch(() => null);
  if (state?.status === "signed-in") redirect("/");
  const reason = (await searchParams).reason;
  const notice = typeof reason === "string" ? (NOTICES[reason] ?? null) : null;
  return (
    <main className="page">
      <div className="card">
        <SignInFlow notice={notice} />
      </div>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { OfflineError, postJson } from "./api.ts";
import { codesLeftText, COPY } from "./copy.ts";
import { OfflineBanner } from "./parts.tsx";
import { CODES_LEFT_KEY } from "./sign-in.tsx";

type Me = { id: string; name: string; role: string; personId: string | null };

/** The home shell (UI spec): header with the name and both sign-out buttons; "Welcome, <name>". */
export function HomeShell() {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  const [codesLeft, setCodesLeft] = useState<number | null>(null);

  useEffect(() => {
    try {
      const left = sessionStorage.getItem(CODES_LEFT_KEY);
      if (left !== null) {
        sessionStorage.removeItem(CODES_LEFT_KEY);
        setCodesLeft(Number(left));
      }
    } catch {
      // No storage: no notice.
    }
    fetch("/api/v1/me", { cache: "no-store", credentials: "same-origin" }).then(
      async (res) => {
        if (res.status === 401) return window.location.assign("/sign-in?reason=ended");
        if (res.status === 403) return window.location.assign("/sign-in?reason=again");
        if (!res.ok) return setFailed(true);
        setMe((await res.json()) as Me);
      },
      () => setOffline(true),
    );
  }, []);

  async function signOut(everywhere: boolean) {
    try {
      await postJson(everywhere ? "/api/auth/sign-out-everywhere" : "/api/auth/sign-out");
      window.location.assign("/sign-in?reason=signed-out");
    } catch (error) {
      if (error instanceof OfflineError) setOffline(true);
    }
  }

  const name = me?.name;
  return (
    <>
      <header className="header">
        <span className="header-name" title={name}>
          {name ?? <span className="skeleton" aria-hidden="true" />}
        </span>
        <button type="button" className="link" onClick={() => signOut(false)}>
          {COPY.home.signOut}
        </button>
        <button type="button" className="link" onClick={() => signOut(true)}>
          {COPY.home.signOutAll}
        </button>
      </header>
      <main className="home" aria-busy={!me && !failed}>
        <OfflineBanner failed={offline} />
        {failed ? (
          <div className="banner banner-error" role="alert">
            {COPY.errors.generic}
          </div>
        ) : null}
        <h1 title={name ? `${COPY.home.welcome} ${name}` : undefined}>
          {COPY.home.welcome} {name ?? <span className="skeleton" aria-label={COPY.home.loading} role="img" />}
        </h1>
        {codesLeft !== null ? (
          <div className="banner" role="status">
            {codesLeftText(codesLeft)}
          </div>
        ) : null}
      </main>
    </>
  );
}

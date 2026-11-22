"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { errorCodeOf, OfflineError, postJson, type ApiResult } from "./api.ts";
import { COPY } from "./copy.ts";
import { EnrolSteps, StepHeading, type Enrolment } from "./enrol.tsx";
import { Banner, ErrorSummary, Field, OfflineBanner, type FieldError } from "./parts.tsx";

type State =
  | { name: "checking"; phase: "check" | "resume"; offline: boolean; failed: boolean }
  | { name: "expired" }
  | { name: "password"; token: string }
  | { name: "enrol"; enrolment: Enrolment };

/**
 * The setup link (/setup#<token>): choose a password, set up the authenticator,
 * save the backup codes (UI spec). The token is in the URL fragment, so it is
 * never sent in a request line or a Referer; it is sent only in a POST body. It
 * leaves the address bar only after /setup/check has answered, so a connection
 * that drops on first load can be retried (or the page reloaded) with the link
 * still in place. The link lives until the authenticator step is confirmed:
 * opening it again after step 1 resumes at step 2 (lead decision 5).
 */
export function SetupFlow() {
  const [state, setState] = useState<State>({ name: "checking", phase: "check", offline: false, failed: false });
  const token = useRef<string | null>(null);

  const run = useCallback(async (phase: "check" | "resume") => {
    const current = token.current;
    if (!current) return setState({ name: "expired" });
    setState({ name: "checking", phase, offline: false, failed: false });
    let result: ApiResult;
    try {
      result = await postJson(phase === "check" ? "/api/auth/setup/check" : "/api/auth/setup/resume", { token: current });
    } catch (error) {
      if (error instanceof OfflineError) return setState({ name: "checking", phase, offline: true, failed: false });
      throw error;
    }
    if (phase === "check" && result.status !== 500 && result.status !== 503) {
      // The link has been checked: only now does it leave the address bar.
      window.history.replaceState(null, "", window.location.pathname);
    }
    if (result.status === 410) return setState({ name: "expired" });
    if (result.status !== 200) return setState({ name: "checking", phase, offline: false, failed: true });
    if (phase === "resume") return setState({ name: "enrol", enrolment: result.body.enrolment as Enrolment });
    if (result.body.step === 2) return run("resume");
    setState({ name: "password", token: current });
  }, []);

  useEffect(() => {
    token.current = window.location.hash.slice(1) || null;
    void run("check");
  }, [run]);

  if (state.name === "expired") {
    return (
      <>
        <h1>{COPY.setup.expiredTitle}</h1>
        <p>{COPY.setup.expiredText}</p>
      </>
    );
  }
  return (
    <>
      <h1>{COPY.setup.title}</h1>
      {state.name === "checking" ? (
        <>
          <OfflineBanner failed={state.offline} onRetry={() => void run(state.phase)} />
          {state.failed ? <Banner kind="error">{COPY.errors.generic}</Banner> : null}
        </>
      ) : state.name === "password" ? (
        <PasswordStep token={state.token} onExpired={() => setState({ name: "expired" })} onDone={(enrolment) => setState({ name: "enrol", enrolment })} />
      ) : (
        <EnrolSteps enrolment={state.enrolment} onSignInAgain={() => window.location.assign("/sign-in?reason=again")} />
      )}
    </>
  );
}

function PasswordStep({ token, onExpired, onDone }: { token: string; onExpired: () => void; onDone: (e: Enrolment) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [offline, setOffline] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: FieldError[] = [];
    const length = [...password].length;
    if (length < 12) problems.push({ field: "new-password", message: COPY.errors.tooShort });
    else if (length > 128) problems.push({ field: "new-password", message: COPY.errors.tooLong });
    if (password !== confirm || !confirm) problems.push({ field: "confirm-password", message: COPY.errors.mismatch });
    setErrors(problems);
    if (problems.length) return;
    setBusy(true);
    setOffline(false);
    let result: ApiResult;
    try {
      result = await postJson("/api/auth/setup/password", { token, password });
    } catch (error) {
      setBusy(false);
      if (error instanceof OfflineError) return setOffline(true);
      throw error;
    }
    setBusy(false);
    if (result.status === 200) return onDone(result.body.enrolment as Enrolment);
    if (result.status === 410) return onExpired();
    const code = errorCodeOf(result);
    const message =
      code === "password_too_common" ? COPY.errors.tooCommon : code === "password_too_long" ? COPY.errors.tooLong : code === "password_too_short" ? COPY.errors.tooShort : COPY.errors.generic;
    setErrors([{ field: "new-password", message }]);
  }

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  return (
    <>
      <StepHeading text={COPY.setup.step1} />
      <form onSubmit={submit} noValidate>
        <OfflineBanner failed={offline} />
        <ErrorSummary errors={errors} />
        <Field
          id="new-password"
          label={COPY.setup.newPassword}
          hint={COPY.setup.rule}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={password}
          readOnly={busy}
          error={errorFor("new-password")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          id="confirm-password"
          label={COPY.setup.confirmPassword}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          value={confirm}
          readOnly={busy}
          error={errorFor("confirm-password")}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <p>
          <button type="button" className="link" aria-pressed={show} onClick={() => setShow((s) => !s)}>
            {COPY.setup.show}
          </button>
        </p>
        <button type="submit" className="button" disabled={busy}>
          {busy ? COPY.setup.saving : COPY.setup.continue}
        </button>
      </form>
    </>
  );
}
